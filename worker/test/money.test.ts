import { describe, expect, it } from "vitest";
import { currencyExponent, toMinor } from "../src/agent/money";

describe("toMinor", () => {
  it("uses 2 decimals for SGD/USD/MYR", () => {
    expect(toMinor(12.5, "SGD")).toBe(1250);
    expect(toMinor(0.1 + 0.2, "USD")).toBe(30);
    expect(toMinor(86, "MYR")).toBe(8600);
  });

  it("avoids float artefacts", () => {
    expect(toMinor(1.005, "SGD")).toBe(101);
    expect(toMinor(19.99, "SGD")).toBe(1999);
  });

  it("uses 0 decimals for JPY/KRW and 3 for KWD", () => {
    expect(toMinor(1200, "JPY")).toBe(1200);
    expect(toMinor(15000, "KRW")).toBe(15000);
    expect(toMinor(1.234, "KWD")).toBe(1234);
  });

  it("rejects malformed codes", () => {
    expect(() => currencyExponent("sgd")).toThrow(RangeError);
    expect(() => currencyExponent("S$D")).toThrow(RangeError);
  });
});
