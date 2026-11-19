import { describe, expect, it } from "vitest";
import { formatMoney, monthRange, presetRange, rangeLabel, shiftDate, shiftMonth } from "../../web/src/ledger/format";

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
  it("builds rolling range presets the 12-calendar-month API limit accepts", () => {
    expect(presetRange("1m", "2026-11-19")).toEqual({ from: "2026-10-19", to: "2026-11-19" });
    expect(presetRange("3m", "2026-11-19")).toEqual({ from: "2026-08-19", to: "2026-11-19" });
    expect(presetRange("1y", "2026-11-19")).toEqual({ from: "2025-12-01", to: "2026-11-19" });
    expect(presetRange("3m", "2026-05-31")).toEqual({ from: "2026-02-28", to: "2026-05-31" });
    expect(shiftDate("2024-03-31", -1)).toBe("2024-02-29");
  });
  it("labels ranges compactly", () => {
    expect(rangeLabel("2026-10-19", "2026-11-19")).toBe("Oct 19 – Nov 19, 2026");
    expect(rangeLabel("2025-12-01", "2026-11-19")).toBe("Dec 1, 2025 – Nov 19, 2026");
    expect(rangeLabel("2026-11-19", "2026-11-19")).toBe("Nov 19, 2026");
  });
});
