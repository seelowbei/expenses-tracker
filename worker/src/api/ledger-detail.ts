import type { Context } from "hono";
import type { AppEnv } from "../app-env";
import { StoredLineItems, StoredReasons, type LedgerDetail } from "../contracts/ledger";
import { readLedgerDetail } from "../db/ledger";

export async function ledgerDetailResponse(c: Context<AppEnv>, id: string, status: 200 | 201 = 200) {
  const row = await readLedgerDetail(c.var.db, c.var.user.id, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!Number.isSafeInteger(row.total_minor) || (row.tax_minor !== null && !Number.isSafeInteger(row.tax_minor))) {
    return c.json({ error: "amount_out_of_range" }, 422);
  }
  const { line_items_json, review_reasons_json, ...fields } = row;
  let reasons: string[] | null = null;
  try {
    if (review_reasons_json && review_reasons_json.length <= 65536) reasons = StoredReasons.parse(JSON.parse(review_reasons_json));
  } catch { /* Preserve malformed evidence without blocking human review. */ }
  try {
    const entry: LedgerDetail = {
      ...fields,
      line_items: StoredLineItems.parse(line_items_json === null ? null : JSON.parse(line_items_json)),
      review_reasons: reasons,
    };
    return c.json({ entry }, status);
  } catch {
    return c.json({ error: "invalid_stored_entry" }, 422);
  }
}

