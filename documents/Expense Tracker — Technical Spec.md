# Expense Tracker — Technical Spec

Nov 9, 2026 · @Celine Low

**Revisions**

- Nov 11, 2026 (M3): the consumer itself sets `failed` on the last delivery (no DLQ consumer; the DLQ only catches crashed Workers, and the daily cron fails receipts left in `processing` for over an hour); post-validation reasons are stored in `receipts.review_reasons`; `POST /api/receipts/:id/retry` ships in M3; a failed queue send at upload parks the receipt for the cron; the cron also re-sends receipts queued longer than the queue's 24 h retention; a receipt whose Drive file was deleted can be uploaded again.
- Nov 10, 2026 (M2): OAuth uses `oauth4webapi` instead of `arctic`, which npm marks as no longer supported; logout deletes all of the user's sessions; the resumable upload for files over 5 MB is deferred to M5 (until then `413 file_too_large`); the app never deletes, trashes or overwrites Drive files, so deleting a ledger entry keeps its file (was: optional `files.delete`).
- Nov 10, 2026: capture the transaction time when the receipt prints one (`txn_time`); record Workers AI usage (tokens, estimated neurons) per model call in a new `ai_usage` table; extraction prompt and post-validation updated from the first M1 runs.

## Overview & scope

A web app where users sign in with Google, upload a receipt (image or PDF), and an AI agent extracts the details, classifies the expense and records it in a per-category ledger. The whole stack runs on the Cloudflare Workers Free plan, and receipt files are stored in each user's own Google Drive.

**In scope (v1)**

- Google sign-in (OpenID Connect) with `drive.file` consent
- Upload JPG, PNG, HEIC (converted in the browser) or PDF receipts, up to 10 MB
- Extraction of merchant, date, time (when printed), total, tax, currency and line items, plus a category
- Ledger view grouped by category and month, with manual edit and re-categorise
- Workers AI usage (tokens and estimated neurons) recorded per model call, for cost tracking and the upgrade trigger
- Original file saved to `Expense Receipts/` in the user's Drive, linked from each record

**Out of scope (v1)**

- Writing to Google Sheets
- Multi-currency conversion, budgets, reports, exports
- Native mobile apps (the web app should still work on mobile)

**Constraints**

- Target hosting cost of $0/month; $5/month Workers Paid is the first step up
- No servers or containers: Workers, D1, Queues and Workers AI only
- Google OAuth limited to non-sensitive scopes, so no security assessment is needed. Personal use: two users, enforced by an email allow-list

## Architecture

A single Worker has three handlers. `fetch` serves the SPA and API; `queue` runs extraction; `scheduled` (a daily Cron Trigger at 00:05 UTC) re-enqueues receipts parked by the AI quota. D1 holds all structured data, Workers AI does the reading, and Google provides sign-in and file storage.

&#91;embedded content: architecture · Cloudflare Workers + Google\]

The upload request only saves the file to Drive and enqueues it. The queue handler fetches the file back from Drive, calls Workers AI, then writes the ledger entry to D1. No R2, KV or Durable Objects are used.

## Tech stack

The stack is a static SPA with a Hono API on a single Worker. It avoids server rendering so each request stays within the free plan's 10 ms CPU limit.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Vite + React + TypeScript, TanStack Query, Tailwind | Served as static assets, which are free and unlimited |
| API | Hono on Cloudflare Workers | Small, typed router built for Workers |
| Auth | `oauth4webapi` (Google OAuth/OIDC, PKCE) + own session table | Small, dependency-free, Web Crypto only; full control over refresh tokens |
| Database | Cloudflare D1 + Drizzle ORM | SQLite with typed queries; migrations via Wrangler |
| Async jobs | Cloudflare Queues (producer + consumer in the same Worker) | Decouples slow AI calls from the upload request |
| AI | Workers AI: `@cf/meta/llama-3.2-11b-vision-instruct` for images; `env.AI.toMarkdown()` + a text LLM for PDFs | Free 10,000 neurons/day; no external API key |
| File storage | Google Drive API v3, `drive.file` scope | Uses the user's own quota; costs $0 |
| Validation | Zod (request bodies + LLM output schema) | One schema for both API and agent output |
| Tooling | Wrangler, pnpm, Vitest + `@cloudflare/vitest-plugin` (formerly `vitest-pool-workers`), GitHub Actions | Local emulation of D1/Queues; CI deploys |
| Infrastructure | Pulumi (TypeScript, Pulumi Cloud state) + `@pulumi/cloudflare` | Typed, reviewable infra; long-lived resources split from per-release deploys |

## Data model (D1)

D1 is the source of truth for the ledger. Drive only holds the original files, so a file deleted in Drive never loses ledger data. Amounts are stored as integer minor units (cents), dates as ISO-8601 text, and the transaction time as local wall-clock `HH:MM` exactly as printed (receipts carry no time zone, so it is never converted).

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,          -- uuid
  google_sub      TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL,
  name            TEXT,
  default_currency TEXT NOT NULL DEFAULT 'SGD',
  drive_folder_id TEXT,                      -- 'Expense Receipts' folder
  refresh_token_enc TEXT,                    -- AES-GCM ciphertext, base64
  drive_status    TEXT NOT NULL DEFAULT 'connected', -- connected | disconnected
  created_at      TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,              -- sha256 of cookie token
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  user_id   TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL = system default
  slug      TEXT NOT NULL,
  name      TEXT NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE TABLE receipts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drive_file_id  TEXT,
  drive_link     TEXT,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,              -- duplicate detection
  status         TEXT NOT NULL,              -- uploading | queued | processing | done | needs_review | failed
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  raw_extraction TEXT,                       -- parsed Extraction JSON (after normalisation, before user edits): audit + accuracy;
                                             -- after a failed repair, the fields that did parse (unvalidated), to pre-fill review
  retry_after    TEXT,                       -- ISO-8601 UTC; set when parked for the AI quota (status queued), cleared on re-enqueue
  review_reasons TEXT,                       -- JSON array of post-validation reasons (e.g. ["total_mismatch","repaired"]); set with needs_review
  created_at     TEXT NOT NULL,
  UNIQUE (user_id, sha256)
);
CREATE INDEX idx_receipts_user_status ON receipts(user_id, status);

