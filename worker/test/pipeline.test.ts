import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiClient } from "../src/agent/extract";
import { aiUsage, categories, ledgerEntries, receipts, users } from "../src/db/schema";
import { cacheAccessToken, clearAccessTokenCache } from "../src/drive/access";
import type { ReceiptMessage } from "../src/pipeline/message";
import { MAX_UPLOAD_BYTES } from "../src/lib/sniff";
import { processReceipt } from "../src/pipeline/process";
import { handleQueue } from "../src/pipeline/queue";
import { bindings, db, downloadUrl, fakeGoogle, makeApp, ORIGIN, seedUser } from "./helpers";

beforeEach(() => clearAccessTokenCache());

const NOW = new Date("2026-11-11T10:00:00.000Z");
const now = () => NOW;

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    merchant: "Grab",
    txn_date: "01/11/2026",
    txn_time: "6:19 PM",
    currency: "SGD",
    total: 18.4,
    total_text: "Total Paid S$18.40",
    tax: null,
    payment_method: "GrabPay",
    line_items: [],
    category_slug: "transport",
    confidence: 0.95,
    ...over,
  });

type Reply = string | Error;

function fakeAi(replies: Reply[], markdown?: { format: string; data?: string }) {
  const calls: string[] = [];
  const ai: AiClient = {
    run: async (model) => {
      calls.push(model);
      const next = replies.shift();
      if (next === undefined) throw new Error("no more replies");
      if (next instanceof Error) throw next;
      return { response: next, usage: { prompt_tokens: 6800, completion_tokens: 100 } };
    },
    toMarkdown: async () => {
      calls.push("toMarkdown");
      return markdown ?? { format: "markdown", data: "" };
    },
  };
  return { ai, calls };
}

/** Signal after the claim reaches AI, then let the test choose when that attempt completes. */
function gatedAi(replies: Reply[]) {
  const fake = fakeAi(replies);
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const ai: AiClient = {
    ...fake.ai,
    run: async (model, input) => {
      markStarted();
      await released;
      return fake.ai.run(model, input);
    },
  };
  return { ai, started, release, calls: fake.calls };
}

async function setup(opts: { mime?: string; status?: "queued" | "processing" | "done" } = {}) {
  const user = await seedUser();
  cacheAccessToken(user.id, "at-cached", 3600);
  const id = crypto.randomUUID();
  const fileId = `file-${id}`;
  await db()
    .insert(receipts)
    .values({
      id,
      userId: user.id,
      driveFileId: fileId,
      driveLink: `https://drive.google.com/file/d/${fileId}/view`,
      mimeType: opts.mime ?? "image/jpeg",
      sizeBytes: 5,
      sha256: `sha-${id}`,
      status: opts.status ?? "queued",
      createdAt: NOW.toISOString(),
    });
  const google = fakeGoogle({ [downloadUrl(fileId)]: () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2])) });
  const run = (ai: AiClient, delivery = 1, body: unknown = { receiptId: id, userId: user.id }) =>
    processReceipt({ db: db(), env: bindings(), app: { fetch: google.fetch }, ai, now }, body, delivery);
  return { user, id, fileId, google, run };
}

const receiptRow = (id: string) => db().select().from(receipts).where(eq(receipts.id, id)).get();
const ledgerFor = (id: string) => db().select().from(ledgerEntries).where(eq(ledgerEntries.receiptId, id)).all();
const usageFor = (id: string) => db().select().from(aiUsage).where(eq(aiUsage.receiptId, id)).all();

