import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { ledgerCursor, parseLedgerQuery, StoredLineItems, StoredReasons, type LedgerDetail, type LedgerPage } from "../contracts/ledger";
import { readLedger, readLedgerDetail } from "../db/ledger";
import { categories } from "../db/schema";

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

ledgerRoutes.get("/:id", async (c) => {
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
});