CREATE TABLE ledger_entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id    TEXT UNIQUE REFERENCES receipts(id) ON DELETE SET NULL,
  category_id   TEXT NOT NULL REFERENCES categories(id),
  merchant      TEXT NOT NULL,
  txn_date      TEXT NOT NULL,               -- YYYY-MM-DD
  txn_time      TEXT,                        -- HH:MM, 24-hour local time as printed; NULL if not printed
  currency      TEXT NOT NULL,               -- ISO 4217
  total_minor   INTEGER NOT NULL,
  tax_minor     INTEGER,
  payment_method TEXT,
  line_items    TEXT,                        -- JSON array
  confidence    REAL,                        -- 0..1 from the agent
  source        TEXT NOT NULL,               -- ai | manual | ai_edited
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  reviewed_at   TEXT                         -- explicit human confirmation; NULL until reviewed
);
CREATE INDEX idx_ledger_user_cat_date ON ledger_entries(user_id, category_id, txn_date);
CREATE INDEX idx_ledger_user_date ON ledger_entries(user_id, txn_date, txn_time);

-- One row per Workers AI call (extraction, repair, PDF conversion), including failed calls.
-- Holds counts only, never receipt content. Neurons are an estimate; Cloudflare's dashboard is authoritative.
CREATE TABLE ai_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id        TEXT REFERENCES receipts(id) ON DELETE SET NULL, -- usage history outlives the receipt
  attempt           INTEGER NOT NULL,          -- receipts.attempts when the call was made
  kind              TEXT NOT NULL,             -- extract | repair | to_markdown
  model             TEXT NOT NULL,             -- e.g. @cf/meta/llama-3.2-11b-vision-instruct, toMarkdown
  input_mode        TEXT,                      -- image | pdf_text
  prompt_tokens     INTEGER,                   -- NULL when the model returns no usage block
  completion_tokens INTEGER,
  neurons_est       REAL,                      -- tokens x per-model rate at call time; NULL if tokens unknown
  latency_ms        INTEGER NOT NULL,
  outcome           TEXT NOT NULL,             -- ok | invalid_output | ai_error | quota_exceeded
  error_code        TEXT,                      -- Workers AI code (e.g. 4006) or our code; never message text
  created_at        TEXT NOT NULL              -- ISO-8601 UTC
);
CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);
CREATE INDEX idx_ai_usage_user_created ON ai_usage(user_id, created_at);
CREATE INDEX idx_ai_usage_receipt ON ai_usage(receipt_id);
```

**Why one row per call:** a receipt can take an extraction call, a repair call, a PDF conversion, and further calls on queue retries. Per-call rows give per-receipt cost (`SUM … GROUP BY receipt_id`), daily neurons against the free cap (`SUM(neurons_est) … GROUP BY substr(created_at, 1, 10)`, UTC days match the quota reset), and repair and failure rates, without double counting. Tokens are stored alongside the estimate so neurons can be recomputed if Cloudflare changes its rates.

Default categories seeded by migration: Food & Dining, Groceries, Transport, Travel, Utilities, Housing, Shopping, Health, Entertainment, Education, Subscriptions, Business, Other. Users can add their own; the agent is given the user's full category list.

## Key flows

Uploads return as soon as the file is saved to Drive and queued. Extraction then runs in the queue consumer, and the UI polls for status.

**1. Sign in with Google**

1. `GET /auth/google` creates `state` and a PKCE `code_verifier`, stores both in a short-lived signed cookie, and redirects to Google with scopes `openid email profile https://www.googleapis.com/auth/drive.file`, `access_type=offline` and `prompt=consent`. `prompt=consent` only needs to be sent on first login or when no refresh token is stored.
2. `GET /auth/google/callback` verifies `state`, exchanges the code, and validates the ID token (`iss`, `aud`, `exp`, `email_verified`).
3. Upsert `users` by `google_sub`. Encrypt the refresh token with AES-GCM using `TOKEN_ENC_KEY` and store it.
4. If `drive_folder_id` is empty, create the `Expense Receipts` folder in Drive and save its id.
5. Create a session: a random 32-byte token goes in an `HttpOnly; Secure; SameSite=Lax` cookie named `__Host-session` (Path=/, no Domain), its SHA-256 is stored in `sessions`, and it expires after 30 days with sliding renewal.

**2. Upload a receipt**

1. The browser checks type and size. It converts HEIC to JPEG and resizes images to a maximum 2000 px long edge at about 80% JPEG quality, which keeps most images under 1 MB.
2. `POST /api/receipts` (multipart) computes the SHA-256. A duplicate returns `409` with the existing receipt id.
3. Insert `receipts` with status `uploading`.
4. Get an access token from the refresh token (cached in memory per isolate until expiry), then upload to Drive with `uploadType=multipart` and `parents=[drive_folder_id]`. Files are named `YYYY-MM-DD_<receiptId>.<ext>`.
5. Save `drive_file_id` and `webViewLink`, set status to `queued`, and send `{ receiptId, userId }` to `RECEIPT_QUEUE`. Return `202` with the receipt.
6. Files over 5 MB: the Worker creates a Drive resumable session and returns its URL, the browser uploads directly, then calls `POST /api/receipts/:id/complete`.

**3. Extract and classify (queue consumer)**

1. Set status to `processing` and increment `attempts`.
2. Download the file from Drive with `files.get?alt=media`.
3. PDF: run `env.AI.toMarkdown()` to get text, then a text LLM call with the extraction prompt. If the text is empty (a scanned PDF), fail with `unsupported_scanned_pdf` in v1.
4. Image: one vision LLM call with the extraction prompt.
5. Validate with Zod. If invalid, retry once with a repair prompt that includes the validation errors.
6. Valid: insert `ledger_entries` (`source='ai'`). Status is `done` when post-validation finds no review reason, otherwise `needs_review` (see "Post-validation rules").
7. Still invalid after the repair call: insert **no** ledger entry. Store the fields that did parse in `receipts.raw_extraction`, set status `needs_review` and `error='invalid_output'`, and ack the message. The review form is pre-filled from those fields (in the M1 eval, only the date was unreadable), and the entry is created with `source='ai_edited'` when the user saves.
8. Workers AI quota exhausted: park the receipt and ack the message; it does not use a queue retry (see "When a limit is hit").
9. Any other error (Drive 429/5xx, other Workers AI errors): status back to `queued` with the error code, and `msg.retry({ delaySeconds })` with backoff of 30 s, 2 min, 10 min. On the last delivery (after 3 retries, `max_retries: 3`) the consumer sets `failed` and acks. Errors a retry can't fix fail at once: `unsupported_scanned_pdf`, `pdf_conversion_failed`, `drive_file_missing` (the user deleted the file; uploading it again reuses the row), `file_too_large` (the Drive file was replaced with one over the 10 MB limit; the consumer never buffers more), `drive_disconnected`. The DLQ only receives messages whose Worker crashed; the daily cron marks receipts still `processing` an hour after upload as `failed` (`processing_timeout`).
10. Every Workers AI call in steps 3–5 writes one `ai_usage` row, whatever the outcome (including quota and invalid-output failures). Rows are written in the same D1 `batch()` as the receipt's status update, so usage is never lost when a later step fails.

