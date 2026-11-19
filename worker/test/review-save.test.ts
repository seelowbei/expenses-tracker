import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { receipts, ledgerEntries, categories } from "../src/db/schema";
import { bindings, db, makeApp, ORIGIN, requestWithEnv, seedUser } from "./helpers";
import { processReceipt } from "../src/pipeline/process";
const values = { merchant: "Reviewed shop", txn_date: "2020-01-01", txn_time: null, currency: "SGD", total_minor: 101,
  tax_minor: null, category_id: "sys_other", payment_method: null, line_items: [{ description: "Discount", amount_minor: -10 }], notes: null };
async function fixture() {
  const user = await seedUser(); const id = crypto.randomUUID(); const app = makeApp();
  await db().insert(receipts).values({ id, userId: user.id, sha256: id, mimeType: "image/jpeg", sizeBytes: 10, status: "needs_review", error: "invalid_output", rawExtraction: '{"merchant":"Original"}', reviewReasons: '["repaired"]', retryAfter: "later", createdAt: "2026-11-18T00:00:00.000Z" });
  const init = (body: unknown = values, cookie = user.cookie, origin = ORIGIN) => ({ method: "POST", headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify(body) });
  const url = `/api/receipts/${id}/review`;
  const post = (body: unknown = values, cookie = user.cookie, origin = ORIGIN) => app.request(url, init(body, cookie, origin));
  const receipt = () => db().select().from(receipts).where(eq(receipts.id, id)).get();
  const entries = () => db().select().from(ledgerEntries).where(eq(ledgerEntries.receiptId, id));
  return { ...app, user, id, url, init, post, receipt, entries };
}
function beforeBatch(before: () => Promise<void>): D1Database {
  return new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
    const value: unknown = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}
describe("missing-entry review saves", () => {
  it("creates a reviewed entry atomically and preserves evidence without external calls", async () => {
    const f = await fixture(); const res = await f.post(); expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ entry: { ...values, source: "ai_edited", confidence: null, reviewed_at: expect.any(String), receipt_status: "done" } });
    expect(await f.receipt()).toMatchObject({ status: "done", error: null, retryAfter: null, rawExtraction: '{"merchant":"Original"}', reviewReasons: '["repaired"]' });
    expect(f.fake.calls).toEqual([]);
  });
  it("allows one winner across concurrent saves and replay never overwrites it", async () => {
    const f = await fixture(); const responses = await Promise.all([f.post(), f.post({ ...values, merchant: "Other" })]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const [entry] = await f.entries(); expect(await f.entries()).toHaveLength(1);
    expect(await (await f.post()).json()).toEqual({ error: "review_already_saved", entryId: entry!.id });
  });
  it("does not resurrect a deleted completed entry or extract it again", async () => {
    const f = await fixture(); expect((await f.post()).status).toBe(201);
    await db().delete(ledgerEntries).where(and(eq(ledgerEntries.userId, f.user.id), eq(ledgerEntries.receiptId, f.id)));
    expect(await (await f.post()).json()).toEqual({ error: "not_reviewable" });
    const result = await processReceipt({ db: db(), env: bindings(), app: { fetch: f.fake.fetch }, ai: { run: async () => { throw new Error("must not extract"); }, toMarkdown: async () => { throw new Error("must not convert"); } } }, { receiptId: f.id, userId: f.user.id }, 1);
    expect(result).toMatchObject({ action: "ack" }); expect(await f.entries()).toHaveLength(0);
  });
  it("enforces session, Origin and receipt/category ownership", async () => {
    const f = await fixture(); const other = await seedUser({ email: "bob@example.com" });
    expect((await f.post(values, "")).status).toBe(401);
    expect((await f.post(values, f.user.cookie, "https://evil.test")).status).toBe(403);
    expect((await f.post(values, other.cookie)).status).toBe(404);
    await db().insert(categories).values({ id: "private", userId: other.id, slug: "private", name: "Private" });
    expect((await f.post({ ...values, category_id: "private" })).status).toBe(404);
    expect(await f.entries()).toHaveLength(0);
  });
  it("rejects invalid, oversized and incomplete bodies", async () => {
    const f = await fixture();
    for (const body of [{}, { ...values, total_minor: 1.2 }, { ...values, source: "ai" }]) expect((await f.post(body)).status).toBe(400);
    for (const [body, status] of [["{", 400], ["x".repeat(32769), 413]] as const) expect((await f.request(f.url, { ...f.init(), body })).status).toBe(status);
  });
  it.each(["status", "category"])("guards a concurrent %s change at the batch boundary", async (change) => {
    const f = await fixture(); const other = await seedUser({ email: "bob@example.com" });
    await db().insert(categories).values({ id: f.id, userId: f.user.id, slug: "mine", name: "Mine" });
    const request = requestWithEnv(f.app, { DB: beforeBatch(async () => {
      if (change === "status") await db().update(receipts).set({ status: "processing" }).where(eq(receipts.id, f.id));
      else await db().update(categories).set({ userId: other.id }).where(eq(categories.id, f.id));
    }) });
    expect((await request(f.url, f.init({ ...values, category_id: f.id }))).status).toBe(change === "status" ? 409 : 404);
    expect(await f.entries()).toHaveLength(0); expect((await f.receipt())?.status).not.toBe("done");
  });
  it("returns successful saved detail even when original warnings are malformed", async () => {
    const f = await fixture();
    await db().update(receipts).set({ reviewReasons: "{" }).where(eq(receipts.id, f.id));
    const response = await f.post(); expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ entry: { review_reasons: null } });
    expect((await f.receipt())?.reviewReasons).toBe("{");
  });
  it("rolls back insertion when receipt completion fails", async () => {
    const f = await fixture();
    await env.DB.exec("CREATE TRIGGER fail_review_create BEFORE UPDATE ON receipts WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    try { expect((await f.post()).status).toBe(500); expect(await f.entries()).toHaveLength(0); expect((await f.receipt())?.status).toBe("needs_review"); }
    finally { await env.DB.exec("DROP TRIGGER fail_review_create"); }
  });
});
