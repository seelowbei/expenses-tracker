# AGENTS.md

Instructions for coding agents (Codex, Claude Code, others). This file is the source of truth; `CLAUDE.md` imports it.

## Project

Receipt-to-ledger expense tracker for two users on the **Cloudflare Workers Free plan**. One Worker serves a static React SPA and a Hono API (`fetch` handler), runs AI extraction (`queue` handler), and re-enqueues receipts parked by the AI quota (`scheduled` handler, daily Cron Trigger at 00:05 UTC). D1 stores all structured data; receipt files live in each user's Google Drive.

The design is in `documents/Expense Tracker — Technical Spec.md`. Read the relevant section before implementing anything; it defines the schema, flows, API, prompt, Zod schema and failure handling. If the code and spec disagree, stop and ask rather than silently picking one.

**Status:** M1 (extraction spike) done provisionally: the original eval passed on 10 local receipts (`documents/M1 eval results.md`), which stay as a regression set; re-run `pnpm --filter worker eval` after any change in `src/agent/`. Real accuracy will come from user corrections (spec, "Evaluation before launch"). M2 (Google sign-in + Drive upload) done and verified locally with real Google accounts: `/auth/*`, `/api/me`, `POST/GET /api/receipts`, the first migrations (full spec schema + default categories) and the SPA in `web/`. Plan and decisions: `documents/M2 plan.md`. M3 (pipeline) implemented and locally verified on branch `m3/pipeline`: tests green; image/text-PDF extraction, persistence, polling, scanned-PDF rejection and cron recovery passed on Nov 16, 2026. The PR is merged; the user is handling staging verification. The Nov 16 eval re-run on 12 receipts passed date accuracy (91.7%) but missed total accuracy (83.3% versus 90%); both wrong totals were routed to review. Verification details and staging follow-ups are tracked in the M3 plan. Includes: queue consumer, ledger and `ai_usage` writes, quota parking, daily cron, retry route, SPA polling (`documents/M3 plan.md`). M4.1 (read-only ledger) is implemented and locally verified on `codex/m4-ledger-browsing`: category/list/detail APIs, bounded filters, pagination, currency-separated SQL totals, SPA browsing and account cache isolation. Plan: `tasks/plan.md`; evidence: `documents/M4.1 verification.md`. M4.1 is merged. M4.2 (existing-entry editing/confirmation) is implemented and locally verified on `codex/m4-entry-editing`: additive `reviewed_at`, atomic version-guarded PATCH, exact money inputs and recoverable editor conflicts. Evidence: `documents/M4.2 verification.md`. M4.2 is merged; staging checks remain. M4.3 (complete review inbox) is implemented and locally verified on `codex/m4-3`: paginated pending receipts, safe partial drafts, atomic missing-entry creation and shared editor recovery. Evidence and verification limits: `documents/M4.3 verification.md`. M4.3 and M4.4 (custom categories) are merged. M4.5 (ledger deletion) is implemented and locally verified on `codex/m4-5`. Evidence: `documents/M4.5 verification.md`. M4.5 PR review and M4 staging sign-off remain open. Do not build M5 features unless asked.

## Layout

```text
documents/           Technical spec and other project docs
web/                 Vite + React + TS SPA (TanStack Query, Tailwind) -> web/dist
worker/src/index.ts  Hono app; exports { fetch, queue, scheduled }
worker/src/pipeline/ queue consumer, enqueue/park, daily cron, retry timing
worker/src/auth/     oauth4webapi Google OIDC + PKCE, sessions, AES-GCM token crypto, /auth routes
worker/src/api/      /api/me, /api/receipts, /api/categories, ledger read/edit, receipt review/detail
worker/src/drive/    Drive v3 client (drive.file scope)
worker/src/agent/    prompt, Zod Extraction schema, post-validation rules
worker/src/db/       Drizzle schema + queries
worker/migrations/   D1 SQL migrations
worker/wrangler.jsonc   local dev, bundling, remote D1 migrations only
infrastructure/foundation/  Pulumi: D1 + queues per env (long-lived, protected)
infrastructure/services/    Pulumi: Worker script, assets, bindings, secrets, queue consumer, routing
```

