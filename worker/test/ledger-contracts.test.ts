import { describe, expect, it } from "vitest";
import { LedgerPatch } from "../src/contracts/ledger-write";

const version = { expected_updated_at: "2026-11-17T00:00:00.000Z" };
describe("human ledger edits", () => {
  it("accepts explicit unchanged review and partial corrections", () => {
    expect(LedgerPatch.parse({ ...version, confirm_review: true })).toEqual({ ...version, confirm_review: true });
    expect(LedgerPatch.parse({ ...version, merchant: "  Shop  ", txn_date: "2000-02-29", txn_time: null, tax_minor: null,
      line_items: [{ description: "Discount", amount_minor: -100 }] })).toMatchObject({ merchant: "Shop", tax_minor: null });
  });
  it.each([
    {}, version, { ...version, confirm_review: false }, { ...version, user_id: "other" },
    { ...version, source: "ai" }, { merchant: "Shop" }, { ...version, merchant: "  " },
    { ...version, txn_date: "2026-02-29" }, { ...version, txn_time: "24:00" },
    { ...version, total_minor: 1.5 }, { ...version, total_minor: -1 },
    { ...version, total_minor: Number.MAX_SAFE_INTEGER + 1 }, { ...version, currency: "XXX" },
    { ...version, currency: "ZZZ" }, { ...version, payment_method: "bitcoin" },
    { ...version, line_items: Array.from({ length: 51 }, () => ({ description: "Item", amount_minor: 1 })) },
    { ...version, notes: "x".repeat(2001) },
  ])("rejects invalid or privileged input: %j", (input) => {
    expect(LedgerPatch.safeParse(input).success).toBe(false);
  });
  it("supports real zero- and three-decimal currencies", () => {
    for (const currency of ["SGD", "JPY", "KWD"]) expect(LedgerPatch.safeParse({ ...version, currency }).success).toBe(true);
  });
});
