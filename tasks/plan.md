# M4 plan — Ledger and review

November 18, 2026. **M4.1 and M4.2 are merged. M4.3 is implemented and locally verified on `codex/m4-3`; PR review and staging checks remain. M4.4–M4.5 remain planned.**

Source: [Technical spec](../documents/Expense%20Tracker%20%E2%80%94%20Technical%20Spec.md), especially “Data model”, “Key flows → Review and ledger”, “Evaluation before launch”, “API”, and milestone M4. Implementation checklist: [todo.md](todo.md).

## Outcome and scope

Users can browse their own expenses by month and category, see totals separately for each currency, review extraction results, correct fields including transaction time, add categories, and delete ledger entries while retaining their Drive originals. Both review paths must work: editing an existing AI entry and creating an entry from a receipt whose extraction remained invalid.

M3 is merged, per the user. The user will verify M3 on staging after deployment; that verification remains open and is not a prerequisite for writing this plan. Record its outcome before calling the full M4 flow verified on staging. The latest combined eval missed the total-accuracy target, making review/edit the first priority after the minimum ledger browsing foundation.

M4 does not include manual expense creation without a receipt, category rename/delete, exports, budgets, FX conversion, an AI usage dashboard, a model fallback, resumable upload, or other M5 work. No new Cloudflare services or bindings are expected. No extraction prompt changes are planned.

## Current implementation

- `worker/src/db/schema.ts` already has ledger entries, categories, receipt review reasons and raw extraction. Ledger entries have nullable transaction time, notes and receipt association; a unique receipt ID prevents duplicate entries.
- `worker/src/db/categories.ts` already returns system defaults plus the signed-in user's categories. Custom categories take precedence over system categories with the same slug when resolving AI output.
- `worker/src/pipeline/process.ts` inserts valid AI results, including results requiring review. Invalid output has no ledger row. The consumer claims only queued/processing receipts; terminal receipts are ignored, and writes are guarded by attempt number.
- Category listing, bounded ledger list/detail and existing-entry PATCH are implemented alongside `/api/me` and the receipt routes. Receipt listing now supports bounded cursor pagination; detail exposes the owned entry ID or a validated draft, and receipt review creates missing entries atomically.
- `web/src/App.tsx` contains sign-in, uploads, recent receipts and bounded status polling. `web/src/api.ts` holds typed calls; `web/src/ledger/` provides browsing and an existing-entry editor. Pure form/money logic is tested by the existing Worker test runner; browser verification uses synthetic data.
- Workerd tests already supply authenticated users, fake Google/AI clients and D1 interleaving helpers. Reuse them for isolation and concurrent-write cases.

## Decisions and proposals

Explicit review confirmation tracking was accepted by the user on November 16, 2026. M4.1 read behavior was adopted for implementation and recorded in the technical spec. The M4.2 existing-entry write proposals were adopted with the November 17 implementation request and recorded in the technical spec. The M4.3 review contracts were adopted with the November 18 implementation request and recorded in the spec. Remaining M4.4–M4.5 details below are proposals filling gaps in the spec, not previously accepted requirements. Reconcile them in the technical spec before dependent implementation. The existing M4 requirements above remain authoritative.

### 1. Complete the review API

Keep the specified ledger and category endpoints. Add narrowly scoped detail and review-save routes rather than overloading an entry ID with a receipt ID:

| Route | Contract / purpose |
| --- | --- |
| `GET /api/categories` | System defaults and this user's custom categories. |
| `POST /api/categories` | Create a custom category from a display name; server owns ID, slug and user association. |
| `GET /api/ledger?from=&to=&category=&cursor=&limit=` | Entry summaries plus SQL totals for the complete filtered range, with a separate next-page cursor. |
| `GET /api/ledger/:id` **(addition)** | Full editable entry, receipt link and original review reasons. Load line items only when opening an entry. |
| `PATCH /api/ledger/:id` | Edit allowed fields, or explicitly confirm a review without changing values. Atomically finish any associated pending review. |
| `DELETE /api/ledger/:id` | Remove the entry from D1 and resolve any associated pending review, keeping receipt metadata and Drive file. |
| `GET /api/receipts?status=needs_review&cursor=&limit=` **(extension)** | Paginated review backlog, independent of the ledger month/category filters. Preserve existing clients and response fields. |
| `GET /api/receipts/:id` **(addition)** | Receipt metadata, associated entry ID if present, and a field-validated partial draft for invalid output. |
| `POST /api/receipts/:id/review` **(addition)** | Create the missing entry for `needs_review` / `invalid_output`; return 201. Existing entries use PATCH. |