pnpm workspace: `web`, `worker`, `infrastructure/*`.

**Environments:** `local` (`wrangler dev` + Miniflare, no Pulumi), `staging` and `production` (Pulumi stacks of the same name in both infra projects). Resource names follow `<thing>-<env>`, e.g. `expense-staging`, `receipts-production`, `expense-tracker-staging`. Exception: the production Worker is `expense-tracker` (served at `expense-tracker.seelowbei.workers.dev`); the local wrangler config is `expense-tracker-local` so it can never deploy over it.

## Commands

```bash
pnpm install
pnpm -r test                                          # all tests
pnpm --filter worker test                             # worker tests in workerd (@cloudflare/vitest-plugin)
pnpm --filter worker coverage                         # tests + Istanbul coverage -> worker/coverage (V8 unsupported in workerd)
pnpm --filter web build                               # SPA -> web/dist (needed before wrangler dev)
pnpm --filter worker bundle                           # Worker -> worker/dist/index.js (for Pulumi services)
pnpm --filter worker dev                              # local app on :8787 (needs Cloudflare auth: AI is always remote)
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=5+0+*+*+*"   # fire the daily cron locally (sends parked receipts: spends neurons)
pnpm --filter worker eval                             # M1 eval against the running dev server (spends neurons)
pnpm --filter worker types                            # regenerate worker-configuration.d.ts after wrangler.jsonc changes
pnpm --filter worker exec wrangler d1 migrations apply expense-local --local
pnpm --filter worker typecheck                        # typecheck
pnpm --filter "./infrastructure/*" typecheck          # Pulumi programs
(cd infrastructure/services && pulumi preview -s staging)   # needs build outputs + Pulumi login
```

Run typecheck and the relevant tests before calling a change done.

## Hard constraints (from the spec — do not violate)

**Platform / cost**
- Only Workers, D1, Queues, Workers AI, static assets. No R2, KV, Durable Objects, containers or external servers.
- **10 ms CPU per request.** No SSR, no PDF parsing, no image transforms in the Worker. Images are resized/HEIC-converted in the browser. Hash with `crypto.subtle.digest`. Stream request bodies; never buffer twice. Awaiting I/O is free; parsing and JSON work are not.
- Queue consumer uses `max_batch_size: 1`.
- Every free-plan limit fails rather than bills, so every path needs a recoverable `failed` state.

**Data**
- Amounts are integer minor units (`*_minor`), using the currency exponent (JPY 0, SGD/USD 2). Never store floats.
- Dates are ISO-8601 text; `txn_date` is `YYYY-MM-DD`.
- Never sum across currencies. Totals are grouped by `category_id, month, currency`. No FX conversion.
- D1 is the source of truth; a missing Drive file must never lose ledger data.
- Migrations are **additive only** (new tables, nullable columns). Drops/renames go in a later release.

**Infrastructure**
- Workers Free plan only: no containers, R2, KV or Durable Objects in Pulumi either.
- Pulumi `services` is the source of truth for deployed bindings and secrets. A new binding goes in both `infrastructure/services/index.ts` and `worker/wrangler.jsonc` (local).
- Never rename `foundation` resources or the D1 `name`; that replaces the database. D1 stays `protect: true`.
- Keep `compatibilityDate` in sync between `services` config and `wrangler.jsonc`.
- `worker/package.json` must define `"bundle": "wrangler deploy --dry-run --outdir dist"`. Call the script, not wrangler directly; the Claude deny rules block any command containing `wrangler deploy`.

