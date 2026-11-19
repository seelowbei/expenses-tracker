import type { Context } from "hono";
import type { AppEnv } from "../app-env";
import { readLedgerExport, type LedgerExportRow } from "../db/ledger";
import { csvCell, csvRow, decimalAmount } from "../lib/csv";
import { categoryVisible } from "./ledger-category";
import { parseLedgerQuery } from "./ledger-query";

/** Bounds D1 rows and CSV work under the 10 ms CPU budget; two users rarely reach this in 12 months. */
export const EXPORT_MAX_ROWS = 5000;

const HEADER = ["date", "time", "merchant", "category", "currency", "total", "tax", "payment_method", "status", "source", "reviewed_at", "notes", "receipt_link", "entry_id"];

function line(r: LedgerExportRow): string {
  const status = r.receipt_status === "needs_review" ? "needs_review" : "confirmed";
  return csvRow([
    csvCell(r.txn_date, true), csvCell(r.txn_time, true), csvCell(r.merchant), csvCell(r.category_name), csvCell(r.currency, true),
    csvCell(decimalAmount(r.total_minor, r.currency), true),
    csvCell(r.tax_minor === null ? null : decimalAmount(r.tax_minor, r.currency), true),
    csvCell(r.payment_method), csvCell(status, true), csvCell(r.source, true), csvCell(r.reviewed_at, true),
    csvCell(r.notes), csvCell(r.drive_link), csvCell(r.id, true),
  ]);
}

export async function ledgerExportResponse(c: Context<AppEnv>) {
  const input = c.req.query();
  // Exports cover the whole filtered range; page parameters would silently truncate it.
  if ("cursor" in input || "limit" in input) return c.json({ error: "invalid_filters" }, 400);
  const q = parseLedgerQuery(input);
  if (!q) return c.json({ error: "invalid_filters" }, 400);
  const { db, user } = c.var;
  if (q.category && !(await categoryVisible(db, user.id, q.category))) return c.json({ error: "not_found" }, 404);
  const rows = await readLedgerExport(db, user.id, q, EXPORT_MAX_ROWS + 1);
  if (rows.length > EXPORT_MAX_ROWS) return c.json({ error: "export_too_large", max_rows: EXPORT_MAX_ROWS }, 422);
  if (rows.some((r) => !Number.isSafeInteger(r.total_minor) || (r.tax_minor !== null && !Number.isSafeInteger(r.tax_minor)))) {
    return c.json({ error: "amount_out_of_range" }, 422);
  }
  // BOM so Excel opens UTF-8 merchant names correctly.
  const body = `﻿${csvRow(HEADER)}${rows.map(line).join("")}`;
  const name = `ledger-${q.from}-to-${q.to}.csv`;
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
}
