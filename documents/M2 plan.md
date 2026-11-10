# M2 plan — Auth + Drive

Nov 10, 2026. Scope from the spec's milestones: Google sign-in, encrypted refresh tokens, folder creation, upload to Drive. Sources: spec sections "Data model", "Key flows" 1–2, "API", "Security & privacy", "Limits" (CPU), "Secrets".

**Done when:** on `localhost:8787` a user on `ALLOWED_EMAILS` signs in with Google, an `Expense Receipts` folder appears in their Drive, an uploaded JPEG/PNG/HEIC/PDF lands there as `YYYY-MM-DD_<receiptId>.<ext>`, and a `receipts` row with status `queued` and the Drive link exists in local D1. A non-allowed account is rejected; logout works; revoking access in Google turns `drive_status` to `disconnected` without losing data.

## Starting point

- Worker: Hono app with `/api/health` and `/api/dev/*` (M1), stub `queue` handler, `lib/sniff.ts` (magic bytes, 10 MB cap). Secrets are already typed in `worker-configuration.d.ts`, and Pulumi `services` already binds all five secrets. No infra changes needed for M2.
- Missing: `src/auth/`, `src/drive/`, `src/db/`, `migrations/`, Drizzle, arctic.
- **`web/` has no app yet**: only `public/` icons and an empty `dist/`. M2 scaffolds the SPA.

## Decisions (confirmed Nov 10, 2026: all proposals accepted)

**Library change during the build:** npm marks `arctic` and its `@oslojs/*` dependencies as "no longer supported". On your call to pick another library, M2 uses `oauth4webapi` 3.8.8 (zero dependencies, Web Crypto only, OpenID Certified). Spec "Tech stack" is updated.

1. **Queue in M2.** The upload flow ends by sending `{ receiptId, userId }` to `RECEIPT_QUEUE`, but the consumer is an M3 stub that retries 3× then dead-letters, leaving the receipt stuck in `queued`. **Proposal:** M2 sets `queued` but does not send; M3 adds the send together with the consumer. (Alternative: send now and make the stub ack without retrying.)
2. **Resumable upload (> 5 MB).** Browser resizing keeps images ~1 MB, so only large PDFs hit this. **Proposal:** defer `POST /api/receipts/resumable` and `/:id/complete` to M5; until then `> 5 MB` returns `413 file_too_large`.
3. **First migration = full spec schema.** **Proposal:** `0000` creates all six tables from the spec (incl. `ledger_entries`, `ai_usage`) and seeds the 13 default categories, so M3/M4 need no catch-up migration. Only M2 code touches `users`, `sessions`, `receipts`, `categories`.
4. **HEIC.** **Proposal:** include it, with the converter lazy-loaded in the browser only when a HEIC file is picked (no Worker cost). Could be deferred if you'd rather keep M2 lean.
5. **Logout scope.** API table says "Delete session"; Security says "Logout … delete all of the user's sessions". **Proposal:** follow Security (delete all), since there are only two users.

## Design notes (decided unless you object)

**Auth (`src/auth/`)**
- `oauth4webapi` with static Google endpoints (no discovery fetch); redirect URI = `APP_ORIGIN + /auth/google/callback`.
- State + PKCE verifier in a 10-minute `oauth_state` cookie (`Path=/auth`), HMAC-SHA256 signed with `SESSION_SECRET`, `HttpOnly; Secure; SameSite=Lax`. No `__Host-` prefix, to avoid local-dev surprises; `workers.dev` is on the Public Suffix List, so sibling Workers can't set cookies for this host anyway.
- Google's granular consent lets users untick Drive: the callback rejects a grant without `drive.file` (`drive_scope_missing`).
- ID token: decoded, not signature-checked. It comes straight from Google's token endpoint over TLS, which OIDC allows. Check `iss`, `aud`, `exp`, `email_verified`, then the allow-list (case-insensitive) → otherwise `302 /?error=not_allowed`, nothing stored.
- `prompt=consent` only when needed: the first redirect omits it; if the callback gets no refresh token and the user has none stored (or is `disconnected`), redirect once more with consent.
- Refresh token: AES-GCM, `v1:<iv>:<ct>` (base64), key from `TOKEN_ENC_KEY`. Pure module with tests.
- Sessions: 32 random bytes (base64url) in cookie `session`; D1 stores SHA-256 hex. 30-day expiry; sliding renewal only when < 15 days remain, so normal requests do no D1 write.
- Middleware on `/api/*` (except health/dev): resolve session → `c.var.user`. Origin check on POST/PATCH/DELETE under `/api/*` and `/auth/logout` → `403 bad_origin`.
- Local: `Secure` cookies on `http://localhost` work in Chrome/Firefox; Safari may drop them. Test in Chrome.

