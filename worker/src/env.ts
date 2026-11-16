import type { ReceiptMessage } from "./pipeline/message";

// Generated `Env` (worker-configuration.d.ts) marks AI/RECEIPT_QUEUE optional because the
// staging/production wrangler env blocks only declare DB. Deployed Workers always get them from Pulumi.
export type Bindings = Env & {
  AI: Ai;
  RECEIPT_QUEUE: Queue<ReceiptMessage>;
  APP_ORIGIN: string;
  DEFAULT_CURRENCY: string;
  /** "true" only in local wrangler vars. Never set by infrastructure/services. */
  DEV_ROUTES?: string;
};
