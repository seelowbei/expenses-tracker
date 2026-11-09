// Long-lived resources: created once per environment, rarely changed.
// Anything holding data is protected so `pulumi destroy` or a rename can't delete it.
import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

const env = pulumi.getStack(); // "staging" | "production"
if (env !== "staging" && env !== "production") {
  throw new Error(`Unknown stack "${env}"; expected "staging" or "production".`);
}

const config = new pulumi.Config();
const accountId = config.require("accountId");

// D1: source of truth for users, sessions, receipts and the ledger.
const db = new cloudflare.D1Database(
  "db",
  {
    accountId,
    name: `expense-${env}`,
    primaryLocationHint: config.get("d1LocationHint") ?? "apac",
  },
  { protect: true },
);

// Receipt extraction queue + dead-letter queue (consumer is wired in services/).
const receiptsDlq = new cloudflare.Queue("receipts-dlq", {
  accountId,
  queueName: `receipts-${env}-dlq`,
});

const receipts = new cloudflare.Queue("receipts", {
  accountId,
  queueName: `receipts-${env}`,
});

export const cloudflareAccountId = accountId;
export const d1DatabaseName = db.name;
export const d1DatabaseId = db.uuid;
export const receiptQueueName = receipts.queueName;
export const receiptQueueId = receipts.queueId;
export const receiptDlqName = receiptsDlq.queueName;
