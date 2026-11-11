import { describe, expect, it } from "vitest";
import { extractJsonObject, normalizeDate, normalizeTime, parseExtraction } from "../src/agent/parse";

describe("normalizeTime", () => {
  it("converts 12-hour times to 24-hour", () => {
    expect(normalizeTime("6:19 PM")).toBe("18:19");
    expect(normalizeTime("06:19pm")).toBe("18:19");
    expect(normalizeTime("12:05 a.m.")).toBe("00:05");
    expect(normalizeTime("12:30 PM")).toBe("12:30");
  });

  it("pads hours and drops seconds", () => {
    expect(normalizeTime("9:05")).toBe("09:05");
    expect(normalizeTime("18:19:42")).toBe("18:19");
    expect(normalizeTime("18.19")).toBe("18:19");
  });

  it("returns null for anything it can't read", () => {
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("13:00 PM")).toBeNull();
    expect(normalizeTime("evening")).toBeNull();
    expect(normalizeTime(1819)).toBeNull();
    expect(normalizeTime(null)).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("reads ambiguous dates day-first", () => {
    expect(normalizeDate("09/11/2026")).toBe("2026-11-09");
    expect(normalizeDate("9-1-2026")).toBe("2026-01-09");
    expect(normalizeDate("03.10.2026")).toBe("2026-10-03");
  });

  it("switches to month-first only when the second number must be a day", () => {
    expect(normalizeDate("11/25/2026")).toBe("2026-11-25");
  });

  it("pads year-first dates and leaves ISO alone", () => {
    expect(normalizeDate("2026/11/9")).toBe("2026-11-09");
    expect(normalizeDate("2026-11-09")).toBe("2026-11-09");
  });

  it("reads month names in any order", () => {
    expect(normalizeDate("9 Nov 2026")).toBe("2026-11-09");
    expect(normalizeDate("Sep-03-2026")).toBe("2026-09-03");
    expect(normalizeDate("October 27, 2026")).toBe("2026-10-27");
    expect(normalizeDate("12 October 2026")).toBe("2026-10-12");
    expect(normalizeDate("Oct. 11, 25")).toBe("2025-10-11");
  });

  it("treats two-digit years as 20YY and ignores weekdays and times", () => {
    expect(normalizeDate("27/09/25 01:14 pm")).toBe("2025-09-27");
    expect(normalizeDate("09/07/2026 (THU)")).toBe("2026-07-09");
    expect(normalizeDate("Sep-03-2026 06:08PM")).toBe("2026-09-03");
    expect(normalizeDate("Date : 8/7/2026 8:02:04 PM")).toBe("2026-07-08");
    expect(normalizeDate("07/07/26 19:31:55 8889 SC021")).toBe("2026-07-07");
    expect(normalizeDate("Marina Sq 09/07/2026")).toBe("2026-07-09");
  });

  it("reads compact POS date stamps", () => {
    expect(normalizeDate("070726")).toBe("2026-07-07");
    expect(normalizeDate("20260707")).toBe("2026-07-07");
    expect(normalizeDate("07072026")).toBe("2026-07-07");
  });

  it("leaves unreadable dates for the schema to reject", () => {
    expect(normalizeDate("123456789")).toBe("123456789");
    expect(normalizeDate("071326")).toBe("071326");
    expect(normalizeDate("32/13/2026")).toBe("32/13/2026");
    expect(normalizeDate("yesterday")).toBe("yesterday");
  });
});

const valid = {
  merchant: "FairPrice Xtra",
  txn_date: "2026-10-03",
  currency: "SGD",
  total: 45.2,
  tax: 3.73,
  payment_method: "card",
  line_items: [{ description: "Milk", amount: 5.2 }],
  category_slug: "groceries",
  confidence: 0.92,
};

describe("extractJsonObject", () => {
  it("handles code fences and surrounding prose", () => {
    const text = 'Here you go:\n```json\n{"a": {"b": "}"}}\n```\nThanks';
    expect(extractJsonObject(text)).toBe('{"a": {"b": "}"}}');
  });

  it("returns null when there is no complete object", () => {
    expect(extractJsonObject("no json")).toBeNull();
    expect(extractJsonObject('{"a": 1')).toBeNull();
  });
});

describe("parseExtraction", () => {
  it("accepts a valid reply string", () => {
    const r = parseExtraction(JSON.stringify(valid));
    expect(r.ok).toBe(true);
  });

  it("accepts an already-parsed object", () => {
    expect(parseExtraction(valid).ok).toBe(true);
  });

  it("fills omitted nullable keys and coerces numeric strings", () => {
    const { tax: _t, payment_method: _p, line_items: _l, ...rest } = valid;
    const r = parseExtraction(JSON.stringify({ ...rest, total: "45.20", currency: "sgd", confidence: "0.9" }));
    expect(r.ok && r.value).toMatchObject({ total: 45.2, currency: "SGD", tax: null, payment_method: null, line_items: [] });
  });

  it("defaults a missing time to null and never fails on an unreadable one", () => {
    const plain = parseExtraction(JSON.stringify(valid));
    expect(plain.ok && plain.value.txn_time).toBeNull();
    const r = parseExtraction(JSON.stringify({ ...valid, txn_time: "around dinner" }));
    expect(r.ok && r.value.txn_time).toBeNull();
    const pm = parseExtraction(JSON.stringify({ ...valid, txn_time: "6:19 PM" }));
    expect(pm.ok && pm.value.txn_time).toBe("18:19");
  });

  it("maps printed payment methods to the enum and never fails on an unknown one", () => {
    const pm = (v: unknown) => {
      const r = parseExtraction(JSON.stringify({ ...valid, payment_method: v }));
      return r.ok ? r.value.payment_method : "FAILED";
    };
    expect(pm("Apple Pay")).toBe("ewallet");
    expect(pm("VISA2")).toBe("card");
    expect(pm("NETS")).toBe("card");
    expect(pm("PayNow")).toBe("bank_transfer");
    expect(pm("CASH")).toBe("cash");
    expect(pm("ewallet")).toBe("ewallet");
    expect(pm("voucher")).toBe("other");
    expect(pm("")).toBeNull();
    expect(pm(42)).toBeNull();
  });

  it("converts printed DD/MM/YYYY dates before validation", () => {
    const r = parseExtraction(JSON.stringify({ ...valid, txn_date: "09/11/2026" }));
    expect(r.ok && r.value.txn_date).toBe("2026-11-09");
  });

  it("reports schema errors with paths", () => {
    const r = parseExtraction(JSON.stringify({ ...valid, txn_date: "yesterday", total: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("txn_date"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("total"))).toBe(true);
    }
  });

  it("reports invalid JSON", () => {
    const r = parseExtraction('{"merchant": "x",}');
    expect(r.ok).toBe(false);
  });

  it("returns the fields that passed on their own when the reply fails as a whole", () => {
    const r = parseExtraction(JSON.stringify({ ...valid, txn_date: "sometime last week", merchant: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.partial).toMatchObject({ total: valid.total, currency: valid.currency, category_slug: valid.category_slug });
    expect(r.partial).not.toHaveProperty("txn_date");
    expect(r.partial).not.toHaveProperty("merchant");
  });

  it("returns no partial fields when there is no JSON", () => {
    const r = parseExtraction("no json here");
    expect(!r.ok && r.partial).toEqual({});
    const bad = parseExtraction('{"merchant": "x",}');
    expect(!bad.ok && bad.partial).toEqual({});
  });
});
