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
export interface ReceiptPage { receipts: ReceiptMetadata[]; nextCursor: string | null }