**Drive (`src/drive/`)**
- Small fetch-based client with injectable `fetch` (tests use fakes, no network): `ensureFolder`, `uploadMultipart`, token refresh.
- Access tokens cached in a module-level `Map<userId, {token, exp}>` (per isolate, never stored).
- Folder: created after sign-in if `drive_folder_id` is empty. If an upload fails with 404 on the parent (user deleted the folder), recreate it once and retry.
- `invalid_grant` or Drive 401 after a refresh → `drive_status='disconnected'`, delete all the user's sessions, receipt `failed` with `error='drive_disconnected'`; ledger rows untouched.
- Multipart body built as a `Blob` of parts (no extra copy).

**Upload (`POST /api/receipts`)**
- `formData()` → size ≤ 5 MB → `sniffMime` → `crypto.subtle.digest` → insert `uploading` → Drive upload → `queued` + `drive_file_id`, `drive_link` → `202`.
- Duplicate: `409 duplicate_receipt` with the existing id, **except** when the existing row is still `uploading`/`failed` with no `drive_file_id` (an earlier Drive failure). Then reuse that row and retry, so a failed upload never blocks re-upload.
- Drive 429/5xx → receipt `failed`, `502 drive_unavailable`; the browser still holds the file and can retry.

**API added in M2:** `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/logout`, `GET /api/me`, `POST /api/receipts`, `GET /api/receipts?status=`. All queries filter by the session's `user_id`. Errors use stable codes.

**DB (`src/db/`)**: Drizzle schema mirroring the spec, `drizzle-kit generate` for SQL, hand-appended seed `INSERT`s (system category ids `sys_<slug>`, `user_id NULL`). Query helpers per table.

**Web (`web/`)**: Vite + React + TS + TanStack Query + Tailwind. Screens: signed-out (Sign in with Google, `not_allowed` message), signed-in (name, Drive status / Reconnect, upload picker, recent receipts list with status and Drive link), logout. Browser: type/size check, HEIC → JPEG, resize to 2000 px long edge at ~0.8 quality via canvas.

**Logging:** receipt ids, statuses, error codes only.

## Tasks (in order, each ends green on typecheck + tests)

1. **DB.** Add `drizzle-orm`, `drizzle-kit`; schema; migration `0000` + seeds; apply locally. Test harness: D1 in vitest with migrations applied (`readD1Migrations`/`applyD1Migrations`).
2. **Crypto helpers.** Token AES-GCM, signed state cookie, session token hashing. Unit tests (round-trip, tamper, wrong key, malformed `v1:` strings).
3. **Sessions + middleware.** Create/lookup/renew/delete; auth and Origin middleware. Tests with D1.
4. **OAuth routes.** Add `arctic`; `/auth/google`, callback, logout, `GET /api/me`. Tests with a fake token endpoint: allow-list rejection, bad state, missing refresh token → consent retry, user upsert, folder creation.
5. **Drive client.** Token refresh + cache, `ensureFolder`, `uploadMultipart`, `invalid_grant`/401/404/429 handling. Tests with fake fetch.
6. **Receipts API.** `POST`/`GET /api/receipts`, duplicate and retry-after-failure paths. Tests.
7. **Web SPA.** Scaffold, sign-in, `/api/me`, upload with resize/HEIC, receipts list. `pnpm --filter web build`.
8. **Manual check (you).** `pnpm --filter worker dev`, sign in at `localhost:8787` in Chrome, upload one of each type, confirm Drive files; try a non-allowed account; revoke at myaccount.google.com → permissions and confirm reconnect prompt.
9. **Docs.** Update AGENTS.md status, spec "Spec revisions" for any decision above that changes the spec, and README/setup notes.

**Build status (Nov 10, 2026):** tasks 1–7 and 9 done. 111 worker tests pass (93% lines); worker, web and infrastructure typecheck; Worker bundle 145 KiB gzipped. Locally verified: signed-out page, 401 on `/api/*` without a session, sign-in redirect with exact scopes + PKCE. **Task 8 (real Google sign-in and upload) is yours.** The SPA does not poll yet (nothing leaves `queued` before M3).

Not in M2: queue consumer and send, extraction, ledger, categories API, resumable upload, staging deploy (needs the staging redirect URI on the dev client and Pulumi secrets set; M5 or whenever you choose to push).
