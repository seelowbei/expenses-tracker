# Expense Tracker — Technical Spec

Nov 9, 2026 · @Celine Low

**Revisions**

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

A single Worker has two handlers. `fetch` serves the SPA and API; `queue` runs extraction. D1 holds all structured data, Workers AI does the reading, and Google provides sign-in and file storage.

&#91;embedded content: architecture · Cloudflare Workers + Google\]

The upload request only saves the file to Drive and enqueues it. The queue handler fetches the file back from Drive, calls Workers AI, then writes the ledger entry to D1. No R2, KV or Durable Objects are used.

## Tech stack

The stack is a static SPA with a Hono API on a single Worker. It avoids server rendering so each request stays within the free plan's 10 ms CPU limit.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Vite + React + TypeScript, TanStack Query, Tailwind | Served as static assets, which are free and unlimited |
| API | Hono on Cloudflare Workers | Small, typed router built for Workers |
| Auth | `arctic` (Google OAuth/OIDC) + own session table | Small library with no framework lock-in; full control over refresh tokens |
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
  raw_extraction TEXT,                       -- JSON from the agent, for audit
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
  updated_at    TEXT NOT NULL
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
5. Create a session: a random 32-byte token goes in an `HttpOnly; Secure; SameSite=Lax` cookie, its SHA-256 is stored in `sessions`, and it expires after 30 days with sliding renewal.

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
6. Valid with `confidence >= 0.7`: insert `ledger_entries` (`source='ai'`) and set status `done`. Valid but low confidence: insert the entry and set status `needs_review`.
7. On an error, `msg.retry({ delaySeconds })` with backoff; after 3 attempts the message goes to the DLQ and status becomes `failed`.
8. Every Workers AI call in steps 3–5 writes one `ai_usage` row, whatever the outcome (including quota and invalid-output failures). Rows are written in the same D1 `batch()` as the receipt's status update, so usage is never lost when a later step fails.

**4. Review and ledger**

1. The ledger page calls `GET /api/ledger?from&to&category`, grouped by category with monthly totals computed in SQL and grouped by currency (GROUP BY category\_id, month, currency); amounts in different currencies are never summed together.
2. Entries in `needs_review` are highlighted at the top. The user edits fields or changes the category, and the entry's `source` becomes `ai_edited`.
3. Deleting an entry asks whether to delete the Drive file too (`files.delete`; allowed under `drive.file` because the app created the file).

## Extraction agent

The agent is a single structured-output call per receipt, plus at most one repair call; it uses no tools and no conversation loop. One model serves both paths, so the prompt and schema are shared and tested once.

| Input | Pre-processing | Model call |
| --- | --- | --- |
| Image (JPG/PNG) | Resized in the browser | `@cf/meta/llama-3.2-11b-vision-instruct` with the image + prompt |
| PDF (text) | `env.AI.toMarkdown()` | Same model, text-only, with the markdown + prompt |
| PDF (scanned) | Empty markdown | v1: fail with a clear message; v2: render page 1 to an image client-side |

**System prompt (strict, short)**

The first M1 runs showed the model replying in prose, leaving dates as `09/11/2026` and using unit prices for line items. The rules below fix those; the JSON shape of the schema is appended after them, and the user message repeats "Reply with only the JSON object, starting with `{`".

```text
You extract data from a single purchase receipt. Output ONLY one JSON object matching the schema. No prose, no markdown, no code fences. The first character of your reply must be "{" and the last must be "}".
Rules:
- Use values printed on the receipt. Never guess. Unknown -> null.
- total = final amount paid incl. tax and tips.
- tax = the tax amount printed (also when prices are tax-inclusive, e.g. "Inclusive of 9% GST ($0.37)" -> 0.37). Ignore struck-through prices.
- date: YYYY-MM-DD. If day/month order is ambiguous, prefer DD/MM (default locale: {{locale}}). Example: printed 09/11/2026 -> "2026-11-09".
- time: HH:MM, 24-hour, the transaction time printed on the receipt (e.g. 6:19 PM -> "18:19"). Not printed -> null. Never use a print, opening-hours or validity time.
- currency: ISO 4217. If no symbol/code, use {{default_currency}}.
- line_items: one per line; amount = the line total actually charged (after quantity and discounts), not the unit price.
- category_slug: exactly one of: {{category_slugs}}. If unsure, "other".
- confidence: 0..1, your certainty that merchant, date and total are all correct.
```

The repair prompt lists one plain-language fix per failing field (e.g. `txn_date must be "YYYY-MM-DD", e.g. printed 09/11/2026 -> "2026-11-09"`) rather than raw Zod messages, which the model ignored.

**Output schema (Zod)**