**4. Review and ledger**

1. The ledger page calls `GET /api/ledger?from&to&category`, grouped by category with monthly totals computed in SQL and grouped by currency (GROUP BY category\_id, month, currency); amounts in different currencies are never summed together.
2. Entries in `needs_review` are highlighted at the top. The user edits fields or changes the category, and the entry's `source` becomes `ai_edited`. Receipts in `needs_review` with no entry yet (invalid output) show the pre-filled form; saving creates the entry.
3. Deleting an entry removes it from D1 only. The Drive file stays: the app never deletes, trashes or overwrites Drive files (see "Security & privacy"), and the user can remove it in Drive themselves.

## Extraction agent

The agent is a single structured-output call per receipt, plus at most one repair call; it uses no tools and no conversation loop. One model serves both paths, so the prompt and schema are shared and tested once.

| Input | Pre-processing | Model call |
| --- | --- | --- |
| Image (JPG/PNG) | Resized in the browser | `@cf/meta/llama-3.2-11b-vision-instruct` with the image + prompt |
| PDF (text) | `env.AI.toMarkdown()` | Same model, text-only, with the markdown + prompt |
| PDF (scanned) | Empty markdown | v1: fail with a clear message; v2: render page 1 to an image client-side |

**System prompt (strict, short)**

The first M1 runs showed the model replying in prose, leaving dates as `09/11/2026` and using unit prices for line items. The rules below fix those. A 10-receipt round then showed the model copying example dates into answers and reordering day/month wrongly even when told to prefer DD/MM (09/11/2026 -> 2026-09-11), so it now copies the date exactly as printed and code converts it (see normalisation). The same round added the tax rules (GST-inclusive is still tax; surcharges are not; nothing printed -> null) and the "after discounts and vouchers" total rule. `total_text` asks the model to copy the line it read the total from, so code can check the total (see post-validation); the JSON shape of the schema is appended after them, and the user message repeats "Reply with only the JSON object, starting with `{`".

```text
You extract data from a single purchase receipt. Output ONLY one JSON object matching the schema. No prose, no markdown, no code fences. The first character of your reply must be "{" and the last must be "}".
Rules:
- Use values printed on the receipt. Never guess. Unknown -> null.
- total = final amount paid incl. tax and tips, after discounts and vouchers.
- total_text = the line you read total from, copied exactly as printed: its label and amount. Not printed -> null.
- tax = the tax amount printed (also when prices are tax-inclusive, e.g. "Inclusive of 9% GST ($0.37)" -> 0.37). Fees, surcharges, service charges and discounts are not tax. No tax amount printed -> null, not 0. Ignore struck-through prices.
- date: the one transaction date copied exactly as printed, with the year. Keep the printed order and separators; do not reorder or reformat it. If several dates are printed, use the payment, transaction, order, invoice or issue date. Never a travel, check-in/check-out, booking period, return, expiry, validity or print date, and never a date range.
- time: HH:MM, 24-hour, the transaction time printed on the receipt (6:19 PM -> "18:19", 01:14 pm -> "13:14", 9:05 AM -> "09:05"). Not printed -> null. Never use a print, opening-hours or validity time.
- currency: ISO 4217. If no symbol/code, use {{default_currency}}.
- line_items: one per line; amount = the line total actually charged (after quantity and discounts), not the unit price.
- category_slug: exactly one of: {{category_slugs}}. Pick the closest fit; "other" only if none fits.
- confidence: 0..1, your certainty that merchant, date and total are all correct.
```

The repair prompt lists one plain-language fix per failing field (e.g. `txn_date must be the one payment or transaction date copied exactly as printed, including day, month and year; not a travel date or a date range.`) rather than raw Zod messages, which the model ignored.

**Output schema (Zod)**

```ts
const Extraction = z.object({
  merchant: z.string().min(1).max(120),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  txn_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), // HH:MM 24-hour, local
  currency: z.string().length(3),
  total: z.number().nonnegative(),
  total_text: z.string().max(200).nullable(), // line the total was read from, as printed; checked in code
  tax: z.number().nonnegative().nullable(),
  payment_method: z.enum(["cash", "card", "ewallet", "bank_transfer", "other"]).nullable(),
  line_items: z.array(z.object({ description: z.string(), amount: z.number() })).max(50),
  category_slug: z.string(),
  confidence: z.number().min(0).max(1),
});
```

**Normalisation before Zod (code, mechanical only)**

- Omitted nullable keys (`tax`, `txn_time`, `payment_method`) become `null`; omitted `line_items` becomes `[]`.
- Numeric strings become numbers; currency is upper-cased.
- `total_text` is trimmed and capped at 200 characters; empty or missing becomes `null`. It is a check field, so it never fails an extraction.
- `payment_method` is mapped to the enum by keyword ("Apple Pay" -> `ewallet`, "VISA" / "NETS" -> `card`, "PayNow" -> `bank_transfer`); any other string becomes `other`, because payment method must never fail an otherwise good extraction.
- `txn_date` arrives as printed and becomes `YYYY-MM-DD` in code. All-number dates (`DD/MM/YYYY`, `-`, `.`, two-digit years as 20YY) are day-first unless the second number can only be a day (e.g. `11/25/2026`), or year-first when they start with four digits; the first separated date in the string wins, so trailing POS codes are ignored. Month names set the month (`Sep-03-2026`, `October 27, 2026`, `12 Oct 26`). Compact stamps are `DDMMYY`, `YYYYMMDD` or `DDMMYYYY`. Weekdays and times are dropped. Anything else fails the schema and goes to the repair call; the parse error quotes the copied date (max 32 chars) so eval runs show which format to support.
- Times: `6:19 PM` / `06:19pm` become `18:19`; `18:19:42` drops the seconds. A time that still doesn't parse becomes `null`, because time is optional and must never fail an otherwise good extraction.

**Post-validation rules (code, not LLM)**

