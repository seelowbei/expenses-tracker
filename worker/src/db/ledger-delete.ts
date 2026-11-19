import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { ledgerEntries as ledger, receipts } from "./schema";

export async function deleteLedgerEntry(db: Db, userId: string, id: string, version: string) {
  const owned = and(eq(ledger.userId, userId), eq(ledger.id, id));
  const currentEntry = () => db.select({
    receiptId: ledger.receiptId, version: ledger.updatedAt, status: receipts.status,
  }).from(ledger).leftJoin(receipts, and(eq(receipts.userId, userId), eq(receipts.id, ledger.receiptId)))
    .where(owned).get();
  type Current = Awaited<ReturnType<typeof currentEntry>>;
  const conflict = (current: Current) => {
    if (!current || (current.receiptId !== null && current.status === null)) return "not_found";
    if (current.status !== null && current.status !== "done" && current.status !== "needs_review") return "receipt_busy";
    if (current.version !== version) return "entry_changed";
    return null;
  };

  const current = await currentEntry();
  const error = conflict(current);
  if (error || !current) return error ?? "not_found";

  const matchingEntry = and(owned, eq(ledger.updatedAt, version));
  if (current.receiptId === null) {
    const deleted = await db.delete(ledger).where(and(matchingEntry, isNull(ledger.receiptId))).returning({ id: ledger.id }).get();
    return deleted ? "deleted" : conflict(await currentEntry()) ?? "entry_changed";
  }

  const receipt = and(eq(receipts.userId, userId), eq(receipts.id, current.receiptId));
  const eligible = db.select({ id: receipts.id }).from(receipts)
    .where(and(receipt, inArray(receipts.status, ["done", "needs_review"])));
  const [deleted] = await db.batch([
    db.delete(ledger).where(and(matchingEntry, eq(ledger.receiptId, current.receiptId), exists(eligible)))
      .returning({ id: ledger.id }),
    // changes() refers to the delete immediately above. A losing request cannot resolve review.
    db.update(receipts).set({ status: "done", error: null, retryAfter: null })
      .where(and(receipt, eq(receipts.status, "needs_review"), sql`changes() = 1`)),
  ]);
  return deleted.length ? "deleted" : conflict(await currentEntry()) ?? "entry_changed";
}