describe("processReceipt: valid extraction", () => {
  it("writes a done ledger entry in minor units with txn_time, plus one ai_usage row", async () => {
    const { id, run } = await setup();
    const { ai } = fakeAi([reply()]);
    expect(await run(ai)).toEqual({ action: "ack" });

    const r = await receiptRow(id);
    expect(r).toMatchObject({ status: "done", error: null, attempts: 1, reviewReasons: null, retryAfter: null });
    expect(JSON.parse(r!.rawExtraction!)).toMatchObject({ merchant: "Grab", txn_date: "2026-11-01", total: 18.4 });

    const [entry, ...more] = await ledgerFor(id);
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      merchant: "Grab",
      txnDate: "2026-11-01",
      txnTime: "18:19",
      currency: "SGD",
      totalMinor: 1840,
      taxMinor: null,
      paymentMethod: "ewallet",
      categoryId: "sys_transport",
      source: "ai",
      lineItems: "[]",
    });

    const usage = await usageFor(id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "extract", outcome: "ok", attempt: 1, promptTokens: 6800, inputMode: "image" });
  });

  it("offers a newly created category only to its owner and stores the chosen category", async () => {
    const owned = await setup();
    const other = await setup();
    const res = await makeApp().request("/api/categories", {
      method: "POST",
      headers: { Cookie: owned.user.cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Pet Care" }),
    });
    expect(res.status).toBe(201);
    const { category } = await res.json<{ category: { id: string; slug: string } }>();
    for (const [receipt, canSeeCategory] of [[owned, true], [other, false]] as const) {
      const fake = fakeAi([reply({ category_slug: canSeeCategory ? category.slug : "transport" })]);
      const prompts: string[] = [];
      const ai: AiClient = {
        ...fake.ai,
        run: (model, input) => {
          prompts.push(JSON.stringify(input.messages));
          return fake.ai.run(model, input);
        },
      };
      expect(await receipt.run(ai)).toEqual({ action: "ack" });
      expect(prompts.some((prompt) => prompt.includes(category.slug))).toBe(canSeeCategory);
      expect(await ledgerFor(receipt.id)).toMatchObject([{ categoryId: canSeeCategory ? category.id : "sys_transport" }]);
    }
  });

  it("goes to needs_review with the reasons stored, and still writes the entry", async () => {
    const { id, run } = await setup();
    const { ai } = fakeAi([reply({ total_text: "Subtotal S$18.40" })]);
    await run(ai);
    const r = await receiptRow(id);
    expect(r!.status).toBe("needs_review");
    expect(JSON.parse(r!.reviewReasons!)).toEqual(["total_is_subtotal"]);
    expect(await ledgerFor(id)).toHaveLength(1);
  });

  it("stores line items and tax in minor units, and JPY with exponent 0", async () => {
    const { id, run } = await setup();
    const { ai } = fakeAi([
      reply({ currency: "JPY", total: 1200, total_text: "合計 ¥1,200", tax: 109, line_items: [{ description: "Ramen", amount: 1200 }] }),
    ]);
    await run(ai);
    const [entry] = await ledgerFor(id);
    expect(entry).toMatchObject({ currency: "JPY", totalMinor: 1200, taxMinor: 109 });
    expect(JSON.parse(entry!.lineItems!)).toEqual([{ description: "Ramen", amount_minor: 1200 }]);
  });

  it("uses the user's own category over the system one with the same slug", async () => {
    const { user, id, run } = await setup();
    await db().insert(categories).values({ id: `own-${user.id}`, userId: user.id, slug: "transport", name: "Getting around" });
    await run(fakeAi([reply()]).ai);
    expect((await ledgerFor(id))[0]!.categoryId).toBe(`own-${user.id}`);
  });

  it("maps an unknown category to other and asks for review", async () => {
    const { id, run } = await setup();
    await run(fakeAi([reply({ category_slug: "spaceships" })]).ai);
    expect((await ledgerFor(id))[0]!.categoryId).toBe("sys_other");
    expect(JSON.parse((await receiptRow(id))!.reviewReasons!)).toEqual(["unknown_category"]);
  });

  it("extracts a text PDF through toMarkdown", async () => {
    const { id, run } = await setup({ mime: "application/pdf" });
    const { ai, calls } = fakeAi([reply()], { format: "markdown", data: "# Receipt\nGrab ride total S$18.40 paid by GrabPay" });
    await run(ai);
    expect(calls).toEqual(["toMarkdown", "@cf/google/gemma-4-26b-a4b-it"]);
    expect((await receiptRow(id))!.status).toBe("done");
    expect((await usageFor(id)).map((u) => u.kind).sort()).toEqual(["extract", "to_markdown"]);
  });
});

