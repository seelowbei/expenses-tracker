import { FALLBACK_CATEGORY } from "./categories";
import { isCurrencyCode, toMinor } from "./money";
import type { Extraction } from "./schema";

export const CONFIDENCE_THRESHOLD = 0.7;
const LINE_ITEM_TOLERANCE = 0.02;

export type ReviewReason =
  | "low_confidence"
  | "unknown_category"
  | "date_out_of_range"
  | "invalid_date"
  | "invalid_currency"
  | "line_items_mismatch";

export interface LedgerDraft {
  merchant: string;
  txn_date: string;
  txn_time: string | null;
  currency: string;
  total_minor: number;
  tax_minor: number | null;
  payment_method: Extraction["payment_method"];
  line_items: { description: string; amount_minor: number }[];
  category_slug: string;
  confidence: number;
}

export interface ValidationResult {
  status: "done" | "needs_review";
  reasons: ReviewReason[];
  draft: LedgerDraft;
}

const DAY_MS = 86_400_000;

function parseIsoDate(s: string): number | null {
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

// Post-validation rules from the spec (code, not LLM). `today` is YYYY-MM-DD (UTC).
export function postValidate(x: Extraction, categorySlugs: readonly string[], today: string): ValidationResult {
  const reasons: ReviewReason[] = [];

  let category = x.category_slug.trim().toLowerCase();
  if (!categorySlugs.includes(category)) {
    category = FALLBACK_CATEGORY;
    reasons.push("unknown_category");
  }

  const txn = parseIsoDate(x.txn_date);
  const now = parseIsoDate(today);
  if (txn === null || now === null) {
    reasons.push("invalid_date");
  } else {
    const tenYearsAgo = Date.UTC(new Date(now).getUTCFullYear() - 10, new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    if (txn > now + DAY_MS || txn < tenYearsAgo) reasons.push("date_out_of_range");
  }

  // The schema already guarantees 3 chars; also require A-Z so minor-unit conversion is safe.
  let currency = x.currency;
  if (!isCurrencyCode(currency)) {
    reasons.push("invalid_currency");
    currency = "XXX"; // ISO 4217 "no currency"; entry must be reviewed anyway
  }

  if (x.line_items.length > 0) {
    const sum = x.line_items.reduce((acc, li) => acc + li.amount, 0);
    const tax = x.tax ?? 0;
    // Spec: compare with total - tax. Also accept tax-inclusive receipts (e.g. "GST included"), where items sum to total.
    const matches = (expected: number) =>
      expected === 0 ? Math.abs(sum) < 0.005 : Math.abs(sum - expected) / Math.abs(expected) <= LINE_ITEM_TOLERANCE;
    if (!matches(x.total - tax) && !matches(x.total)) reasons.push("line_items_mismatch");
  }

  if (x.confidence < CONFIDENCE_THRESHOLD) reasons.push("low_confidence");

  return {
    status: reasons.length === 0 ? "done" : "needs_review",
    reasons,
    draft: {
      merchant: x.merchant,
      txn_date: x.txn_date,
      txn_time: x.txn_time, // never forces review
      currency,
      total_minor: toMinor(x.total, currency),
      tax_minor: x.tax === null ? null : toMinor(x.tax, currency),
      payment_method: x.payment_method,
      line_items: x.line_items.map((li) => ({ description: li.description, amount_minor: toMinor(li.amount, currency) })),
      category_slug: category,
      confidence: x.confidence,
    },
  };
}
