// M1 eval runner (Node). Sends each receipt in eval/receipts/ to the local Worker's
// /api/dev/extract route and scores the result against <name>.json labels.
//
//   pnpm --filter worker dev        # terminal 1 (needs Workers AI auth)
//   pnpm --filter worker eval       # terminal 2
//
// Options: --dir <path>  --url <origin>  --only <substring>  --image-mode data_url|bytes  --limit <n>
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { FIELDS, Label, scoreFields, type FieldScores, type Predicted } from "./compare";

// `pnpm --filter worker eval -- --limit 1` forwards the `--` separator; drop it.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values: args } = parseArgs({
  args: argv,
  options: {
    dir: { type: "string", default: path.join(import.meta.dirname, "receipts") },
    url: { type: "string", default: "http://localhost:8787" },
    only: { type: "string" },
    "image-mode": { type: "string", default: "data_url" },
    limit: { type: "string" },
  },
});

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);
const HEIC_EXT = new Set([".heic", ".heif"]);
const TARGET = 0.9;

interface CallRecord {
  kind: "extract" | "repair" | "to_markdown";
  outcome: string;
  promptTokens: number | null;
  completionTokens: number | null;
  neuronsEst: number | null;
}

interface DevResponse {
  elapsedMs: number;
  sizeBytes: number;
  usage: { calls: number; llmCalls: number; promptTokens: number; completionTokens: number; neuronsEst: number | null };
  result:
    | { ok: true; status: "done" | "needs_review"; reasons: string[]; extraction: Predicted & { confidence: number }; draft: { category_slug: string }; calls: CallRecord[] }
    | { ok: false; code: string; detail?: string; calls: CallRecord[] };
}

interface Row {
  name: string;
  kind: "image" | "pdf";
  status: string;
  reasons: string[];
  confidence: number | null;
  scores: FieldScores | null;
  llmCalls: number;
  repaired: boolean;
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  neurons: number | null;
  uploadBytes: number;
  response: DevResponse;
}

