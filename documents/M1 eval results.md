# M1 eval results

Model: `@cf/meta/llama-3.2-11b-vision-instruct` through the real agent (`worker/src/agent/`), run with `pnpm --filter worker eval` on 10 Nov 2026.

## Decision

**Provisional go.** Only 10 local receipts are available, so the eval is not the 50-receipt set the spec planned. At this size one miss is 10 points, and 9/10 is consistent with true accuracy anywhere from about 60% to 98%. Rather than wait for more receipts:

- The 10 labelled receipts stay in `worker/eval/receipts/` (git-ignored) as a regression set. Re-run the eval after every prompt, schema or normalisation change.
- Real accuracy is measured from the user's own corrections once the pipeline and ledger UI exist. See "Evaluation before launch" in the spec.
- The fallback stays as specced: an external vision model via AI Gateway for `needs_review` cases, if corrections show the model is too weak.

## Test set

10 receipts from Singapore, all images (9 SGD, 1 USD):

- 6 photos of thermal paper (one faded, one with the date only in a POS footer stamp)
- 4 digital receipts or screenshots (email receipts, delivery and ride-hailing apps)

Plus 2 text PDFs (email receipts from booking sites: one in SGD, one in JPY), added after the image runs. See "PDF path" below.

## Results (final run)

| Field | Accuracy | Target |
| --- | --- | --- |
| merchant | 90% (9/10) | |
| txn_date | 90% (9/10) | 90%: pass |
| txn_time | 89% (8/9) | none |
| total | 90% (9/10) | 90%: pass |
| tax | 60% (6/10) | |
| currency | 100% (10/10) | |
| category | 80% (8/10) | |

- Merchant, date and total all correct: 7/10.
- Status: 8 `done`, 2 `needs_review`, no failures.
- 1.1 LLM calls per receipt, with a 10% repair rate. Average latency about 7 s.
- About 7,700 input and 150 output tokens per receipt. The image is almost all of the input.
- **About 43 neurons per receipt, which is roughly 230 receipts a day on the free 10,000-neuron cap.**

## What changed to get there

The first run scored 60% on date. The model copied the prompt's example date into answers and reordered day/month wrongly even when told to prefer DD/MM. A clearer prompt made it worse (40%). The model now copies the date exactly as printed, and code converts it (`normalizeDate` in `worker/src/agent/parse.ts`). Unknown payment methods such as "Apple Pay" made one receipt fail outright; they are now mapped in code.

## Known failure types

- **Confidence is always 1.0.** The 0.7 threshold never triggers. Review checks in code replace it (see below).
- **Total:** a delivery-app receipt returned the subtotal before a voucher. The review checks now catch this.
- **Tax:** returns `0` when no tax is printed instead of `null`, and took a fuel surcharge as tax.
- **Date:** a faded thermal receipt was misread (09 → 19). No prompt or code change can fix that.
- **Time:** used the "Print @" time once, despite the prompt rule.
- **Merchant:** a receipt with the brand only as a logo (Chinese calligraphy) returned the legal entity name.
- **Category:** falls back to `other` for less obvious cases.

## PDF path

Two text PDFs went through `toMarkdown()` and then the same model as text.

- **Cheaper and faster than images:** about 1,700 input tokens and 16–25 neurons per receipt, against about 7,700 and 43 for images.
- **The flight booking:** extracted correctly. It used the issue date rather than the flight dates.
- **The hotel booking:** first run, the model copied the stay date range as the date and failed twice. After the date rule named payment/issue dates and excluded travel dates and ranges, the date was right. The total came back garbled (two digits swapped), and `total_mismatch` caught it against the copied line.
- **Scanned PDFs:** none tested yet.

## Run-to-run variation

Results vary between runs even at temperature 0. In the 12-receipt run, a receipt that was right three times before returned its first line item as the total, and copied an unrelated line as `total_text`. Total accuracy for that run was 75% (9/12). This is one more reason not to treat a 10-receipt score as stable.

## Review checks

Model confidence can't route receipts to review, so the model now also copies the line it read the total from (`total_text`). Code flags `needs_review` when:

- **`total_mismatch`:** the line shows a different amount (tax amounts ignored).
- **`total_unverified`:** the line has neither an amount nor a total word, or is missing.
- **`total_is_subtotal`:** it's a subtotal line.
- **`repaired`:** the extraction needed a repair call.

These run alongside the existing checks: unknown category, date out of range, line items not adding up.

Replaying two runs' extractions through the final checks:

| Run | `done` (merchant, date and total all correct) | `needs_review` (any of those wrong) |
| --- | --- | --- |
| 10 images | 6 (4) | 4 (1) |
| 10 images + 2 PDFs | 7 (5) | 5 (3) |

- Every wrong total went to review in both runs: the delivery-app voucher, the multi-item receipt, and the garbled JPY total.
- One false alarm (`total_unverified`), when the model copied a receipt number instead of the total line. A stricter first version, which flagged any line without an amount, sent 6 of 10 to review.
- Still `done` but wrong: a merchant returned as its legal entity name, and a faded date misread (09 → 19). No code check can see either; only your corrections will.


## M3 regression rerun — Nov 16, 2026

User ran `pnpm --filter worker eval` against the local dev server and supplied the console report. Results file: `worker/eval/results/run-2026-11-16T09-48-05-376Z.json` (git-ignored). The set now includes 12 labelled receipts: the 10 images plus 2 text PDFs.

**Rerun complete; combined-set total accuracy misses the target.** Date passes. This does not establish a regression caused by M3: the original passing baseline used 10 images, and earlier mixed-set runs already showed total errors and run-to-run variation. In this rerun, the 10-image subset still scores 9/10 on both total and date.

| Field | Accuracy | Target result |
| --- | --- | --- |
| merchant | 91.7% (11/12) | |
| txn_date | 91.7% (11/12) | 90%: pass |
| txn_time | 90.9% (10/11) | none |
| total | 83.3% (10/12) | 90%: fail |
| tax | 75.0% (9/12) | |
| currency | 100% (12/12) | |
| category | 91.7% (11/12) | |

- Status: 7 `done`, 5 `needs_review`, no extraction failures.
- Merchant, date and total all correct: 8/12 (66.7%); 5/7 among `done`, 3/5 among `needs_review`.
- Both incorrect totals (the delivery-app image and one text PDF) were routed to `needs_review`.
- Two `done` receipts still have a core-field error: one merchant mismatch and one incorrect date. A separate `done` receipt has an incorrect time. Tax and category also remain imperfect.
- 1.17 LLM calls per receipt; 16.7% repair rate; average latency 7.81 s.
- Estimated usage: 487.2 neurons total, 40.6 per receipt; reported capacity about 246 receipts/day within the free cap.

The existing provisional-go decision remains unchanged: use corrections to assess real accuracy and decide whether a model fallback is needed. This run is not an all-fields accuracy pass and does not verify the queue, ledger writes, scanned-PDF rejection or cron recovery; the eval calls the extraction route directly.
