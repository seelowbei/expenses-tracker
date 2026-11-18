# M4 implementation checklist

Design and decisions: [plan.md](plan.md). The user confirmed explicit review tracking on November 16, 2026; M4.1 is implemented and locally verified on November 17, 2026; M4.2 is implemented and locally verified; M4.3–M4.5 remain unstarted. File lists are likely locations, not permission to broaden scope. Split work further if a task needs more than roughly five substantive files.

## PR delivery order

| PR | Tasks |
| --- | --- |
| M4.1 — Browse the ledger | Task 1 read contracts; Tasks 3–5. |
| M4.2 — Edit and confirm existing entries | Task 1 write contracts; Tasks 2, 7–8. |
| M4.3 — Complete the review inbox | Tasks 6, 9 and review-inbox UI. |
| M4.4 — Add custom categories | Task 10. |
| M4.5 — Delete ledger entries | Task 11 and final combined verification. |

Task 1 decisions/contracts are resolved incrementally per PR. Task 12 verification and documentation run throughout; each PR must pass its own relevant checks before merge. Numbered tasks are identifiers; follow the delivery order above. Checkpoints below apply when their associated work is complete, even where task numbering differs from merge order.

M4.1 is merged; local evidence is in [M4.1 verification](../documents/M4.1%20verification.md). M4.2 completes the existing-entry part of Task 1, Tasks 2, 7–8 and Checkpoint C locally. Evidence and staging follow-ups: [M4.2 verification](../documents/M4.2%20verification.md). M4.3–M4.5 contracts remain to be resolved with their implementations. The November 18 M4.2 follow-up adds side-by-side image/PDF review, mobile pane switching and immediate Recent receipts status synchronization; local evidence is in the same verification document.

## Task 1 — Confirm decisions and define write contracts

**Description:** Reconcile the plan's API additions, review completion, deletion lifecycle, filtering and category rules with the technical spec, then define the human-edit contract using appropriate existing extraction field schemas.

**Acceptance criteria:**
- [x] Carry the confirmed `reviewed_at` decision and M4.2 existing-entry write proposals into the spec before dependent implementation. M4.3–M4.5 proposals remain scoped to their PRs.
- [x] Validate allowed fields, actual dates/time, safe integer amounts, nullable fields and explicit confirmation; reject unknown fields and define stable errors/body limits.
- [x] Export browser-consumable existing-entry contract types without Worker runtime dependencies; document response shapes and optimistic concurrency (read cursors documented in M4.1).

**Verification:** Focused contract tests, `pnpm --filter worker typecheck`, `pnpm --filter web typecheck`.

**Dependencies:** Plan review. **Scope:** Medium.

**Likely files:** Technical spec, `worker/src/contracts/ledger.ts`, `worker/test/ledger-contracts.test.ts`.

## Task 2 — Add review confirmation storage

**Description:** Add the user-approved nullable review timestamp without altering existing values or extraction behavior.

**Acceptance criteria:**
- [x] Add nullable `reviewed_at` through the next available additive migration; keep Drizzle and spec aligned.
- [x] Existing AI rows remain readable with null review time; pipeline behavior is unchanged; its column-complete insert explicitly writes null review time.
- [x] Local migration applies to both a fresh DB and a DB with existing entries, without data loss.

**Verification:** Local migrations only; worker typecheck and relevant DB/pipeline tests.

**Dependencies:** Task 1. **Scope:** Small/medium.

**Likely files:** `worker/src/db/schema.ts`, new migration SQL and generated migration metadata, `worker/test/db-helpers.test.ts`.

## Task 3 — Expose available categories

**Description:** Add the authenticated category read endpoint using the existing category visibility/resolution helpers.

**Acceptance criteria:**
- [x] Return system defaults plus the user's own categories, deterministically ordered.
- [x] Another user's categories never appear; existing slug collisions retain documented resolution behavior.
- [x] Missing session returns 401; DTOs expose only selector fields, not user information.

**Verification:** `pnpm --filter worker test -- test/categories.test.ts`; worker typecheck.

**Dependencies:** Task 1. **Scope:** Medium.

**Likely files:** `worker/src/api/categories.ts`, `worker/src/index.ts`, `worker/src/db/categories.ts`, `worker/test/categories.test.ts`.

## Checkpoint A — Contracts and data foundation

- [x] M4.1–M4.2 decisions and spec agree; no unresolved decision has been silently implemented.
- [x] Relevant tests and worker/web typechecks pass; existing upload/pipeline behavior still passes.

## Task 4 — Read ledger pages with complete totals

**Description:** Implement ledger list/detail queries, bounded filters and SQL totals across the full filtered result.

**Acceptance criteria:**
- [x] Sort by date/time with null times last and an ID tie-breaker; page boundaries do not skip or duplicate stable rows.
- [x] Totals group by category/month/currency over every matching row, not just the page; pending existing entries are distinguishable.
- [x] Scope entries, receipt joins and category selections to the user; enforce date/range/limit bounds and safe sums.

