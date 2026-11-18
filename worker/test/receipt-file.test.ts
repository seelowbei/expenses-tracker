import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cacheAccessToken, clearAccessTokenCache } from "../src/drive/access";
import { receipts, users } from "../src/db/schema";
import { db, downloadUrl, fakeGoogle, makeApp, seedUser } from "./helpers";

beforeEach(() => clearAccessTokenCache());
async function fixture(mimeType = "image/png") {
  const user = await seedUser(); const id = crypto.randomUUID();
  cacheAccessToken(user.id, "synthetic-access", 3600);
  await db().insert(receipts).values({ id, userId: user.id, driveFileId: "file", mimeType, sizeBytes: 3, sha256: id, status: "done", createdAt: new Date().toISOString() });
  return { user, id };
}
describe("private original receipt stream", () => {
  it("streams an owned file without buffering or forwarding upstream headers", async () => {
    const f = await fixture(); let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); finish = () => controller.close();
    } });
    const google = fakeGoogle({ [downloadUrl("file")]: () => new Response(body, { headers: { "Content-Type": "text/html", "Set-Cookie": "upstream=private" } }) });
    const response = await makeApp(google).request(`/api/receipts/${f.id}/file`, { headers: { Cookie: f.user.cookie } });
    // The route responds before the upstream stream closes; arrayBuffer() in the Worker would hang here.
    expect(response.status).toBe(200); finish();
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie") ?? "").not.toContain("upstream");
    expect(google.calls).toHaveLength(1);
  });
  it("requires ownership and a session before contacting Drive", async () => {
    const f = await fixture(); const other = await seedUser({ email: "bob@example.com" }); const app = makeApp();
    expect((await app.request(`/api/receipts/${f.id}/file`)).status).toBe(401);
    expect((await app.request(`/api/receipts/${f.id}/file`, { headers: { Cookie: other.cookie } })).status).toBe(404);
    expect(app.fake.calls).toHaveLength(0);
  });
  it.each([[404, 404, "receipt_file_missing"], [503, 503, "drive_unavailable"]])("handles Drive %i without changing ledger or receipt status", async (upstream, status, error) => {
    const f = await fixture("application/pdf");
    const app = makeApp(fakeGoogle({ [downloadUrl("file")]: () => new Response(null, { status: upstream as number }) }));
    const response = await app.request(`/api/receipts/${f.id}/file`, { headers: { Cookie: f.user.cookie } });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
    expect((await db().select().from(receipts).where(eq(receipts.id, f.id)).get())?.status).toBe("done");
  });
  it("fails unsupported stored types without making a Drive request", async () => {
    const f = await fixture("text/html"); const app = makeApp();
    expect((await app.request(`/api/receipts/${f.id}/file`, { headers: { Cookie: f.user.cookie } })).status).toBe(415);
    expect(app.fake.calls).toHaveLength(0);
  });
  it("handles a disconnected account without exposing credentials", async () => {
    const f = await fixture(); clearAccessTokenCache();
    await db().update(users).set({ driveStatus: "disconnected" }).where(eq(users.id, f.user.id));
    const response = await makeApp().request(`/api/receipts/${f.id}/file`, { headers: { Cookie: f.user.cookie } });
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "drive_disconnected" });
  });
});
