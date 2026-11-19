import { z } from "zod";
import { LedgerFields } from "./ledger-write";

export const ReviewCreate = LedgerFields;
export type ReviewCreate = z.infer<typeof ReviewCreate>;
export type ReviewDraft = Partial<ReviewCreate>;
export interface ReceiptMetadata {
  id: string;
  status: "uploading" | "queued" | "processing" | "done" | "needs_review" | "failed";
  mimeType: string;
  sizeBytes: number;
  driveLink: string | null;
  error: string | null;
  retryAfter: string | null;
  reviewReasons: string[] | null;
  createdAt: string;
}
export interface ReviewDetail { receipt: ReceiptMetadata; entryId: string | null; draft: ReviewDraft | null }
export interface ReceiptListItem extends ReceiptMetadata { hasLedgerEntry: boolean }
export interface ReceiptPage { receipts: ReceiptListItem[]; nextCursor: string | null }

export const ReceiptCursor = z.object({ id: z.string().min(1).max(120), createdAt: z.iso.datetime(), status: z.string().max(100) }).strict();
export type ReceiptCursor = z.infer<typeof ReceiptCursor>;
