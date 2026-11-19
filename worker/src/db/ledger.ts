import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { LedgerCursor, LedgerFilters } from "../contracts/ledger";
import type { Db } from "./client";
import { categories, ledgerEntries as ledger, receipts } from "./schema";

const summary = {
  // D1 batch maps object rows: joined IDs need distinct SQL names, not only TS keys.
  id: ledger.id, receipt_id: sql<string | null>`${receipts.id}`.as("receipt_id"), category_id: ledger.categoryId, category_name: categories.name,
  merchant: ledger.merchant, txn_date: ledger.txnDate, txn_time: ledger.txnTime,
  currency: ledger.currency, total_minor: ledger.totalMinor,
  receipt_status: receipts.status, drive_link: receipts.driveLink,
};
const categoryJoin = (userId: string) => and(eq(categories.id, ledger.categoryId), or(eq(categories.userId, userId), isNull(categories.userId)));
const receiptJoin = (userId: string) => and(eq(receipts.id, ledger.receiptId), eq(receipts.userId, userId));

const rangeWhere = (userId: string, q: LedgerFilters) =>
  and(eq(ledger.userId, userId), gte(ledger.txnDate, q.from), lte(ledger.txnDate, q.to), q.category ? eq(ledger.categoryId, q.category) : undefined);

function after(cursor: LedgerCursor | null) {
  if (!cursor) return undefined;
  const sameTime = cursor.time === null ? isNull(ledger.txnTime) : eq(ledger.txnTime, cursor.time);
  return or(
    lt(ledger.txnDate, cursor.date),
    and(eq(ledger.txnDate, cursor.date), or(
      ...(cursor.time === null ? [] : [lt(ledger.txnTime, cursor.time), isNull(ledger.txnTime)]),
      and(sameTime, lt(ledger.id, cursor.id)),
    )),
  );
}

export async function readLedger(db: Db, userId: string, q: LedgerFilters & { cursor: LedgerCursor | null; limit: number }) {
  const where = rangeWhere(userId, q);
  const month = sql<string>`substr(${ledger.txnDate}, 1, 7)`;
  // D1 batch gives the page and its full-range aggregates one consistent read snapshot.
  return db.batch([
    db.select(summary).from(ledger)
      .innerJoin(categories, categoryJoin(userId)).leftJoin(receipts, receiptJoin(userId))
      .where(and(where, after(q.cursor)))
      .orderBy(desc(ledger.txnDate), desc(ledger.txnTime), desc(ledger.id)).limit(q.limit + 1),
    db.select({
      category_id: ledger.categoryId, category_name: categories.name, month, currency: ledger.currency,
      // Return exact integer text so unsafe values cannot be rounded at the D1 JSON boundary.
      total_text: sql<string>`cast(sum(${ledger.totalMinor}) as text)`,
      entry_count: sql<number>`count(*)`,
      needs_review_count: sql<number>`sum(case when ${receipts.status} = 'needs_review' then 1 else 0 end)`,
    }).from(ledger).innerJoin(categories, categoryJoin(userId)).leftJoin(receipts, receiptJoin(userId))
      .where(where).groupBy(ledger.categoryId, month, ledger.currency)
      .orderBy(desc(month), categories.name, ledger.categoryId, ledger.currency),
  ]);
}

export type LedgerExportRow = Awaited<ReturnType<typeof readLedgerExport>>[number];

/** Every entry in the filtered range, in list order, with the fields a spreadsheet needs (no line items). */
export function readLedgerExport(db: Db, userId: string, q: LedgerFilters, limit: number) {
  return db.select({
    id: ledger.id, category_name: categories.name, merchant: ledger.merchant, txn_date: ledger.txnDate, txn_time: ledger.txnTime,
    currency: ledger.currency, total_minor: ledger.totalMinor, tax_minor: ledger.taxMinor, payment_method: ledger.paymentMethod,
    notes: ledger.notes, source: ledger.source, reviewed_at: ledger.reviewedAt,
    receipt_status: receipts.status, drive_link: receipts.driveLink,
  }).from(ledger).innerJoin(categories, categoryJoin(userId)).leftJoin(receipts, receiptJoin(userId))
    .where(rangeWhere(userId, q))
    .orderBy(desc(ledger.txnDate), desc(ledger.txnTime), desc(ledger.id)).limit(limit);
}

export function readLedgerDetail(db: Db, userId: string, id: string) {
  return db.select({
    ...summary, tax_minor: ledger.taxMinor, payment_method: ledger.paymentMethod,
    line_items_json: ledger.lineItems, notes: ledger.notes, source: ledger.source,
    confidence: ledger.confidence, created_at: ledger.createdAt, updated_at: ledger.updatedAt, reviewed_at: ledger.reviewedAt,
    review_reasons_json: receipts.reviewReasons,
  }).from(ledger).innerJoin(categories, categoryJoin(userId)).leftJoin(receipts, receiptJoin(userId))
    .where(and(eq(ledger.userId, userId), eq(ledger.id, id))).get();
}
