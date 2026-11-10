import { describe, expect, it } from "vitest";
import { merchantMatches, scoreFields, type Label } from "../eval/compare";

describe("merchantMatches", () => {
  it("ignores case, punctuation and legal suffixes", () => {
    expect(merchantMatches("NTUC FairPrice Co-operative Ltd", "ntuc fairprice co-operative")).toBe(true);
    expect(merchantMatches("Kopitiam Pte. Ltd.", "KOPITIAM")).toBe(true);
  });

  it("accepts substrings and small typos", () => {
    expect(merchantMatches("Cold Storage", "Cold Storage Jelita")).toBe(true);
    expect(merchantMatches("Guardian", "Guardiam")).toBe(true);
  });

  it("rejects different merchants", () => {
    expect(merchantMatches("Watsons", "Guardian")).toBe(false);
  });
});

describe("scoreFields", () => {
  const label: Label = {
    merchant: "Grab",
    txn_date: "2026-11-01",
    currency: "SGD",
    total: 18.4,
    tax: null,
    category_slug: "transport",
  };

  const predicted = { merchant: "GRAB", txn_date: "2026-11-01", txn_time: "18:19", currency: "sgd", total: 18.4, tax: 0, category_slug: "travel" };

  it("scores each field and leaves time unscored when the label omits it", () => {
    expect(scoreFields(label, predicted)).toEqual({
      merchant: true, txn_date: true, txn_time: null, total: true, tax: false, currency: true, category_slug: false,
    });
  });

  it("scores time when labelled, including a labelled null", () => {
    expect(scoreFields({ ...label, txn_time: "18:19" }, predicted).txn_time).toBe(true);
    expect(scoreFields({ ...label, txn_time: null }, predicted).txn_time).toBe(false);
    expect(scoreFields({ ...label, txn_time: null }, { ...predicted, txn_time: null }).txn_time).toBe(true);
  });

  it("scores a failed extraction as all wrong", () => {
    const s = scoreFields({ ...label, txn_time: "18:19" }, null);
    expect(Object.values(s).every((v) => v === false)).toBe(true);
  });
});
