import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSession, deleteUserSessions, SESSION_TTL_MS, validateSession } from "../src/auth/session";
import { sessions } from "../src/db/schema";
import { sha256Hex } from "../src/lib/encoding";
import { db, seedUser } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("sessions", () => {
  it("stores only the SHA-256 of the token and resolves the user", async () => {
    const { id } = await seedUser();
    const { token, expiresAt } = await createSession(db(), id);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5000);

    const row = await db().select().from(sessions).where(eq(sessions.id, await sha256Hex(token))).get();
    expect(row?.userId).toBe(id);
    expect(await db().select().from(sessions).where(eq(sessions.id, token)).get()).toBeUndefined();

    const s = await validateSession(db(), token);
    expect(s?.user.id).toBe(id);
    expect(s?.renewedUntil).toBeUndefined();
  });

  it("rejects unknown and expired tokens, deleting expired rows", async () => {
    const { id } = await seedUser();
    expect(await validateSession(db(), "nope")).toBeNull();

    const { token } = await createSession(db(), id);
    const later = new Date(Date.now() + SESSION_TTL_MS + DAY);
    expect(await validateSession(db(), token, later)).toBeNull();
    expect(await db().select().from(sessions).where(eq(sessions.id, await sha256Hex(token))).get()).toBeUndefined();
  });

  it("renews only when less than 15 days remain", async () => {
    const { id } = await seedUser();
    const { token } = await createSession(db(), id);

    const day10 = new Date(Date.now() + 10 * DAY);
    expect((await validateSession(db(), token, day10))?.renewedUntil).toBeUndefined();

    const day20 = new Date(Date.now() + 20 * DAY);
    const renewed = await validateSession(db(), token, day20);
    expect(renewed?.renewedUntil?.getTime()).toBe(day20.getTime() + SESSION_TTL_MS);
    const row = await db().select().from(sessions).where(eq(sessions.id, await sha256Hex(token))).get();
    expect(row?.expiresAt).toBe(renewed!.renewedUntil!.toISOString());
  });

  it("deletes all of a user's sessions", async () => {
    const { id, token } = await seedUser();
    const second = await createSession(db(), id);
    const other = await seedUser();
    await deleteUserSessions(db(), id);
    expect(await validateSession(db(), token)).toBeNull();
    expect(await validateSession(db(), second.token)).toBeNull();
    expect(await validateSession(db(), other.token)).not.toBeNull();
  });
});