- `category_slug` must be in the user's list; otherwise map it to `other` and set `needs_review`.
- `txn_date` no later than today + 1 day and no earlier than 10 years ago; otherwise `needs_review`.
- If line items exist and their sum differs by more than 2% from both `total - tax` and `total` (tax-inclusive receipts, common with Singapore GST): `needs_review`. A null `tax` counts as 0.
- `total_text` vs `total`: if the copied line contains money amounts and none equals `total`, `needs_review` (`total_mismatch`). Only amounts with decimals count, so receipt numbers and quantities are ignored, except for zero-decimal currencies (JPY). Amounts equal to `tax` or printed right after a GST/VAT/SST/tax label are ignored.
- `total_text` with no amount: accepted if it has a total word (total, paid, amount, charge, due, balance, payable, 合計…), because table layouts print label and amount apart; otherwise, or when `total_text` is `null`, `needs_review` (`total_unverified`): the model could not point to the total line.
- `total_text` labelled as a subtotal, "before discount/voucher/GST" or "excl.": `needs_review` (`total_is_subtotal`).
- The extraction needed the repair call: `needs_review` (`repaired`).
- `confidence < 0.7`: `needs_review`. In the M1 eval the model reported 1.0 for every receipt, including wrong ones, so in practice review comes from the code checks above, not from confidence.
- `txn_time` never forces review.
- Convert to minor units with the currency's exponent (JPY 0, SGD/USD 2) before insert.

**Usage accounting**

- Each call's `usage.prompt_tokens` / `usage.completion_tokens` (returned by the vision model) go to `ai_usage`.
- `neurons_est` = tokens × the model's per-token rate, kept as a constant per model in `src/agent/` and derived from Cloudflare's published prices at $0.011 per 1,000 neurons. For `@cf/meta/llama-3.2-11b-vision-instruct`: $0.0485/M input → ~0.00441 neurons/token, $0.676/M output → ~0.0615 neurons/token.
- `toMarkdown()` rows record the converter's estimated `tokens` with `neurons_est = 0` (free for PDFs per the docs; confirm against the dashboard in M1).

**Evaluation before launch**

The plan was a 50-receipt test set (local receipts, mixed images and PDFs, a few crumpled or faded) with hand-labelled JSON. Labels include `txn_time` (`null` when none is printed). Track per-field accuracy (including time), category accuracy, repair rate and neurons per receipt. Target at least 90% on total and date; time is reported but has no target. If the model misses the target, fall back to an external vision model via AI Gateway on `needs_review` cases only.

**Decision (Nov 10, 2026): provisional go on 10 receipts.** Only 10 local receipts were available. The eval passed (date 90%, total 90%, about 43 neurons per receipt; details in `documents/M1 eval results.md`), but at that size the result is weak evidence. So:

- The 10 labelled receipts are kept as a regression set; re-run the eval after every prompt, schema or normalisation change.
- Real accuracy comes from the users' own corrections once M3/M4 exist. `receipts.raw_extraction` keeps the parsed extraction, and `ledger_entries` holds the final values, so a per-field comparison (merchant, date, time, total, tax, currency, category) for entries with `source` `ai` or `ai_edited` gives the edit rate per field. Count only entries with non-null `reviewed_at`: a wrong value in an unreviewed `done` entry is not yet a correction.
- The AI Gateway fallback is decided from that edit rate, not from the 10-receipt eval.

First M1 measurement (one digital Kopitiam receipt, after the prompt fixes): 1 call, 6,831 input + 106 output tokens, ~37 neurons, 4.2 s, all fields correct. The image accounts for almost all input tokens.

## API