Keep current receipt DTO casing. New ledger request fields use the spec's names (`txn_date`, `txn_time`, `category_id`, `total_minor`, etc.). Export contract types for browser calls without importing Worker bindings or database modules into the SPA. Compose appropriate field constraints from `Extraction.shape`; human edits need their own request schema, not fabricated AI confidence or `total_text`.

All new routes sit behind the current session and Origin middleware. User IDs come only from the session; joins also scope the receipt/entry to that user, and category IDs must belong to the user or the system defaults. Unknown and other-user resources both return 404. Reject unknown write properties, malformed JSON, invalid field values and oversized bodies using stable codes and field names, never echoed receipt content.

### 2. Make review completion explicit

**Confirmed by the user, November 16, 2026:** add a nullable `ledger_entries.reviewed_at` timestamp through an additive migration. It records an explicit “Save review”, including confirmation without edits. Merely rendering an entry does not count as review. This answers the spec's requirement to measure accuracy only on entries users have checked; the current schema cannot distinguish an untouched AI entry from one confirmed unchanged.

On successful review save:

- Validate human-entered fields, then atomically update/create the entry and move the receipt from `needs_review` to `done`; clear its active error and retry time.
- Preserve `raw_extraction`, original `review_reasons`, confidence and `ai_usage` as extraction evidence. Render retained reasons as original warnings only; current review state is determined by receipt status.
- An actual correction changes `source='ai'` to `ai_edited`; an unchanged confirmation keeps `ai`. Creating the missing entry sets `ai_edited`. Already edited entries keep that source. Set `reviewed_at` and `updated_at` on explicit confirmation.

The form never edits source, user IDs, confidence, receipt IDs, audit fields or timestamps directly.

### 3. Deleting an entry keeps its receipt as a terminal record

Propose retaining the receipt, duplicate hash, raw extraction, original review reasons, usage records and Drive link. If the entry was awaiting review, the deletion also changes its receipt to `done` and clears the active error/retry time in the same D1 batch. The UI labels a receipt with no entry as “No ledger entry”; it must not claim it was reviewed or offer a new review form just because an entry is absent.

The confirmation says the expense leaves the ledger and totals but the Drive file remains. There is no undo in M4. Re-uploading identical bytes still returns the existing duplicate receipt; deletion does not silently enable extraction again. A repeated delete returns 404 once absent. Invalid-output receipts without an entry have nothing to delete in M4; users complete their review first.

### 4. Keep browsing bounded and totals complete

- Default to the current calendar month in the browser, with month navigation, an optional category filter and a date-range control. Date filters are inclusive `YYYY-MM-DD`; reject impossible dates or reversed ranges. The default API range is the current UTC calendar month when both bounds are omitted; the browser normally supplies both bounds. Require both when either is supplied. Propose a maximum range of 12 calendar months per request.
- Propose pages of 50 entries, capped at 100. Sort newest date first, then latest time first, null times last within the day, then ID for deterministic ties. Cursors include the complete ordering position; changing filters resets them. Transaction times remain the local printed time, with no timezone conversion.
- Compute totals in D1 by `category_id`, month and currency over the complete filtered range, independent of page size. Include existing `needs_review` entries, visibly marked as provisional. Invalid-output receipts without entries contribute nothing. Never sum across currencies or convert FX.
- The review section above the ledger loads `status=needs_review` directly, with its own cursor, so receipts missing a date or older than the newest 50 are still reachable. Show each pending receipt once there; a matching ledger row can remain highlighted in its category group without being counted twice.
- The listing omits raw extraction and line items; details are fetched on demand. Guard integer sums before JSON serialization; fail with a stable error rather than returning rounded, unsafe numbers.

### 5. Human input and categories

The editor covers merchant, date, optional time, currency, total, optional tax, category, payment method, line items and notes. Empty optional values become null; blank required values block saving. Validate actual calendar dates and `HH:MM`. Do not prevent a user correcting an old receipt merely because it was flagged by the AI's date-range heuristic.

