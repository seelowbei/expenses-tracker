import type { ReceiptMessage } from "./pipeline/message";

// Generated `Env` (worker-configuration.d.ts) marks AI/RECEIPT_QUEUE optional because the
// staging/production wrangler env blocks only declare DB. Deployed Workers always get them from Pulumi.
// DRIVE_FOLDER_NAME is omitted so it is a plain string: the generated type is the local literal.
export type Bindings = Omit<Env, "DRIVE_FOLDER_NAME"> & {
  AI: Ai;
  RECEIPT_QUEUE: Queue<ReceiptMessage>;
  APP_ORIGIN: string;
  DEFAULT_CURRENCY: string;
  /** Name for newly created Drive folders, so each environment's folder is distinguishable. Defaults to FOLDER_NAME. */
  DRIVE_FOLDER_NAME?: string;
  /** "true" only in local wrangler vars. Never set by infrastructure/services. */
  DEV_ROUTES?: string;
};
