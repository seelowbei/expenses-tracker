import { z } from "zod";

export interface LedgerFilters { from: string; to: string; category?: string }
export interface LedgerCursor extends LedgerFilters { id: string; date: string; time: string | null }

export interface LedgerSummary {
  id: string;
  receipt_id: string | null;
  category_id: string;
  category_name: string;
  merchant: string;
  txn_date: string;
  txn_time: string | null;
  currency: string;
  total_minor: number;
  receipt_status: string | null;
  drive_link: string | null;
}
export interface LedgerTotal {
  category_id: string;
  category_name: string;
  month: string;
  currency: string;
  total_minor: number;
  entry_count: number;
  needs_review_count: number;
}
export interface LedgerPage {
  entries: LedgerSummary[];
  totals: LedgerTotal[];
  nextCursor: string | null;
}
export interface LedgerDetail extends LedgerSummary {
  tax_minor: number | null;
  payment_method: string | null;
  line_items: { description: string; amount_minor: number }[] | null;
  notes: string | null;
  source: "ai" | "manual" | "ai_edited";
  confidence: number | null;
  created_at: string;
  updated_at: string;
  review_reasons: string[] | null;
}

export const StoredLineItems = z.array(z.object({ description: z.string(), amount_minor: z.number().int().safe() })).max(50).nullable();
export const StoredReasons = z.array(z.string()).nullable();