**Security**
- Every query filters by `user_id` from the session — never from request input.
- State-changing `/api/*` routes check `Origin` against `APP_ORIGIN`.
- OAuth scopes are exactly `openid email profile https://www.googleapis.com/auth/drive.file`. Never request full `drive`.
- Refresh tokens: AES-GCM, random 12-byte IV, stored as `v1:<iv>:<ciphertext>`, key `TOKEN_ENC_KEY`. Access tokens cached in memory only.
- Session cookie `__Host-session`: random 32-byte token, `HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain; only its SHA-256 is stored. Keep the `__Host-` prefix on auth cookies.
- Callback rejects emails not in `ALLOWED_EMAILS`.
- Uploads: allow-list `image/jpeg`, `image/png`, `application/pdf` with magic-byte checks; 10 MB max; server-generated file names.
- `invalid_grant` / Drive 401 → `drive_status='disconnected'`, delete the user's sessions, keep ledger data.
- **Drive is write-once:** only create the folder and upload new files. Never delete, trash, overwrite or move Drive files (no `DELETE`/`PATCH`/`PUT` to Drive, no `trashed`). `drive.file` would allow it, so `test/drive-no-delete.test.ts` guards it. Deleting a ledger entry keeps the Drive file.
- **Logging:** receipt ids, statuses, error codes only. Never log OCR text, amounts, emails or tokens.

**Extraction agent**
- One structured-output call per receipt plus at most one repair call. No tools, no conversation loop.
- Receipt content is untrusted data. LLM output goes only through the Zod `Extraction` schema and the post-validation rules in `src/agent/`; the model can only choose from the user's existing category slugs.
- `confidence >= 0.7` → `done`; otherwise `needs_review`. Post-validation failures also force `needs_review`: unknown slug, date out of range, line-item sum off by >2%, `total` not matching the amount in the copied `total_text` (or no usable `total_text`), a subtotal `total_text`, or a repair call. The model's confidence is ~always 1.0, so these code checks are what actually route receipts to review.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- Validate every request body and every LLM response with Zod; share schemas between API and agent.
- Use Drizzle for queries; raw SQL only in migrations or where Drizzle can't express it.
- Keep pure logic (minor-unit conversion, post-validation, crypto helpers, prompt rendering) in small modules with unit tests.
- Use the `Env` bindings type generated by `wrangler types`; `src/env.ts` only narrows the bindings the generated type marks optional.
- `/api/dev/*` routes exist only for the M1 eval and are gated by `DEV_ROUTES === "true"` (local wrangler vars). Never set it in Pulumi config.
- Unit tests never call the real Workers AI binding; pass a fake `AiClient`.
- Errors returned to the client use stable machine-readable codes (e.g. `unsupported_scanned_pdf`, `duplicate_receipt`).

## Do not

- Run `wrangler deploy`, `wrangler secret put`, `wrangler rollback`, or any `--remote` D1 command. Deployment is CI-only (merge to `main` → staging, published GitHub release `v*` → production).
- Run `pulumi up`, `pulumi destroy`, `pulumi refresh`, `pulumi state`, `pulumi stack rm/init` or `pulumi config set`. `pulumi preview` is fine. Ask the user to apply.
- Read, print or commit `worker/.dev.vars`, any `.env` file (e.g. `worker/.env` holding the dev token) or any secret. Never echo `$CLOUDFLARE_API_TOKEN`.
  When adding or renaming a local variable, update the templates `worker/.env.sample` (Wrangler CLI) and `worker/.dev.vars.sample` (Worker bindings) instead, plus the matching Pulumi config key in `infrastructure/services`.
- Add dependencies that need Node-only APIs beyond `nodejs_compat`, or that are large enough to hurt cold start/CPU.
- Send real receipt images or personal data to any service other than Workers AI and Google Drive.

## Spec revisions not yet in code

- **Nov 10, 2026 (M2, decided):** the resumable upload for files over 5 MB is deferred to M5 (until then `413 file_too_large`).
- **Nov 10, 2026 (decided), M4 part:** after "invalid LLM JSON twice" the receipt is `needs_review` with `error='invalid_output'` and the parsed fields in `raw_extraction` (done in M3). The pre-filled review form and creating the entry on save (`source='ai_edited'`) are M4 work.
