import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { driveFileName, MAX_DIRECT_UPLOAD_BYTES } from "../src/api/receipts";
import { validateSession } from "../src/auth/session";
import { receipts, users } from "../src/db/schema";
import { cacheAccessToken, clearAccessTokenCache } from "../src/drive/access";
import { db, FOLDER_URL, fakeGoogle, json, makeApp, ORIGIN, seedUser, TOKEN_URL, UPLOAD_URL } from "./helpers";

beforeEach(() => clearAccessTokenCache());

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const PDF = new TextEncoder().encode("%PDF-1.7\n...");

let n = 0;
/** Unique bytes per call so tests never collide on the (user_id, sha256) duplicate check. */
const unique = (base: Uint8Array) => new Uint8Array([...base, ...new TextEncoder().encode(`#${++n}-${Math.random()}`)]);

function form(bytes: Uint8Array, name = "r.jpg") {
  const f = new FormData();
  f.append("file", new File([bytes], name, { type: "application/octet-stream" }));
  return f;
}

const refreshOk = () => json({ access_token: "at-refreshed", expires_in: 3599, token_type: "Bearer" });
const uploadOk = (id = "file-1") => () => json({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });

function upload(request: ReturnType<typeof makeApp>["request"], cookie: string, bytes: Uint8Array, extra: HeadersInit = {}) {
  return request("/api/receipts", { method: "POST", body: form(bytes), headers: { Cookie: cookie, Origin: ORIGIN, ...extra } });
}

