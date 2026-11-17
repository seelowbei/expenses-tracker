import { z } from "zod";
import { Extraction } from "../agent/schema";
import { fromBase64Url, toBase64Url } from "../lib/encoding";

const date = z.iso.date();
const id = z.string().min(1).max(120);
const filters = z.object({ from: date, to: date, category: id.optional() });
const Cursor = filters.extend({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: Extraction.shape.txn_time });
export type LedgerCursor = z.infer<typeof Cursor>;
export type LedgerFilters = z.infer<typeof filters>;

export function parseLedgerQuery(input: Record<string, string>, today = new Date().toISOString().slice(0, 10)) {
  const month = today.slice(0, 7);
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const Query = filters.extend({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  }).strict();
  const query = Query.safeParse(input.from === undefined && input.to === undefined
    ? { ...input, from: `${month}-01`, to: end.toISOString().slice(0, 10) } : input);
  if (!query.success) return null;
  const q = query.data;
  const months = (Number(q.to.slice(0, 4)) - Number(q.from.slice(0, 4))) * 12 + Number(q.to.slice(5, 7)) - Number(q.from.slice(5, 7));
  if (q.from > q.to || months > 11) return null;
  let cursor: LedgerCursor | null = null;
  if (q.cursor) {
    try {
      cursor = Cursor.parse(JSON.parse(new TextDecoder().decode(fromBase64Url(q.cursor))));
    } catch { return null; }
    if (cursor.from !== q.from || cursor.to !== q.to || cursor.category !== q.category || cursor.date < q.from || cursor.date > q.to) return null;
  }
  return { ...q, cursor };
}

export function ledgerCursor(filters: LedgerFilters, last: LedgerSummary): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({
    from: filters.from, to: filters.to, category: filters.category,
    id: last.id, date: last.txn_date, time: last.txn_time,
  })));
}

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
