import type { Context } from "hono";
import type { AppEnv } from "../app-env";
import { StoredLineItems, StoredReasons, type LedgerDetail } from "../contracts/ledger";
import { readLedgerDetail } from "../db/ledger";

export async function ledgerDetailResponse(c: Context<AppEnv>, id: string) {
  const row = await readLedgerDetail(c.var.db, c.var.user.id, id);
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

