import { describe, expect, it } from "vitest";
import { reviewDraft } from "../src/contracts/review-draft";
const categories = [{ id: "sys_other", userId: null, name: "Other", slug: "other" }];
const draft = (value: unknown) => reviewDraft(JSON.stringify(value), categories);
describe("safe partial review drafts", () => {
  it("keeps usable fields and leaves missing required values absent", () => {
    expect(draft({ merchant: " Shop ", txn_date: "2026-02-30", txn_time: null, category_slug: "unknown" })).toEqual({ merchant: "Shop", txn_time: null });
    expect(draft({ currency: "XXX", total: 12, tax: 1, line_items: [] })).toEqual({});
  });
  it("converts amounts exactly with currency exponent and supports discounts", () => {
    expect(draft({ currency: "SGD", total: 1.01, tax: null, line_items: [{ description: "Discount", amount: -0.1 }] }))
      .toEqual({ currency: "SGD", total_minor: 101, tax_minor: null, line_items: [{ description: "Discount", amount_minor: -10 }] });
    expect(draft({ currency: "JPY", total: 120 })).toEqual({ currency: "JPY", total_minor: 120 });
    expect(draft({ currency: "KWD", total: 0.001 })).toEqual({ currency: "KWD", total_minor: 1 });
    for (const total of [1.005, 1e-7, 1e21, Number.MAX_SAFE_INTEGER]) expect(draft({ currency: "SGD", total })).toEqual({ currency: "SGD" });
  });
  it("omits malformed line items rather than dropping individual charges", () => {
    expect(draft({ currency: "SGD", line_items: [{ description: "Valid", amount: 1 }, { description: "", amount: 2 }] })).toEqual({ currency: "SGD" });
    expect(draft({ currency: "SGD", total: -1, tax: -1 })).toEqual({ currency: "SGD" });
  });
  it("rejects malformed, oversized and non-object storage without throwing", () => {
    for (const raw of [null, "{", "[]", "null", JSON.stringify({ merchant: "x".repeat(66000) })]) expect(reviewDraft(raw, categories)).toEqual({});
  });
  it("resolves visible slugs with custom precedence and ignores extra keys", () => {
    expect(reviewDraft('{"category_slug":"other","confidence":1,"notes":"injected","user_id":"foreign"}', [...categories, { ...categories[0]!, id: "custom", userId: "owner" }]))
      .toEqual({ category_id: "custom" });
  });
});
