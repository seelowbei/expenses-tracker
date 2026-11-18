// /api/receipts: direct upload to Drive (spec "Key flows" 2), listing for polling, retry of failed receipts.
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { clearSessionCookie } from "../auth/session";
import { nowIso } from "../db/client";
import { RECEIPT_STATUSES, receipts, type Receipt } from "../db/schema";
import { DriveDisconnectedError, ensureFolder, withDrive } from "../drive/access";
import { DriveError } from "../drive/client";
import { sha256Hex } from "../lib/encoding";
import { log } from "../lib/log";
import { sniffMime, type AllowedMime } from "../lib/sniff";
import { receiptFileRoutes } from "./receipt-file";
import { enqueueOrPark } from "../pipeline/enqueue";

/** Direct multipart limit. Larger files need the resumable flow (deferred to M5). */
export const MAX_DIRECT_UPLOAD_BYTES = 5 * 1024 * 1024;
const MULTIPART_OVERHEAD = 64 * 1024;
/** An `uploading` row older than this is treated as abandoned. A ≤ 5 MB Drive upload takes seconds. */
export const STALE_UPLOAD_MS = 2 * 60 * 1000;

const EXT: Record<AllowedMime, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };

export function driveFileName(createdAt: string, receiptId: string, mime: AllowedMime): string {
  return `${createdAt.slice(0, 10)}_${receiptId}.${EXT[mime]}`;
}

export function toReceiptDto(r: Receipt) {
  return {
    id: r.id,
    status: r.status,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    driveLink: r.driveLink,
    error: r.error,
    /** Set while parked (AI quota or queue unavailable): the cron sends it again after this time. */
    retryAfter: r.retryAfter,
    reviewReasons: r.reviewReasons ? (JSON.parse(r.reviewReasons) as string[]) : null,
    createdAt: r.createdAt,
  };
}
export type ReceiptDto = ReturnType<typeof toReceiptDto>;

const StatusQuery = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(z.enum(RECEIPT_STATUSES)));

export const receiptRoutes = new Hono<AppEnv>();
receiptRoutes.route("/", receiptFileRoutes);

receiptRoutes.get("/", async (c) => {
  const status = StatusQuery.safeParse(c.req.query("status"));
  if (!status.success) return c.json({ error: "invalid_status" }, 400);
  const user = c.var.user;
  const where = status.data.length
    ? and(eq(receipts.userId, user.id), inArray(receipts.status, status.data))
    : eq(receipts.userId, user.id);
  const rows = await c.var.db.select().from(receipts).where(where).orderBy(desc(receipts.createdAt)).limit(50);
  return c.json({ receipts: rows.map(toReceiptDto) });
});

