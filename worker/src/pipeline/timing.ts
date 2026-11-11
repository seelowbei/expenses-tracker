// Retry and parking times for the consumer and the cron (spec "Limits, cost & failure handling").

/** First delivery plus `max_retries: 3` (wrangler.jsonc / infrastructure/services). */
export const MAX_DELIVERIES = 4;

/** Backoff after delivery n (1-based): 30 s, 2 min, 10 min. */
const BACKOFF_SECONDS = [30, 120, 600] as const;

export function retryDelaySeconds(delivery: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(delivery, 1), BACKOFF_SECONDS.length) - 1]!;
}

/** Cron schedule (`5 0 * * *`): five minutes after the Workers AI daily reset at 00:00 UTC. */
export const PARK_CRON = "5 0 * * *";

/** The next 00:05 UTC strictly after `now`, as ISO-8601. Parked receipts wait for it. */
export function nextParkTime(now: Date): string {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5));
  if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
}

/** A receipt still `processing` after this is treated as crashed (the message died in the DLQ). */
export const PROCESSING_TIMEOUT_MS = 60 * 60 * 1000;

/** Queues keep messages for a fixed 24 h on the Free plan; a receipt queued longer has no message left. */
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
