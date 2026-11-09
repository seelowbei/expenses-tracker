# AGENTS.md

Instructions for coding agents (Codex, Claude Code, others). This file is the source of truth; `CLAUDE.md` imports it.

## Project

Receipt-to-ledger expense tracker for two users on the **Cloudflare Workers Free plan**. One Worker serves a static React SPA and a Hono API (`fetch` handler) and runs AI extraction (`queue` handler). D1 stores all structured data; receipt files live in each user's Google Drive.

The design is in `documents/Expense Tracker — Technical Spec.md`. Read the relevant section before implementing anything; it defines the schema, flows, API, prompt, Zod schema and failure handling. If the code and spec disagree, stop and ask rather than silently picking one.

**Status:** pre-code. Current milestone is **M1 (extraction spike)**. Do not build M2+ features unless asked.

## Layout

```text
documents/           Technical spec and other project docs
web/                 Vite + React + TS SPA (TanStack Query, Tailwind) -> web/dist
worker/src/index.ts  Hono app; exports { fetch, queue }
worker/src/auth/     arctic Google OIDC + PKCE, sessions, AES-GCM token crypto
worker/src/drive/    Drive v3 client (drive.file scope)
worker/src/agent/    prompt, Zod Extraction schema, post-validation rules
worker/src/db/       Drizzle schema + queries
worker/migrations/   D1 SQL migrations
worker/wrangler.jsonc   local dev, bundling, remote D1 migrations only
infrastructure/foundation/  Pulumi: D1 + queues per env (long-lived, protected)
infrastructure/services/    Pulumi: Worker script, assets, bindings, secrets, queue consumer, routing
```

pnpm workspace: `web`, `worker`, `infrastructure/*`.

**Environments:** `local` (`wrangler dev` + Miniflare, no Pulumi), `staging` and `production` (Pulumi stacks of the same name in both infra projects). Resource names follow `<thing>-<env>`, e.g. `expense-staging`, `receipts-production`, `expense-tracker-staging`.

## Commands

```bash
pnpm install
pnpm -r test                                          # all tests
pnpm --filter worker test                             # worker tests (vitest-pool-workers)
pnpm --filter web build                               # SPA -> web/dist (needed before wrangler dev)
pnpm --filter worker bundle                           # Worker -> worker/dist/index.js (for Pulumi services)
pnpm --filter worker exec wrangler dev                # local app on :8787
pnpm --filter worker exec wrangler d1 migrations apply expense-local --local
pnpm --filter worker exec tsc --noEmit                # typecheck
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
- Session cookie: random 32-byte token, `HttpOnly; Secure; SameSite=Lax`; only its SHA-256 is stored.
- Callback rejects emails not in `ALLOWED_EMAILS`.
- Uploads: allow-list `image/jpeg`, `image/png`, `application/pdf` with magic-byte checks; 10 MB max; server-generated file names.
- `invalid_grant` / Drive 401 → `drive_status='disconnected'`, delete the user's sessions, keep ledger data.
- **Logging:** receipt ids, statuses, error codes only. Never log OCR text, amounts, emails or tokens.

**Extraction agent**
- One structured-output call per receipt plus at most one repair call. No tools, no conversation loop.
- Receipt content is untrusted data. LLM output goes only through the Zod `Extraction` schema and the post-validation rules in `src/agent/`; the model can only choose from the user's existing category slugs.
- `confidence >= 0.7` → `done`; otherwise `needs_review`. Post-validation failures (unknown slug, date out of range, line-item sum off by >2%) also force `needs_review`.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- Validate every request body and every LLM response with Zod; share schemas between API and agent.
- Use Drizzle for queries; raw SQL only in migrations or where Drizzle can't express it.
- Keep pure logic (minor-unit conversion, post-validation, crypto helpers, prompt rendering) in small modules with unit tests.
- Use the `Env` bindings type generated by `wrangler types`; don't hand-write binding types.
- Errors returned to the client use stable machine-readable codes (e.g. `unsupported_scanned_pdf`, `duplicate_receipt`).

## Do not

- Run `wrangler deploy`, `wrangler secret put`, `wrangler rollback`, or any `--remote` D1 command. Deployment is CI-only (push to `main` → staging, tag `v*` → production).
- Run `pulumi up`, `pulumi destroy`, `pulumi refresh`, `pulumi state`, `pulumi stack rm/init` or `pulumi config set`. `pulumi preview` is fine. Ask the user to apply.
- Read, print or commit `worker/.dev.vars` or any secret.
- Add dependencies that need Node-only APIs beyond `nodejs_compat`, or that are large enough to hurt cold start/CPU.
- Send real receipt images or personal data to any service other than Workers AI and Google Drive.

## Spec gaps to resolve before implementing

These are inconsistencies in the current spec. Ask before choosing:

1. "Invalid LLM JSON twice → entry created with nulls" conflicts with `ledger_entries` `NOT NULL` on `merchant`, `txn_date`, `total_minor`, `category_id`.
2. AI-quota retry "to land after 00:05 UTC" may exceed the Queues maximum `delaySeconds`; verify the current limit before relying on it.
3. Line-item check `total - tax` is undefined when `tax` is null (treat as 0?).