All `/api/*` routes need a valid session cookie and are scoped to the session's `user_id`. State-changing routes also check `Origin` against `APP_ORIGIN`.

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/auth/google` | Start OAuth | 302 to Google |
| GET | `/auth/google/callback` | Finish OAuth, create session | 302 to `/` |
| POST | `/auth/logout` | Delete all of the user's sessions | 204 |
| GET | `/api/me` | Profile, Drive status, default currency | 200 |
| POST | `/api/receipts` | Multipart upload (≤ 5 MB) | 202 receipt / 409 duplicate |
| POST | `/api/receipts/resumable` | Start Drive resumable upload (> 5 MB) | 200 `{ receiptId, uploadUrl }` |
| POST | `/api/receipts/:id/complete` | Confirm resumable upload, enqueue | 202 |
| GET | `/api/receipts?status=&cursor=&limit=` | Paginated receipt metadata (polling and review inbox) | 200 |
| GET | `/api/receipts/:id` | Owned receipt, entry ID and safe partial review draft | 200 |
| POST | `/api/receipts/:id/review` | Create a missing entry and complete invalid-output review | 201 / 409 |
| POST | `/api/receipts/:id/retry` | Re-enqueue a failed receipt that still has its Drive file | 202 / 409 `not_retryable` / 409 `reupload_required` |
| GET | `/api/ledger?from=&to=&category=` | Entries + totals by category/month | 200 |
| PATCH | `/api/ledger/:id` | Edit fields / category | 200 |
| DELETE | `/api/ledger/:id` | Delete entry (the Drive file is kept) | 204 |
| GET / POST | `/api/categories` | List / add categories | 200 / 201 |

The UI polls `GET /api/receipts?status=queued,processing` every 3 s while anything is pending, and stops when nothing is.

Ledger entries carry `txn_time` (`"HH:MM"` or `null`). `GET /api/ledger` orders entries by `txn_date` then `txn_time` (entries without a time last within their day), and `PATCH /api/ledger/:id` accepts `txn_time` (`"HH:MM"` or `null`) like any other field. AI usage has no API in v1; it is stored for later reporting and queried with `wrangler d1 execute` until then.

### M4.5 ledger deletion

`DELETE /api/ledger/:id` accepts a strict JSON object containing only `expected_updated_at`, the millisecond UTC ISO timestamp from the loaded entry. It uses the existing 32 KiB streamed-body limit, session and Origin checks, and standard JSON body errors. Success returns 204. Missing or inaccessible entries and associated receipts return 404 `not_found`, including a repeated delete. A stale version returns 409 `entry_changed`. Associated receipts in states other than `done` or `needs_review` return 409 `receipt_busy`. Entries without an associated receipt can be deleted.

A version-guarded D1 batch deletes only the owned ledger row. If the deletion succeeds and the associated receipt was awaiting review, the same batch sets the receipt to `done` and clears its active error and retry time. The receipt, hash, Drive link, extracted evidence, original review reasons and AI usage are retained. The delete path makes no Drive or AI calls. The retained terminal receipt prevents stale review submissions, delayed queue deliveries and duplicate uploads from recreating the entry. Existing duplicate detection still applies.

The editor asks for confirmation and explains that deletion is permanent and removes the expense from the ledger and totals while keeping the Drive file. On stale or uncertain results it preserves the draft and checks the current server state. Success refreshes ledger and receipt queries for the active account. The receipt list includes `hasLedgerEntry` derived from the owned ledger association. A completed receipt without an entry displays “No ledger entry” and has no review action.

### M4.4 custom categories

`POST /api/categories` accepts a strict JSON object with a single `name` field (1–60 UTF-16 code units after trimming, with no control characters). It uses the existing 32 KiB streamed-body limit, session and Origin checks, and standard body errors. Success returns `201 { category: { id, slug, name } }`. The server generates the ID and assigns ownership from the session.

The slug uses lowercase ASCII letters and digits with hyphen separators after Unicode decomposition and removal of combining marks. If that yields no slug, use `custom-` followed by the SHA-256 hex digest of the lowercased NFKC name. A matching slug or ASCII case-insensitive display name among visible categories returns `409 category_exists`. Check for conflicts in the insert statement so concurrent requests cannot create duplicates. Existing categories retain their stored names, slugs and resolution precedence.

The shared editor creates and selects the category without discarding expense edits. The expense assignment persists when the user saves the review. The category is private to its owner and becomes available to later extractions through the existing category lookup. Rename and deletion are outside this milestone.

### M4.3 review inbox (November 18, 2026)

Receipt listing adds `cursor`/`limit` and returns `{ receipts, nextCursor }`, preserving existing camelCase receipt fields and status-filter behavior. Default 50, maximum 100, strict positive integer limit. Sort by `created_at DESC, id DESC`, independently of transaction dates. Cursors carry upload timestamp, ID and normalized status filters; reject malformed/oversized/mismatched cursors with `400 invalid_filters`. Invalid statuses retain `400 invalid_status`. Select metadata only. The pending inbox uses `status=needs_review` and is independent of ledger filters; refresh discovers new receipts and saving resets pagination.

`GET /api/receipts/:id` returns `{ receipt, entryId, draft }`, scoped to the session user including the associated entry. `draft` is null except for `needs_review` / `invalid_output` receipts without an entry. For those receipts, return only independently validated partial human fields using ledger field names; raw extraction stays private. Malformed, non-object or over-64-KiB stored extraction yields an empty draft. Missing/invalid required values stay blank, with no default date, zero total, currency or category. Resolve category slugs against visible categories with existing custom-category precedence. Preserve optional nulls; monetary values require a supported extracted currency and exact safe minor-unit conversion without rounding. Omit unsafe/over-precision amounts and omit malformed line-item collections as a whole. Malformed stored review reasons yield absent warnings without changing stored evidence.

`POST /api/receipts/:id/review` accepts the complete strict human `LedgerFields` object with the same field limits as M4.2 and a 32 KiB streamed-body limit. Creation requires an owned receipt still in `needs_review` with `invalid_output` and no entry. Validate category ownership at write time. Conditional insertion and receipt completion share one atomic D1 batch, with completion gated on this insert. Retain the receipt uniqueness constraint. Success returns `201 { entry }` using the ledger detail DTO, with server-generated ID/timestamps, `source='ai_edited'`, non-null `reviewed_at` and null confidence. Clear receipt error/retry time and set `done`; preserve extraction/reasons/usage and Drive metadata. No new migration is required.

Unknown or foreign receipts/categories return `404 not_found`. An owned existing entry returns `409 review_already_saved` with `entryId`; never overwrite it. Other ineligible states return `409 not_reviewable`, including completed receipts whose entries are absent. Body errors use existing `invalid_json`, `invalid_body` (field paths only) and `body_too_large`. Writes require Origin and session checks. List/detail/save routes call neither Drive nor AI; the existing optional preview alone reads Drive.

Both review paths share the editor and receipt preview. Required draft fields stay blank until supplied; choosing/changing currency requires checking monetary values, never FX conversion. On duplicate, uncertain save or conflict, retain the draft and reload receipt state before explicit retry. If an entry now exists, load it for comparison and require explicit version-guarded PATCH for further edits. If no longer eligible, disable creation while retaining the draft. Saved state cancels stale reads, updates Recent receipts, removes pending items and refreshes all ledger totals/filters. Poll completion invalidates review/detail queries without changing the three-second interval or 15-minute cap. Account changes clear forms and caches; preview failures do not block edits.

### M4.2 existing-entry edits (November 17, 2026)

`PATCH /api/ledger/:id` accepts a strict JSON object (maximum 32 KiB), with required `expected_updated_at` matching the loaded entry. Editable fields are `merchant`, `txn_date`, `txn_time`, `currency`, `total_minor`, `tax_minor`, `category_id`, `payment_method`, `line_items` and `notes`. Omitted fields are preserved. An empty edit is invalid unless `confirm_review: true` explicitly confirms the entry unchanged. Success returns `{ entry }` using the detail DTO, now including nullable `reviewed_at`.

Human values use real calendar dates and local `HH:MM` times, supported ISO currencies (excluding `XXX`), safe integer minor units, nonnegative total/tax and signed line-item amounts. Optional values may be null. Merchant is trimmed and 1–120 characters; category IDs are 1–120 characters; line items are at most 50 with trimmed 1–200 character descriptions; notes are at most 2,000 trimmed characters. Payment methods match the extraction enum. Human confirmation does not rerun AI confidence, date-age or total-text heuristics. Currency changes require all monetary fields (`total_minor`, `tax_minor`, `line_items`) and `confirm_currency: true`; the browser asks the user to check their decimal values in the new currency, without FX conversion or reinterpreting stored minor units.

Writes require the session and valid Origin. Entries and associated receipts must belong to that user; categories must be system defaults or owned by that user. Missing/inaccessible resources return 404 `not_found`. Only unassociated entries or receipts in `done`/`needs_review` can be edited; other receipt states return 409 `receipt_busy`. Stale versions return 409 `entry_changed`. Invalid bodies return 400 `invalid_body` with field paths only; malformed JSON returns 400 `invalid_json`; oversized bodies return 413 `body_too_large`; currency changes lacking confirmation return 400 `currency_confirmation_required`.

A conditional D1 batch updates the entry and resolves its pending receipt atomically, clearing active error/retry time. Preserve raw extraction, original review reasons, confidence and usage evidence. Actual corrections turn source `ai` into `ai_edited`; unchanged confirmations keep `ai`, and other sources are preserved. Every successful save sets `reviewed_at` and advances `updated_at` strictly, including saves within the same millisecond. These timestamps are server-owned. Simply viewing an entry does not confirm it. Accuracy measurement uses explicitly reviewed entries only.

The editor retains unsaved values after failures and conflicts, reloads the latest server state for comparison, and requires an explicit decision before retrying against a new version. A lost response must not cause a blind resubmit. Successful saves refresh all ledger filters/totals and receipt queries. Closing a dirty editor asks before discarding changes; signing out or changing accounts clears it. The M4.3 contract above provides the complete review inbox and missing-entry creation.

**Review workspace (November 17 user feedback):** desktop review shows the original receipt beside the editor, with independent scrolling and a fixed save/cancel footer. Small screens switch between receipt and details while retaining the form. A successful PATCH updates the matching recent receipt from the server-confirmed status immediately, cancels pre-save reads, and then refreshes queries; retained original warnings never imply current pending status.

`GET /api/receipts/:id/file` is an authenticated, ownership-scoped read of the original Drive file for this workspace. The Worker streams Drive `files.get?alt=media` without buffering, parsing PDFs, or transforming images. Only stored JPEG/PNG/PDF MIME types are served, with private/no-store and nosniff headers. The browser holds a temporary object URL for display and revokes it on close/account change. Missing files return 404 `receipt_file_missing`; inaccessible receipts return 404 `not_found`; transient Drive failures return 503 `drive_unavailable`; revoked access uses the existing disconnect/session-expiry flow. Preview failure never blocks editing ledger data. This adds no storage, scope, or Drive write operations, and ordinary lists still do not call Drive.

### M4.1 read API contract (November 16, 2026)

`GET /api/categories` returns `{ categories: [{ id, slug, name }] }`, containing system defaults and the session user's custom categories, ordered by display name then ID. Existing slug collisions remain visible; extraction keeps its existing user-category precedence.

`GET /api/ledger` accepts inclusive `from`/`to` dates, optional `category` ID, `limit` (default 50, maximum 100), and an opaque `cursor`. Both dates must be supplied together; omitting both selects the current UTC month. Dates must be real `YYYY-MM-DD` dates, with a range spanning no more than 12 calendar months. The browser supplies its selected calendar range explicitly. Invalid filters/cursors return 400; an inaccessible category returns 404. Cursor positions are tied to the requested filters.

The response is `{ entries, totals, nextCursor }`. Entries use the documented snake_case ledger fields plus `category_name`, `receipt_status` and `drive_link`. List summaries omit line items, notes, raw extraction and confidence. Entries sort by descending date, descending time (unknown times last within the day), then descending ID. Totals cover the **whole filtered range**, grouped by category, month and currency, independently of pagination. Each total includes `entry_count` and `needs_review_count`; entries awaiting review are included but visibly provisional. A receipt without a ledger entry contributes nothing. Unsafe integer amounts/totals fail with `amount_out_of_range` instead of returning rounded numbers.

`GET /api/ledger/:id` returns `{ entry }` with the summary fields plus tax, payment method, normalized line items, notes, source, confidence, timestamps and original review reasons. Missing and other-user entries return 404. All joins enforce session ownership (or system-default category visibility); missing Drive files never prevent ledger reads. These routes make no Drive or AI calls.

**Totals display (November 17, 2026):** the browser combines the API's monthly totals across the selected range into one grand total per currency, with one subtotal per category within that currency. Category review counts are combined across months and remain visible. These sums use exact integer minor units, including when the combined sum exceeds JavaScript's safe-number boundary. Filters still apply to every total, independently of pagination; currencies are never combined or converted.

M4.1 provides browsing and details. M4.2 adds editing and confirmation of existing entries, and M4.3 adds the complete review inbox. M4.4 adds custom category creation, and M4.5 adds ledger entry deletion. Existing receipt upload, status and retry remain available.

## Security & privacy

The two highest-value secrets are the users' Google refresh tokens. They are encrypted at rest and never leave the Worker.

- **Scopes:** only `openid email profile drive.file`. `drive.file` is non-sensitive, so the app can only see files it created. Never request the full `drive` scope.
- **Drive is write-once:** the app only creates the folder and uploads new files. It never deletes, trashes or overwrites Drive files. No Google scope enforces this (`drive.file` allows deleting files the app created), so it is a code rule, checked by `worker/test/drive-no-delete.test.ts`. Drive keeps trashed files for 30 days, and D1 holds the ledger either way.
- **Refresh tokens:** AES-GCM with a random 12-byte IV per token. The key is a 32-byte `TOKEN_ENC_KEY` Worker secret, and the stored value is `v1:<iv>:<ciphertext>` so the key can be rotated later.
- **Access tokens:** cached in memory only for their lifetime, never written to D1 or logs.
- **Sessions:** opaque random token in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie (as is the OAuth state cookie, so no sibling subdomain can set or shadow them), stored only as its SHA-256 hash. Logout and `invalid_grant` delete all of the user's sessions.
- **Revocation:** Google returning `invalid_grant` or `401` sets `drive_status='disconnected'` and the UI asks the user to reconnect. Ledger data stays.
- **Isolation:** every query filters by `user_id` taken from the session, never from request input.
- **Uploads:** a MIME allow-list (`image/jpeg`, `image/png`, `application/pdf`) with magic-byte checks, a 10 MB limit, and file names generated by the server.
- **Prompt injection:** receipt text is treated as data. The model has no tools, its output goes only through Zod, and it can only choose from the user's existing categories.
- **Logging:** log receipt ids, statuses and error codes only. Never log OCR text, amounts or tokens.
- **AI usage rows:** `ai_usage` stores counts, model names, outcomes and error codes only, never prompts, replies or receipt content. It is scoped by `user_id` like everything else, and removed with the account.
- **Account deletion:** `DELETE /api/me` (v1.1) removes D1 rows and revokes the Google token; Drive files stay with the user.
- **Google verification:** publish the consent screen as In production. With only non-sensitive scopes no verification is required, and it avoids Testing mode's 7-day refresh-token expiry. Because the app is then open to any Google account, the callback rejects any email not in the ALLOWED\_EMAILS var (the two users).

## Limits, cost & failure handling

Expected cost is $0/month. Workers AI's 10,000 neurons/day is the cap that will bind first; the others have plenty of headroom. Free-plan limits fail rather than bill, so every path needs a recoverable `failed` state.

| Service | Free plan limit (resets 00:00 UTC = 08:00 SGT) | Per receipt (est.) | Headroom |
| --- | --- | --- | --- |
| Workers requests | 100,000/day; 10 ms CPU/request | \~15 (upload + polls + views) | \~6,000 receipts/day |
| Static assets | Free, unlimited | — | — |
| Workers AI | 10,000 neurons/day | \~37 neurons with one call; \~75 with a repair (1 receipt measured, confirm on 50) | \~130–270 receipts/day |
| Queues | 10,000 ops/day; 24 h retention | 3 ops (+1 per retry) | \~3,000 receipts/day |
| D1 | 5M rows read, 100k rows written/day; 5 GB | \~6–8 writes (incl. 1–3 `ai_usage` rows) | Not a constraint |
| Google Drive | Per-user API quotas; user's own storage | 2 calls | Not a constraint |

**Staying inside 10 ms CPU**

- Waiting on `fetch`, AI, D1 or Queue calls doesn't count toward CPU time; parsing, hashing large buffers and JSON work does.
- Resize images in the browser. Hash with `crypto.subtle.digest` (native), and stream request bodies rather than buffering them twice.
- Do no PDF parsing, image transforms or SSR in the Worker.

**When a limit is hit**

| Failure | Behaviour |
| --- | --- |
| Workers AI quota exhausted | Consumer catches the error, acks the message, and parks the receipt in D1: status `queued`, `retry_after` = next 00:05 UTC. The daily Cron Trigger (`5 0 * * *`, the `scheduled` handler) re-sends every parked receipt whose `retry_after` has passed to `RECEIPT_QUEUE` and clears `retry_after`. Queue retries are not used for this: on the Free plan, messages are kept for a fixed 24 h, delays max out at 24 h, and each retry counts toward `max_retries`. The UI shows "waiting for tomorrow's AI quota (after 08:00 SGT)". |
| Drive 401 / `invalid_grant` | `drive_status='disconnected'`, receipt `failed`, UI prompts to reconnect |
| Drive 429 / 5xx | Retry with backoff of 30 s, 2 min, 10 min, then `failed` (the consumer sets it on the last delivery) |
| Queue send fails at upload (e.g. Queues daily ops) | The file is already in Drive, so the receipt is parked like an AI-quota park (`error='queue_unavailable'`) and the upload still returns `202`; the cron sends it. The cron also re-sends any receipt `queued` for longer than the queue's 24 h retention. |
| Invalid LLM JSON twice | No ledger entry. Receipt `needs_review` with `error='invalid_output'`; the review form is pre-filled from the fields that did parse, and the entry is created when the user saves. `ledger_entries` keeps its `NOT NULL` columns. |
| Error 1027 (daily requests) | SPA shows a "service busy, try later" banner; uploads are not lost because the browser keeps the file until a 202 |

**Upgrade trigger:** move to Workers Paid ($5/month) when neurons regularly exceed about 8,000/day or CPU errors appear. Paid adds $0.011 per 1,000 neurons beyond the free allocation and up to 5 min CPU. Daily neurons come from `ai_usage` (`SUM(neurons_est)` per UTC day), checked against the Workers AI dashboard now and then because `neurons_est` is an estimate.

**Optional quota guard:** before an AI call, the consumer can read today's `SUM(neurons_est)` and, above about 9,500, park the receipt as in "Workers AI quota exhausted" above instead of making a call that will fail.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Queues pricing](https://developers.cloudflare.com/queues/pricing/) · [Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)

## Deployment

The app deploys as one Worker per environment, serving both the SPA and the API. Infrastructure is defined with Pulumi (TypeScript, state in Pulumi Cloud) in two projects: `foundation` provisions the long-lived resources and `services` builds and deploys the Worker onto them. GitHub Actions runs tests, applies D1 migrations, then runs `pulumi up` for `services`.

**Repo layout**

```text
expense-tracker/
  documents/           # this spec and other project docs
  web/                 # Vite + React SPA -> web/dist
  worker/
    src/index.ts       # Hono app: fetch + queue handlers
    src/auth/  src/drive/  src/agent/  src/db/
    migrations/        # D1 SQL migrations (Drizzle-generated)
    wrangler.jsonc     # local dev, bundling, remote D1 migrations
  infrastructure/
    foundation/        # Pulumi: D1 database, receipt queue + DLQ (protected, applied manually)
    services/          # Pulumi: Worker script, assets, bindings, queue consumer, routing (CI)
  .github/workflows/deploy.yml
