import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { receipts } from "../src/db/schema";
import { runParkCron } from "../src/pipeline/cron";
import { nextParkTime, retryDelaySeconds } from "../src/pipeline/timing";
import { db, fakeQueue, seedUser } from "./helpers";

const NOW = new Date("2026-11-12T00:05:00.000Z");

async function receipt(userId: string, set: Partial<typeof receipts.$inferInsert>) {
  const id = crypto.randomUUID();
  await db().insert(receipts).values({
    id, userId, driveFileId: `f-${id}`, mimeType: "image/jpeg", sizeBytes: 1, sha256: `s-${id}`,
    status: "queued", createdAt: "2026-11-11T09:00:00.000Z", ...set,
  });
  return id;
}
const row = (id: string) => db().select().from(receipts).where(eq(receipts.id, id)).get();

describe("timing", () => {
  it("parks until the next 00:05 UTC", () => {
    expect(nextParkTime(new Date("2026-11-11T10:00:00Z"))).toBe("2026-11-12T00:05:00.000Z");
    expect(nextParkTime(new Date("2026-11-11T00:04:59Z"))).toBe("2026-11-11T00:05:00.000Z");
    expect(nextParkTime(new Date("2026-11-11T00:05:00Z"))).toBe("2026-11-12T00:05:00.000Z");
    expect(nextParkTime(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01T00:05:00.000Z");
  });

  it("backs off 30 s, 2 min, 10 min", () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 120, 600, 600]);
  });
});

describe("runParkCron", () => {
  it("re-sends due parked receipts for every user and unparks them; leaves the rest", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const dueA = await receipt(a.id, { retryAfter: "2026-11-12T00:05:00.000Z", error: "ai_quota" });
    const dueB = await receipt(b.id, { retryAfter: "2026-11-11T00:05:00.000Z", error: "queue_unavailable" });
    const later = await receipt(a.id, { retryAfter: "2026-11-13T00:05:00.000Z", error: "ai_quota" });
    const plain = await receipt(a.id, {});
    const q = fakeQueue();

    const result = await runParkCron(db(), q.queue, NOW);
    expect(q.sent).toEqual(expect.arrayContaining([{ receiptId: dueA, userId: a.id }, { receiptId: dueB, userId: b.id }]));
    expect(q.sent.map((m) => m.receiptId)).not.toContain(later);
    expect(q.sent.map((m) => m.receiptId)).not.toContain(plain);
    expect(result.resent).toBeGreaterThanOrEqual(2);
    expect(await row(dueA)).toMatchObject({ status: "queued", retryAfter: null, error: null });
    expect(await row(later)).toMatchObject({ retryAfter: "2026-11-13T00:05:00.000Z" });
  });

  it("re-parks for tomorrow when the queue refuses the batch", async () => {
    const a = await seedUser();
    const due = await receipt(a.id, { retryAfter: "2026-11-12T00:00:00.000Z", error: "ai_quota" });
    const q = fakeQueue();
    q.state.failing = true;
    const result = await runParkCron(db(), q.queue, NOW);
    expect(result.resent).toBe(0);
    expect(await row(due)).toMatchObject({ status: "queued", retryAfter: "2026-11-13T00:05:00.000Z", error: "queue_unavailable" });
  });

  it("fails receipts stuck in processing for over an hour, before re-sending", async () => {
    const a = await seedUser();
    const stuck = await receipt(a.id, { status: "processing", createdAt: "2026-11-11T22:00:00.000Z" });
    const fresh = await receipt(a.id, { status: "processing", createdAt: "2026-11-12T00:00:00.000Z" });
    const result = await runParkCron(db(), fakeQueue().queue, NOW);
    expect(result.timedOut).toBeGreaterThanOrEqual(1);
    expect(await row(stuck)).toMatchObject({ status: "failed", error: "processing_timeout" });
    expect(await row(fresh)).toMatchObject({ status: "processing" });
  });
});
