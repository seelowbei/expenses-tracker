# Infrastructure

Pulumi (TypeScript) for the **staging** and **production** environments. State lives in Pulumi Cloud. Local development needs no Pulumi; it runs on `wrangler dev` with Miniflare (see the root README).

| Project | Folder | Provisions | Applied by |
| --- | --- | --- | --- |
| `expense-foundation` | [`foundation/`](./foundation) | D1 database `expense-<env>` (protected), queues `receipts-<env>` and `receipts-<env>-dlq` | You, manually, when it changes |
| `expense-services` | [`services/`](./services) | Worker `expense-tracker-staging` / `expense-tracker` (production): bundle + `web/dist` assets, bindings and secrets, queue consumer, workers.dev or custom domain | CI on every deploy |

Both projects have the stacks `staging` and `production`. `services` reads `foundation` outputs through a `StackReference` to the stack with the same name.

Everything stays on the Cloudflare Workers Free plan: no containers, R2, KV or Durable Objects.

## Prerequisites

- Pulumi CLI, `pulumi login` (Pulumi Cloud)
- `CLOUDFLARE_API_TOKEN` in your shell set to the **provisioning** token (Account: Workers Scripts, D1, Queues edit; plus Zone: Workers Routes edit for a custom domain), not the `wrangler dev` token. See the root README's "Cloudflare tokens".
- `pnpm install` at the repo root

## First-time setup

**1. Foundation** (once per environment)

```bash
cd infrastructure/foundation
pulumi stack init staging
pulumi config set accountId <cloudflare-account-id> -s staging
pulumi preview -s staging
pulumi up -s staging
pulumi stack output d1DatabaseId -s staging   # copy into worker/wrangler.jsonc env.staging
```

Repeat with `production`.

**2. Services config** (once per environment)

```bash
cd infrastructure/services
pulumi stack init staging
pulumi config set appOrigin https://expense-tracker-staging.<sub>.workers.dev -s staging
pulumi config set --secret googleClientId <id> -s staging
pulumi config set --secret googleClientSecret <secret> -s staging
openssl rand -base64 32 | pulumi config set --secret tokenEncKey -s staging
openssl rand -base64 32 | pulumi config set --secret sessionSecret -s staging
pulumi config set --secret allowedEmails you@example.com,partner@example.com -s staging
```

For production, use the production OAuth client. To serve it on a custom domain instead of workers.dev:

```bash
pulumi config set customDomain expenses.example.com -s production
pulumi config set zoneId <zone-id> -s production
```

## Deploying services

CI (`.github/workflows/deploy.yml`) does this after the CI checks pass: every merge to `main` deploys **staging**; publishing a GitHub release with a `v*` tag on `main` deploys **production** (prereleases are skipped). To roll production back, re-run the Deploy run of an earlier release. To run it by hand:

```bash
pnpm --filter web build        # -> web/dist
pnpm --filter worker bundle    # -> worker/dist/index.js (wrangler dry-run build)
pnpm --filter worker exec wrangler d1 migrations apply expense-staging --env staging --remote
cd infrastructure/services && pulumi up -s staging
```

The program stops with a clear error if `worker/dist/index.js` or `web/dist` is missing. Override the paths with the `workerBundle` and `assetsDir` config keys (relative to the repo root).

## Rules

- **Foundation holds data.** D1 is `protect`ed. Never rename its resources or the D1 `name`, since either would replace the database. To retire one, remove `protect` in a reviewed change first.
- **Pulumi is the source of truth for deployed bindings.** `worker/wrangler.jsonc` is only for local dev, bundling and remote migrations. If you add a binding, add it in both places.
- **Keep `compatibilityDate` in sync** between `services` config and `wrangler.jsonc`.
- **Secrets go in Pulumi config with `--secret`.** Never commit them in plain text or use `wrangler secret put` against deployed Workers; the next `pulumi up` would overwrite them.
- **Emergency rollback:** `wrangler rollback --name <worker>` (`expense-tracker-staging` or `expense-tracker`), then redeploy a known-good commit through CI so Pulumi state matches again.