```

**Environments**

| Env | URL | D1 | Queue | Google OAuth client | Provisioned by | Deploy trigger |
| --- | --- | --- | --- | --- | --- | --- |
| local | `localhost:8787` | Local SQLite (Miniflare) | Local | Dev client, redirect to localhost | — | `wrangler dev` |
| staging | `expense-tracker-staging.<sub>.workers.dev` | `expense-staging` | `receipts-staging` | Dev client | Pulumi stacks `staging` | Merge (push) to `main` |
| production | Custom domain, or `expense-tracker.<sub>.workers.dev` (Worker `expense-tracker`) | `expense-production` | `receipts-production` | Prod client | Pulumi stacks `production` | Published GitHub release, tag `v*` on `main` |

**Pulumi projects**

| Project | Resources | Outputs / inputs | Applied |
| --- | --- | --- | --- |
| `expense-foundation` | `D1Database` (protected), `Queue` receipts + DLQ | Exports account id, D1 id/name, queue id/name, DLQ name | Manually, on change |
| `expense-services` | `WorkersScript` (bundle + `web/dist` assets + bindings), `QueueConsumer`, `WorkersScriptSubdomain`, optional `WorkersCustomDomain` | Reads foundation outputs via `StackReference` to the same stack name | CI on every deploy |

The `services` stack sets the deployed bindings: `AI`, `DB`, `RECEIPT_QUEUE`, `APP_ORIGIN`, `DEFAULT_CURRENCY` and the secrets. The queue consumer uses `batchSize: 1`, `maxRetries: 3` and the DLQ. The services stack also defines the Worker's daily Cron Trigger (`5 0 * * *`), which `wrangler.jsonc` mirrors locally under `triggers.crons`. With a batch size of 1, each receipt runs in its own invocation, so its CPU budget and failure stay separate from other receipts.

**wrangler.jsonc (abridged)**

Wrangler is no longer the deployment source. It runs local dev, bundles the Worker (the `worker` package's `bundle` script, which runs `wrangler deploy --dry-run --outdir dist`) and applies remote D1 migrations. The top-level config is local-only; the `staging` and `production` blocks exist only so migrations can find each database.

```jsonc
{
  "name": "expense-tracker-local",       // never a deployed Worker name
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",       // keep in sync with services config
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "../web/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/auth/*"]
  },
  "ai": { "binding": "AI" },
  "d1_databases": [{ "binding": "DB", "database_name": "expense-local", "database_id": "local", "migrations_dir": "migrations" }],
  "queues": {
    "producers": [{ "binding": "RECEIPT_QUEUE", "queue": "receipts-local" }],
    "consumers": [{ "queue": "receipts-local", "max_batch_size": 1, "max_retries": 3, "dead_letter_queue": "receipts-local-dlq" }]
  },
  "vars": { "APP_ORIGIN": "http://localhost:8787", "DEFAULT_CURRENCY": "SGD" },
  "observability": { "enabled": true },
  "env": {
    "staging":    { "d1_databases": [{ "binding": "DB", "database_name": "expense-staging",    "database_id": "<foundation staging d1DatabaseId>",    "migrations_dir": "migrations" }] },
    "production": { "d1_databases": [{ "binding": "DB", "database_name": "expense-production", "database_id": "<foundation production d1DatabaseId>", "migrations_dir": "migrations" }] }
  }
}
```

**Secrets**

- Deployed (per stack, `pulumi config set --secret <key> -s <stack>` in `infrastructure/services`): `googleClientId`, `googleClientSecret`, `tokenEncKey` (32 random bytes, base64: `openssl rand -base64 32`), `sessionSecret` (signs the OAuth state cookie), `allowedEmails` (comma-separated allow-list). They become the Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `SESSION_SECRET` and `ALLOWED_EMAILS`.
- Non-secret per stack: `appOrigin`, optional `customDomain` + `zoneId` (production).
- Local: `worker/.dev.vars` (git-ignored) with the same names in upper case.

**One-time setup**

1. Pulumi: `pulumi login` (Pulumi Cloud), then `pulumi stack init staging` and `pulumi stack init production` in both `infrastructure/foundation` and `infrastructure/services`.
2. Foundation: `pulumi config set accountId <id>` per stack, then `pulumi up -s staging` and `pulumi up -s production`. Copy each `d1DatabaseId` output into the matching `env` block of `wrangler.jsonc`.
3. Workers AI: send one request with the prompt `agree` to `@cf/meta/llama-3.2-11b-vision-instruct` to accept Meta's license for the account.
4. Google Cloud: create a project, enable the Drive API, and configure the OAuth consent screen (External; add both accounts as test users while building, then Publish app to In production before daily use). Use scopes `openid`, `email`, `profile`, `drive.file`.
5. Create two OAuth Web clients (dev, prod) with redirect URIs `http://localhost:8787/auth/google/callback`, `https://expense-tracker-staging.<sub>.workers.dev/auth/google/callback` and the production origin's `/auth/google/callback`.
6. Services: set `appOrigin` and the secrets for each stack.
7. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Account: Workers Scripts, D1, Queues edit; Zone: Workers Routes edit if a custom domain is used), `CLOUDFLARE_ACCOUNT_ID`, `PULUMI_ACCESS_TOKEN`.