**Verification:** Ledger read tests cover two users, month boundaries, category filtering, mixed currencies, absent receipt links, null times and more than 50 entries; worker typecheck.

**Dependencies:** Task 1 read contracts and Task 3. No dependency on the review timestamp migration. **Scope:** Medium.

**Likely files:** `worker/src/db/ledger.ts`, `worker/src/api/ledger.ts`, `worker/src/index.ts`, `worker/test/ledger-read.test.ts`, contract module.

## Task 5 — Browse the ledger in the SPA

**Description:** Add the first working month/category ledger view while keeping upload and status behavior available.

**Acceptance criteria:**
- [x] Show currency-labelled totals, grouped entries, time when known, provisional review badges and accessible page navigation.
- [x] Show loading, empty and retry states; date/category changes reset pagination and fetch correctly scoped data.
- [x] Clear ledger caches/forms on sign-out or account change; receipt completion and ledger focus refresh data.

**Verification:** Worker/web typecheck and SPA build; Chrome check month/category changes, a second page, upload completion and account switching with synthetic data.

**Dependencies:** Tasks 3–4. **Scope:** Medium.

**Likely files:** `web/src/App.tsx`, `web/src/api.ts`, `web/src/ledger/LedgerView.tsx`, `web/src/ledger/format.ts`.

## Checkpoint B — Useful ledger

- [x] Full tests, worker/web typechecks and SPA build pass.
- [x] Browser shows correct totals for paginated multi-currency data and no cross-user cached content.

## Task 6 — Expose the full review backlog

**Description:** Extend receipt listing with pagination and provide safe detail for pending review, including invalid-output receipts with no ledger row.

**Acceptance criteria:**
- [ ] Review listing reaches older pending receipts beyond the current 50-row limit and does not depend on a valid transaction date.
- [ ] Detail returns the owned associated entry ID or a field-validated partial draft; malformed stored data fails safely and does not crash the page.
- [ ] Keep existing upload/list/poll DTO behavior compatible; other-user receipt/detail requests return 404.

**Verification:** Receipt review read tests include more than 50 receipts, no-entry invalid output, unsafe partial fields and two users; worker typecheck and existing receipt tests.

**Dependencies:** Tasks 1, 4. **Scope:** Medium.

**Likely files:** `worker/src/api/receipts.ts`, `worker/src/db/review.ts`, `worker/src/contracts/review.ts`, `worker/test/review-read.test.ts`.

## Task 7 — Save existing entries atomically

**Description:** Implement PATCH for corrections and explicit review confirmation, with concurrent-edit protection.

**Acceptance criteria:**
- [x] Save allowed fields and finish pending review in one conditional batch; preserve original extraction, reasons and usage.
- [x] Apply source/review-time rules, verify category ownership, preserve untouched optional fields and reject invalid currency/amount/date values.
- [x] Stale writes, active processing, failed batches and double submissions cannot overwrite newer values or partially finish review.

**Verification:** Focused write tests with D1 interleaving/failure cases and two-user/Origin tests; worker typecheck. Include unchanged confirmation, signed discount items and null time/tax.

**Dependencies:** Tasks 1–4. Uses ledger detail from Task 4; receipt review detail from Task 6 is not required. **Scope:** Medium.

**Likely files:** `worker/src/api/ledger.ts`, `worker/src/db/ledger.ts`, `worker/src/contracts/ledger.ts`, `worker/test/ledger-write.test.ts`.

## Task 8 — Review and edit existing entries

**Description:** Build the reusable editor opened from a ledger entry, including exact decimal input handling and clear original warnings. The separate pending-review inbox belongs to M4.3.

**Acceptance criteria:**
- [x] Edit every supported field, including time, tax, line items and notes; open the Drive original and confirm unchanged values explicitly.
- [x] Exact decimal-to-minor conversion handles SGD, JPY and a three-decimal currency; currency changes reconfirm amounts, and unsafe/over-precision values block save.
- [x] Keyboard/mobile use, dirty-close confirmation, retained form state on failures and conflicts work; successful save updates totals/review state without reload.

**Verification:** Pure conversion/form tests using the existing test tooling (no real AI), worker/web typecheck, SPA build and Chrome checks at phone/desktop widths. If wiring tests adds more files, split that small prerequisite first.

**Dependencies:** Tasks 5 and 7. **Scope:** Medium, split form logic from UI if needed.

**Likely files:** `web/src/ledger/EntryEditor.tsx`, `web/src/ledger/form.ts`, `web/src/ledger/LedgerView.tsx`, `web/src/api.ts`, focused pure-form test file.

## Checkpoint C — Existing-entry review works

- [x] Full tests, worker/web typechecks and SPA build pass.
- [x] Review saves correctly, including unchanged confirmation, and failed/conflicting saves preserve user input.

## Task 9 — Complete review when no entry exists