Money inputs stay decimal strings until converted exactly to safe integer minor units with the currency exponent. Reject excess fractional digits rather than silently rounding, and support zero- and three-decimal currencies as well as SGD/USD. Totals and tax stay nonnegative, as in extraction; signed line-item amounts support discounts. Cap line items at the existing 50 and impose modest text/body limits. Currency changes require explicit reconfirmation of all monetary fields; never reinterpret saved cents as yen or perform an FX conversion. Validate a real supported currency and reject the pipeline's `XXX` placeholder on human save.

Do not make human confirmation depend on reproducing the model's total-text or line-item heuristics. Display the original warnings; the user can confirm a valid corrected total even if the original extraction remains inconsistent. Save normalized line items as `{ description, amount_minor }`, matching current persistence.

Propose custom category names of 1–60 trimmed characters, slug generation on the server, and rejection of duplicate names/slugs against the user's visible categories (409 `category_exists`). For names without a usable ASCII slug, use a stable server-generated suffix. New categories cannot shadow system slugs; existing colliding categories remain readable and retain the current resolver precedence. No category rename/delete UI. Creating a category refreshes the selector immediately; the next extraction uses it through the existing category lookup.

## Writes, recovery and concurrency

Use Drizzle conditional writes in D1 batches for ledger/receipt state changes. A pre-read followed by unconditional writes is insufficient. Only terminal `done`/`needs_review` receipt associations are editable/deletable; queued/processing records return 409 `receipt_busy`.

For missing-entry review, creation must be conditional on the same user's receipt still being `needs_review` with `invalid_output`, with no entry. Keep the receipt uniqueness constraint as the final guard. A duplicate submission returns 409 `review_already_saved` with the current entry ID, which the UI fetches; it must not overwrite the winning values. A request after that entry was deleted returns 409 `not_reviewable`, never recreating it. Any failed batch leaves the prior review state and form data recoverable.

For existing-entry edits/deletion, propose an `expected_updated_at` precondition supplied from the loaded entry. Apply it in the write predicate and return 409 `entry_changed` for stale state. Advance `updated_at` strictly, even for two writes within the same clock millisecond. A repeated save after a lost response reloads the server state; it does not blindly resubmit. An empty PATCH is invalid unless it explicitly requests review confirmation.

On a save/delete error retain the form, show a recoverable message and refetch on conflict without discarding unsaved values. Confirm destructive actions in the UI, disable duplicate submits, and announce success/error accessibly. Session expiry returns the user to sign-in. Query caches and unsaved forms must clear on sign-out/account change so the second user cannot see the first user's ledger.

## UI structure and refresh

Keep the existing upload and status experience. Add a ledger section with month/category controls, currency-labelled totals and grouped entries, with the pending review section above it. Use a focused edit/review panel that works as a full-width form on phones and a bounded panel on desktop. November 17 user feedback adds a side-by-side original preview: an authenticated read-only route streams the Drive file to a browser image/PDF viewer. The Worker never buffers, parses or transforms it. Keep the existing Drive link as a fallback; preview failures must not block editing.

Extract new UI components from `App.tsx` as the slices require; avoid an unrelated application rewrite or router dependency. Use labelled form controls, visible keyboard focus, focus restoration when closing the editor, clear field errors and a dirty-form close confirmation. Include loading, empty, retryable error and stale-conflict states in light and dark themes.

Keep the existing three-second receipt polling and 15-minute cap. When an observed receipt becomes `done`/`needs_review`, invalidate ledger summaries and the review backlog; opening/refocusing the ledger also fetches current data. Edits, review saves and deletes invalidate both the prior and new filter scopes, totals, receipt detail and review queue. Category creation invalidates category queries. Ordinary listing does not call Workers AI or Drive.

## M4.3 execution plan — November 18, 2026

Branch: `codex/m4-3`, created from `origin/main`. Implementation and local verification are complete; PR review and staging remain. This implements Tasks 6 and 9, preserving M4.4/M4.5 scope and prior staging follow-ups. Contracts were adopted in the technical spec before dependent code. Evidence and verification limits: [M4.3 verification](../documents/M4.3%20verification.md).

**Outcome:** every pending receipt is reachable, including missing-date/invalid-output receipts. A user can review an existing entry or create a missing entry exactly once, then see the inbox and currency-separated totals update without reloading.

### Adopted contracts