// Mirrors the browser: auto-rotate, max 2000 px long edge, JPEG ~80%.
async function prepareImage(file: string): Promise<Buffer> {
  return sharp(file)
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function loadLabel(file: string): Promise<Label | null> {
  const labelPath = file.replace(/\.[^.]+$/, ".json");
  if (!existsSync(labelPath)) return null;
  return Label.parse(JSON.parse(await readFile(labelPath, "utf8")));
}

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`);
const tick = (b: boolean | null | undefined) => (b === undefined || b === null ? "·" : b ? "✓" : "✗");

async function main() {
  const dir = args.dir!;
  if (!existsSync(dir)) throw new Error(`No receipts folder at ${dir}. See eval/README.md.`);

  let files = (await readdir(dir)).filter((f) => !f.startsWith(".")).sort();
  const heic = files.filter((f) => HEIC_EXT.has(path.extname(f).toLowerCase()));
  for (const f of heic) console.warn(`skip ${f}: convert HEIC first (sips -s format jpeg "${f}" --out "${f.replace(/\.[^.]+$/, ".jpg")}")`);

  files = files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return IMAGE_EXT.has(ext) || ext === ".pdf";
  });
  if (args.only) files = files.filter((f) => f.includes(args.only!));
  if (args.limit) files = files.slice(0, Number(args.limit));
  if (files.length === 0) throw new Error(`No .jpg/.png/.pdf receipts in ${dir}.`);

  const rows: Row[] = [];
  console.log(`receipt                          kind   status         ${FIELDS.map((f) => f.slice(0, 4)).join(" ")}  calls     ms  neurons`);

  for (const f of files) {
    const full = path.join(dir, f);
    const isPdf = path.extname(f).toLowerCase() === ".pdf";
    const bytes = isPdf ? await readFile(full) : await prepareImage(full);
    const label = await loadLabel(full);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: isPdf ? "application/pdf" : "image/jpeg" }), f);
    form.append("imageMode", args["image-mode"]!);

    const res = await fetch(`${args.url}/api/dev/extract`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as DevResponse;
    const r = body.result;

    const predicted: Predicted | null = r.ok ? { ...r.extraction, category_slug: r.draft.category_slug } : null;
    const row: Row = {
      name: f,
      kind: isPdf ? "pdf" : "image",
      status: r.ok ? r.status : `failed:${r.code}`,
      reasons: r.ok ? r.reasons : [],
      confidence: r.ok ? r.extraction.confidence : null,
      scores: label ? scoreFields(label, predicted) : null,
      llmCalls: body.usage.llmCalls,
      repaired: r.calls.some((c) => c.kind === "repair"),
      elapsedMs: body.elapsedMs,
      promptTokens: body.usage.promptTokens,
      completionTokens: body.usage.completionTokens,
      neurons: body.usage.neuronsEst,
      uploadBytes: body.sizeBytes,
      response: body,
    };
    rows.push(row);

    const s = row.scores;
    console.log(
      `${f.slice(0, 32).padEnd(32)} ${row.kind.padEnd(6)} ${row.status.slice(0, 14).padEnd(14)} ` +
        `${FIELDS.map((k) => `  ${tick(s?.[k])} `).join("")} ${String(row.llmCalls).padStart(5)} ${String(row.elapsedMs).padStart(6)} ` +
        `${row.neurons === null ? "    n/a" : row.neurons.toFixed(1).padStart(7)}`,
    );
  }

  // ---- Summary ----
  const scored = rows.filter((r) => r.scores);
  // Per field, only receipts whose label includes it (txn_time can be left out).
  const fieldStats = Object.fromEntries(
    FIELDS.map((k) => {
      const withField = scored.filter((r) => r.scores![k] !== null);
      return [k, { right: withField.filter((r) => r.scores![k] === true).length, of: withField.length }];
    }),
  ) as Record<string, { right: number; of: number }>;
  const byStatus = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  const core = (r: Row) => r.scores!.merchant && r.scores!.txn_date && r.scores!.total;
  const done = scored.filter((r) => r.status === "done");
  const review = scored.filter((r) => r.status === "needs_review");
  const neuronRows = rows.filter((r) => r.neurons !== null);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  console.log(`\n${rows.length} receipts, ${scored.length} labelled`);
  console.log("Status:", Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("\nField accuracy (labelled):");
  for (const k of FIELDS) {
    const f = fieldStats[k]!;
    console.log(`  ${k.padEnd(14)} ${pct(f.right, f.of)}  (${f.right}/${f.of})${k === "txn_time" ? "  reported, no target" : ""}`);
  }
  console.log(`\nAll of merchant+date+total correct: ${pct(scored.filter(core).length, scored.length)}`);
  console.log(`  when status=done:         ${pct(done.filter(core).length, done.length)} (${done.length})`);
  console.log(`  when status=needs_review: ${pct(review.filter(core).length, review.length)} (${review.length})`);

  const meets = (k: string) => fieldStats[k]!.of > 0 && fieldStats[k]!.right / fieldStats[k]!.of >= TARGET;
  const totalOk = meets("total");
  const dateOk = meets("txn_date");
  console.log(`\nTarget ≥ ${TARGET * 100}% on total and date: total ${totalOk ? "PASS" : "FAIL"} · date ${dateOk ? "PASS" : "FAIL"}`);

  console.log(`\nLLM calls/receipt: ${avg(rows.map((r) => r.llmCalls)).toFixed(2)} · repair rate ${pct(rows.filter((r) => r.repaired).length, rows.length)} · latency avg ${Math.round(avg(rows.map((r) => r.elapsedMs)))} ms`);
  console.log(`Tokens/receipt: ${Math.round(avg(rows.map((r) => r.promptTokens)))} in · ${Math.round(avg(rows.map((r) => r.completionTokens)))} out`);
  console.log(`Upload size avg (images): ${Math.round(avg(rows.filter((r) => r.kind === "image").map((r) => r.uploadBytes)) / 1024)} KB`);
  if (neuronRows.length === rows.length) {
    const perReceipt = avg(neuronRows.map((r) => r.neurons!));
    console.log(`Neurons/receipt (estimated from usage): ${perReceipt.toFixed(1)} · total this run ${neuronRows.reduce((a, r) => a + r.neurons!, 0).toFixed(1)} · ~${Math.floor(10_000 / perReceipt)} receipts/day on the free cap`);
  } else {
    console.log("Neurons: the model returned no token usage for some calls. Read today's Workers AI neuron count in the dashboard before and after the run.");
  }

  const outDir = path.join(import.meta.dirname, "results");
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(out, JSON.stringify({ args, rows }, null, 2));
  console.log(`\nFull results: ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
