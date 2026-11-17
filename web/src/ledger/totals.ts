import type { LedgerTotal } from "../../../worker/src/contracts/ledger";

interface CategorySubtotal {
  category_id: string;
  category_name: string;
  total_minor: bigint;
  needs_review_count: number;
}

/** Roll up full-range API totals, never the paginated entries. */
export function summarizeTotals(totals: LedgerTotal[]) {
  const currencies = new Map<string, { total_minor: bigint; categories: Map<string, CategorySubtotal> }>();
  for (const row of totals) {
    const group = currencies.get(row.currency) ?? { total_minor: 0n, categories: new Map<string, CategorySubtotal>() };
    const category = group.categories.get(row.category_id) ?? {
      category_id: row.category_id, category_name: row.category_name, total_minor: 0n, needs_review_count: 0,
    };
    // Individual API totals are safe integers; their combined sum may exceed that boundary.
    const amount = BigInt(row.total_minor);
    group.total_minor += amount;
    category.total_minor += amount;
    category.needs_review_count += row.needs_review_count;
    group.categories.set(row.category_id, category);
    currencies.set(row.currency, group);
  }
  return [...currencies].sort(([a], [b]) => a.localeCompare(b)).map(([currency, group]) => ({
    currency,
    total_minor: group.total_minor,
    categories: [...group.categories.values()].sort((a, b) => a.category_name.localeCompare(b.category_name) || a.category_id.localeCompare(b.category_id)),
  }));
}