receiptRoutes.post("/", async (c) => {
  const { db } = c.var;
  const user = c.var.user;
  if (user.driveStatus === "disconnected") return c.json({ error: "drive_disconnected" }, 409);

  // Checked before formData() buffers the body. Browsers always send Content-Length with a FormData body;
  // without it (chunked), nothing would stop a body far beyond the limit from being buffered.
  const lengthHeader = c.req.header("Content-Length");
  const declared = lengthHeader === undefined ? NaN : Number(lengthHeader);
  if (!Number.isSafeInteger(declared) || declared < 0) return c.json({ error: "length_required" }, 411);
  if (declared > MAX_DIRECT_UPLOAD_BYTES + MULTIPART_OVERHEAD) return c.json({ error: "file_too_large" }, 413);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "missing_file" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "missing_file" }, 400);
  if (file.size > MAX_DIRECT_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);

  // One read of the bytes: sniff + native hash. The upload sends the original File blob.
  const bytes = await file.arrayBuffer();
  const mime = sniffMime(new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength)));
  if (!mime) return c.json({ error: "unsupported_type" }, 415);
  const sha256 = await sha256Hex(bytes);

  // Duplicate check. A row without a Drive file is reused when its upload failed, or when it has been
  // `uploading` for longer than any real upload takes (the Worker died mid-request), so it never blocks a retry.
  let receipt = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.userId, user.id), eq(receipts.sha256, sha256)))
    .get();
  if (receipt) {
    const now = new Date();
    const staleBefore = nowIso(new Date(now.getTime() - STALE_UPLOAD_MS));
    // Claimed in one conditional UPDATE: of two concurrent requests for the same file, only one gets the row,
    // so Drive never receives a second copy that the write-once rule would leave orphaned.
    // created_at restarts with the attempt: it is what makes an in-flight upload look fresh, and no Drive file exists yet.
    // A failed receipt whose Drive file the user deleted (drive_file_missing) is reusable too: it gets a new file.
    const claimed = await db
      .update(receipts)
      .set({ status: "uploading", error: null, mimeType: mime, sizeBytes: file.size, createdAt: nowIso(now), driveFileId: null, driveLink: null })
      .where(
        and(
          eq(receipts.id, receipt.id),
          eq(receipts.userId, user.id),
          or(
            and(
              isNull(receipts.driveFileId),
              or(eq(receipts.status, "failed"), and(eq(receipts.status, "uploading"), lt(receipts.createdAt, staleBefore))),
            ),
            and(eq(receipts.status, "failed"), eq(receipts.error, "drive_file_missing")),
          ),
        ),
      )
      .returning()
      .get();
    if (!claimed) return c.json({ error: "duplicate_receipt", receiptId: receipt.id }, 409);
    receipt = claimed;
  } else {
    try {
      receipt = await db
        .insert(receipts)
        .values({
          id: crypto.randomUUID(),
          userId: user.id,
          mimeType: mime,
          sizeBytes: file.size,
          sha256,
          status: "uploading",
          createdAt: nowIso(),
        })
        .returning()
        .get();
    } catch (e) {
      // Lost a race with an identical concurrent upload (UNIQUE user_id, sha256). Anything else is a real D1 error.
      const other = await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(eq(receipts.userId, user.id), eq(receipts.sha256, sha256)))
        .get();
      if (!other) throw e;
      return c.json({ error: "duplicate_receipt", receiptId: other.id }, 409);
    }
  }
  const r = receipt!;

  const failWith = async (error: string) => {
    await db
      .update(receipts)
      .set({ status: "failed", error })
      .where(and(eq(receipts.id, r.id), eq(receipts.userId, user.id)));
    log("receipt_upload_failed", { receiptId: r.id, code: error });
  };

  let uploaded: { id: string; webViewLink: string };
  try {
    uploaded = await withDrive(c.env, c.var.deps, db, user, async (drive) => {
      const upload = async (parentId: string) =>
        drive.uploadMultipart({ name: driveFileName(r.createdAt, r.id, mime), mimeType: mime, parentId, body: file });
      const folderId = await ensureFolder(db, user, drive);
      try {
        return await upload(folderId);
      } catch (e) {
        // The user deleted the folder: recreate it once and retry.
        if (e instanceof DriveError && e.kind === "not_found") return upload(await ensureFolder(db, user, drive, true));
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof DriveDisconnectedError) {
      await failWith("drive_disconnected");
      clearSessionCookie(c);
      return c.json({ error: "drive_disconnected", receiptId: r.id }, 401);
    }
    const code = e instanceof DriveError && e.kind === "unavailable" ? "drive_unavailable" : "drive_error";
    await failWith(code);
    return c.json({ error: code, receiptId: r.id }, 502);
  }

  await db
    .update(receipts)
    .set({ driveFileId: uploaded.id, driveLink: uploaded.webViewLink, status: "queued", error: null, retryAfter: null })
    .where(and(eq(receipts.id, r.id), eq(receipts.userId, user.id)));
  // Sent only once the row is `queued` with its Drive file, which is what the consumer claims.
  const sent = await enqueueOrPark(c.env.RECEIPT_QUEUE, db, { receiptId: r.id, userId: user.id });
  const saved = await db.select().from(receipts).where(and(eq(receipts.id, r.id), eq(receipts.userId, user.id))).get();
  log("receipt_uploaded", { receiptId: r.id, status: "queued", code: sent === "parked" ? "queue_unavailable" : null });
  return c.json({ receipt: toReceiptDto(saved!) }, 202);
});

receiptRoutes.post("/:id/retry", async (c) => {
  const { db } = c.var;
  const user = c.var.user;
  const id = c.req.param("id");
  const scope = and(eq(receipts.id, id), eq(receipts.userId, user.id));
  const existing = await db.select().from(receipts).where(scope).get();
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.status !== "failed" || existing.error === "unsupported_scanned_pdf") {
    return c.json({ error: "not_retryable", receiptId: id }, 409);
  }
  if (user.driveStatus === "disconnected") return c.json({ error: "drive_disconnected" }, 409);
  // No Drive file to read (the upload failed, or the user deleted it): the browser re-uploads, which reuses this row.
  if (!existing.driveFileId || existing.error === "drive_file_missing") {
    return c.json({ error: "reupload_required", receiptId: id }, 409);
  }
  // Conditional, so two clicks send one message.
  const claimed = await db
    .update(receipts)
    .set({ status: "queued", error: null, retryAfter: null })
    .where(and(scope, eq(receipts.status, "failed")))
    .returning()
    .get();
  if (!claimed) return c.json({ error: "not_retryable", receiptId: id }, 409);
  await enqueueOrPark(c.env.RECEIPT_QUEUE, db, { receiptId: id, userId: user.id });
  const saved = await db.select().from(receipts).where(scope).get();
  log("receipt_retry", { receiptId: id, status: saved!.status });
  return c.json({ receipt: toReceiptDto(saved!) }, 202);
});
