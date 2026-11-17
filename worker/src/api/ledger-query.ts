import { z } from "zod";
import type { LedgerCursor, LedgerFilters, LedgerSummary } from "../contracts/ledger";
import { Extraction } from "../agent/schema";
import { fromBase64Url, toBase64Url } from "../lib/encoding";

const date = z.iso.date();
const id = z.string().min(1).max(120);
const filters = z.object({ from: date, to: date, category: id.optional() });
const Cursor = filters.extend({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: Extraction.shape.txn_time });
const Query = filters.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();

export function parseLedgerQuery(input: Record<string, string>, today = new Date().toISOString().slice(0, 10)) {
  const month = today.slice(0, 7);
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
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
