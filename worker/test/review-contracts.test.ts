import { describe, expect, it } from "vitest";
import { ReviewCreate } from "../src/contracts/review";

const valid = { merchant: "Shop", txn_date: "2026-11-18", txn_time: null, currency: "SGD", total_minor: 1250,
  tax_minor: null, category_id: "sys_other", payment_method: null, line_items: null, notes: null };
describe("review creation contract", () => {
  it("accepts complete human values including signed discounts", () => {
    expect(ReviewCreate.parse({ ...valid, line_items: [{ description: "Discount", amount_minor: -100 }] }).total_minor).toBe(1250);
  });
  it("requires every field and rejects audit fields", () => {
    for (const key of Object.keys(valid)) {
      const body: Record<string, unknown> = { ...valid }; delete body[key];
      expect(ReviewCreate.safeParse(body).success).toBe(false);
    }
    for (const key of ["source", "confidence", "user_id", "receipt_id", "expected_updated_at", "reviewed_at"]) {
      expect(ReviewCreate.safeParse({ ...valid, [key]: "untrusted" }).success).toBe(false);
    }
  });
  it("rejects impossible dates, placeholder currencies and unsafe money", () => {
    for (const edits of [{ txn_date: "2026-02-30" }, { currency: "XXX" }, { total_minor: 1.25 }, { total_minor: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(ReviewCreate.safeParse({ ...valid, ...edits }).success).toBe(false);
    }
  });
});
