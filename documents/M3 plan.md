# M3 plan — Pipeline

Nov 11, 2026. Scope from the spec's milestones: queue consumer, validation, ledger writes (including `txn_time`), `ai_usage` rows for every AI call, retries/DLQ, invalid-output and AI-quota parking (`scheduled` cron), status polling. Sources: spec "Data model", "Key flows" 2–3, "Extraction agent", "API", "Limits, cost & failure handling", and the Nov 10 revisions in AGENTS.md.

**Done when:** on `localhost:8787` an uploaded JPEG/PNG reaches `done` or `needs_review` without a page reload. It gets a `ledger_entries` row (`source='ai'`, minor units, `txn_time`) and one `ai_usage` row per AI call. A text PDF goes through `toMarkdown` and gets the same result. A scanned PDF ends `failed` with `unsupported_scanned_pdf`. A receipt parked with `retry_after` in the past is re-sent when the cron is triggered. Invalid output, quota, Drive errors and retries are covered by tests (they can't be produced on demand locally).

## Starting point

- `extractReceipt` (M1) already does one extract call plus at most one repair call, post-validation and minor-unit drafts, and returns `AiCallRecord`s shaped like `ai_usage`. It does **not** return partial fields on `invalid_output`.
- The schema (migration `0000`) already has `ledger_entries`, `ai_usage` and `receipts.retry_after`. Drizzle tables exist; there are no query helpers for them yet.
- `POST /api/receipts` ends in `queued` and doesn't send anything. `queue` is a stub that retries every message.
- Drive client: `createFolder` and `uploadMultipart` only. Download is missing.
- Infra: queue, DLQ and consumer (`batchSize: 1`, `maxRetries: 3`) already exist in Pulumi and `wrangler.jsonc`. There is no cron trigger and nothing consumes the DLQ.
- SPA: receipts list, no polling.

## Decisions (confirmed Nov 11, 2026: all proposals accepted)

1. **Who sets `failed` after the last retry.** The spec says "after 3 attempts the message goes to the DLQ and status becomes `failed`", but nothing consumes the DLQ. **Proposal:** on the last delivery (`msg.attempts > 3`, i.e. after 3 retries spaced 30 s / 2 min / 10 min, matching `max_retries: 3`), the consumer sets `failed` with the last error code and acks. The DLQ then only receives messages whose Worker crashed (CPU limit, unhandled error). Those leave the receipt in `processing`, so the daily cron also marks `processing` rows older than 1 h as `failed` (`processing_timeout`). No DLQ consumer. (Alternative: a second consumer on the DLQ that sets `failed`. That adds a Pulumi resource and queue ops for the same result.)
2. **Persisting review reasons.** Post-validation returns reasons (`total_mismatch`, `repaired`, …) that M4's review UI needs, and `repaired` can't be recomputed later. **Proposal:** additive migration `0002` with a nullable `receipts.review_reasons TEXT` (JSON array), filled for `needs_review`. Spec "Data model" updated. (Alternative: fold the reasons into `raw_extraction` as `{ extraction, reasons }`. That changes the documented shape of that column.)
3. **`POST /api/receipts/:id/retry` in M3.** The spec's API table has it, but the milestone list doesn't name it. Without it a `failed` receipt can't be recovered: re-uploading gets `409 duplicate_receipt` once the Drive file exists. **Proposal:** include it. It applies to `failed` receipts with a `drive_file_id`, not `unsupported_scanned_pdf`, and is 404 for other users' receipts. It sets `queued`, sends to the queue and returns `202`. A retry button goes in the SPA.
4. **Queue send fails after the Drive upload** (e.g. the Queues daily ops limit). The spec doesn't cover this. The file is already in Drive, so the user can't re-upload. **Proposal:** park the receipt the same way as for the AI quota (`queued` + `retry_after` = next 00:05 UTC) and still return `202`. The cron sends it again.
5. **Optional quota guard** (spec: skip the AI call when today's `SUM(neurons_est)` is above ~9,500). **Proposal:** leave it out of M3. A quota error (4006) already parks the receipt, and the estimate isn't authoritative. Revisit once `ai_usage` holds real numbers.

## Design notes (decided unless you object)

**Consumer (`src/pipeline/`, new)**
- `processReceipt(deps, message)` takes injected `AiClient`, `fetch`, D1 and clock. It returns an outcome (`ack` or `retry(delaySeconds)`), and the `queue` handler just applies it. Tests call it directly and also go through `worker.queue()`.
- **Claim:** a conditional `UPDATE … SET status='processing', attempts=attempts+1 WHERE id=? AND user_id=? AND status IN ('queued','processing') AND retry_after IS NULL`. If nothing matches (already `done`/`needs_review`/`failed`, wrong user or still parked), the message is acked without doing anything. Queues deliver at least once, so this, plus `ledger_entries.receipt_id UNIQUE` with `onConflictDoNothing`, makes redelivery harmless. `processing` is accepted so a delivery after a crash can resume.
- The user comes from the receipt row, not the message alone. Both must match.
- **Inputs:** Drive `files.get?alt=media` (a new `downloadFile` in `drive/client.ts`, GET only, so `drive-no-delete.test.ts` keeps passing). The category slugs are the user's own categories plus the system ones. The default currency is `users.default_currency`, locale `en-SG`, `today` in UTC.
- **Category id:** the slug resolves to the user's own category first, then the system one (`sys_<slug>`).
- **Writes:** one `db.batch()` per outcome holds the `ai_usage` rows (`attempt = receipts.attempts`), the receipt status/error/`raw_extraction`/`review_reasons` update and, when valid, the `ledger_entries` insert. `raw_extraction` is the parsed `Extraction` JSON as the spec says, never the raw model replies (`ExtractResult.replies` stays eval-only and is never stored).

| Result | Receipt | Ledger | Message |
| --- | --- | --- | --- |
| valid, no reasons | `done` | insert `source='ai'` | ack |
| valid, reasons | `needs_review` + `review_reasons` | insert `source='ai'` | ack |
| `invalid_output` (after repair) | `needs_review`, `error='invalid_output'`, `raw_extraction` = fields that parsed | none | ack |
| `quota_exceeded` | `queued`, `retry_after` = next 00:05 UTC, `error='ai_quota'` | none | ack |
| `unsupported_scanned_pdf`, `pdf_conversion_failed` | `failed` + code | none | ack |
| Drive 401 / `invalid_grant` | `failed`, `drive_disconnected` (user disconnected as in M2) | none | ack |
| Drive 404 on the file | `failed`, `drive_file_missing` | none | ack |
| `ai_error`, Drive 429/5xx, other | `queued`, `error=<code>` (UI shows "retrying") | none | `retry` 30 s → 2 min → 10 min; last delivery → `failed` (decision 1) |

- **Partial fields on invalid output:** when Zod fails, `parseExtraction` also returns `partial`, which holds each normalised key that passes its own field schema (`Extraction.shape[key]`). `extractReceipt` passes it through on `invalid_output`. Stored unvalidated, for M4's pre-filled form only.
- **CPU:** the consumer base64-encodes the image for the data-URL call (native `Buffer`, ~1 MB). Local dev doesn't enforce the 10 ms limit, so check consumer CPU time in staging observability after the first deploy. If it's too high, the fallback is a stronger resize in the browser.

**Enqueue (`POST /api/receipts`)**
- After the Drive upload: `queued` → `RECEIPT_QUEUE.send({ receiptId, userId })` → `202`. A send failure parks the receipt (decision 4). `ReceiptMessage` moves from `index.ts` to `src/pipeline/` with a Zod schema, and the consumer acks and logs malformed messages.

**Cron (`scheduled`, `5 0 * * *`)**
- Selects `queued` rows with `retry_after <= now` (all users; this is a system job, not a request path). It sends them with `sendBatch` (≤ 100 per call) and clears `retry_after` only for rows whose send succeeded. Then the `processing_timeout` sweep (decision 1).
- `triggers.crons` goes in `wrangler.jsonc`, and the cron trigger resource goes in `infrastructure/services/index.ts` (check the resource name in the installed `@pulumi/cloudflare` version). Then `pnpm --filter worker types`.
- Local: the `dev` script gets `--test-scheduled`, so `curl "http://localhost:8787/__scheduled?cron=5+0+*+*+*"` fires it.

**API changes:** `ReceiptDto` gains `retryAfter` and `reviewReasons`. New `POST /api/receipts/:id/retry` (decision 3), behind the Origin check, scoped by session `user_id`.

**Web:** TanStack Query `refetchInterval: 3000` while any receipt is `queued`/`processing`, stopping when none are. Each status gets a label. Parked receipts show "waiting for tomorrow's AI quota (after 08:00 SGT)". `failed` shows its error code as plain text and a Retry button. Merchant and total stay out of the list until M4's ledger API.

**Logging:** receipt ids, statuses, error codes, attempt numbers only.

## Tasks (in order, each ends green on typecheck + tests)

1. **DB.** Migration `0002` (`review_reasons`), Drizzle schema, helpers: resolve category by slug, insert `ai_usage` rows, insert ledger entry, claim receipt. Apply locally.
2. **Agent.** `partial` on parse failure, passed through `extractReceipt` on `invalid_output`. Unit tests. Then re-run `pnpm --filter worker eval` (spends ~430 neurons; needs the dev server and Cloudflare auth).
3. **Drive download.** `downloadFile` (GET `alt=media`), 401/404/429 handling via `withDrive`. Tests with fake fetch; `drive-no-delete` still green.
4. **Consumer.** `src/pipeline/process.ts` + `queue` handler. One test per row of the outcome table, plus redelivery after `done` (no second ledger row), wrong `userId` (ignored), last-attempt `failed`, `ai_usage` rows present on every path, minor units and `txn_time` in the ledger row.
5. **Enqueue + retry route.** Send on upload, park on send failure, `POST /api/receipts/:id/retry`. Tests (fake queue binding).
6. **Cron.** `scheduled` handler: re-send parked rows, sweep `processing` > 1 h. `wrangler.jsonc` trigger, Pulumi cron resource, `types`, `--test-scheduled`. Tests; `pnpm --filter "./infrastructure/*" typecheck`; `pulumi preview -s staging` if you're logged in.
7. **Web.** Polling, status labels, parked message, Retry button. `pnpm --filter web build`.
8. **Manual check (you).** `pnpm --filter worker dev`, upload a photo, a text PDF and a scanned PDF in Chrome, watch the statuses change, then inspect `ledger_entries` / `ai_usage` with `wrangler d1 execute expense-local --local`. Set `retry_after` on a `queued` row to the past and fire `/__scheduled`.
9. **Docs.** AGENTS.md status + layout (`src/pipeline/`), spec revisions for decisions 1–4 and remove the M3 items from "Spec revisions not yet in code", README notes for the local cron.

After merge (staging deploy via CI): make sure migration `0002` reaches staging before the new code runs (by the deploy workflow if it applies migrations, otherwise by you: `--remote` D1 is denied to agents), and check consumer CPU time in Workers observability.

Not in M3: ledger/categories API and UI, review form and saving (M4); resumable upload, limits banners (M5); quota guard (decision 5).
