// Drizzle schema for D1. Mirrors "Data model (D1)" in the technical spec; keep them in sync.
// Migrations are generated from this file (`pnpm db:generate`) and must stay additive.
import { index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  defaultCurrency: text("default_currency").notNull().default("SGD"),
  driveFolderId: text("drive_folder_id"),
  refreshTokenEnc: text("refresh_token_enc"),
  driveStatus: text("drive_status", { enum: ["connected", "disconnected"] }).notNull().default("connected"),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 hex of the cookie token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }), // NULL = system default
    slug: text("slug").notNull(),
    name: text("name").notNull(),
  },
  (t) => [unique().on(t.userId, t.slug)],
);

export const RECEIPT_STATUSES = ["uploading", "queued", "processing", "done", "needs_review", "failed"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    driveFileId: text("drive_file_id"),
    driveLink: text("drive_link"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: RECEIPT_STATUSES }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    rawExtraction: text("raw_extraction"),
    retryAfter: text("retry_after"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique().on(t.userId, t.sha256), index("idx_receipts_user_status").on(t.userId, t.status)],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    receiptId: text("receipt_id")
      .unique()
      .references(() => receipts.id, { onDelete: "set null" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    merchant: text("merchant").notNull(),
    txnDate: text("txn_date").notNull(),
    txnTime: text("txn_time"),
    currency: text("currency").notNull(),
    totalMinor: integer("total_minor").notNull(),
    taxMinor: integer("tax_minor"),
    paymentMethod: text("payment_method"),
    lineItems: text("line_items"),
    confidence: real("confidence"),
    source: text("source", { enum: ["ai", "manual", "ai_edited"] }).notNull(),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_ledger_user_cat_date").on(t.userId, t.categoryId, t.txnDate),
    index("idx_ledger_user_date").on(t.userId, t.txnDate, t.txnTime),
  ],
);

export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    receiptId: text("receipt_id").references(() => receipts.id, { onDelete: "set null" }),
    attempt: integer("attempt").notNull(),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    inputMode: text("input_mode"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    neuronsEst: real("neurons_est"),
    latencyMs: integer("latency_ms").notNull(),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_ai_usage_created").on(t.createdAt),
    index("idx_ai_usage_user_created").on(t.userId, t.createdAt),
    index("idx_ai_usage_receipt").on(t.receiptId),
  ],
);

export type User = typeof users.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
