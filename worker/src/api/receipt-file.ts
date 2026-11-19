import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { clearSessionCookie } from "../auth/session";
import { receipts } from "../db/schema";
import { DriveDisconnectedError, withDrive } from "../drive/access";
import { DriveError } from "../drive/client";
import { MAX_UPLOAD_BYTES } from "../lib/sniff";

export const receiptFileRoutes = new Hono<AppEnv>();
receiptFileRoutes.get("/:id/file", async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  const { db, user, deps } = c.var;
  const receipt = await db.select({ fileId: receipts.driveFileId, mime: receipts.mimeType }).from(receipts)
    .where(and(eq(receipts.id, c.req.param("id")), eq(receipts.userId, user.id))).get();
  if (!receipt) return c.json({ error: "not_found" }, 404);
  if (!receipt.fileId) return c.json({ error: "receipt_file_missing" }, 404);
  if (!["image/jpeg", "image/png", "application/pdf"].includes(receipt.mime)) return c.json({ error: "unsupported_type" }, 415);
  try {
    const response = await withDrive(c.env, deps, db, user, (drive) => drive.openFile(receipt.fileId!));
    if (Number(response.headers.get("Content-Length")) > MAX_UPLOAD_BYTES) {
      await response.body?.cancel();
      return c.json({ error: "file_too_large" }, 413);
    }
    // Forward only the stream, never Google's headers/tokens or a buffered file copy.
    c.header("Content-Type", receipt.mime);
    c.header("Content-Disposition", `inline; filename="receipt.${receipt.mime === "application/pdf" ? "pdf" : receipt.mime === "image/png" ? "png" : "jpg"}"`);
    return c.newResponse(response.body);
  } catch (e) {
    if (e instanceof DriveDisconnectedError) {
      clearSessionCookie(c);
      return c.json({ error: "drive_disconnected" }, 401);
    }
    if (e instanceof DriveError && e.kind === "not_found") return c.json({ error: "receipt_file_missing" }, 404);
    return c.json({ error: "drive_unavailable" }, 503);
  }
});
