import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import type { ReviewCreate } from "../contracts/review";
import type { Db } from "./client";
import { categories, ledgerEntries as ledger, receipts } from "./schema";
import { readReviewReceipt } from "./review";

type Result = { saved: string } | { error: "not_found" | "not_reviewable" } | { error: "review_already_saved"; entryId: string };
export async function createReviewedEntry(db: Db, userId: string, receiptId: string, values: ReviewCreate): Promise<Result> {
  const category = db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, values.category_id), or(eq(categories.userId, userId), isNull(categories.userId))));
  const check = async (): Promise<Result | null> => {
    const current = await readReviewReceipt(db, userId, receiptId);
    if (!current) return { error: "not_found" };
    if (current.entryId) return { error: "review_already_saved", entryId: current.entryId };
    if (current.receipt.status !== "needs_review" || current.receipt.error !== "invalid_output") return { error: "not_reviewable" };
    if (!await category.get()) return { error: "not_found" };
    return null;
  };
  const invalid = await check();
  if (invalid) return invalid;
  const id = crypto.randomUUID(), stamp = new Date().toISOString();
  const scope = and(eq(receipts.userId, userId), eq(receipts.id, receiptId), eq(receipts.status, "needs_review"), eq(receipts.error, "invalid_output"));
  const [saved] = await db.batch([
    db.insert(ledger).select(db.select({
      id: sql`${id}`.as("id"), userId: receipts.userId, receiptId: receipts.id,
      categoryId: sql`${values.category_id}`.as("category_id"), merchant: sql`${values.merchant}`.as("merchant"),
      txnDate: sql`${values.txn_date}`.as("txn_date"), txnTime: sql`${values.txn_time}`.as("txn_time"),
      currency: sql`${values.currency}`.as("currency"), totalMinor: sql`${values.total_minor}`.as("total_minor"), taxMinor: sql`${values.tax_minor}`.as("tax_minor"),
      paymentMethod: sql`${values.payment_method}`.as("payment_method"), lineItems: sql`${values.line_items === null ? null : JSON.stringify(values.line_items)}`.as("line_items"),
      confidence: sql`null`.as("confidence"), source: sql`'ai_edited'`.as("source"), notes: sql`${values.notes}`.as("notes"),
      createdAt: sql`${stamp}`.as("created_at"), updatedAt: sql`${stamp}`.as("updated_at"), reviewedAt: sql`${stamp}`.as("reviewed_at"),
    }).from(receipts).where(and(scope, exists(category))))
      .onConflictDoNothing({ target: ledger.receiptId }).returning({ id: ledger.id }),
    // changes() is this batch's preceding insert: a losing request cannot complete review.
    db.update(receipts).set({ status: "done", error: null, retryAfter: null }).where(and(scope, sql`changes() = 1`)),
  ]);
  if (saved.length) return { saved: id };
  return await check() ?? { error: "not_reviewable" };
}
