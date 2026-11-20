# M1 extraction eval

Measures how well the extraction model (`VISION_MODEL` in `src/agent/extract.ts`, currently `@cf/google/gemma-4-26b-a4b-it`) extracts your receipts. Compare another model with `--model <id>`; it must have a price in `MODEL_RATES` (`src/agent/usage.ts`). **Target: at least 90% on total and date.**

Each receipt goes through the real agent (`src/agent/`) via the local Worker's `/api/dev/extract` route, so the prompt, Zod schema, repair call and post-validation are exactly what production will run.

## 1. Workers AI access (once)

`wrangler dev` always calls the real Workers AI, so it needs Cloudflare auth in the terminal you start it from. Use the separate **dev token** (`expense-tracker-dev`, see [Cloudflare tokens](../../README.md#cloudflare-tokens)), never the provisioning token:

```bash
export CLOUDFLARE_API_TOKEN=<dev token>
```

Or keep it in `worker/.env`, which Wrangler reads automatically and git ignores: `cp worker/.env.sample worker/.env`, then fill in `CLOUDFLARE_API_TOKEN`. The template also turns off Wrangler's habit of passing `.env` values to the Worker as bindings.

Eval calls count against the free 10,000 neurons/day, which resets at 08:00 SGT.

## 2. Accept the Llama license (only for `--model @cf/meta/llama-3.2-11b-vision-instruct`)

```bash
pnpm --filter worker dev
```

In a second terminal:

```bash
curl -X POST http://localhost:8787/api/dev/agree
```

## 3. Build the test set

Put receipts in `worker/eval/receipts/`. This folder is git-ignored, so personal receipts never get committed.

- Aim for about 50: a mix of photos and PDFs, with a few crumpled, faded or long ones.
- Use `.jpg`, `.png` or `.pdf`. Convert iPhone HEIC photos first: `sips -s format jpeg IMG_0001.HEIC --out IMG_0001.jpg`
- Photos are resized like the browser will do it (max 2000 px long edge, JPEG 80%) before upload.
- Next to each receipt, add a label with the same base name, e.g. `fairprice-2026-10-03.jpg` and `fairprice-2026-10-03.json`:

```json
{
  "merchant": "FairPrice Xtra",
  "txn_date": "2026-10-03",
  "txn_time": "14:52",
  "currency": "SGD",
  "total": 45.20,
  "tax": 3.73,
  "category_slug": "groceries",
  "notes": "faded thermal paper"
}
```

Use `"tax": null` when the receipt shows no tax amount. `txn_time` is the printed transaction time as 24-hour `"HH:MM"` (6:19 PM → `"18:19"`), or `null` when none is printed; leave the key out to skip scoring time for that receipt. `category_slug` is one of: food-dining, groceries, transport, travel, utilities, housing, shopping, health, entertainment, education, subscriptions, business, other.

## 4. Run

With `pnpm --filter worker dev` running:

```bash
pnpm --filter worker eval
```

Useful options: `-- --only fairprice`, `-- --limit 5`, `-- --image-mode bytes` (sends the image as a byte array instead of a base64 data URL, to compare).

The report shows per-field accuracy (time is reported but has no target), PASS/FAIL against the 90% target on total and date, how often `done` vs `needs_review` entries are right (to tune the 0.7 confidence threshold), LLM calls and repair rate, tokens and estimated neurons per receipt (with how many receipts a day the free cap allows), and latency. Full results, including one usage record per AI call shaped like the spec's `ai_usage` rows, go to `worker/eval/results/` (git-ignored).

**Neurons:** if the model returns no token usage, the report says so. Then read today's Workers AI neuron count in the Cloudflare dashboard before and after a run and divide by the number of receipts.

## What to record

Put the summary (accuracy per field, neurons per receipt, notable failure types) in `documents/` once the run is representative. If total or date is below 90%, the spec's fallback is an external vision model via AI Gateway for `needs_review` cases only.
