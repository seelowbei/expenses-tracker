import { ledgerDetailResponse } from "./ledger-detail";
import { readJsonBody } from "./json-body";
import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { type LedgerPage } from "../contracts/ledger";
import { readLedger } from "../db/ledger";
import { categories } from "../db/schema";
import { LedgerDelete, LedgerPatch } from "../contracts/ledger-write";
import { deleteLedgerEntry } from "../db/ledger-delete";
import { saveLedgerEntry } from "../db/ledger-write";
import { ledgerCursor, parseLedgerQuery } from "./ledger-query";

export const ledgerRoutes = new Hono<AppEnv>();

ledgerRoutes.get("/", async (c) => {
  const q = parseLedgerQuery(c.req.query());
  if (!q) return c.json({ error: "invalid_filters" }, 400);
  const { db, user } = c.var;
  if (q.category) {
    const visible = await db.select({ id: categories.id }).from(categories)
      .where(and(eq(categories.id, q.category), or(eq(categories.userId, user.id), isNull(categories.userId)))).get();
    if (!visible) return c.json({ error: "not_found" }, 404);
  }
  const [rows, sums] = await readLedger(db, user.id, q);
  const entries = rows.slice(0, q.limit);
  const totals = sums.map(({ total_text, ...rest }) => ({ ...rest, total_minor: Number(total_text) }));
  if (rows.some((e) => !Number.isSafeInteger(e.total_minor)) || totals.some((t) => !Number.isSafeInteger(t.total_minor))) {
    return c.json({ error: "amount_out_of_range" }, 422);
  }
  const body: LedgerPage = {
    entries, totals,
    nextCursor: rows.length > q.limit ? ledgerCursor(q, entries[entries.length - 1]!) : null,
  };
  return c.json(body);
});

ledgerRoutes.get("/:id", (c) => ledgerDetailResponse(c, c.req.param("id")));

ledgerRoutes.patch("/:id", async (c) => {
  const read = await readJsonBody(c.req.raw);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const parsed = LedgerPatch.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] }, 400);
  const result = await saveLedgerEntry(c.var.db, c.var.user.id, c.req.param("id"), parsed.data);
  if (result === "not_found") return c.json({ error: result }, 404);
  if (result === "entry_changed" || result === "receipt_busy") return c.json({ error: result }, 409);
  if (result === "currency_confirmation_required" || result === "invalid_body") return c.json({ error: result }, 400);
  if (result === "invalid_stored_entry") return c.json({ error: result }, 422);
  return ledgerDetailResponse(c, c.req.param("id"));
});

ledgerRoutes.delete("/:id", async (c) => {
  const read = await readJsonBody(c.req.raw);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const parsed = LedgerDelete.safeParse(read.body);
  if (!parsed.success) return c.json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] }, 400);
  const result = await deleteLedgerEntry(c.var.db, c.var.user.id, c.req.param("id"), parsed.data.expected_updated_at);
  if (result === "not_found") return c.json({ error: result }, 404);
  if (result === "entry_changed" || result === "receipt_busy") return c.json({ error: result }, 409);
  return c.body(null, 204);
});
