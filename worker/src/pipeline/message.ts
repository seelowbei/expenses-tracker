import { z } from "zod";

/** Body of a RECEIPT_QUEUE message. Produced by the upload route, the retry route and the cron. */
export const ReceiptMessage = z.object({ receiptId: z.string().min(1), userId: z.string().min(1) });
export type ReceiptMessage = z.infer<typeof ReceiptMessage>;