**CI/CD (`.github/workflows/deploy.yml`)**

Nov 10, 2026: production deploys when a GitHub release is published (not on a bare tag push); the tag must be `v*` and point at a commit on `main`, and prereleases are skipped. The workflow calls `ci.yml` (typecheck + tests) as its first job. Abridged sketch:

```yaml
on:
  push: { branches: [main] }
  release: { types: [published] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r test
      - name: Set env
        run: echo "STACK=$([[ $GITHUB_EVENT_NAME == release ]] && echo production || echo staging)" >> $GITHUB_ENV
      - name: Build
        run: |
          pnpm --filter web build
          pnpm --filter worker bundle
      - name: Migrate D1
        working-directory: worker
        run: npx wrangler d1 migrations apply expense-$STACK --env $STACK --remote
      - name: Deploy services
        uses: pulumi/actions@v6
        with:
          command: up
          stack-name: ${{ env.STACK }}
          work-dir: infrastructure/services
```

`foundation` is not run by CI. Change it deliberately with `pulumi preview` then `pulumi up`; D1 is `protect`ed so it can't be deleted by accident.

**Migration rule:** additive only (new tables, nullable columns) in the same release as the code, because the migration runs before the new code is live. Drop or rename only in a later release. Use `wrangler d1 time-travel` to restore D1 to a point in time if a migration goes wrong.

