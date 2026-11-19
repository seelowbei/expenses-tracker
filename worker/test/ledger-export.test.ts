import { describe, expect, it } from "vitest";
import { categories, ledgerEntries, receipts, type NewLedgerEntry } from "../src/db/schema";
import { EXPORT_MAX_ROWS } from "../src/api/ledger-export";
import { csvCell, decimalAmount } from "../src/lib/csv";
import { db, makeApp, seedUser } from "./helpers";

async function entry(userId: string, values: Partial<NewLedgerEntry> = {}) {
  const row: NewLedgerEntry = {
    id: crypto.randomUUID(), userId, categoryId: "sys_other", merchant: "Synthetic shop",
    txnDate: "2026-11-16", txnTime: "12:00", currency: "SGD", totalMinor: 1234,
    source: "ai", createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", ...values,
  };
  await db().insert(ledgerEntries).values(row);
  return row;
}
const range = "from=2026-11-01&to=2026-11-30";
const get = (cookie: string, query = range) => makeApp().request(`/api/ledger/export?${query}`, { headers: { Cookie: cookie } });
const lines = async (res: Response) => (await res.text()).replace(/^﻿/, "").split("\r\n").filter(Boolean);

describe("csv helpers", () => {
  it("formats exact decimals using the currency exponent", () => {
    expect(decimalAmount(1234, "SGD")).toBe("12.34");
    expect(decimalAmount(5, "USD")).toBe("0.05");
    expect(decimalAmount(-250, "SGD")).toBe("-2.50");
    expect(decimalAmount(1500, "JPY")).toBe("1500");
    expect(decimalAmount(1234, "KWD")).toBe("1.234");
    expect(decimalAmount(Number.MAX_SAFE_INTEGER, "SGD")).toBe("90071992547409.91");
  });

  it("quotes RFC 4180 specials and neutralises spreadsheet formulas in free text", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell('Bob\'s "Diner", Ltd')).toBe('"Bob\'s ""Diner"", Ltd"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    for (const v of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell("-2.50", true)).toBe("-2.50");
  });
});

describe("ledger export", () => {
  it("returns every entry in the range as an attachment, newest first", async () => {
    const user = await seedUser();
    const receiptId = crypto.randomUUID();
    await db().insert(receipts).values({
      id: receiptId, userId: user.id, status: "needs_review", mimeType: "image/png", sizeBytes: 1, sha256: "h",
      driveLink: "https://drive.google.com/file/d/x", createdAt: "2026-11-16T00:00:00.000Z",
    });
    for (let i = 0; i < 120; i++) await entry(user.id, { txnDate: "2026-11-02", totalMinor: 1 });
    const latest = await entry(user.id, { receiptId, merchant: "=cmd|' /C calc'!A0", notes: "a, \"b\"", taxMinor: 100, paymentMethod: "card", txnTime: null });
    await entry(user.id, { txnDate: "2026-10-31" });

    const res = await get(user.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="ledger-2026-11-01-to-2026-11-30.csv"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const rows = await lines(res);
    expect(rows[0]).toBe("date,time,merchant,category,currency,total,tax,payment_method,status,source,reviewed_at,notes,receipt_link,entry_id");
    expect(rows).toHaveLength(122);
    expect(rows[1]).toBe(`2026-11-16,,'=cmd|' /C calc'!A0,Other,SGD,12.34,1.00,card,needs_review,ai,,"a, ""b""",https://drive.google.com/file/d/x,${latest.id}`);
    expect(rows[2]).toMatch(/^2026-11-02,12:00,Synthetic shop,Other,SGD,0\.01,,,confirmed,ai,,,,/);
  });

  it("filters by category and keeps other users' entries out", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    await entry(a.id, { categoryId: "sys_other", merchant: "Mine" });
    await entry(b.id, { merchant: "Theirs" });
    const foreign = crypto.randomUUID();
    await db().insert(categories).values({ id: foreign, userId: b.id, slug: "private", name: "Private" });
    expect(await lines(await get(a.cookie))).toEqual([expect.stringMatching(/^date,/), expect.stringContaining("Mine")]);
    expect(await lines(await get(a.cookie, `${range}&category=sys_food-dining`))).toHaveLength(1);
    expect((await get(a.cookie, `${range}&category=${foreign}`)).status).toBe(404);
  });

  it("rejects invalid ranges and page parameters", async () => {
    const user = await seedUser();
    for (const q of ["from=2026-11-30&to=2026-11-01", "from=2025-01-01&to=2026-11-30", "from=2026-11-01", `${range}&limit=5`, `${range}&cursor=x`]) {
      const res = await get(user.cookie, q);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_filters" });
    }
  });

  it("refuses ranges over the row cap instead of truncating", async () => {
    const user = await seedUser();
    const rows = Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => ({
      id: `e${i}`, userId: user.id, categoryId: "sys_other", merchant: "m", txnDate: "2026-11-01", currency: "SGD", totalMinor: 1,
      source: "ai" as const, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    }));
    // D1 caps bound parameters per statement, so insert in small chunks.
    for (let i = 0; i < rows.length; i += 8) await db().insert(ledgerEntries).values(rows.slice(i, i + 8));
    const res = await get(user.cookie);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "export_too_large", max_rows: EXPORT_MAX_ROWS });
  });

  it("requires authentication", async () => {
    expect((await makeApp().request(`/api/ledger/export?${range}`)).status).toBe(401);
  });
});
