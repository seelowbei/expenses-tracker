import { describe, expect, it } from "vitest";
import { decimalToMinor, minorToDecimal, entryForm, formPatch } from "../../web/src/ledger/form";
import type { LedgerDetail } from "../src/contracts/ledger";

const entry: LedgerDetail = {
  id: "entry", receipt_id: "receipt", category_id: "sys_other", category_name: "Other", merchant: "Shop",
  txn_date: "2026-11-17", txn_time: null, currency: "SGD", total_minor: 1234, tax_minor: null,
  receipt_status: "needs_review", drive_link: null, payment_method: null, line_items: null, notes: null,
  source: "ai", confidence: 0.9, created_at: "2026-11-17T00:00:00.000Z", updated_at: "2026-11-17T00:00:00.000Z", reviewed_at: null, review_reasons: ["total_mismatch"],
};
describe("exact human money inputs", () => {
  it.each([["12.34", "SGD", 1234], ["1234", "JPY", 1234], ["1.234", "KWD", 1234], ["-1.05", "USD", -105], ["90071992547409.91", "SGD", Number.MAX_SAFE_INTEGER]])("converts %s %s exactly", (value, currency, expected) => {
    expect(decimalToMinor(value, currency)).toBe(expected);
    expect(decimalToMinor(minorToDecimal(expected, currency), currency)).toBe(expected);
  });
  it.each([["1.234", "SGD"], ["1.0", "JPY"], ["1e3", "USD"], ["", "SGD"], ["NaN", "SGD"], ["90071992547409.92", "SGD"], ["1", "XXX"], ["1,000", "USD"]])("rejects %s %s without rounding", (value, currency) => {
    expect(() => decimalToMinor(value, currency)).toThrow();
  });
  it("round-trips an unchanged entry, including null optional fields", () => {
    const result = formPatch(entryForm(entry), entry, false);
    expect(result).toMatchObject({ patch: { confirm_review: true, total_minor: 1234, tax_minor: null, txn_time: null, line_items: null, notes: null } });
  });
  it("requires currency reconfirmation and never reinterprets saved minor units", () => {
    const form = { ...entryForm(entry), currency: "KWD" };
    expect(form.total).toBe("12.34");
    expect(formPatch(form, entry, false)).toMatchObject({ errors: { currency: expect.any(String) } });
    expect(formPatch(form, entry, true)).toMatchObject({ patch: { total_minor: 12340, confirm_currency: true } });
  });
  it("returns field errors for invalid dates, amounts and signed totals; permits discounts", () => {
    const form = { ...entryForm(entry), txn_date: "2026-02-30", total: "-1", tax: "1.001" };
    expect(formPatch(form, entry, false)).toMatchObject({ errors: { txn_date: expect.any(String), total: expect.any(String), tax: expect.any(String) } });
    expect(formPatch({ ...entryForm(entry), line_items: [{ description: "Discount", amount: "-1.00" }] }, entry, false)).toMatchObject({ patch: { line_items: [{ description: "Discount", amount_minor: -100 }] } });
  });
});
