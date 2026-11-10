import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "../src/agent/categories";
import type { Extraction } from "../src/agent/schema";
import { amountsIn, postValidate } from "../src/agent/validate";

const slugs = DEFAULT_CATEGORIES.map((c) => c.slug);
const today = "2026-11-09";
const base: Extraction = {
  merchant: "Kopitiam",
  txn_date: "2026-11-08",
  txn_time: "12:30",
  currency: "SGD",
  total: 10.9,
  total_text: "TOTAL $10.90",
  tax: 0.9,
  payment_method: "card",
  line_items: [
    { description: "Chicken rice", amount: 5 },
    { description: "Kopi", amount: 5 },
  ],
  category_slug: "food-dining",
  confidence: 0.9,
};

describe("postValidate", () => {
  it("marks a clean extraction done and converts to minor units", () => {
    const r = postValidate(base, slugs, today);
    expect(r.status).toBe("done");
    expect(r.reasons).toEqual([]);
    expect(r.draft).toMatchObject({ total_minor: 1090, tax_minor: 90, category_slug: "food-dining", txn_time: "12:30" });
    expect(r.draft.line_items[0]).toEqual({ description: "Chicken rice", amount_minor: 500 });
  });

  it("maps unknown categories to other and flags review", () => {
    const r = postValidate({ ...base, category_slug: "hawker" }, slugs, today);
    expect(r.draft.category_slug).toBe("other");
    expect(r.reasons).toContain("unknown_category");
    expect(r.status).toBe("needs_review");
  });

  it("allows today + 1 day but not later, and not older than 10 years", () => {
    expect(postValidate({ ...base, txn_date: "2026-11-10" }, slugs, today).reasons).not.toContain("date_out_of_range");
    expect(postValidate({ ...base, txn_date: "2026-11-11" }, slugs, today).reasons).toContain("date_out_of_range");
    expect(postValidate({ ...base, txn_date: "2016-11-09" }, slugs, today).reasons).not.toContain("date_out_of_range");
    expect(postValidate({ ...base, txn_date: "2016-11-08" }, slugs, today).reasons).toContain("date_out_of_range");
  });

  it("flags impossible calendar dates", () => {
    expect(postValidate({ ...base, txn_date: "2026-02-30" }, slugs, today).reasons).toContain("invalid_date");
  });

  it("flags line items that differ from total - tax by more than 2%", () => {
    const r = postValidate({ ...base, line_items: [{ description: "x", amount: 7 }] }, slugs, today);
    expect(r.reasons).toContain("line_items_mismatch");
  });

  it("accepts tax-inclusive receipts where items sum to the total", () => {
    const r = postValidate({ ...base, total: 10, total_text: "TOTAL 10.00", tax: 0.83 }, slugs, today);
    expect(r.reasons).not.toContain("line_items_mismatch");
  });

  it("treats null tax as 0 and skips the check with no line items", () => {
    expect(postValidate({ ...base, total: 10, total_text: "TOTAL 10.00", tax: null }, slugs, today).reasons).toEqual([]);
    expect(postValidate({ ...base, line_items: [] }, slugs, today).reasons).toEqual([]);
  });

  it("never sends a receipt to review for a missing time", () => {
    const r = postValidate({ ...base, txn_time: null }, slugs, today);
    expect(r.status).toBe("done");
    expect(r.draft.txn_time).toBeNull();
  });

  it("flags low confidence", () => {
    const r = postValidate({ ...base, confidence: 0.69 }, slugs, today);
    expect(r.reasons).toEqual(["low_confidence"]);
  });

  it("flags a total that conflicts with the amount in the copied total line", () => {
    expect(postValidate({ ...base, total_text: "Order total S$ 6.84" }, slugs, today).reasons).toEqual(["total_mismatch"]);
    expect(postValidate({ ...base, total: 1234.5, total_text: "Total S$ 1,234.50", line_items: [] }, slugs, today).reasons).toEqual([]);
  });

  it("does not flag a copied line with no amount, or no line at all", () => {
    for (const total_text of [null, "Total", "TOTAL(6Qt)", "Receipt #1414-8063"]) {
      expect(postValidate({ ...base, total_text }, slugs, today).reasons).toEqual([]);
    }
  });

  it("uses whole numbers as amounts for zero-decimal currencies", () => {
    const yen = { ...base, currency: "JPY", total: 1200, tax: null, line_items: [] };
    expect(postValidate({ ...yen, total_text: "合計 ¥1,200" }, slugs, today).reasons).toEqual([]);
    expect(postValidate({ ...yen, total_text: "合計 ¥1,500" }, slugs, today).reasons).toEqual(["total_mismatch"]);
  });

  it("flags a total read from a subtotal line even when the amounts agree", () => {
    for (const line of ["Subtotal S$ 10.90", "SUB-TOTAL 10.90", "Total before voucher 10.90", "Total excl. GST 10.90"]) {
      expect(postValidate({ ...base, total_text: line }, slugs, today).reasons).toEqual(["total_is_subtotal"]);
    }
    expect(postValidate({ ...base, total_text: "TOTAL(GST INCLUSIVE) $10.90" }, slugs, today).reasons).toEqual([]);
  });

  it("flags extractions that needed a repair call", () => {
    expect(postValidate(base, slugs, today, { repaired: true }).reasons).toEqual(["repaired"]);
  });

  it("flags non-alphabetic currency codes without throwing", () => {
    const r = postValidate({ ...base, currency: "S$D" }, slugs, today);
    expect(r.reasons).toContain("invalid_currency");
  });
});

describe("amountsIn", () => {
  it("reads amounts with thousands separators and comma decimals", () => {
    expect(amountsIn("Total S$ 1,234.50")).toEqual([1234.5]);
    expect(amountsIn("Summe 12,50 EUR")).toEqual([12.5]);
    expect(amountsIn("Total")).toEqual([]);
  });

  it("skips whole numbers (quantities, receipt numbers) unless asked for them", () => {
    expect(amountsIn("TOTAL(6Qt) $10.50")).toEqual([10.5]);
    expect(amountsIn("Receipt #1414-8063")).toEqual([]);
    expect(amountsIn("¥1,200", true)).toEqual([1200]);
  });
});
