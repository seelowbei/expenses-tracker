import { describe, expect, it } from "vitest";
import { entryForm, formCreate } from "../../web/src/ledger/form";

describe("missing-entry review form", () => {
  it("leaves required missing fields blank and blocks incomplete save", () => {
    const form = entryForm({ merchant: "Shop" });
    expect(form).toMatchObject({ merchant: "Shop", txn_date: "", currency: "", category_id: "", total: "", tax: "" });
    expect(formCreate(form, "", false).errors).toBeDefined();
  });
  it("serializes a complete human form without fake ledger fields", () => {
    const form = entryForm({ merchant: "Shop", txn_date: "2026-11-18", currency: "KWD", total_minor: 1234, category_id: "sys_other", line_items: [{ description: "Discount", amount_minor: -1 }] });
    const result = formCreate(form, "KWD", false);
    expect(result.body).toEqual({ merchant: "Shop", txn_date: "2026-11-18", txn_time: null, currency: "KWD", total_minor: 1234,
      tax_minor: null, category_id: "sys_other", payment_method: null, notes: null, line_items: [{ description: "Discount", amount_minor: -1 }] });
  });
  it("requires checking amounts after selecting or changing currency", () => {
    const form = { ...entryForm({ merchant: "Shop", txn_date: "2026-11-18", category_id: "sys_other" }), currency: "JPY", total: "123" };
    expect(formCreate(form, "", false).errors?.currency).toBeDefined();
    expect(formCreate(form, "", true).body?.total_minor).toBe(123);
    expect(formCreate({ ...form, total: "1.23" }, "", true).errors?.total).toBeDefined();
  });
});