| Operation | Behavior |
| --- | --- |
| `GET /api/receipts?status=needs_review&cursor=&limit=` | Preserve receipt fields; add `nextCursor`. Default 50, cap 100; strict positive integer limits. Order by `created_at DESC, id DESC`; fetch one extra row for pagination. No transaction-date dependency. |
| Existing receipt listing | Keep absent/comma-separated status behavior and the default newest 50. Pagination is additive. Bounded, validated cursors contain the ordering position and normalized status filter; reject filter mismatches. Preserve `invalid_status`; use `invalid_filters` for bad pagination. |
| `GET /api/receipts/:id` | Return `{ receipt, entryId, draft }`. Receipt metadata retains camelCase; `entryId` is owned or null. `draft` contains partial human fields using ledger names, only for eligible missing-entry review; otherwise null. Never return raw extraction. |
| `POST /api/receipts/:id/review` | Strict complete `LedgerFields` body, capped at 32 KiB streamed bytes. Return `201 { entry }` using `LedgerDetail`. No client-supplied version, confidence, source or audit fields. Existing entries use PATCH. |

All reads/joins use the session user; categories must be system defaults or owned. Unknown/foreign resources return `404 not_found`; writes retain Origin checks. Reuse `invalid_json`, `invalid_body` (field paths only) and `body_too_large` conventions.

**Safe drafts:** parse stored extraction only on detail requests, with a 64 KiB input bound. Null, malformed, oversized or non-object JSON yields an empty draft so manual completion remains possible. Validate each recognized field independently against human-edit constraints; omit invalid/unknown fields. Impossible dates, blank merchants, unsupported currencies and unknown category slugs stay blank. Resolve category slugs through the existing visible-category resolver, preserving custom-category precedence. Preserve explicit optional nulls. Never silently fill missing required values with today's date, zero, default currency or `Other`.

Extraction amounts are decimal numbers; human saves use minor units. Convert only with a supported extracted currency and exact safe conversion. Omit over-precision/unsafe values instead of rounding; test exponent notation and zero-/three-decimal currencies. Without valid currency, omit monetary prefill. Validate a line-item collection as a whole (maximum 50, bounded descriptions, safe signed amounts); omit a malformed collection rather than silently dropping charges. Do not reuse the pipeline's rounding conversion for this path. Keep new draft logic outside `src/agent/`.

Malformed stored review reasons must also fail safely in receipt DTO conversion: return absent warnings while retaining the invalid-output status explanation and stored evidence. Lists select metadata only, never raw extraction/line items. Ordinary list/detail/save routes call neither AI nor Drive; the optional existing preview alone fetches Drive.

**Atomic creation:** require the owned receipt to still be `needs_review`, have `error='invalid_output'`, and have no entry at write time. Use a conditional insert and receipt completion in one D1 batch; gate completion on that insert's success. Retain receipt uniqueness as the final guard and check category visibility in the write predicate. Prove this with workerd tests before UI integration, reusing the existing guarded insert/batch patterns where possible.

Generate ID/timestamps server-side; write `source='ai_edited'` and `reviewed_at`/`created_at`/`updated_at`. Store null confidence because there was no validated full extraction. Preserve raw extraction, original reasons, usage and Drive metadata; clear active error/retry time and set `done`. Both statements roll back on failure. No migration is expected.

An existing owned entry returns `409 review_already_saved` with `entryId`; never overwrite it. Other ineligible states, including a completed receipt whose entry is absent, return `409 not_reviewable`. Scope conflict lookups by user. Test status/category races at the batch boundary, simultaneous submissions, lost responses, deletion-shaped terminal fixtures and delayed queue delivery. M4.3 does not implement deletion.

### UI and recovery

Add a review section above the ledger, independent of month/category filters. Each receipt appears once per page, labelled with upload date/status and Drive link; load expense details on opening. Provide Previous/Next and Refresh. Reset to the first page after a confirmed save. All queries are account-scoped; cancel pending review/detail reads before publishing saved state so stale results cannot restore a pending item.

Reuse `EntryFields`, `ReceiptPreview` and the existing dialog layout. Give `EntryEditor` explicit existing-entry and missing-entry inputs instead of fabricating `LedgerDetail` for a draft. Extract only the shared form serialization needed by both modes. Preserve PATCH concurrency, exact money inputs, currency reconfirmation, original warnings, mobile panes and dirty-close protection. Selecting currency for a blank draft requires checking entered amounts, without reinterpreting them.