```ts
const Extraction = z.object({
  merchant: z.string().min(1).max(120),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  txn_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), // HH:MM 24-hour, local
  currency: z.string().length(3),
  total: z.number().nonnegative(),
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
- Printed dates `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY` become `YYYY-MM-DD`, day-first unless the second number can only be a day (e.g. `11/25/2026`).
- Times: `6:19 PM` / `06:19pm` become `18:19`; `18:19:42` drops the seconds. A time that still doesn't parse becomes `null`, because time is optional and must never fail an otherwise good extraction.

**Post-validation rules (code, not LLM)**

- `category_slug` must be in the user's list; otherwise map it to `other` and set `needs_review`.
- `txn_date` no later than today + 1 day and no earlier than 10 years ago; otherwise `needs_review`.
- If line items exist and their sum differs by more than 2% from both `total - tax` and `total` (tax-inclusive receipts, common with Singapore GST): `needs_review`. A null `tax` counts as 0.
- `txn_time` never forces review.
- Convert to minor units with the currency's exponent (JPY 0, SGD/USD 2) before insert.

**Usage accounting**

- Each call's `usage.prompt_tokens` / `usage.completion_tokens` (returned by the vision model) go to `ai_usage`.
- `neurons_est` = tokens × the model's per-token rate, kept as a constant per model in `src/agent/` and derived from Cloudflare's published prices at $0.011 per 1,000 neurons. For `@cf/meta/llama-3.2-11b-vision-instruct`: $0.0485/M input → ~0.00441 neurons/token, $0.676/M output → ~0.0615 neurons/token.
- `toMarkdown()` rows record the converter's estimated `tokens` with `neurons_est = 0` (free for PDFs per the docs; confirm against the dashboard in M1).

**Evaluation before launch**

Build a 50-receipt test set (local receipts, mixed images and PDFs, a few crumpled or faded) with hand-labelled JSON. Labels include `txn_time` (`null` when none is printed). Track per-field accuracy (including time), category accuracy, repair rate and neurons per receipt. Target at least 90% on total and date; time is reported but has no target. If the model misses the target, fall back to an external vision model via AI Gateway on `needs_review` cases only.

First M1 measurement (one digital Kopitiam receipt, after the prompt fixes): 1 call, 6,831 input + 106 output tokens, ~37 neurons, 4.2 s, all fields correct. The image accounts for almost all input tokens.

## API

All `/api/*` routes need a valid session cookie and are scoped to the session's `user_id`. State-changing routes also check `Origin` against `APP_ORIGIN`.

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/auth/google` | Start OAuth | 302 to Google |
| GET | `/auth/google/callback` | Finish OAuth, create session | 302 to `/` |
| POST | `/auth/logout` | Delete session | 204 |
| GET | `/api/me` | Profile, Drive status, default currency | 200 |
| POST | `/api/receipts` | Multipart upload (≤ 5 MB) | 202 receipt / 409 duplicate |
| POST | `/api/receipts/resumable` | Start Drive resumable upload (> 5 MB) | 200 `{ receiptId, uploadUrl }` |
| POST | `/api/receipts/:id/complete` | Confirm resumable upload, enqueue | 202 |
| GET | `/api/receipts?status=` | List receipts (for polling) | 200 |
| POST | `/api/receipts/:id/retry` | Re-enqueue a failed receipt | 202 |
| GET | `/api/ledger?from=&to=&category=` | Entries + totals by category/month | 200 |
| PATCH | `/api/ledger/:id` | Edit fields / category | 200 |
| DELETE | `/api/ledger/:id?deleteFile=` | Delete entry, optionally the Drive file | 204 |
| GET / POST | `/api/categories` | List / add categories | 200 / 201 |

The UI polls `GET /api/receipts?status=queued,processing` every 3 s while anything is pending, and stops when nothing is.

Ledger entries carry `txn_time` (`"HH:MM"` or `null`). `GET /api/ledger` orders entries by `txn_date` then `txn_time` (entries without a time last within their day), and `PATCH /api/ledger/:id` accepts `txn_time` (`"HH:MM"` or `null`) like any other field. AI usage has no API in v1; it is stored for later reporting and queried with `wrangler d1 execute` until then.

## Security & privacy

The two highest-value secrets are the users' Google refresh tokens. They are encrypted at rest and never leave the Worker.

- **Scopes:** only `openid email profile drive.file`. `drive.file` is non-sensitive, so the app can only see files it created. Never request the full `drive` scope.
- **Refresh tokens:** AES-GCM with a random 12-byte IV per token. The key is a 32-byte `TOKEN_ENC_KEY` Worker secret, and the stored value is `v1:<iv>:<ciphertext>` so the key can be rotated later.
- **Access tokens:** cached in memory only for their lifetime, never written to D1 or logs.
- **Sessions:** opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored only as its SHA-256 hash. Logout and `invalid_grant` delete all of the user's sessions.
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
| Workers AI quota exhausted | Consumer catches the error, sets status `queued`, and calls `msg.retry({ delaySeconds })` to land after 00:05 UTC. If the delay exceeds 24 h retention, set `failed` with a "retry tomorrow" message. |
| Drive 401 / `invalid_grant` | `drive_status='disconnected'`, receipt `failed`, UI prompts to reconnect |
| Drive 429 / 5xx | Retry with backoff of 30 s, 2 min, 10 min, then DLQ |
| Invalid LLM JSON twice | Entry created with nulls, status `needs_review` |
| Error 1027 (daily requests) | SPA shows a "service busy, try later" banner; uploads are not lost because the browser keeps the file until a 202 |

**Upgrade trigger:** move to Workers Paid ($5/month) when neurons regularly exceed about 8,000/day or CPU errors appear. Paid adds $0.011 per 1,000 neurons beyond the free allocation and up to 5 min CPU. Daily neurons come from `ai_usage` (`SUM(neurons_est)` per UTC day), checked against the Workers AI dashboard now and then because `neurons_est` is an estimate.

**Optional quota guard:** before an AI call, the consumer can read today's `SUM(neurons_est)` and, above about 9,500, defer the message as in "Workers AI quota exhausted" below instead of making a call that will fail.

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
| staging | `expense-tracker-staging.<sub>.workers.dev` | `expense-staging` | `receipts-staging` | Dev client | Pulumi stacks `staging` | Push to `main` |
| production | Custom domain, or `expense-tracker-production.<sub>.workers.dev` | `expense-production` | `receipts-production` | Prod client | Pulumi stacks `production` | Git tag `v*` |

**Pulumi projects**

| Project | Resources | Outputs / inputs | Applied |
| --- | --- | --- | --- |
| `expense-foundation` | `D1Database` (protected), `Queue` receipts + DLQ | Exports account id, D1 id/name, queue id/name, DLQ name | Manually, on change |
| `expense-services` | `WorkersScript` (bundle + `web/dist` assets + bindings), `QueueConsumer`, `WorkersScriptSubdomain`, optional `WorkersCustomDomain` | Reads foundation outputs via `StackReference` to the same stack name | CI on every deploy |

The `services` stack sets the deployed bindings: `AI`, `DB`, `RECEIPT_QUEUE`, `APP_ORIGIN`, `DEFAULT_CURRENCY` and the secrets. The queue consumer uses `batchSize: 1`, `maxRetries: 3` and the DLQ. With a batch size of 1, each receipt runs in its own invocation, so its CPU budget and failure stay separate from other receipts.

**wrangler.jsonc (abridged)**

Wrangler is no longer the deployment source. It runs local dev, bundles the Worker (the `worker` package's `bundle` script, which runs `wrangler deploy --dry-run --outdir dist`) and applies remote D1 migrations. The top-level config is local-only; the `staging` and `production` blocks exist only so migrations can find each database.

```jsonc
{
  "name": "expense-tracker",
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

```yaml
on:
  push: { branches: [main], tags: ['v*'] }
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
        run: echo "STACK=$([[ $GITHUB_REF == refs/tags/* ]] && echo production || echo staging)" >> $GITHUB_ENV
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

**Rollback:** re-run the workflow for the previous tag (or revert on `main` for staging); Pulumi redeploys that build. In an emergency, `wrangler rollback --name expense-tracker-<env>` reverts within seconds, then the next `pulumi up` restores Pulumi as the source of truth. The D1 schema stays forward-compatible thanks to the additive rule.

## Risks, open questions & milestones

The biggest risk is extraction accuracy from the free open-source vision model. Milestone 1 measures it before the rest is built on top.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Vision model accuracy too low on local receipts | Users fix most entries by hand | 50-receipt eval first; `needs_review` flow; optional external model via AI Gateway |
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

1. **M1 — Extraction spike:** Worker + Workers AI only, extract `txn_time` too, run the 50-receipt eval, record accuracy (including time) and neurons per receipt from the model's token usage.
2. **M2 — Auth + Drive:** Google sign-in, encrypted refresh tokens, folder creation, upload to Drive.
3. **M3 — Pipeline:** Queue consumer, validation, ledger writes (including `txn_time`), `ai_usage` rows for every AI call, retries/DLQ, status polling.
4. **M4 — Ledger UI:** category/month views (entries ordered by date and time), review and edit including time, categories, delete.
5. **M5 — Hardening & prod:** CI/CD, prod env and domain, limits banners, privacy policy, OAuth consent screen published as In production, allow-list set.
