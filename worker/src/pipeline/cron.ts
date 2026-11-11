// `scheduled` handler (daily, PARK_CRON): sweep crashed receipts, then re-send parked ones.
// A system job over all users: every write is still scoped by receipt id and user id.
import { and, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { receipts } from "../db/schema";
import { log } from "../lib/log";
import type { ReceiptMessage } from "./message";
import { nextParkTime, PROCESSING_TIMEOUT_MS } from "./timing";

/** Queue sendBatch takes up to 100 messages; D1 binds up to 100 parameters, so ids go 50 at a time. */
const CHUNK = 50;
/** Per run. Two users stay far below this; anything left waits for the next day. */
const MAX_PER_RUN = 1000;

export interface CronResult {
  resent: number;
  stillParked: number;
  timedOut: number;
}

export async function runParkCron(db: Db, queue: Queue<ReceiptMessage>, now = new Date()): Promise<CronResult> {
  // 1. Receipts stuck in `processing`: the Worker died on every delivery and the message went to the DLQ.
  //    Runs before the re-send, so receipts claimed by this run's own messages are never swept.
  //    receipts has no "started at", so age is measured from upload; a slow receipt swept by mistake
  //    is still finished by its consumer, whose final write sets the real status.
  const timedOut = await db
    .update(receipts)
    .set({ status: "failed", error: "processing_timeout" })
    .where(and(eq(receipts.status, "processing"), lt(receipts.createdAt, new Date(now.getTime() - PROCESSING_TIMEOUT_MS).toISOString())))
    .returning({ id: receipts.id });

  // 2. Parked receipts whose time has come.
  const due = await db
    .select({ id: receipts.id, userId: receipts.userId })
    .from(receipts)
    .where(and(eq(receipts.status, "queued"), isNotNull(receipts.retryAfter), lte(receipts.retryAfter, now.toISOString())))
    .orderBy(receipts.retryAfter)
    .limit(MAX_PER_RUN);

  let resent = 0;
  for (let i = 0; i < due.length; i += CHUNK) {
    const chunk = due.slice(i, i + CHUNK);
    // Unparked before the send: the consumer skips receipts that still have retry_after, and a message
    // can arrive before this run's next statement.
    const setParked = (retryAfter: string | null, error: string | null) =>
      Promise.all(
        [...new Set(chunk.map((r) => r.userId))].map((userId) =>
          db
            .update(receipts)
            .set({ retryAfter, error })
            .where(
              and(
                inArray(receipts.id, chunk.filter((r) => r.userId === userId).map((r) => r.id)),
                eq(receipts.userId, userId),
                eq(receipts.status, "queued"),
              ),
            ),
        ),
      );
    await setParked(null, null);
    try {
      await queue.sendBatch(chunk.map((r) => ({ body: { receiptId: r.id, userId: r.userId } })));
    } catch (e) {
      log("park_cron_send_failed", { name: (e as Error).name, count: chunk.length });
      await setParked(nextParkTime(now), "queue_unavailable"); // try again tomorrow, with everything after it
      break;
    }
    resent += chunk.length;
  }

  const result = { resent, stillParked: due.length - resent, timedOut: timedOut.length };
  log("park_cron", { ...result });
  return result;
}