**Description:** Add conditional receipt-to-ledger creation and connect it to the shared editor. Integrate Task 6's paginated review inbox above the ledger, independent of month/category filters, with links to both existing-entry and missing-entry review. Implement the inbox UI as a separate focused commit within M4.3 if needed to keep each task small.

**Acceptance criteria:**
- [ ] Prefill only usable parsed fields, leave missing required values blank, and create exactly one `ai_edited` entry on valid save.
- [ ] Creation and receipt completion are atomic; double saves identify the existing entry without overwriting it, and a deleted completed entry cannot be recreated through this route.
- [ ] The receipt leaves pending review and appears in the correct month/category totals without a reload; original extraction remains intact.

**Verification:** Focused review-save tests including uniqueness, stale state, two users and injected DB failure; worker/web typecheck, SPA build and Chrome invalid-output review flow.

**Dependencies:** Tasks 6–8. **Scope:** Medium.

**Likely files:** `worker/src/api/receipt-review.ts` (mounted from receipt routes), `worker/src/api/receipts.ts`, `worker/test/review-save.test.ts`, `web/src/api.ts`, `web/src/ledger/EntryEditor.tsx`. Split DB helpers into a preceding task if the handler needs a separate module.

## Task 10 — Add a custom category

**Description:** Let the user create a category and immediately select it in the editor.

**Acceptance criteria:**
- [ ] Server generates the category ID/slug from a bounded name, including a non-ASCII fallback; no client-supplied user association.
- [ ] Duplicate or system-colliding names/slugs return a clear conflict; concurrent creates cannot produce duplicates.
- [ ] New category is immediately selectable and reaches subsequent extraction via existing category lookup; other users cannot select it.

**Verification:** Category route/helper tests and worker/web typechecks; SPA build and Chrome creation/duplicate flow. Verify extraction category inputs with a fake AI client.

**Dependencies:** Tasks 3 and 8; scheduled after M4.3 to prioritize completing review. **Scope:** Medium.

**Likely files:** `worker/src/api/categories.ts`, `worker/test/categories.test.ts`, `web/src/api.ts`, `web/src/ledger/CategoryCreate.tsx`, `web/src/ledger/EntryEditor.tsx`.

## Checkpoint D — Both review paths work

- [ ] Full tests, worker/web typechecks and SPA build pass.
- [ ] Both entry-backed and invalid-output review work, including custom categorization and correct currency totals.

## Task 11 — Delete an entry while retaining its receipt

**Description:** Implement deletion with the agreed terminal-receipt behavior and a clear UI confirmation.

**Acceptance criteria:**
- [ ] Confirmed deletion removes the ledger row and totals only; original Drive file, receipt metadata and usage remain, with pending review resolved atomically.
- [ ] Another user's ID, stale entry and failed batch are handled safely; a delayed queue delivery or old review form cannot recreate the row.
- [ ] UI explains Drive retention, handles cancel/retry/conflict, and refreshes ledger/review state without reload.

**Verification:** Deletion/queue-redelivery regression tests, `drive-no-delete.test.ts`, worker/web typechecks, SPA build and Chrome confirmation/failure flow. Assert no Google or AI calls occur.

**Dependencies:** Tasks 7–9. **Scope:** Medium.

**Likely files:** `worker/src/api/ledger.ts`, `worker/src/db/ledger.ts`, `worker/test/ledger-delete.test.ts`, `web/src/api.ts`, `web/src/ledger/EntryEditor.tsx`.

## Task 12 — Verify and document the milestone

**Description:** Run the relevant verification and documentation work in every PR, then exercise the combined M3/M4 experience with M4.5. Record evidence and remaining staging work; this is not a separate cleanup PR.

**Acceptance criteria:**
- [ ] Verify two-user isolation, upload-to-review-to-ledger, both review cases, exact money, time ordering, pagination, categories, deletion and a missing Drive original.
- [ ] Keyboard/mobile layouts and API failures remain recoverable; no receipt content/amounts appear in logs; all required checks pass.
- [ ] Update milestone status/spec/verification notes accurately and record M3 staging results only when supplied by the user.

**Verification:** `pnpm -r test`; worker/web/infrastructure typechecks; `pnpm --filter web build`; `pnpm --filter worker bundle`; real Chrome verification. Run the receipt eval only if agent files changed. After CI deployment, check new route CPU in staging and record migration/old-row compatibility.

**Dependencies:** Tasks 1–11; user-supplied M3 staging result for final staging sign-off. **Scope:** Medium verification/documentation.

**Likely files:** `AGENTS.md`, technical spec, milestone verification notes, this checklist.

## Checkpoint E — M4 complete

- [ ] Local automated and browser checks pass; review findings are addressed.
- [ ] Staging verification confirms migration, route CPU and M3/M4 flows after CI deployment.
- [ ] Documentation separates demonstrated behavior from open follow-ups; no M5 work has been added.
