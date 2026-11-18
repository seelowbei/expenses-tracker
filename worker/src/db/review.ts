import { and, eq } from "drizzle-orm";
import type { Db } from "./client";
import { ledgerEntries, receipts } from "./schema";

export function readReviewReceipt(db: Db, userId: string, id: string) {
  return db.select({ receipt: receipts, entryId: ledgerEntries.id }).from(receipts)
    .leftJoin(ledgerEntries, and(eq(ledgerEntries.receiptId, receipts.id), eq(ledgerEntries.userId, userId)))
    .where(and(eq(receipts.userId, userId), eq(receipts.id, id))).get();
}
