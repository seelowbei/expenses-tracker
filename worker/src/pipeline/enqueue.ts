// Sending receipts to RECEIPT_QUEUE, with the D1 park as the fallback when the queue refuses.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import { log } from "../lib/log";
import type { ReceiptMessage } from "./message";
import { nextParkTime } from "./timing";

/**
 * Sends one receipt for extraction. If the send fails (e.g. the Queues daily ops limit), the receipt is
 * parked like an AI-quota park, so the daily cron sends it again; the file is already in Drive, so the
 * user could not simply re-upload it.
 */
export async function enqueueOrPark(queue: Queue<ReceiptMessage>, db: Db, msg: ReceiptMessage, now = new Date()): Promise<"sent" | "parked"> {
  try {
    await queue.send(msg);
    return "sent";
  } catch (e) {
    log("receipt_enqueue_failed", { receiptId: msg.receiptId, name: (e as Error).name });
    await db
      .update(receipts)
      .set({ retryAfter: nextParkTime(now), error: "queue_unavailable" })
      .where(and(eq(receipts.id, msg.receiptId), eq(receipts.userId, msg.userId)));
    return "parked";
  }
}
