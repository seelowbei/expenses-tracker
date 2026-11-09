# Expense Tracker

Personal expense tracker for two users. Sign in with Google, upload a receipt (photo or PDF), and an AI agent extracts merchant, date, total, tax, currency and line items, picks a category, and records the expense in a per-category ledger. The original file is saved to `Expense Receipts/` in the user's own Google Drive.

The whole stack runs on the **Cloudflare Workers Free plan** ($0/month target).

> Full design: [`Expense Tracker — Technical Spec.md`](./Expense%20Tracker%20—%20Technical%20Spec.md)

## Status

Pre-code. Nothing is scaffolded yet. Work follows the spec's milestones:

| Milestone | Scope |
| --- | --- |
| **M1 — Extraction spike** | Worker + Workers AI only; 50-receipt eval; record accuracy and neurons/receipt |
| M2 — Auth + Drive | Google sign-in, encrypted refresh tokens, Drive folder, upload |
| M3 — Pipeline | Queue consumer, Zod validation, ledger writes, retries/DLQ, status polling |
| M4 — Ledger UI | Category/month views, review & edit, categories, delete |
| M5 — Hardening & prod | CI/CD, prod env, limit banners, privacy policy, OAuth consent published |

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite + React + TypeScript, TanStack Query, Tailwind (static assets) |
| API | Hono on a single Cloudflare Worker (`fetch` + `queue` handlers) |
| Auth | `arctic` (Google OIDC + PKCE), own `sessions` table |
| Database | Cloudflare D1 + Drizzle ORM |
| Async jobs | Cloudflare Queues (producer + consumer in the same Worker), DLQ |
| AI | Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`; `env.AI.toMarkdown()` for PDFs |
| File storage | Google Drive API v3, `drive.file` scope |
| Validation | Zod (API bodies + LLM output) |
| Tooling | pnpm workspaces, Wrangler, Vitest + `@cloudflare/vitest-pool-workers`, GitHub Actions |

```text
Browser (SPA) ──► Worker fetch ──► Google Drive (save file)
                       │                 ▲
                       ▼                 │ download
                 RECEIPT_QUEUE ──► Worker queue ──► Workers AI ──► D1 ledger
```

## Repo layout (planned)

```text
web/                    Vite + React SPA -> web/dist
worker/
  src/index.ts          Hono app: fetch + queue handlers
  src/auth/             OAuth, sessions, token encryption
  src/drive/            Drive API client
  src/agent/            Extraction prompt, Zod schema, post-validation
  src/db/               Drizzle schema + queries
  migrations/           D1 SQL migrations
  wrangler.jsonc
.github/workflows/deploy.yml
```

## Prerequisites

- Node.js 22+ and pnpm 9+
- A Cloudflare account (Free plan) and `wrangler login`
- A Google Cloud project with the Drive API enabled

## One-time setup

**Cloudflare**

```bash
cd worker
npx wrangler d1 create expense-dev
npx wrangler d1 create expense-prod
npx wrangler queues create receipts-dev
npx wrangler queues create receipts-dev-dlq
npx wrangler queues create receipts-prod
npx wrangler queues create receipts-prod-dlq
```

Put the D1 database ids into `worker/wrangler.jsonc`.

The Llama 3.2 Vision model requires accepting Meta's license once per Cloudflare account: send a single request to `@cf/meta/llama-3.2-11b-vision-instruct` with the prompt `agree` before the first real call.

**Google Cloud**

1. Configure the OAuth consent screen (External). Scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`. Add both accounts as test users while building; publish to **In production** before daily use (avoids Testing mode's 7-day refresh-token expiry).
2. Create two OAuth Web clients (dev, prod) with redirect URIs:
   - `http://localhost:8787/auth/google/callback`
   - `https://expense-dev.<sub>.workers.dev/auth/google/callback`
   - `https://<prod-domain>/auth/google/callback`

**Secrets** (per environment)

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --env dev
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev
npx wrangler secret put TOKEN_ENC_KEY --env dev    # openssl rand -base64 32
npx wrangler secret put SESSION_SECRET --env dev   # signs the OAuth state cookie
```

Repeat without `--env dev` for prod. `ALLOWED_EMAILS` (comma-separated allow-list of the two users) is set as a var or secret per environment.

**GitHub repo secrets:** `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, Queues edit) and `CLOUDFLARE_ACCOUNT_ID`.

## Local development

Create `worker/.dev.vars` (git-ignored):

```ini
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TOKEN_ENC_KEY=...
SESSION_SECRET=...
ALLOWED_EMAILS=you@example.com,partner@example.com
APP_ORIGIN=http://localhost:8787
```

`APP_ORIGIN` must be overridden locally because the top-level `vars` in `wrangler.jsonc` point at prod.

```bash
pnpm install
pnpm --filter worker exec wrangler d1 migrations apply expense-dev --local
pnpm --filter web build
pnpm --filter worker exec wrangler dev
```

App runs at http://localhost:8787 with local D1 and Queues (Miniflare). Workers AI calls go to Cloudflare even in local dev and count against the daily neuron quota.

## Tests

```bash
pnpm -r test
```

Worker tests run inside the Workers runtime via `@cloudflare/vitest-pool-workers`, with local D1 and Queues.

## Deployment

| Env | URL | D1 | Queue | Trigger |
| --- | --- | --- | --- | --- |
| local | `localhost:8787` | Local SQLite | Local | `wrangler dev` |
| dev | `expense-dev.<sub>.workers.dev` | `expense-dev` | `receipts-dev` | Push to `main` |
| prod | Custom domain or workers.dev | `expense-prod` | `receipts-prod` | Git tag `v*` |

CI runs tests, builds the SPA, applies D1 migrations (`--remote`), then `wrangler deploy`.

- **Migrations are additive only** in the same release as the code (new tables, nullable columns). Drop or rename only in a later release.
- **Rollback:** `wrangler rollback [--env dev]`. Restore D1 with `wrangler d1 time-travel` if a migration goes wrong.

## Free-plan limits

| Service | Daily limit (resets 00:00 UTC / 08:00 SGT) | Binds first? |
| --- | --- | --- |
| Workers AI | 10,000 neurons | **Yes** (~100–200 receipts/day) |
| Workers | 100,000 requests; 10 ms CPU/request | CPU per request is the tight one |
| Queues | 10,000 ops; 24 h retention | No |
| D1 | 5M rows read, 100k written | No |

Upgrade to Workers Paid ($5/month) when neurons regularly exceed ~8,000/day or CPU errors (1101) appear.

## Working with coding agents

- [`AGENTS.md`](./AGENTS.md) — project instructions for Codex and other agents (source of truth)
- [`CLAUDE.md`](./CLAUDE.md) — Claude Code entry point; imports `AGENTS.md`
- [`.claude/settings.json`](./.claude/settings.json) — Claude Code permissions
- [`.codex/config.toml`](./.codex/config.toml) — Codex project config
