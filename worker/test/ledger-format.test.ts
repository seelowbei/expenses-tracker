import { describe, expect, it } from "vitest";
import { formatMoney, monthRange, shiftMonth } from "../../web/src/ledger/format";

describe("ledger display helpers", () => {
  it("formats minor units exactly, including at the safe integer boundary", () => {
    expect(formatMoney(1234, "SGD")).toBe("SGD 12.34");
    expect(formatMoney(1234, "JPY")).toBe("JPY 1,234");
    expect(formatMoney(1234, "KWD")).toBe("KWD 1.234");
    expect(formatMoney(-5, "USD")).toBe("USD -0.05");
    expect(formatMoney(Number.MAX_SAFE_INTEGER, "SGD")).toBe("SGD 90,071,992,547,409.91");
  });
  it("uses calendar month boundaries without local timezone shifts", () => {
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});