describe("processReceipt: redelivery and scoping", () => {
  it("ignores a redelivered message once the receipt is done", async () => {
    const { id, run } = await setup();
    await run(fakeAi([reply()]).ai);
    const second = fakeAi([reply()]);
    expect(await run(second.ai, 2)).toEqual({ action: "ack" });
    expect(second.calls).toEqual([]);
    expect(await ledgerFor(id)).toHaveLength(1);
    expect(await usageFor(id)).toHaveLength(1);
    expect((await receiptRow(id))!.attempts).toBe(1);
  });

  it("resumes a receipt left in processing by a crashed delivery, without a second entry", async () => {
    const { id, run } = await setup({ status: "processing" });
    await run(fakeAi([reply()]).ai, 2);
    expect((await receiptRow(id))!.status).toBe("done");
    expect(await ledgerFor(id)).toHaveLength(1);
  });

  it("ignores a message whose userId doesn't own the receipt", async () => {
    const { id, run } = await setup();
    const other = await seedUser({ email: "bob@example.com" });
    const { ai, calls } = fakeAi([reply()]);
    expect(await run(ai, 1, { receiptId: id, userId: other.id })).toEqual({ action: "ack" });
    expect(calls).toEqual([]);
    expect((await receiptRow(id))!.status).toBe("queued");
  });

  it("acks a malformed message", async () => {
    const { run } = await setup();
    expect(await run(fakeAi([]).ai, 1, { receiptId: 42 })).toEqual({ action: "ack" });
  });
});

describe("processReceipt: overlapping deliveries", () => {
  const latestReply = () => reply({ merchant: "Latest result", total: 32.1, total_text: "Total Paid S$32.10" });
  const partial = JSON.stringify({ merchant: "Partial result", total: 4.5, currency: "SGD", txn_date: "??" });
  const quota = () => new Error("4006: you have used up your daily free allocation of 10,000 neurons");
  const capacity = () => new Error("3040: capacity temporarily exceeded");

  async function expectLatestLedger(id: string) {
    const row = await receiptRow(id);
    expect(row).toMatchObject({ status: "done", error: null, attempts: 2, reviewReasons: null, retryAfter: null });
    expect(JSON.parse(row!.rawExtraction!)).toMatchObject({ merchant: "Latest result", total: 32.1 });
    expect(await ledgerFor(id)).toEqual([expect.objectContaining({ merchant: "Latest result", totalMinor: 3210, source: "ai" })]);
  }

  it.each([
    { name: "success", replies: () => [reply()], usage: ["extract:ok"] },
    { name: "success needing review", replies: () => [reply({ total_text: "Subtotal S$18.40" })], usage: ["extract:ok"] },
    { name: "quota", replies: () => [quota()], usage: ["extract:quota_exceeded"] },
    { name: "transient failure", replies: () => [capacity()], usage: ["extract:ai_error"] },
    { name: "invalid output", replies: () => [partial, partial], usage: ["extract:invalid_output", "repair:invalid_output"] },
  ])("acks an older $name without replacing a newer success, while keeping every AI call", async ({ replies, usage }) => {
    const { id, run } = await setup();
    const older = gatedAi(replies());
    const newer = gatedAi([latestReply()]);
    const first = run(older.ai);
    await older.started;
    const second = run(newer.ai, 2);
    await newer.started;
    newer.release();
    expect(await second).toEqual({ action: "ack" });
    const finished = await receiptRow(id);
    older.release();
    expect(await first).toEqual({ action: "ack" });

    expect(await receiptRow(id)).toEqual(finished);
    await expectLatestLedger(id);
    const records = await usageFor(id);
    expect(records).toHaveLength(older.calls.length + newer.calls.length);
    expect(records.filter((r) => r.attempt === 1).map((r) => `${r.kind}:${r.outcome}`).sort()).toEqual(usage);
    expect(records.filter((r) => r.attempt === 2)).toEqual([expect.objectContaining({ kind: "extract", outcome: "ok" })]);
  });

  it("does not insert the older success while a newer claimed attempt is still running", async () => {
    const { id, run } = await setup();
    const older = gatedAi([reply({ total_text: "Subtotal S$18.40" })]);
    const newer = gatedAi([latestReply()]);
    const first = run(older.ai);
    await older.started;
    const second = run(newer.ai, 2);
    await newer.started;
    try {
      older.release();
      expect(await first).toEqual({ action: "ack" });
      expect(await receiptRow(id)).toMatchObject({ status: "processing", attempts: 2, rawExtraction: null, reviewReasons: null, retryAfter: null });
      expect(await ledgerFor(id)).toEqual([]);
      expect(await usageFor(id)).toEqual([expect.objectContaining({ attempt: 1, kind: "extract", outcome: "ok" })]);
    } finally {
      older.release();
      newer.release();
      await Promise.all([first, second]);
    }
    expect(await second).toEqual({ action: "ack" });
    await expectLatestLedger(id);
    const records = await usageFor(id);
    expect(records).toHaveLength(older.calls.length + newer.calls.length);
    expect(records.map((r) => r.attempt).sort()).toEqual([1, 2]);
  });

  it.each([
    { name: "final failure", replies: () => [capacity()], status: "failed", error: "ai_error", usage: ["extract:ai_error"] },
    { name: "invalid output", replies: () => [partial, partial], status: "needs_review", error: "invalid_output", usage: ["extract:invalid_output", "repair:invalid_output"] },
    { name: "quota park", replies: () => [quota()], status: "queued", error: "ai_quota", usage: ["extract:quota_exceeded"] },
  ])("does not insert a stale success after a newer $name", async ({ replies, status, error, usage }) => {
    const { id, run } = await setup();
    const older = gatedAi([reply()]);
    const newer = gatedAi(replies());
    const first = run(older.ai);
    await older.started;
    const second = run(newer.ai, 4);
    await newer.started;
    newer.release();
    expect(await second).toEqual({ action: "ack" });
    const finished = await receiptRow(id);
    older.release();
    expect(await first).toEqual({ action: "ack" });

    expect(await receiptRow(id)).toEqual(finished);
    expect(finished).toMatchObject({ status, error, attempts: 2, reviewReasons: null });
    if (error === "invalid_output") {
      expect(JSON.parse(finished!.rawExtraction!)).toMatchObject({ merchant: "Partial result", total: 4.5, currency: "SGD" });
    } else {
      expect(finished!.rawExtraction).toBeNull();
    }
    expect(finished!.retryAfter).toBe(error === "ai_quota" ? "2026-11-12T00:05:00.000Z" : null);
    expect(await ledgerFor(id)).toEqual([]);
    const records = await usageFor(id);
    expect(records).toHaveLength(older.calls.length + newer.calls.length);
    expect(records.filter((r) => r.attempt === 1)).toEqual([expect.objectContaining({ kind: "extract", outcome: "ok" })]);
    expect(records.filter((r) => r.attempt === 2).map((r) => `${r.kind}:${r.outcome}`).sort()).toEqual(usage);
  });
});

