import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { ReceiptCursor, ReceiptMetadata } from "../contracts/review";
import type { Db } from "./client";
import { ledgerEntries, receipts } from "./schema";

export function readReviewReceipt(db: Db, userId: string, id: string) {
  return db.select({ receipt: receipts, entryId: ledgerEntries.id }).from(receipts)
    .leftJoin(ledgerEntries, and(eq(ledgerEntries.receiptId, receipts.id), eq(ledgerEntries.userId, userId)))
    .where(and(eq(receipts.userId, userId), eq(receipts.id, id))).get();
}

export function readReceiptPage(db: Db, userId: string, status: ReceiptMetadata["status"][], cursor: ReceiptCursor | null, limit: number) {
  return db.select({ id: receipts.id, status: receipts.status, mimeType: receipts.mimeType, sizeBytes: receipts.sizeBytes,
    driveLink: receipts.driveLink, error: receipts.error, retryAfter: receipts.retryAfter, reviewReasons: receipts.reviewReasons, createdAt: receipts.createdAt,
    entryId: ledgerEntries.id,
  }).from(receipts)
    .leftJoin(ledgerEntries, and(eq(ledgerEntries.receiptId, receipts.id), eq(ledgerEntries.userId, userId)))
    .where(and(eq(receipts.userId, userId), status.length ? inArray(receipts.status, status) : undefined,
    cursor ? or(lt(receipts.createdAt, cursor.createdAt), and(eq(receipts.createdAt, cursor.createdAt), lt(receipts.id, cursor.id))) : undefined,
  )).orderBy(desc(receipts.createdAt), desc(receipts.id)).limit(limit + 1);
}
