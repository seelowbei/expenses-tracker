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

The set has no PDFs, so the PDF path (`toMarkdown()` and then the same model) is still untested.

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

- **Confidence is always 1.0.** The 0.7 threshold never triggers, so `needs_review` only comes from post-validation (line items not adding up). A wrong total on a delivery-app receipt was saved as `done`.
- **Total:** a delivery-app receipt returned the subtotal before a voucher.
- **Tax:** returns `0` when no tax is printed instead of `null`, and took a fuel surcharge as tax.
- **Date:** a faded thermal receipt was misread (09 → 19). No prompt or code change can fix that.
- **Time:** used the "Print @" time once, despite the prompt rule.
- **Merchant:** a receipt with the brand only as a logo (Chinese calligraphy) returned the legal entity name.
- **Category:** falls back to `other` for less obvious cases (a certification fee, a bottled drink from a TCM shop).
