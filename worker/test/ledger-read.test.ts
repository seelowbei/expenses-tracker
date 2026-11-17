import { describe, expect, it } from "vitest";
import { categories, ledgerEntries, receipts, type NewLedgerEntry } from "../src/db/schema";
import { db, makeApp, seedUser } from "./helpers";
import { parseLedgerQuery } from "../src/api/ledger-query";

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
const get = (cookie: string, query = range) => makeApp().request(`/api/ledger?${query}`, { headers: { Cookie: cookie } });

describe("ledger reads", () => {
  it("defaults to the current UTC month and accepts leap dates", () => {
    expect(parseLedgerQuery({}, "2024-02-29")).toMatchObject({ from: "2024-02-01", to: "2024-02-29", limit: 50 });
    expect(parseLedgerQuery({ from: "2024-02-29", to: "2024-03-01" })).not.toBeNull();
    expect(parseLedgerQuery({ from: "2026-02-29", to: "2026-03-01" })).toBeNull();
  });

  it("uses a bounded default page and rejects a cursor reused with different filters", async () => {
    const user = await seedUser();
    for (let i = 0; i < 51; i++) await entry(user.id, { totalMinor: 1 });
    const res = await get(user.cookie);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; totals: { total_minor: number }[]; nextCursor: string };
    expect(body.entries).toHaveLength(50);
    expect(body.totals[0]?.total_minor).toBe(51);
    const last = await get(user.cookie, `${range}&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(await last.json()).toMatchObject({ entries: [expect.any(Object)], nextCursor: null });
    expect((await get(user.cookie, `${range}&category=sys_other&cursor=${encodeURIComponent(body.nextCursor)}`)).status).toBe(400);
  });

  it("returns empty totals and no cursor for an empty range", async () => {
    const user = await seedUser();
    expect(await (await get(user.cookie)).json()).toEqual({ entries: [], totals: [], nextCursor: null });
  });

  it("rejects unsafe aggregate amounts instead of returning rounded totals", async () => {
    const user = await seedUser();
    await entry(user.id, { totalMinor: Number.MAX_SAFE_INTEGER });
    await entry(user.id, { totalMinor: 1 });
    const res = await get(user.cookie);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "amount_out_of_range" });
  });

  it("does not expose entries that reference another user's category", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const categoryId = crypto.randomUUID();
    await db().insert(categories).values({ id: categoryId, userId: b.id, slug: "private", name: "Private" });
    const row = await entry(a.id, { categoryId });
    expect(await (await get(a.cookie)).json()).toEqual({ entries: [], totals: [], nextCursor: null });
    expect((await makeApp().request(`/api/ledger/${row.id}`, { headers: { Cookie: a.cookie } })).status).toBe(404);
  });

  it("handles malformed stored details with a stable error", async () => {
    const user = await seedUser();
    const row = await entry(user.id, { lineItems: "{broken" });
    const res = await makeApp().request(`/api/ledger/${row.id}`, { headers: { Cookie: user.cookie } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_stored_entry" });
  });
  it("requires authentication for list and detail", async () => {
    for (const path of ["/api/ledger", "/api/ledger/unknown"]) expect((await makeApp().request(path)).status).toBe(401);
  });

  it("paginates equal dates/times and null times while totals cover the whole range", async () => {
    const user = await seedUser();
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await entry(user.id, { txnTime: i < 2 ? "12:00" : null, totalMinor: 100 }));
    rows.push(await entry(user.id, { txnDate: "2026-11-15", txnTime: "23:00", totalMinor: 100 }));
    await entry(user.id, { txnDate: "2026-10-31", totalMinor: 9999 });
    const expected = [...rows].sort((a, b) => b.txnDate.localeCompare(a.txnDate) || (b.txnTime ?? "").localeCompare(a.txnTime ?? "") || b.id.localeCompare(a.id));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const res = await get(user.cookie, `${range}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: { id: string }[]; totals: unknown[]; nextCursor: string | null };
      seen.push(...body.entries.map((e) => e.id));
      expect(body.totals).toEqual([expect.objectContaining({ total_minor: 600, entry_count: 6, currency: "SGD", month: "2026-11" })]);
      cursor = body.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it("separates users, categories, months and currencies, including provisional entries", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const receiptId = crypto.randomUUID();
    await db().insert(receipts).values({ id: receiptId, userId: a.id, mimeType: "image/jpeg", sizeBytes: 10, sha256: receiptId, status: "needs_review", createdAt: "2026-11-16T00:00:00.000Z" });
    await entry(a.id, { receiptId, totalMinor: 200 });
    await entry(a.id, { currency: "JPY", totalMinor: 500 });
    await entry(a.id, { categoryId: "sys_groceries", totalMinor: 700 });
    await entry(a.id, { txnDate: "2026-10-31", totalMinor: 300 });
    await entry(b.id, { totalMinor: 9000 });
    const res = await get(a.cookie, "from=2026-10-01&to=2026-11-30&category=sys_other");
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Record<string, unknown>[]; totals: Record<string, unknown>[] };
    expect(body.entries).toHaveLength(3);
    expect(body.totals).toEqual(expect.arrayContaining([
      expect.objectContaining({ month: "2026-10", currency: "SGD", total_minor: 300 }),
      expect.objectContaining({ month: "2026-11", currency: "SGD", total_minor: 200, needs_review_count: 1 }),
      expect.objectContaining({ month: "2026-11", currency: "JPY", total_minor: 500 }),
    ]));
    expect(body.totals).toHaveLength(3);
    expect(body.entries.every((e) => !("user_id" in e) && !("line_items" in e) && !("raw_extraction" in e))).toBe(true);
  });

  it("rejects malformed filters and inaccessible categories", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const categoryId = crypto.randomUUID();
    await db().insert(categories).values({ id: categoryId, userId: b.id, name: "Private", slug: "private" });
    for (const query of ["from=2026-11-01", "from=2026-02-30&to=2026-03-01", "from=2026-11-30&to=2026-11-01", "from=2025-01-01&to=2026-01-01", `${range}&limit=101`, `${range}&limit=0`, `${range}&limit=1.5`, `${range}&cursor=invalid`]) {
      expect((await get(a.cookie, query)).status, query).toBe(400);
    }
    for (const id of [categoryId, "missing"]) expect((await get(a.cookie, `${range}&category=${id}`)).status).toBe(404);
  });

  it("reads owned details without fetching Drive, and hides other-user associations", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const receiptId = crypto.randomUUID();
    await db().insert(receipts).values({ id: receiptId, userId: b.id, mimeType: "image/jpeg", sizeBytes: 10, sha256: receiptId, status: "done", driveLink: "https://example.test/private", createdAt: "2026-11-16T00:00:00.000Z" });
    const own = await entry(a.id, { receiptId, notes: "My note", lineItems: JSON.stringify([{ description: "Item", amount_minor: 1234 }]) });
    const other = await entry(b.id);
    const { request, fake } = makeApp();
    const res = await request(`/api/ledger/${own.id}`, { headers: { Cookie: a.cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ entry: { id: own.id, receipt_id: null, drive_link: null, receipt_status: null, notes: "My note", line_items: [{ description: "Item", amount_minor: 1234 }] } });
    for (const id of [other.id, "missing"]) expect((await request(`/api/ledger/${id}`, { headers: { Cookie: a.cookie } })).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });
});