describe("POST /api/receipts", () => {
  it("uploads to the user's Drive folder and leaves the receipt queued", async () => {
    const { cookie, id } = await seedUser({ driveFolderId: "folder-a" });
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk("file-a") });
    const { request } = makeApp(google);
    const bytes = unique(JPEG);

    const res = await upload(request, cookie, bytes);
    expect(res.status).toBe(202);
    const { receipt } = (await res.json()) as { receipt: { id: string; status: string; driveLink: string; mimeType: string } };
    expect(receipt).toMatchObject({ status: "queued", mimeType: "image/jpeg", driveLink: "https://drive.google.com/file/d/file-a/view" });

    const refresh = new URLSearchParams(google.callsTo(TOKEN_URL)[0]!.body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe(`rt-${id}`);

    const call = google.callsTo(UPLOAD_URL)[0]!;
    expect(call.url.searchParams.get("uploadType")).toBe("multipart");
    expect(call.headers.get("Authorization")).toBe("Bearer at-refreshed");
    expect(call.headers.get("Content-Type")).toMatch(/^multipart\/related; boundary=/);
    const row = await db().select().from(receipts).where(eq(receipts.id, receipt.id)).get();
    const name = driveFileName(row!.createdAt, receipt.id, "image/jpeg");
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_[0-9a-f-]{36}\.jpg$/);
    expect(call.body).toContain(JSON.stringify({ name, mimeType: "image/jpeg", parents: ["folder-a"] }));
    expect(row).toMatchObject({ userId: id, status: "queued", driveFileId: "file-a", sizeBytes: bytes.length, error: null });
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names PNG and PDF files by their sniffed type, ignoring the client's file name", async () => {
    const { cookie } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk() });
    const { request } = makeApp(google);
    expect((await upload(request, cookie, unique(PNG))).status).toBe(202);
    expect((await upload(request, cookie, unique(PDF))).status).toBe(202);
    const [png, pdf] = google.callsTo(UPLOAD_URL);
    expect(png!.body).toMatch(/_[0-9a-f-]{36}\.png","mimeType":"image\/png"/);
    expect(pdf!.body).toMatch(/_[0-9a-f-]{36}\.pdf","mimeType":"application\/pdf"/);
    // The access token was cached after the first refresh.
    expect(google.callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it("returns 409 with the existing id for a duplicate", async () => {
    const { cookie } = await seedUser();
    const { request } = makeApp(fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk() }));
    const bytes = unique(JPEG);
    const first = (await (await upload(request, cookie, bytes)).json()) as { receipt: { id: string } };
    const dup = await upload(request, cookie, bytes);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "duplicate_receipt", receiptId: first.receipt.id });
  });

  it("allows the same file for a different user", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const { request } = makeApp(fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk() }));
    const bytes = unique(JPEG);
    expect((await upload(request, a.cookie, bytes)).status).toBe(202);
    expect((await upload(request, b.cookie, bytes)).status).toBe(202);
  });

  it("rejects unsupported, empty, missing and oversized files", async () => {
    const { cookie } = await seedUser();
    const { request } = makeApp();
    const gif = await upload(request, cookie, new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]));
    expect(gif.status).toBe(415);
    expect(await gif.json()).toEqual({ error: "unsupported_type" });
    expect((await upload(request, cookie, new Uint8Array())).status).toBe(400);
    expect((await request("/api/receipts", { method: "POST", body: "x", headers: { Cookie: cookie, Origin: ORIGIN } })).status).toBe(400);

    const big = new Uint8Array(MAX_DIRECT_UPLOAD_BYTES + 1);
    big.set(JPEG);
    const tooBig = await upload(request, cookie, big);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: "file_too_large" });
  });

  it("marks the receipt failed on Drive 5xx and lets the same file be retried", async () => {
    const { cookie, id } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: () => new Response("", { status: 503 }) });
    const { request } = makeApp(google);
    const bytes = unique(JPEG);

    const res = await upload(request, cookie, bytes);
    expect(res.status).toBe(502);
    const { receiptId } = (await res.json()) as { receiptId: string };
    expect(await db().select().from(receipts).where(eq(receipts.id, receiptId)).get()).toMatchObject({ status: "failed", error: "drive_unavailable" });

    google.set(UPLOAD_URL, uploadOk("file-retry"));
    const retry = await upload(request, cookie, bytes);
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { receipt: { id: string } }).receipt.id).toBe(receiptId);
    const rows = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", driveFileId: "file-retry", error: null });
  });

  it("creates the folder when the user has none, and recreates it when Drive says it is gone", async () => {
    const { cookie, id } = await seedUser({ driveFolderId: null });
    const google = fakeGoogle({
      [TOKEN_URL]: refreshOk,
      [FOLDER_URL]: [() => json({ id: "folder-1" }), () => json({ id: "folder-2" })],
      [UPLOAD_URL]: uploadOk(),
    });
    const { request } = makeApp(google);
    expect((await upload(request, cookie, unique(JPEG))).status).toBe(202);
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveFolderId).toBe("folder-1");

    google.set(UPLOAD_URL, [() => new Response("", { status: 404 }), uploadOk()]);
    expect((await upload(request, cookie, unique(JPEG))).status).toBe(202);
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveFolderId).toBe("folder-2");
    expect(google.callsTo(UPLOAD_URL).at(-1)!.body).toContain('"parents":["folder-2"]');
  });

  it("disconnects Drive on invalid_grant: receipt failed, sessions deleted, 401", async () => {
    const { cookie, id, token } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) });
    const { request } = makeApp(google);
    const res = await upload(request, cookie, unique(JPEG));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("drive_disconnected");
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveStatus).toBe("disconnected");
    expect(await validateSession(db(), token)).toBeNull();
    const [row] = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(row).toMatchObject({ status: "failed", error: "drive_disconnected" });
  });

  it("refreshes once when a cached access token gets a 401, and disconnects if the fresh one does too", async () => {
    const a = await seedUser();
    cacheAccessToken(a.id, "at-stale", 3600);
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: [() => new Response("", { status: 401 }), uploadOk()] });
    const { request } = makeApp(google);
    expect((await upload(request, a.cookie, unique(JPEG))).status).toBe(202);
    const auths = google.callsTo(UPLOAD_URL).map((c) => c.headers.get("Authorization"));
    expect(auths).toEqual(["Bearer at-stale", "Bearer at-refreshed"]);

    const b = await seedUser();
    google.set(UPLOAD_URL, () => new Response("", { status: 401 }));
    expect((await upload(request, b.cookie, unique(JPEG))).status).toBe(401);
    expect((await db().select().from(users).where(eq(users.id, b.id)).get())?.driveStatus).toBe("disconnected");
  });

  it("requires a session and our Origin", async () => {
    const { cookie } = await seedUser();
    const { request } = makeApp();
    expect((await request("/api/receipts", { method: "POST", body: form(JPEG), headers: { Origin: ORIGIN } })).status).toBe(401);
    expect((await request("/api/receipts", { method: "POST", body: form(JPEG), headers: { Cookie: cookie } })).status).toBe(403);
    expect(
      (await request("/api/receipts", { method: "POST", body: form(JPEG), headers: { Cookie: cookie, Origin: "https://evil.example" } })).status,
    ).toBe(403);
  });
});

describe("GET /api/receipts", () => {
  it("lists only the session user's receipts, filtered by status", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const { request } = makeApp(fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk() }));
    await upload(request, a.cookie, unique(JPEG));
    await upload(request, b.cookie, unique(JPEG));
    await db()
      .update(receipts)
      .set({ status: "done" })
      .where(and(eq(receipts.userId, a.id)));
    await upload(request, a.cookie, unique(PNG));

    const all = (await (await request("/api/receipts", { headers: { Cookie: a.cookie } })).json()) as { receipts: { status: string }[] };
    expect(all.receipts.map((r) => r.status).sort()).toEqual(["done", "queued"]);

    const pending = (await (await request("/api/receipts?status=queued,processing", { headers: { Cookie: a.cookie } })).json()) as {
      receipts: { status: string; mimeType: string }[];
    };
    expect(pending.receipts).toHaveLength(1);
    expect(pending.receipts[0]).toMatchObject({ status: "queued", mimeType: "image/png" });

    expect((await request("/api/receipts?status=bogus", { headers: { Cookie: a.cookie } })).status).toBe(400);
    expect(env.APP_ORIGIN).toBe(ORIGIN);
  });
});
