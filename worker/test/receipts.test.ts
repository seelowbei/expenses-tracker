import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { driveFileName, MAX_DIRECT_UPLOAD_BYTES, STALE_UPLOAD_MS } from "../src/api/receipts";
import { sha256Hex } from "../src/lib/encoding";
import { validateSession } from "../src/auth/session";
import { receipts, users } from "../src/db/schema";
import { cacheAccessToken, clearAccessTokenCache } from "../src/drive/access";
import { d1WithHook, db, FOLDER_URL, fakeGoogle, fakeQueue, json, makeApp, ORIGIN, requestWithEnv, seedUser, TOKEN_URL, UPLOAD_URL } from "./helpers";

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

/** Sends the multipart body the way a browser does: serialized, with Content-Type and Content-Length. */
async function upload(request: ReturnType<typeof makeApp>["request"], cookie: string, bytes: Uint8Array, extra: Record<string, string> = {}) {
  const encoded = new Request("http://localhost/", { method: "POST", body: form(bytes) });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers = { Cookie: cookie, Origin: ORIGIN, "Content-Type": encoded.headers.get("Content-Type")!, "Content-Length": String(body.length), ...extra };
  return request("/api/receipts", { method: "POST", body, headers });
}

describe("POST /api/receipts", () => {
  it("uploads to the user's Drive folder, queues the receipt and sends it for extraction", async () => {
    const { cookie, id } = await seedUser({ driveFolderId: "folder-a" });
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk("file-a") });
    const { request, queue } = makeApp(google);
    const bytes = unique(JPEG);

    const res = await upload(request, cookie, bytes);
    expect(res.status).toBe(202);
    const { receipt } = (await res.json()) as { receipt: { id: string; status: string; driveLink: string; mimeType: string } };
    expect(queue.sent).toEqual([{ receiptId: receipt.id, userId: id }]);
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
    expect((await request("/api/receipts", { method: "POST", body: "x", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Length": "1" } })).status).toBe(400);
    // No Content-Length (a chunked body): rejected before anything is buffered.
    const chunked = await request("/api/receipts", { method: "POST", body: form(unique(JPEG)), headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(chunked.status).toBe(411);
    expect(await chunked.json()).toEqual({ error: "length_required" });

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

  it("uploads a file once when the same file is sent again while its upload is in flight", async () => {
    const { cookie, id } = await seedUser();
    let reachedDrive!: () => void;
    let releaseDrive!: () => void;
    const atDrive = new Promise<void>((r) => (reachedDrive = r));
    const google = fakeGoogle({
      [TOKEN_URL]: refreshOk,
      [UPLOAD_URL]: async () => {
        const released = new Promise<void>((r) => (releaseDrive = r));
        reachedDrive();
        await released;
        return uploadOk("file-once")();
      },
    });
    const { request } = makeApp(google);
    const bytes = unique(JPEG);

    const first = upload(request, cookie, bytes);
    await atDrive;
    const second = await upload(request, cookie, bytes);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("duplicate_receipt");

    releaseDrive();
    expect((await first).status).toBe(202);
    expect(google.callsTo(UPLOAD_URL)).toHaveLength(1);
    const rows = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", driveFileId: "file-once" });
  });

  it("retries a receipt left in uploading only once the upload is stale", async () => {
    const { cookie, id } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk("file-stuck") });
    const { request } = makeApp(google);
    const bytes = unique(JPEG);
    const receiptId = crypto.randomUUID();
    const startedAt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    await db()
      .insert(receipts)
      .values({ id: receiptId, userId: id, mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: await sha256Hex(bytes), status: "uploading", createdAt: startedAt(1000) });

    const fresh = await upload(request, cookie, bytes);
    expect(fresh.status).toBe(409);
    expect(google.callsTo(UPLOAD_URL)).toHaveLength(0);

    await db().update(receipts).set({ createdAt: startedAt(STALE_UPLOAD_MS + 1000) }).where(eq(receipts.id, receiptId));
    const stale = await upload(request, cookie, bytes);
    expect(stale.status).toBe(202);
    expect(((await stale.json()) as { receipt: { id: string } }).receipt.id).toBe(receiptId);
    expect(await db().select().from(receipts).where(eq(receipts.id, receiptId)).get()).toMatchObject({ status: "queued", driveFileId: "file-stuck" });
  });

  it("disconnects Drive when the stored refresh token can't be decrypted", async () => {
    const { cookie, id, token } = await seedUser();
    // Well-formed v1 value that no key decrypts (as after a TOKEN_ENC_KEY change).
    await db().update(users).set({ refreshTokenEnc: `v1:${"A".repeat(16)}:${"A".repeat(22)}==` }).where(eq(users.id, id));
    const google = fakeGoogle();
    const { request } = makeApp(google);

    const res = await upload(request, cookie, unique(JPEG));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("drive_disconnected");
    expect(google.calls).toHaveLength(0);
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveStatus).toBe("disconnected");
    expect(await validateSession(db(), token)).toBeNull();
    const [row] = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(row).toMatchObject({ status: "failed", error: "drive_disconnected" });
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

  it("returns 409 with the winner's id when an identical upload inserts first", async () => {
    const { cookie, id } = await seedUser();
    const google = fakeGoogle();
    const { app } = makeApp(google);
    const bytes = unique(JPEG);
    const winnerId = crypto.randomUUID();
    let raced = false;
    // The identical request's row lands between our duplicate check and our insert.
    const DB = d1WithHook(/^insert into "receipts"/i, async () => {
      if (raced) return;
      raced = true;
      await db()
        .insert(receipts)
        .values({ id: winnerId, userId: id, mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: await sha256Hex(bytes), status: "uploading", createdAt: new Date().toISOString() });
    });

    const res = await upload(requestWithEnv(app, { DB }), cookie, bytes);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_receipt", receiptId: winnerId });
    expect(google.calls).toHaveLength(0);
  });

  it("returns 500 for a D1 error on insert instead of calling it a duplicate", async () => {
    const { cookie, id } = await seedUser();
    const google = fakeGoogle();
    const { app } = makeApp(google);
    const DB = d1WithHook(/^insert into "receipts"/i, async () => {
      throw new Error("D1_ERROR: simulated");
    });

    const res = await upload(requestWithEnv(app, { DB }), cookie, unique(JPEG));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(google.calls).toHaveLength(0);
    expect(await db().select().from(receipts).where(eq(receipts.userId, id))).toHaveLength(0);
  });

  it("fails the receipt but keeps Drive connected on other refresh errors", async () => {
    const { cookie, id, token } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: () => json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401) });
    const { request } = makeApp(google);

    const rejected = await upload(request, cookie, unique(JPEG));
    expect(rejected.status).toBe(502);
    expect(((await rejected.json()) as { error: string }).error).toBe("drive_error");

    google.set(TOKEN_URL, () => {
      throw new TypeError("network connection lost");
    });
    const offline = await upload(request, cookie, unique(JPEG));
    expect(offline.status).toBe(502);
    expect(((await offline.json()) as { error: string }).error).toBe("drive_error");

    expect(google.callsTo(UPLOAD_URL)).toHaveLength(0);
    const rows = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["failed", "drive_error"],
      ["failed", "drive_error"],
    ]);
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveStatus).toBe("connected");
    expect(await validateSession(db(), token)).not.toBeNull();
  });

  it("keeps Drive connected when TOKEN_ENC_KEY is misconfigured, not just different", async () => {
    const { cookie, id, token } = await seedUser();
    const google = fakeGoogle();
    const { app } = makeApp(google);
    // Valid base64 but 9 bytes: a config error that must not disconnect every user.
    const res = await upload(requestWithEnv(app, { TOKEN_ENC_KEY: btoa("too-short") }), cookie, unique(JPEG));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("drive_error");
    expect(google.calls).toHaveLength(0);
    expect((await db().select().from(users).where(eq(users.id, id)).get())?.driveStatus).toBe("connected");
    expect(await validateSession(db(), token)).not.toBeNull();
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

  it("parks the receipt for the cron when the queue send fails, and still returns 202", async () => {
    const { cookie } = await seedUser();
    const queue = fakeQueue();
    queue.state.failing = true;
    const { request } = makeApp(fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk() }), queue);
    const res = await upload(request, cookie, unique(JPEG));
    expect(res.status).toBe(202);
    const { receipt } = (await res.json()) as { receipt: { id: string; status: string; error: string; retryAfter: string } };
    expect(receipt).toMatchObject({ status: "queued", error: "queue_unavailable" });
    expect(receipt.retryAfter).toMatch(/T00:05:00\.000Z$/);
  });

  it("lets a receipt whose Drive file was deleted be uploaded again, with a new file", async () => {
    const { cookie, id } = await seedUser();
    const google = fakeGoogle({ [TOKEN_URL]: refreshOk, [UPLOAD_URL]: uploadOk("file-old") });
    const { request } = makeApp(google);
    const bytes = unique(JPEG);
    const first = (await (await upload(request, cookie, bytes)).json()) as { receipt: { id: string } };
    await db().update(receipts).set({ status: "failed", error: "drive_file_missing" }).where(eq(receipts.id, first.receipt.id));

    google.set(UPLOAD_URL, uploadOk("file-new"));
    const again = await upload(request, cookie, bytes);
    expect(again.status).toBe(202);
    const rows = await db().select().from(receipts).where(eq(receipts.userId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.receipt.id, status: "queued", driveFileId: "file-new", error: null });
  });
});