On duplicate/uncertain save, retain the form and reload receipt detail. If another save won, fetch its entry and show the existing comparison flow; a later overwrite requires an explicit version-guarded PATCH, never an automatic POST retry. If still eligible, retry requires a successful reload and explicit user action. If no longer eligible, retain the draft with an explanation and disable creation. Preview failure never blocks editing. Clear forms/caches on account change or session expiry.

Extend receipt-completion invalidation to review/detail queries while preserving the three-second polling interval and 15-minute cap. Confirmed saves update Recent receipts immediately, remove the pending item and invalidate all ledger filter/totals scopes. Empty pages caused by concurrent reviews offer a first-page refresh. Cursors work even when the anchor receipt leaves pending review; refresh discovers newly pending receipts. No snapshot-consistency guarantee is proposed for a changing inbox.

### Increment order

The checklist in `todo.md` defines slices **4.3-0 through 4.3-8**: contracts → safe detail → atomic creation → pagination → shared form → editor → cache synchronization → inbox → final verification. API prerequisites deliberately come first because draft safety and concurrent creation are the highest risks. Every commit remains compilable and testable through its API or existing UI; expose new review actions only when the save path works.

For each implementation slice: implement one logical change, run focused tests and affected typechecks/build, inspect the result, then commit before expanding. Split again if more than roughly five substantive files or a large unverified change is needed. Do not repeat successful checks on unchanged code. Keep one M4.3 PR; intermediate commits are not separately merged/deployed, so no feature flag or new binding is needed. Work sequentially; no parallel agents are needed.

At the API checkpoint verify isolation, compatibility, conditional creation and rollback. At the UI checkpoint verify both review paths using synthetic data, over 50 receipts and missing-date drafts. Finish repository tests, worker/web/infrastructure typechecks, SPA build, Worker bundle and Chrome checks. Tests use fake AI/Drive clients. Record staging CPU verification against the 10 ms budget separately; local tests cannot establish production CPU. No agent changes are planned; run the receipt eval if that scope changes.

Rollback is a code revert: no destructive/down migration, infrastructure change or Drive mutation. Already-created entries remain valid ledger data. Custom categories, deletion UI/API, manual expenses, extraction changes and M5 stay out of scope.

**Contract adoption:** DTOs, cursor behavior, draft omission and save/conflict semantics were recorded in slice 4.3-0 before implementation. Existing M3/M4.2 staging follow-ups remain separate; this plan does not claim them complete.

## Recommended PR split

Ship five PRs in this order. Each PR includes its own spec updates, tests, browser verification and staging smoke check. Task numbers below refer to [todo.md](todo.md); they are work-item identifiers, not the merge order. Resolve only the proposals needed for the current PR and define contracts as their endpoints are implemented.

| PR | User-visible result | Scope and task mapping | Main acceptance check |
| --- | --- | --- | --- |
| **M4.1 — Browse the ledger** | See expenses by month/category, with totals separated by currency. | Read contracts from Task 1; Tasks 3–5: category listing, ledger list/detail, pagination, filters and read-only UI. No migration needed. | More than one page of entries still produces complete totals; dates/times order correctly; two users remain isolated. |
| **M4.2 — Edit and confirm an existing entry** | Open an entry from the ledger, correct its fields or confirm it unchanged. | Write contracts from Task 1; Task 2 and Tasks 7–8: `reviewed_at` migration, PATCH, reusable form, exact money handling and stale-edit protection. Existing `needs_review` entries can be resolved directly from the ledger. | Saving updates totals and review state atomically; unchanged confirmation records review; a stale tab cannot overwrite newer edits. |
| **M4.3 — Complete the review inbox** | Reach every pending receipt and recover receipts that have no ledger entry. | Tasks 6 and 9 plus the review-inbox UI: paginated pending list, receipt detail, safe partial prefill and conditional entry creation using the existing editor. | An old receipt with no valid date is reachable; completing it creates exactly one entry and clears pending review. |
| **M4.4 — Add custom categories** | Create a category and immediately assign it to an expense. | Task 10: category creation API, duplicate handling and form integration. | New category is selectable, private to the user and available to subsequent extraction. |
| **M4.5 — Delete ledger entries** | Remove an expense while retaining its receipt and Drive original. | Task 11: conditional deletion, terminal-receipt behavior, confirmation and refreshed totals. Finish the combined Task 12 verification. | Delete removes the total, preserves the Drive file and cannot be undone accidentally by delayed extraction or an old review submission. |

