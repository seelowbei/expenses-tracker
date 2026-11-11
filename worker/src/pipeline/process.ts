// Queue consumer: one receipt per message (spec "Key flows" 3, "When a limit is hit").
// Pure orchestration over injected AI, fetch, D1 and clock, so every outcome is testable without Workers AI.
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { extractReceipt, type AiClient, type ExtractResult, type ReceiptInput } from "../agent/extract";
import type { AppDeps } from "../app-env";
import { categoriesFor, categoryIdFor, categorySlugs } from "../db/categories";
import type { Db } from "../db/client";
import { aiUsage, ledgerEntries, receipts, users, type Receipt } from "../db/schema";
import { usageRows } from "../db/usage";
import { DriveDisconnectedError, withDrive } from "../drive/access";
import { DriveError } from "../drive/client";
import type { Bindings } from "../env";
import { log } from "../lib/log";
import { ReceiptMessage } from "./message";
import { MAX_DELIVERIES, nextParkTime, retryDelaySeconds } from "./timing";

export interface PipelineDeps {
  db: Db;
  env: Bindings;
  app: AppDeps;
  ai: AiClient;
  now?: () => Date;
}

/** What the queue handler does with the message. */
export type Outcome = { action: "ack" } | { action: "retry"; delaySeconds: number };

/** Stable codes stored in `receipts.error`. */
export type PipelineError =
  | "invalid_output"
  | "ai_quota"
  | "ai_error"
  | "unsupported_scanned_pdf"
  | "pdf_conversion_failed"
  | "drive_disconnected"
  | "drive_file_missing"
  | "drive_unavailable"
  | "drive_error"
  | "internal_error";

const ACK: Outcome = { action: "ack" };
const LOCALE = "en-SG";

/** Failures worth another delivery. Everything else is final on the first try. */
type Transient = "ai_error" | "drive_unavailable" | "drive_error" | "internal_error";

export async function processReceipt(deps: PipelineDeps, body: unknown, delivery: number): Promise<Outcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const msg = ReceiptMessage.safeParse(body);
  if (!msg.success) {
    log("receipt_message_invalid", {});
    return ACK;
  }
  const { receiptId, userId } = msg.data;

  // Claim. At-least-once delivery: a receipt already finished, parked or belonging to someone else is left alone.
  // `processing` is accepted so a redelivery after a crash can resume.
  const receipt = await db
    .update(receipts)
    .set({ status: "processing", attempts: sql`${receipts.attempts} + 1`, error: null })
    .where(
      and(
        eq(receipts.id, receiptId),
        eq(receipts.userId, userId),
        inArray(receipts.status, ["queued", "processing"]),
        isNull(receipts.retryAfter),
        isNotNull(receipts.driveFileId),
      ),
    )
    .returning()
    .get();
  if (!receipt) {
    log("receipt_skipped", { receiptId });
    return ACK;
  }
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return ACK; // FK cascade removes receipts with their user; nothing left to do

  const scope = and(eq(receipts.id, receipt.id), eq(receipts.userId, user.id));
  const finish = async (
    set: Partial<Receipt>,
    extra: { result?: ExtractResult; ledger?: BatchItem<"sqlite"> } = {},
  ): Promise<void> => {
    const createdAt = now().toISOString();
    const usage = usageRows(extra.result?.calls ?? [], { userId: user.id, receiptId: receipt.id, attempt: receipt.attempts, createdAt });
    const update = db.update(receipts).set(set).where(scope);
    // One batch: ai_usage rows are never lost when the status update or ledger insert is written, and vice versa.
    await db.batch([
      update,
      ...(usage.length ? [db.insert(aiUsage).values(usage)] : []),
      ...(extra.ledger ? [extra.ledger] : []),
    ]);
    log("receipt_processed", { receiptId: receipt.id, status: set.status ?? null, code: set.error ?? null, attempt: receipt.attempts });
  };

  const fail = async (code: PipelineError, result?: ExtractResult): Promise<Outcome> => {
    await finish({ status: "failed", error: code }, { result });
    return ACK;
  };

  const transient = async (code: Transient, result?: ExtractResult): Promise<Outcome> => {
    if (delivery >= MAX_DELIVERIES) return fail(code, result);
    await finish({ status: "queued", error: code }, { result });
    return { action: "retry", delaySeconds: retryDelaySeconds(delivery) };
  };

  // 1. The file, from the user's Drive.
  let bytes: Uint8Array;
  try {
    bytes = await withDrive(deps.env, deps.app, db, user, (drive) => drive.downloadFile(receipt.driveFileId!));
  } catch (e) {
    if (e instanceof DriveDisconnectedError) return fail("drive_disconnected");
    if (e instanceof DriveError && e.kind === "not_found") return fail("drive_file_missing");
    if (e instanceof DriveError) return transient(e.kind === "unavailable" ? "drive_unavailable" : "drive_error");
    log("receipt_download_error", { receiptId: receipt.id, name: (e as Error).name });
    return transient("internal_error");
  }

  // 2. Extraction (one call + at most one repair), with the user's categories and currency.
  const cats = await categoriesFor(db, user.id);
  const input: ReceiptInput =
    receipt.mimeType === "application/pdf"
      ? { kind: "pdf", bytes }
      : { kind: "image", mimeType: receipt.mimeType === "image/png" ? "image/png" : "image/jpeg", bytes };
  let result: ExtractResult;
  try {
    result = await extractReceipt(deps.ai, input, {
      categorySlugs: categorySlugs(cats),
      defaultCurrency: user.defaultCurrency,
      locale: LOCALE,
      today: now().toISOString().slice(0, 10),
    });
  } catch (e) {
    log("receipt_extract_error", { receiptId: receipt.id, name: (e as Error).name });
    return transient("internal_error");
  }

  // 3. Outcome.
  if (result.ok) {
    const { draft } = result;
    const stamp = now().toISOString();
    const ledger = db
      .insert(ledgerEntries)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        receiptId: receipt.id,
        categoryId: categoryIdFor(cats, draft.category_slug) ?? "sys_other",
        merchant: draft.merchant,
        txnDate: draft.txn_date,
        txnTime: draft.txn_time,
        currency: draft.currency,
        totalMinor: draft.total_minor,
        taxMinor: draft.tax_minor,
        paymentMethod: draft.payment_method,
        lineItems: JSON.stringify(draft.line_items),
        confidence: draft.confidence,
        source: "ai",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoNothing({ target: ledgerEntries.receiptId }); // redelivery never makes a second entry
    await finish(
      {
        status: result.status,
        error: null,
        rawExtraction: JSON.stringify(result.extraction),
        reviewReasons: result.status === "needs_review" ? JSON.stringify(result.reasons) : null,
      },
      { result, ledger },
    );
    return ACK;
  }

  switch (result.code) {
    case "invalid_output":
      // No ledger entry: the review form (M4) is pre-filled from the fields that did parse.
      await finish(
        { status: "needs_review", error: "invalid_output", rawExtraction: JSON.stringify(result.partial ?? {}), reviewReasons: null },
        { result },
      );
      return ACK;
    case "quota_exceeded":
      // Parked in D1 until the daily cron; queue retries can't wait for the reset on the Free plan.
      await finish({ status: "queued", error: "ai_quota", retryAfter: nextParkTime(now()) }, { result });
      return ACK;
    case "unsupported_scanned_pdf":
    case "pdf_conversion_failed":
      return fail(result.code, result);
    case "ai_error":
      return transient("ai_error", result);
  }
}
