import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { ReviewCreate } from "../contracts/review";
import { createReviewedEntry } from "../db/review-write";
import { ledgerDetailResponse } from "./ledger-detail";
import { readJsonBody } from "./json-body";
import { log } from "../lib/log";

export const receiptReviewRoutes = new Hono<AppEnv>();
receiptReviewRoutes.post("/:id/review", async (c) => {
  const read = await readJsonBody(c.req.raw);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const parsed = ReviewCreate.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map(i => i.path.join(".")))] }, 400);
  const result = await createReviewedEntry(c.var.db, c.var.user.id, c.req.param("id"), parsed.data);
  if ("error" in result) return c.json(result, result.error === "not_found" ? 404 : 409);
  log("receipt_review_saved", { receiptId: c.req.param("id"), status: "done" });
  return ledgerDetailResponse(c, result.saved, 201);
});
