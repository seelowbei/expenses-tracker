// Deploys the Expense Tracker Worker onto the foundation resources:
// SPA static assets + Hono API (fetch) + receipt extraction (queue consumer) + daily re-send (cron).
//
// Build first (see infrastructure/README.md):
//   pnpm --filter web build                                 -> web/dist
//   pnpm --filter worker bundle   -> worker/dist/index.js
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

const env = pulumi.getStack(); // "staging" | "production"
if (env !== "staging" && env !== "production") {
  throw new Error(`Unknown stack "${env}"; expected "staging" or "production".`);
}

const config = new pulumi.Config();
const foundation = new pulumi.StackReference(
  `${pulumi.getOrganization()}/expense-foundation/${env}`,
);

const accountId = foundation.requireOutput("cloudflareAccountId") as pulumi.Output<string>;
const d1DatabaseId = foundation.requireOutput("d1DatabaseId") as pulumi.Output<string>;
const receiptQueueName = foundation.requireOutput("receiptQueueName") as pulumi.Output<string>;
const receiptQueueId = foundation.requireOutput("receiptQueueId") as pulumi.Output<string>;
const receiptDlqName = foundation.requireOutput("receiptDlqName") as pulumi.Output<string>;

// ---- Build artifacts -------------------------------------------------------

const repoRoot = path.resolve(__dirname, "../..");
const workerBundle = path.join(repoRoot, config.get("workerBundle") ?? "worker/dist/index.js");
const assetsDir = path.join(repoRoot, config.get("assetsDir") ?? "web/dist");

for (const [what, p] of [["Worker bundle", workerBundle], ["SPA assets", assetsDir]] as const) {
  if (!fs.existsSync(p)) {
    throw new Error(`${what} not found at ${p}. Build it before running pulumi (see infrastructure/README.md).`);
  }
}

const workerSha256 = crypto.createHash("sha256").update(fs.readFileSync(workerBundle)).digest("hex");

// Cloudflare applies `_headers` (CSP, frame-ancestors, HSTS for the SPA) only when its contents are sent
// as assets.config.headers. The provider's directory upload would publish it as a plain file instead,
// so it is read here and the assets are uploaded from a copy without it. Wrangler dev reads the file itself.
const HEADERS_FILE = "_headers";
const headersPath = path.join(assetsDir, HEADERS_FILE);
if (!fs.existsSync(headersPath)) {
  throw new Error(`${HEADERS_FILE} not found in ${assetsDir}; it comes from web/public/${HEADERS_FILE}.`);
}
const assetHeaders = fs.readFileSync(headersPath, "utf8");
const uploadDir = path.join(__dirname, ".build", "assets");
fs.rmSync(uploadDir, { recursive: true, force: true });
fs.cpSync(assetsDir, uploadDir, { recursive: true, filter: (src) => path.relative(assetsDir, src) !== HEADERS_FILE });

// ---- Worker ----------------------------------------------------------------

// Production keeps the bare name so it serves at expense-tracker.<sub>.workers.dev.
// Renaming a deployed script creates a new Worker; change it only with the OAuth redirect URI and appOrigin.
const scriptName = env === "production" ? "expense-tracker" : `expense-tracker-${env}`;
const secret = (key: string) => config.requireSecret(key);

const worker = new cloudflare.WorkersScript("worker", {
  accountId,
  scriptName,
  mainModule: path.basename(workerBundle),
  contentFile: workerBundle,
  contentSha256: workerSha256,
  compatibilityDate: config.get("compatibilityDate") ?? "2026-11-01",
  compatibilityFlags: ["nodejs_compat"],
  assets: {
    directory: uploadDir,
    config: {
      headers: assetHeaders,
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/auth/*"],
    },
  },
  bindings: [
    { type: "ai", name: "AI" },
    { type: "d1", name: "DB", id: d1DatabaseId },
    { type: "queue", name: "RECEIPT_QUEUE", queueName: receiptQueueName },
    { type: "plain_text", name: "APP_ORIGIN", text: config.require("appOrigin") },
    { type: "plain_text", name: "DEFAULT_CURRENCY", text: config.get("defaultCurrency") ?? "SGD" },
    // Testers share Google accounts across environments, so non-production folders carry the env name.
    // Only names folders created from now on; existing folders keep theirs (rename them in Drive).
    {
      type: "plain_text",
      name: "DRIVE_FOLDER_NAME",
      text: config.get("driveFolderName") ?? (env === "production" ? "Expense Receipts" : `Expense Receipts (${env})`),
    },
    { type: "secret_text", name: "GOOGLE_CLIENT_ID", text: secret("googleClientId") },
    { type: "secret_text", name: "GOOGLE_CLIENT_SECRET", text: secret("googleClientSecret") },
    { type: "secret_text", name: "TOKEN_ENC_KEY", text: secret("tokenEncKey") },
    { type: "secret_text", name: "SESSION_SECRET", text: secret("sessionSecret") },
  ],
  observability: { enabled: true },
});

// One receipt per invocation so CPU budget and failures stay isolated.
new cloudflare.QueueConsumer(
  "receipts-consumer",
  {
    accountId,
    queueId: receiptQueueId,
    type: "worker",
    scriptName: worker.scriptName,
    deadLetterQueue: receiptDlqName,
    settings: { batchSize: 1, maxRetries: 3 },
  },
  { dependsOn: [worker] },
);

// Daily re-send of receipts parked for the AI quota (or a failed queue send), five minutes after the
// 00:00 UTC Workers AI reset. Keep in sync with PARK_CRON in worker/src/pipeline/timing.ts and wrangler.jsonc.
new cloudflare.WorkersCronTrigger(
  "receipts-park-cron",
  {
    accountId,
    scriptName: worker.scriptName,
    schedules: [{ cron: "5 0 * * *" }],
  },
  { dependsOn: [worker] },
);

// ---- Routing ---------------------------------------------------------------

const customDomain = config.get("customDomain");

new cloudflare.WorkersScriptSubdomain("workers-dev", {
  accountId,
  scriptName: worker.scriptName,
  // Keep workers.dev on unless a custom domain takes over.
  enabled: !customDomain,
});

if (customDomain) {
  new cloudflare.WorkersCustomDomain("custom-domain", {
    accountId,
    hostname: customDomain,
    service: worker.scriptName,
    zoneId: config.require("zoneId"),
  });
}

export const workerName = worker.scriptName;
export const appOrigin = config.require("appOrigin");
