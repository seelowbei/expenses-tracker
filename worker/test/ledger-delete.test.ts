import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { aiUsage, ledgerEntries, receipts } from "../src/db/schema";
import { sha256Hex } from "../src/lib/encoding";
import { processReceipt } from "../src/pipeline/process";
import { bindings, db, makeApp, ORIGIN, requestWithEnv, seedUser } from "./helpers";

const stamp = "2026-11-19T00:00:00.000Z";

async function fixture() {
  const f = makeApp();
  const user = await seedUser();
  const id = crypto.randomUUID();
  const otherEntryId = crypto.randomUUID();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const sha256 = await sha256Hex(bytes);
  const evidence = { sha256, driveFileId: "original", driveLink: "https://drive.google.com/open?id=original",
    rawExtraction: '{"merchant":"Shop"}', reviewReasons: '["repaired"]' };
  await db().insert(receipts).values({ ...evidence, id, userId: user.id, mimeType: "image/jpeg",
    sizeBytes: bytes.length, status: "needs_review", error: "invalid_output", retryAfter: stamp, createdAt: stamp });
  const entryFields = { userId: user.id, categoryId: "sys_other", merchant: "Shop", txnDate: "2026-11-19",
    source: "ai" as const, createdAt: stamp, updatedAt: stamp };
  await db().insert(ledgerEntries).values([
    { ...entryFields, id, receiptId: id, totalMinor: 100, currency: "SGD" },
    { ...entryFields, id: otherEntryId, totalMinor: 500, currency: "JPY" },
  ]);
  const url = `/api/ledger/${id}`;
  const headers = { Cookie: user.cookie, Origin: ORIGIN, "Content-Type": "application/json" };
  const write = (method: string, body: unknown, extra = {}) => ({ method, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const del = (body: unknown = { expected_updated_at: stamp }, extra = {}) => f.request(url, write("DELETE", body, extra));
  const receipt = () => db().select().from(receipts).where(eq(receipts.id, id)).get();
  return { ...f, id, otherEntryId, user, bytes, evidence, url, headers, del, write, receipt };
}

it("deletes only the ledger entry, resolves review and prevents recreation", async () => {
  const f = await fixture();
  await db().insert(aiUsage).values({ id: "usage", userId: f.user.id, receiptId: f.id, attempt: 1,
    kind: "extract", model: "synthetic", neuronsEst: 1, latencyMs: 1, outcome: "ok", createdAt: stamp });
  const response = await f.del();
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect((await f.request(f.url, { headers: f.headers })).status).toBe(404);
  expect(await f.receipt()).toMatchObject({ ...f.evidence, status: "done", error: null, retryAfter: null });
  expect(await db().select().from(aiUsage).where(eq(aiUsage.receiptId, f.id))).toHaveLength(1);
  const ledger = await f.request("/api/ledger?from=2026-11-01&to=2026-11-30", { headers: f.headers });
  expect(await ledger.json()).toMatchObject({ entries: [{ id: f.otherEntryId }], totals: [{ currency: "JPY", total_minor: 500 }] });
  const detail = await f.request(`/api/receipts/${f.id}`, { headers: f.headers });
  expect(await detail.json()).toMatchObject({ entryId: null, draft: null });
  const recent = await f.request("/api/receipts", { headers: f.headers });
  expect(await recent.json()).toMatchObject({ receipts: [{ id: f.id, status: "done", hasLedgerEntry: false, driveLink: f.evidence.driveLink }] });
  const review = await f.request(`/api/receipts/${f.id}/review`, f.write("POST", {
    merchant: "Shop", txn_date: "2026-11-19", txn_time: null, currency: "SGD", total_minor: 100,
    tax_minor: null, category_id: "sys_other", payment_method: null, line_items: null, notes: null,
  }));
  expect(await review.json()).toEqual({ error: "not_reviewable" });
  const ai = { run: vi.fn(), toMarkdown: vi.fn() };
  expect(await processReceipt({ db: db(), env: bindings(), app: { fetch: f.fake.fetch }, ai },
    { receiptId: f.id, userId: f.user.id }, 2)).toEqual({ action: "ack" });
  const form = new FormData();
  form.set("file", new File([f.bytes], "receipt.jpg", { type: "image/jpeg" }));
  const upload = new Request(`${ORIGIN}/api/receipts`, { method: "POST", headers: { Cookie: f.user.cookie, Origin: ORIGIN }, body: form });
  const uploadBytes = await upload.arrayBuffer();
  upload.headers.set("Content-Length", String(uploadBytes.byteLength));
  const duplicate = await f.request("/api/receipts", { method: "POST", headers: upload.headers, body: uploadBytes });
  expect(await duplicate.json()).toMatchObject({ error: "duplicate_receipt" });
  expect(f.queue.sent).toEqual([]);
  expect(f.fake.calls).toEqual([]);
  expect(ai.run).not.toHaveBeenCalled();
  expect(ai.toMarkdown).not.toHaveBeenCalled();
  expect((await f.del()).status).toBe(404);
});

it("checks session, Origin, version, ownership and receipt state", async () => {
  const f = await fixture();
  const other = await seedUser({ email: "bob@example.com" });
  expect((await f.del(undefined, { Cookie: "" })).status).toBe(401);
  expect((await f.del(undefined, { Origin: "https://other.example" })).status).toBe(403);
  expect((await f.del(undefined, { Cookie: other.cookie })).status).toBe(404);
  expect((await f.del({ expected_updated_at: stamp, user_id: other.id })).status).toBe(400);
  expect((await f.request(f.url, { ...f.write("DELETE", {}), body: "{" })).status).toBe(400);
  expect((await f.request(f.url, { ...f.write("DELETE", {}), body: "x".repeat(32769) })).status).toBe(413);
  expect(await (await f.del({ expected_updated_at: "2026-11-19T00:00:00.001Z" })).json()).toEqual({ error: "entry_changed" });
  await db().update(receipts).set({ status: "processing" }).where(eq(receipts.id, f.id));
  expect(await (await f.del()).json()).toEqual({ error: "receipt_busy" });
  await db().update(receipts).set({ userId: other.id, status: "done" }).where(eq(receipts.id, f.id));
  expect((await f.del()).status).toBe(404);
  const manual = await f.request(`/api/ledger/${f.otherEntryId}`, f.write("DELETE", { expected_updated_at: stamp }));
  expect(manual.status).toBe(204);
});

it("commits at most one competing delete and rejects an old version after edit", async () => {
  const f = await fixture();
  const save = await f.request(f.url, f.write("PATCH", { expected_updated_at: stamp, merchant: "Edited" }));
  expect(save.status).toBe(200);
  expect((await f.del()).status).toBe(409);
  const { entry } = await save.json<{ entry: { updated_at: string } }>();
  const body = { expected_updated_at: entry.updated_at };
  expect((await Promise.all([f.del(body), f.del(body)])).map(r => r.status).sort()).toEqual([204, 404]);
});

it("rolls back the deletion if resolving the receipt fails", async () => {
  const f = await fixture();
  await env.DB.exec("CREATE TRIGGER fail_delete_review BEFORE UPDATE ON receipts WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  try {
    expect((await f.del()).status).toBe(500);
    expect((await f.request(f.url, { headers: f.headers })).status).toBe(200);
    expect(await f.receipt()).toMatchObject({ status: "needs_review", error: "invalid_output" });
  } finally {
    await env.DB.exec("DROP TRIGGER fail_delete_review");
  }
});

it.each(["edit", "receipt claim"] as const)("guards a competing %s at the batch boundary", async (race) => {
  const f = await fixture();
  const dbBeforeBatch = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (race === "edit") {
        await db().update(ledgerEntries).set({ updatedAt: "2026-11-19T00:00:00.001Z" }).where(eq(ledgerEntries.id, f.id));
      } else {
        await db().update(receipts).set({ status: "processing" }).where(eq(receipts.id, f.id));
      }
      return target.batch(statements);
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const request = requestWithEnv(f.app, { DB: dbBeforeBatch });
  const response = await request(f.url, f.write("DELETE", { expected_updated_at: stamp }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: race === "edit" ? "entry_changed" : "receipt_busy" });
  expect((await f.request(f.url, { headers: f.headers })).status).toBe(200);
  expect((await f.receipt())?.status).toBe(race === "edit" ? "needs_review" : "processing");
});