describe("processReceipt: failures", () => {
  it("invalid output twice: needs_review with the parsed fields, no ledger entry", async () => {
    const { id, run } = await setup();
    const half = JSON.stringify({ merchant: "Kopitiam", total: 4.5, currency: "SGD", txn_date: "??" });
    await run(fakeAi([half, half]).ai);
    const r = await receiptRow(id);
    expect(r).toMatchObject({ status: "needs_review", error: "invalid_output", reviewReasons: null });
    expect(JSON.parse(r!.rawExtraction!)).toMatchObject({ merchant: "Kopitiam", total: 4.5 });
    expect(await ledgerFor(id)).toEqual([]);
    expect((await usageFor(id)).map((u) => [u.kind, u.outcome]).sort()).toEqual([
      ["extract", "invalid_output"],
      ["repair", "invalid_output"],
    ]);
  });

  it("AI quota: parks until the next 00:05 UTC, acks, and records the failed call", async () => {
    const { id, run } = await setup();
    const quota = new Error("4006: you have used up your daily free allocation of 10,000 neurons");
    expect(await run(fakeAi([quota]).ai)).toEqual({ action: "ack" });
    expect(await receiptRow(id)).toMatchObject({ status: "queued", error: "ai_quota", retryAfter: "2026-11-12T00:05:00.000Z" });
    expect(await usageFor(id)).toEqual([expect.objectContaining({ outcome: "quota_exceeded", errorCode: "4006" })]);

    // A stray delivery while parked does nothing.
    const again = fakeAi([reply()]);
    await run(again.ai, 2);
    expect(again.calls).toEqual([]);
  });

  it("other AI errors retry with backoff, then fail on the last delivery", async () => {
    const { id, run } = await setup();
    const boom = () => new Error("3040: capacity temporarily exceeded");
    expect(await run(fakeAi([boom()]).ai, 1)).toEqual({ action: "retry", delaySeconds: 30 });
    expect(await receiptRow(id)).toMatchObject({ status: "queued", error: "ai_error" });
    expect(await run(fakeAi([boom()]).ai, 2)).toEqual({ action: "retry", delaySeconds: 120 });
    expect(await run(fakeAi([boom()]).ai, 3)).toEqual({ action: "retry", delaySeconds: 600 });
    expect(await run(fakeAi([boom()]).ai, 4)).toEqual({ action: "ack" });
    expect(await receiptRow(id)).toMatchObject({ status: "failed", error: "ai_error", attempts: 4 });
    expect((await usageFor(id)).map((u) => u.attempt).sort()).toEqual([1, 2, 3, 4]);
  });

  it("a scanned PDF fails for good with unsupported_scanned_pdf", async () => {
    const { id, run } = await setup({ mime: "application/pdf" });
    expect(await run(fakeAi([], { format: "markdown", data: "# Metadata\n- pages: 1" }).ai)).toEqual({ action: "ack" });
    expect(await receiptRow(id)).toMatchObject({ status: "failed", error: "unsupported_scanned_pdf" });
    expect(await usageFor(id)).toEqual([expect.objectContaining({ kind: "to_markdown", outcome: "ok" })]);
  });

  it("a file deleted from Drive fails with drive_file_missing and makes no AI call", async () => {
    const { id, fileId, google, run } = await setup();
    google.set(downloadUrl(fileId), () => new Response("gone", { status: 404 }));
    const { ai, calls } = fakeAi([reply()]);
    expect(await run(ai)).toEqual({ action: "ack" });
    expect(calls).toEqual([]);
    expect(await receiptRow(id)).toMatchObject({ status: "failed", error: "drive_file_missing" });
  });

  it("a Drive file over the upload limit fails with file_too_large and makes no AI call", async () => {
    const { id, fileId, google, run } = await setup();
    google.set(downloadUrl(fileId), () => new Response("x", { headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 1) } }));
    const { ai, calls } = fakeAi([reply()]);
    expect(await run(ai)).toEqual({ action: "ack" });
    expect(calls).toEqual([]);
    expect(await receiptRow(id)).toMatchObject({ status: "failed", error: "file_too_large" });
  });

  it("Drive 5xx retries as drive_unavailable", async () => {
    const { id, fileId, google, run } = await setup();
    google.set(downloadUrl(fileId), () => new Response("busy", { status: 503 }));
    expect(await run(fakeAi([]).ai, 2)).toEqual({ action: "retry", delaySeconds: 120 });
    expect(await receiptRow(id)).toMatchObject({ status: "queued", error: "drive_unavailable" });
  });

  it("Drive 401 after a refresh disconnects the user and fails the receipt", async () => {
    const { user, id, fileId, google, run } = await setup();
    clearAccessTokenCache();
    google.set("POST https://oauth2.googleapis.com/token", () =>
      new Response(JSON.stringify({ access_token: "at-new", expires_in: 3599, token_type: "Bearer" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    google.set(downloadUrl(fileId), () => new Response("no", { status: 401 }));
    expect(await run(fakeAi([]).ai)).toEqual({ action: "ack" });
    expect(await receiptRow(id)).toMatchObject({ status: "failed", error: "drive_disconnected" });
    expect((await db().select().from(users).where(eq(users.id, user.id)).get())!.driveStatus).toBe("disconnected");
  });
});

describe("handleQueue", () => {
  function message(body: unknown, attempts = 1) {
    const seen: { acked: boolean; retried?: number } = { acked: false };
    const msg = {
      id: crypto.randomUUID(),
      timestamp: NOW,
      body,
      attempts,
      ack: () => void (seen.acked = true),
      retry: (o?: { delaySeconds?: number }) => void (seen.retried = o?.delaySeconds),
    } as unknown as Message<ReceiptMessage>;
    return { msg, seen };
  }
  const batchOf = (...messages: Message<ReceiptMessage>[]) =>
    ({ queue: "receipts-local", messages, ackAll() {}, retryAll() {} }) as unknown as MessageBatch<ReceiptMessage>;

  it("acks finished messages and retries transient failures with the backoff delay", async () => {
    const ok = await setup();
    const bad = await setup();
    bad.google.set(downloadUrl(bad.fileId), () => new Response("busy", { status: 500 }));
    const a = message({ receiptId: ok.id, userId: ok.user.id });
    const b = message({ receiptId: bad.id, userId: bad.user.id });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes(bad.fileId) ? bad.google.fetch(input, init) : ok.google.fetch(input, init);
    await handleQueue(batchOf(a.msg, b.msg), bindings(), { app: { fetch }, ai: fakeAi([reply()]).ai, now });
    expect(a.seen).toEqual({ acked: true });
    expect(b.seen).toEqual({ acked: false, retried: 30 });
  });
});
