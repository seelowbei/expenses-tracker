import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { LedgerFields, type LedgerPatch } from "../contracts/ledger-write";
import type { Db } from "./client";
import { categories, ledgerEntries as ledger, receipts } from "./schema";

export async function saveLedgerEntry(db: Db, userId: string, id: string, patch: LedgerPatch) {
  const owned = and(eq(ledger.userId, userId), eq(ledger.id, id));
  const current = await db.select().from(ledger).where(owned).get();
  if (!current) return "not_found";
  const visibleCategory = (categoryId: string) => and(eq(categories.id, categoryId), or(eq(categories.userId, userId), isNull(categories.userId)));
  for (const categoryId of new Set([current.categoryId, patch.category_id ?? current.categoryId])) {
    if (!await db.select({ id: categories.id }).from(categories).where(visibleCategory(categoryId)).get()) return "not_found";
  }
  if (current.receiptId) {
    const receipt = await db.select().from(receipts).where(and(eq(receipts.userId, userId), eq(receipts.id, current.receiptId))).get();
    if (!receipt) return "not_found";
    if (receipt.status !== "done" && receipt.status !== "needs_review") return "receipt_busy";
  }
  if (current.updatedAt !== patch.expected_updated_at) return "entry_changed";
  if (patch.currency !== undefined && patch.currency !== current.currency &&
    (!patch.confirm_currency || patch.total_minor === undefined || patch.tax_minor === undefined || patch.line_items === undefined)) return "currency_confirmation_required";
  let storedItems: unknown;
  try { storedItems = current.lineItems === null ? null : JSON.parse(current.lineItems); }
  catch { return "invalid_stored_entry"; }
  const before = { merchant: current.merchant, txn_date: current.txnDate, txn_time: current.txnTime, currency: current.currency,
    total_minor: current.totalMinor, tax_minor: current.taxMinor, category_id: current.categoryId,
    payment_method: current.paymentMethod, line_items: storedItems, notes: current.notes };
  const { expected_updated_at, confirm_review, confirm_currency, ...edits } = patch;
  const parsed = LedgerFields.safeParse({ ...before, ...edits });
  if (!parsed.success) return "invalid_body";
  const values = parsed.data;
  const changed = (Object.keys(values) as (keyof typeof values)[]).some((key) => JSON.stringify(before[key]) !== JSON.stringify(values[key]));
  const stamp = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
  const eligibleReceipt = db.select({ id: receipts.id }).from(receipts).where(and(
    eq(receipts.id, ledger.receiptId), eq(receipts.userId, userId), inArray(receipts.status, ["done", "needs_review"]),
  ));
  const [saved] = await db.batch([
    db.update(ledger).set({
      merchant: values.merchant, txnDate: values.txn_date, txnTime: values.txn_time, currency: values.currency,
      totalMinor: values.total_minor, taxMinor: values.tax_minor, categoryId: values.category_id,
      paymentMethod: values.payment_method, lineItems: values.line_items === null ? null : JSON.stringify(values.line_items), notes: values.notes,
      source: changed && current.source === "ai" ? "ai_edited" : current.source, reviewedAt: stamp, updatedAt: stamp,
    }).where(and(owned, eq(ledger.updatedAt, expected_updated_at),
      or(isNull(ledger.receiptId), exists(eligibleReceipt)),
      exists(db.select({ id: categories.id }).from(categories).where(visibleCategory(values.category_id))),
    )).returning({ id: ledger.id }),
    // changes() refers to the immediately preceding conditional UPDATE in this atomic batch.
    // A losing save must not resolve review, even when two requests compute the same timestamp.
    db.update(receipts).set({ status: "done", error: null, retryAfter: null }).where(and(
      eq(receipts.userId, userId), eq(receipts.id, current.receiptId ?? ""), eq(receipts.status, "needs_review"), sql`changes() = 1`,
    )),
  ]);
  return saved.length ? "saved" : "entry_changed";
}
