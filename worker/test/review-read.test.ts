import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { receipts, ledgerEntries } from "../src/db/schema";
import { db, makeApp, seedUser } from "./helpers";

async function receiptFor(userId: string, extra = {}) {
  const id = crypto.randomUUID();
  await db().insert(receipts).values({ id, userId, sha256: id, mimeType: "image/jpeg", sizeBytes: 10,
    status: "needs_review", error: "invalid_output", rawExtraction: '{"merchant":"Shop","total":1.23,"currency":"SGD"}', createdAt: "2026-11-18T00:00:00.000Z", ...extra });
  return id;
}
describe("receipt review detail", () => {
  it("returns safe partial fields and never exposes raw extraction", async () => {
    const user = await seedUser(); const id = await receiptFor(user.id, { reviewReasons: "{" }); const app = makeApp();
    const response = await app.request(`/api/receipts/${id}`, { headers: { Cookie: user.cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ entryId: null, draft: { merchant: "Shop", currency: "SGD", total_minor: 123 }, receipt: { reviewReasons: null } });
    expect(JSON.stringify(body)).not.toContain("rawExtraction");
    expect(app.fake.calls).toEqual([]);
    expect((await app.request('/api/receipts', { headers: { Cookie: user.cookie } })).status).toBe(200);
  });
  it("hides foreign receipts and returns no draft for terminal receipts", async () => {
    const user = await seedUser(); const other = await seedUser({ email: "bob@example.com" }); const id = await receiptFor(user.id, { status: "done" }); const app = makeApp();
    expect((await app.request(`/api/receipts/${id}`, { headers: { Cookie: other.cookie } })).status).toBe(404);
    expect((await app.request(`/api/receipts/${id}`)).status).toBe(401);
    expect(await (await app.request(`/api/receipts/${id}`, { headers: { Cookie: user.cookie } })).json()).toMatchObject({ entryId: null, draft: null });
  });
  it("returns the associated owned entry and prefers it to the raw draft", async () => {
    const user = await seedUser(); const id = await receiptFor(user.id); const app = makeApp();
    await db().insert(ledgerEntries).values({ id: "entry", userId: user.id, receiptId: id, merchant: "Saved", categoryId: "sys_other", txnDate: "2026-11-18", currency: "SGD", totalMinor: 123, source: "ai", createdAt: "now", updatedAt: "now" });
    expect(await (await app.request(`/api/receipts/${id}`, { headers: { Cookie: user.cookie } })).json()).toMatchObject({ entryId: "entry", draft: null });
  });
});

describe("receipt review pagination", () => {
  it("reaches every pending receipt with tied timestamps and a removed cursor anchor", async () => {
    const user = await seedUser(); const app = makeApp(); const headers = { Cookie: user.cookie };
    for (let i = 0; i < 53; i++) await receiptFor(user.id);
    await receiptFor(user.id, { status: "done" });
    const first = await (await app.request('/api/receipts?status=needs_review', { headers })).json() as { receipts: { id: string }[]; nextCursor: string };
    expect(first.receipts).toHaveLength(50); expect(first.nextCursor).toBeTypeOf("string");
    const anchor = first.receipts.at(-1)!.id;
    await db().update(receipts).set({ status: "done" }).where(eq(receipts.id, anchor));
    const second = await (await app.request(`/api/receipts?status=needs_review&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).json() as { receipts: { id: string }[]; nextCursor: string | null };
    expect(second.receipts).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.receipts, ...second.receipts].map(r => r.id)).size).toBe(53);
    expect((await app.request(`/api/receipts?status=done&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).status).toBe(400);
    const other = await seedUser({ email: "bob@example.com" });
    expect(await (await app.request(`/api/receipts?status=needs_review&cursor=${encodeURIComponent(first.nextCursor)}`, { headers: { Cookie: other.cookie } })).json()).toMatchObject({ receipts: [] });
  });
  it("bounds pagination and preserves default and comma-separated status behavior", async () => {
    const user = await seedUser(); const app = makeApp(); const headers = { Cookie: user.cookie };
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'cursor=bad', `cursor=${'x'.repeat(2000)}`]) {
      expect(await (await app.request(`/api/receipts?${query}`, { headers })).json()).toEqual({ error: "invalid_filters" });
    }
    await receiptFor(user.id, { status: "queued" }); await receiptFor(user.id, { status: "processing" });
    expect(await (await app.request('/api/receipts?status=processing,queued&limit=100', { headers })).json()).toMatchObject({ receipts: [expect.any(Object), expect.any(Object)], nextCursor: null });
    expect((await app.request('/api/receipts?status=bogus', { headers })).status).toBe(400);
    expect((await app.request('/api/receipts', { headers })).status).toBe(200);
  });
});