describe("POST /api/receipts/:id/retry", () => {
  async function failedReceipt(opts: { error?: string; driveFileId?: string | null } = {}) {
    const user = await seedUser();
    const id = crypto.randomUUID();
    await db().insert(receipts).values({
      id,
      userId: user.id,
      driveFileId: opts.driveFileId === undefined ? "file-x" : opts.driveFileId,
      mimeType: "image/jpeg",
      sizeBytes: 3,
      sha256: `sha-${id}`,
      status: "failed",
      error: opts.error ?? "ai_error",
      attempts: 4,
      createdAt: new Date().toISOString(),
    });
    return { user, id };
  }
  const post = (request: ReturnType<typeof makeApp>["request"], cookie: string, id: string) =>
    request(`/api/receipts/${id}/retry`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });

  it("re-queues a failed receipt and sends it, once", async () => {
    const { user, id } = await failedReceipt();
    const { request, queue } = makeApp();
    const res = await post(request, user.cookie, id);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { receipt: { status: string; error: null } }).receipt).toMatchObject({ status: "queued", error: null });
    expect(queue.sent).toEqual([{ receiptId: id, userId: user.id }]);

    const again = await post(request, user.cookie, id);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_retryable", receiptId: id });
    expect(queue.sent).toHaveLength(1);
  });

  it("refuses scanned PDFs, asks for a re-upload without a Drive file, and hides other users' receipts", async () => {
    const { request } = makeApp();
    const scanned = await failedReceipt({ error: "unsupported_scanned_pdf" });
    expect(await (await post(request, scanned.user.cookie, scanned.id)).json()).toEqual({ error: "not_retryable", receiptId: scanned.id });

    const missing = await failedReceipt({ error: "drive_file_missing" });
    expect(await (await post(request, missing.user.cookie, missing.id)).json()).toEqual({ error: "reupload_required", receiptId: missing.id });

    const noFile = await failedReceipt({ error: "drive_unavailable", driveFileId: null });
    expect(await (await post(request, noFile.user.cookie, noFile.id)).json()).toEqual({ error: "reupload_required", receiptId: noFile.id });

    const other = await seedUser({ email: "bob@example.com" });
    expect((await post(request, other.cookie, scanned.id)).status).toBe(404);
  });

  it("requires our Origin", async () => {
    const { user, id } = await failedReceipt();
    const { request } = makeApp();
    const res = await request(`/api/receipts/${id}/retry`, { method: "POST", headers: { Cookie: user.cookie, Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
