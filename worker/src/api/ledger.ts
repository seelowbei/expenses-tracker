import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { StoredLineItems, StoredReasons, type LedgerDetail, type LedgerPage } from "../contracts/ledger";
import { readLedger, readLedgerDetail } from "../db/ledger";
import { categories } from "../db/schema";
import { LedgerPatch } from "../contracts/ledger-write";
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

async function detailResponse(c: import("hono").Context<AppEnv, "/:id">) {
  const row = await readLedgerDetail(c.var.db, c.var.user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!Number.isSafeInteger(row.total_minor) || (row.tax_minor !== null && !Number.isSafeInteger(row.tax_minor))) {
    return c.json({ error: "amount_out_of_range" }, 422);
  }
  const { line_items_json, review_reasons_json, ...fields } = row;
  try {
    const entry: LedgerDetail = {
      ...fields,
      line_items: StoredLineItems.parse(line_items_json === null ? null : JSON.parse(line_items_json)),
      review_reasons: StoredReasons.parse(review_reasons_json === null ? null : JSON.parse(review_reasons_json)),
    };
    return c.json({ entry });
  } catch {
    return c.json({ error: "invalid_stored_entry" }, 422);
  }
}

ledgerRoutes.get("/:id", detailResponse);

ledgerRoutes.patch("/:id", async (c) => {
  // Count actual streamed bytes; Content-Length may be absent or misleading.
  const reader = c.req.raw.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32 * 1024) { await reader.cancel(); return c.json({ error: "body_too_large" }, 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch { return c.json({ error: "invalid_body" }, 400); }
    finally { reader.releaseLock(); }
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { return c.json({ error: "invalid_json" }, 400); }
  const parsed = LedgerPatch.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))] }, 400);
  const result = await saveLedgerEntry(c.var.db, c.var.user.id, c.req.param("id"), parsed.data);
  if (result === "not_found") return c.json({ error: result }, 404);
  if (result === "entry_changed" || result === "receipt_busy") return c.json({ error: result }, 409);
  if (result === "currency_confirmation_required" || result === "invalid_body") return c.json({ error: result }, 400);
  if (result === "invalid_stored_entry") return c.json({ error: result }, 422);
  return detailResponse(c);
});