**Rollback:** re-run the Deploy run of the previous release (or revert on `main` for staging); Pulumi redeploys that build. In an emergency, `wrangler rollback --name <worker>` (`expense-tracker-staging` or `expense-tracker`) reverts within seconds, then the next `pulumi up` restores Pulumi as the source of truth. The D1 schema stays forward-compatible thanks to the additive rule.

## Risks, open questions & milestones

The biggest risk is extraction accuracy from the free open-source vision model. Milestone 1 measures it before the rest is built on top.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Vision model accuracy too low on local receipts | Users fix most entries by hand | 10-receipt regression eval; per-field edit rate from user corrections; `needs_review` flow; optional external model via AI Gateway |
| Neuron cost per receipt higher than estimated | Free cap at fewer than 100 receipts/day | Measure in M1; track daily from `ai_usage`; cut repair calls with a stricter prompt; resize images harder; upgrade to Paid ($5) |
| Free-plan CPU (10 ms) exceeded on upload | Error 1101 / failed uploads | Client-side resize; resumable upload straight to Drive for large files |
| OAuth app left in Testing mode | Max 100 test users; 7-day refresh-token expiry in Testing mode | Publish as In production (non-sensitive scopes need no verification); email allow-list limits sign-in to the two users |
| User revokes Drive access or deletes files | Broken receipt links | D1 is source of truth; reconnect prompt; link marked unavailable |
| Drive API Terms on storing app content in Drive | Policy issue at verification | Files are uploaded by the user into their own Drive; confirm wording before submitting |

**Open questions**

- [ ] Personal-only, or open to other users? Decided: personal use for two people. No Google verification needed; OAuth app published as In production.
- [ ] Multi-currency: store only, or convert to a home currency for totals? Decided: store only. Each entry keeps its original currency, there are no FX rates or conversion, and totals are grouped by currency (e.g. SGD 1,240.50 · MYR 86.00).
- [ ] Scanned PDFs: v1 rejects them; is client-side page-to-image rendering needed for launch? Decided: deferred to a later stage. v1 shows an "upload a photo or screenshot instead" message for scanned PDFs.
- [ ] Custom domain for prod: optional for personal use; the workers.dev URL works as a stable OAuth redirect URI.
- [ ] Shared or separate ledgers for the two users? Decided: separate. Each user has their own ledger, categories and Drive folder, all scoped by user\_id; the current schema needs no change.

**Milestones**

1. **M1 — Extraction spike:** Worker + Workers AI only, extract `txn_time` too, run the eval, record accuracy (including time) and neurons per receipt from the model's token usage. Done provisionally on 10 receipts (see "Evaluation before launch").
2. **M2 — Auth + Drive:** Google sign-in, encrypted refresh tokens, folder creation, upload to Drive.
3. **M3 — Pipeline:** Queue consumer, validation, ledger writes (including `txn_time`), `ai_usage` rows for every AI call, retries/DLQ, invalid-output and AI-quota parking (`scheduled` cron), status polling.
4. **M4 — Ledger UI:** category/month views (entries ordered by date and time), review and edit including time, categories, delete.
5. **M5 — Hardening & prod:** CI/CD, prod env and domain, limits banners, privacy policy, OAuth consent screen published as In production, allow-list set.
