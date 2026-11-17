import { describe, expect, it } from "vitest";
import type { LedgerTotal } from "../src/contracts/ledger";
import { summarizeTotals } from "../../web/src/ledger/totals";
import { formatMoney } from "../../web/src/ledger/format";

const row = (category: string, month: string, currency: string, amount: number, reviews = 0): LedgerTotal => ({
  category_id: category, category_name: category, month, currency,
  total_minor: amount, entry_count: 1, needs_review_count: reviews,
});

describe("ledger range totals", () => {
  it("combines months into category subtotals and a grand total for each currency", () => {
    expect(summarizeTotals([
      row("Food", "2026-11", "SGD", 450, 1),
      row("Travel", "2026-10", "SGD", 5730),
      row("Food", "2026-09", "SGD", 500, 2),
      row("Food", "2026-10", "USD", 17500),
    ])).toEqual([
      { currency: "SGD", total_minor: 6680n, categories: [
        { category_id: "Food", category_name: "Food", total_minor: 950n, needs_review_count: 3 },
        { category_id: "Travel", category_name: "Travel", total_minor: 5730n, needs_review_count: 0 },
      ] },
      { currency: "USD", total_minor: 17500n, categories: [
        { category_id: "Food", category_name: "Food", total_minor: 17500n, needs_review_count: 0 },
      ] },
    ]);
  });

  it("preserves exact minor units when range sums exceed the safe number boundary", () => {
    const [total] = summarizeTotals([
      row("Food", "2026-11", "SGD", Number.MAX_SAFE_INTEGER),
      row("Food", "2026-10", "SGD", 2),
      row("Travel", "2026-10", "SGD", 2),
    ]);
    expect(formatMoney(total!.categories[0]!.total_minor, total!.currency)).toBe("SGD 90,071,992,547,409.93");
    expect(formatMoney(total!.total_minor, total!.currency)).toBe("SGD 90,071,992,547,409.95");
  });

  it("keeps same-name category IDs separate and supports zero totals and empty ranges", () => {
    const [total] = summarizeTotals([
      row("Food", "2026-11", "JPY", 500),
      row("Food", "2026-10", "JPY", -500),
      { ...row("custom-food", "2026-11", "JPY", 100), category_name: "Food" },
    ]);
    expect(total!.total_minor).toBe(100n);
    expect(total!.categories).toHaveLength(2);
    expect(total!.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ category_id: "Food", total_minor: 0n }),
      expect.objectContaining({ category_id: "custom-food", total_minor: 100n }),
    ]));
    expect(summarizeTotals([])).toEqual([]);
  });
});
