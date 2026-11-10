// Scoring for the M1 eval. Pure functions (no Node APIs) so they run in the workerd test pool too.
import { z } from "zod";

/** Hand-labelled ground truth, stored next to each receipt as <name>.json. */
export const Label = z.object({
  merchant: z.string().min(1),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** "HH:MM" 24-hour, null if no time is printed. Omit to leave time unscored. */
  txn_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  currency: z.string().length(3),
  total: z.number().nonnegative(),
  tax: z.number().nonnegative().nullable(),
  category_slug: z.string(),
  notes: z.string().optional(),
});
export type Label = z.infer<typeof Label>;

export const FIELDS = ["merchant", "txn_date", "txn_time", "total", "tax", "currency", "category_slug"] as const;
export type Field = (typeof FIELDS)[number];
/** null = not scored (the label leaves the field out). */
export type FieldScores = Record<Field, boolean | null>;

export interface Predicted {
  merchant: string;
  txn_date: string;
  txn_time: string | null;
  currency: string;
  total: number;
  tax: number | null;
  category_slug: string;
}

const LEGAL_SUFFIXES = /\b(pte|ltd|sdn|bhd|llp|llc|inc|co|corp|limited|private)\b/g;

export function normalizeMerchant(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export function merchantMatches(expected: string, actual: string): boolean {
  const a = normalizeMerchant(expected);
  const b = normalizeMerchant(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.length >= 3 && longer.includes(shorter)) return true;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.8;
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function scoreFields(label: Label, p: Predicted | null): FieldScores {
  const timeScored = label.txn_time !== undefined;
  if (!p) {
    return {
      merchant: false, txn_date: false, txn_time: timeScored ? false : null,
      total: false, tax: false, currency: false, category_slug: false,
    };
  }
  return {
    merchant: merchantMatches(label.merchant, p.merchant),
    txn_date: label.txn_date === p.txn_date,
    txn_time: timeScored ? label.txn_time === p.txn_time : null,
    total: sameAmount(label.total, p.total),
    tax: label.tax === null || p.tax === null ? label.tax === p.tax : sameAmount(label.tax, p.tax),
    currency: label.currency.toUpperCase() === p.currency.toUpperCase(),
    category_slug: label.category_slug === p.category_slug,
  };
}
