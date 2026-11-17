import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { categories, ledgerEntries, receipts } from "../src/db/schema";
import { db, makeApp, ORIGIN, seedUser, requestWithEnv } from "./helpers";

const stamp = "2026-11-17T00:00:00.000Z";
async function fixture() {
  const user = await seedUser();
  const id = crypto.randomUUID();
  await db().insert(receipts).values({ id, userId: user.id, mimeType: "image/jpeg", sizeBytes: 10, sha256: id,
    status: "needs_review", error: "test_warning", retryAfter: stamp, rawExtraction: '{"synthetic":true}', reviewReasons: '["total_mismatch"]', createdAt: stamp });
  await db().insert(ledgerEntries).values({ id, userId: user.id, receiptId: id, categoryId: "sys_other", merchant: "Synthetic shop",
    txnDate: "2026-11-17", txnTime: "12:00", currency: "SGD", totalMinor: 1234, taxMinor: 34,
    source: "ai", confidence: 0.9, notes: "Keep", createdAt: stamp, updatedAt: stamp });
  const app = makeApp();
  const patch = (body: unknown, cookie = user.cookie, origin = ORIGIN) => app.request(`/api/ledger/${id}`, {
    method: "PATCH", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const row = () => db().select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
  const receipt = () => db().select().from(receipts).where(eq(receipts.id, id)).get();
  return { ...app, id, user, patch, row, receipt };
}

describe("existing entry saves", () => {
  it("atomically corrects an entry and completes review while preserving evidence", async () => {
    const f = await fixture();
    const res = await f.patch({ expected_updated_at: stamp, total_minor: 1500, txn_time: null, tax_minor: null,
      line_items: [{ description: "Discount", amount_minor: -100 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entry: { total_minor: 1500, txn_time: null, tax_minor: null, notes: "Keep", source: "ai_edited", reviewed_at: expect.any(String), receipt_status: "done" } });
    expect(await f.receipt()).toMatchObject({ status: "done", error: null, retryAfter: null, rawExtraction: '{"synthetic":true}', reviewReasons: '["total_mismatch"]' });
    expect((await f.row())?.confidence).toBe(0.9);
    expect(f.fake.calls).toEqual([]);
  });
  it("records unchanged confirmation without marking AI values corrected, and rejects replay", async () => {
    const f = await fixture();
    expect((await f.patch({ expected_updated_at: stamp, confirm_review: true })).status).toBe(200);
    const row = await f.row();
    expect(row).toMatchObject({ source: "ai", reviewedAt: expect.any(String) });
    expect(row!.updatedAt > stamp).toBe(true);
    expect((await f.patch({ expected_updated_at: stamp, merchant: "Stale" })).status).toBe(409);
    expect((await f.row())?.merchant).toBe("Synthetic shop");
  });
  it("preserves omitted values and treats reordered line-item keys as unchanged", async () => {
    const f = await fixture();
    const lineItems = '[{"amount_minor":1234,"description":"Item"}]';
    await db().update(ledgerEntries).set({ notes: "  Original note  ", lineItems }).where(eq(ledgerEntries.id, f.id));
    expect((await f.patch({ expected_updated_at: stamp, confirm_review: true })).status).toBe(200);
    const row = await f.row();
    expect(row).toMatchObject({ notes: "  Original note  ", lineItems, source: "ai" });
    expect((await f.patch({ expected_updated_at: row!.updatedAt, line_items: [{ description: "Item", amount_minor: 1234 }] })).status).toBe(200);
    expect((await f.row())?.source).toBe("ai");
  });
  it("never writes an entry associated with another user's receipt", async () => {
    const f = await fixture(); const other = await seedUser({ email: "bob@example.com" });
    await db().update(receipts).set({ userId: other.id }).where(eq(receipts.id, f.id));
    expect((await f.patch({ expected_updated_at: stamp, total_minor: 9999 })).status).toBe(404);
    expect((await f.row())?.totalMinor).toBe(1234);
    expect((await f.receipt())?.status).toBe("needs_review");
  });
  it("requires explicit monetary confirmation when changing currency", async () => {
    const f = await fixture();
    expect(await (await f.patch({ expected_updated_at: stamp, currency: "JPY" })).json()).toEqual({ error: "currency_confirmation_required" });
    expect((await f.patch({ expected_updated_at: stamp, currency: "JPY", total_minor: 1234, tax_minor: null, line_items: null, confirm_currency: true })).status).toBe(200);
  });
  it("rejects other users, foreign categories, unauthenticated requests and invalid Origins", async () => {
    const f = await fixture(); const other = await seedUser({ email: "bob@example.com" });
    const body = { expected_updated_at: stamp, confirm_review: true };
    expect((await f.patch(body, other.cookie)).status).toBe(404);
    expect((await f.patch(body, "")).status).toBe(401);
    expect((await f.patch(body, f.user.cookie, "https://evil.test")).status).toBe(403);
    const categoryId = crypto.randomUUID();
    await db().insert(categories).values({ id: categoryId, userId: other.id, name: "Private", slug: "private" });
    expect((await f.patch({ ...body, category_id: categoryId })).status).toBe(404);
    expect((await f.receipt())?.status).toBe("needs_review");
  });
  it("blocks receipts still processing and malformed or oversized bodies", async () => {
    const f = await fixture();
    await db().update(receipts).set({ status: "processing" }).where(eq(receipts.id, f.id));
    expect(await (await f.patch({ expected_updated_at: stamp, confirm_review: true })).json()).toEqual({ error: "receipt_busy" });
    expect((await f.patch({ expected_updated_at: stamp, total_minor: -1 })).status).toBe(400);
    for (const [body, status] of [["{", 400], ["x".repeat(32769), 413]] as const) {
      expect((await f.request(`/api/ledger/${f.id}`, { method: "PATCH", headers: { Cookie: f.user.cookie, Origin: ORIGIN }, body })).status).toBe(status);
    }
  });
});

// Interleave at the actual batch boundary, after the route has read its version/status.
function beforeBatch(before: () => Promise<void>): D1Database {
  return new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("save races and rollback", () => {
  it.each(["version", "receipt"])("guards a concurrent %s change at commit time", async (change) => {
    const f = await fixture();
    const request = requestWithEnv(f.app, { DB: beforeBatch(async () => {
      if (change === "version") await db().update(ledgerEntries).set({ merchant: "Winner", updatedAt: "2026-11-17T00:00:00.001Z" }).where(eq(ledgerEntries.id, f.id));
      else await db().update(receipts).set({ status: "processing" }).where(eq(receipts.id, f.id));
    }) });
    const res = await request(`/api/ledger/${f.id}`, { method: "PATCH", headers: { Cookie: f.user.cookie, Origin: ORIGIN },
      body: JSON.stringify({ expected_updated_at: stamp, merchant: "Loser" }) });
    expect(res.status).toBe(409);
    expect((await f.row())?.merchant).toBe(change === "version" ? "Winner" : "Synthetic shop");
    expect((await f.row())?.reviewedAt).toBeNull();
    expect((await f.receipt())?.status).toBe(change === "version" ? "needs_review" : "processing");
  });
  it("rolls back the ledger if receipt completion fails inside the batch", async () => {
    const f = await fixture();
    await env.DB.exec("CREATE TRIGGER fail_review BEFORE UPDATE ON receipts WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    try {
      expect((await f.patch({ expected_updated_at: stamp, total_minor: 2000 })).status).toBe(500);
      expect(await f.row()).toMatchObject({ totalMinor: 1234, source: "ai", updatedAt: stamp, reviewedAt: null });
      expect(await f.receipt()).toMatchObject({ status: "needs_review", error: "test_warning" });
    } finally { await env.DB.exec("DROP TRIGGER fail_review"); }
  });
  it("advances timestamps even when the old version is ahead of the clock", async () => {
    const f = await fixture();
    const future = "2099-01-01T00:00:00.000Z";
    await db().update(ledgerEntries).set({ updatedAt: future }).where(eq(ledgerEntries.id, f.id));
    expect((await f.patch({ expected_updated_at: future, confirm_review: true })).status).toBe(200);
    expect((await f.row())?.updatedAt).toBe("2099-01-01T00:00:00.001Z");
  });
  it("preserves edited/manual sources and supports entries without a receipt", async () => {
    const f = await fixture();
    for (const source of ["ai_edited", "manual"] as const) {
      await db().update(ledgerEntries).set({ source, receiptId: null, updatedAt: stamp }).where(eq(ledgerEntries.id, f.id));
      expect((await f.patch({ expected_updated_at: stamp, merchant: "Updated" })).status).toBe(200);
      expect((await f.row())?.source).toBe(source);
    }
  });
});
