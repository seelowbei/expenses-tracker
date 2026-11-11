import type { AiClient } from "../agent/extract";
import type { AppDeps } from "../app-env";
import { getDb } from "../db/client";
import type { Bindings } from "../env";
import { log } from "../lib/log";
import type { ReceiptMessage } from "./message";
import { processReceipt } from "./process";
import { retryDelaySeconds } from "./timing";

/** `queue` handler. `max_batch_size: 1`, but any batch size works. */
export async function handleQueue(
  batch: MessageBatch<ReceiptMessage>,
  env: Bindings,
  deps: { app: AppDeps; ai: AiClient; now?: () => Date },
): Promise<void> {
  const db = getDb(env.DB);
  for (const msg of batch.messages) {
    try {
      const outcome = await processReceipt({ db, env, app: deps.app, ai: deps.ai, now: deps.now }, msg.body, msg.attempts);
      if (outcome.action === "ack") msg.ack();
      else msg.retry({ delaySeconds: outcome.delaySeconds });
    } catch (e) {
      // D1 failed while claiming or writing. Nothing was committed by the batch, so another delivery is safe.
      log("receipt_queue_error", { name: (e as Error).name, attempt: msg.attempts });
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
}