M4.2 is the largest PR because validation, persistence and the editor must agree. Keep it to existing-entry editing: the backlog query, partial extraction handling, create-on-review route, category creation and deletion belong in later PRs. Use focused commits within each PR; the roughly five-file guideline applies to an implementation task, not an entire PR.

Merge sequentially and branch each PR from the latest `main`; each merge deploys a usable increment to staging. M4.4 and M4.5 have no feature dependency on one another, but sequential work avoids overlapping editor changes. Review/edit actions for invalid-output receipts are exposed in M4.3, once their save path exists; M4.1 and M4.2 keep the existing status message for those receipts.

Task 12 is a running verification/documentation checklist, not a separate cleanup PR. Run relevant checks and update documentation in every PR, then perform the combined milestone check with M4.5. Do not defer isolation, money correctness or failure handling to the last PR. The user's pending M3 staging verification remains separate.

## Implementation tasks

Detailed acceptance criteria, likely files, dependencies and checks are in [todo.md](todo.md).

1. Resolve proposals and define validated contracts.
2. Add the confirmed explicit review tracking.
3. Expose visible categories.
4. Implement bounded ledger reads and complete totals.
5. Add the minimum ledger browsing UI.
6. Expose the complete review backlog and safe receipt detail.
7. Implement editing and confirmation of existing entries.
8. Build the shared review/editor form.
9. Complete missing-entry review end to end.
10. Add custom category creation.
11. Implement entry deletion end to end.
12. Verify the combined flows and update project documentation.

Use the PR sequence above to order these tasks: a useful ledger first, then existing-entry editing, then the complete review inbox, then category creation/deletion. Keep each task independently reviewable; split it before coding if its concrete change exceeds roughly five substantive files. No parallel agents are needed for this plan.

## Verification and completion

Each implementation slice runs the affected worker tests, worker/web typecheck and the SPA build where relevant. Full checkpoints run `pnpm -r test`, worker and web typechecks, and `pnpm --filter web build`. Run infrastructure typecheck at final verification; use `pnpm --filter worker bundle` for the deployment artifact. No real AI calls in unit tests. If any file under `worker/src/agent/` changes, rerun the required receipt eval against the local server and report its results separately from functional checks.

Use real Chrome checks against the built SPA for month/category navigation, keyboard/mobile editing, conflicts, preserved form state after failure, review disappearance after save, refreshed totals, category creation and delete confirmation. Use synthetic data for screenshots or browser mocks. Do not transmit real receipts to a browser-testing service or external model.

Completion requires both users' isolation verified, both review paths completed without a reload, exact currency handling, null-time ordering, pagination with complete totals, no resurrection after deletion or delayed queue delivery, and no Drive mutations. Test injected D1 failures for atomicity. Exercise a missing/disconnected Drive case: an existing authenticated user can still read/edit D1 data without fetching the file. For a revoked session, sign-in remains required.

After CI deploys M4, check representative ledger read and edit CPU against the project's 10 ms budget in staging. Check migrated legacy rows (`reviewed_at` null) and M3 upload/poll/retry regression behavior. The user owns the pending M3 staging check; do not mark it complete from local evidence.

## Main risks and open decisions

| Risk / decision | Plan response |
| --- | --- |
| Invalid output has no entry ID and may have no valid date | Dedicated receipt review creation and a filter-independent backlog. |
| Deletion could surface a new review or allow recreation | Retain terminal receipt; condition every creation on pending invalid-output state. |
| A save races another tab, a delete or a repeated request | Conditional writes, atomic batches, uniqueness and explicit conflicts. |
| Reviewed and untouched AI values are indistinguishable | Nullable `reviewed_at` on explicit confirmation, accepted by the user. |
| Decimal/currency mistakes change expense values | Exact string conversion, safe integer checks and explicit currency reconfirmation. |
| Large lists exceed CPU/response bounds | Pagination, SQL aggregates, bounded ranges and detail-on-demand; verify in staging. |
| Spec lacks new route, deletion lifecycle and review-tracking details | Review these proposals and update the spec before dependent code. |

M4.2 local evidence and staging follow-ups: [M4.2 verification](../documents/M4.2%20verification.md). Deployment remains CI-only; no infrastructure mutation or deployment was performed during implementation.
