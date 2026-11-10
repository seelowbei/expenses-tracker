// Opaque session tokens: the cookie holds 32 random bytes, D1 stores only their SHA-256.
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client";
import { sessions, users, type User } from "../db/schema";
import { randomBytes, sha256Hex, toBase64Url } from "../lib/encoding";

export const SESSION_COOKIE = "session";
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Sliding renewal only when less than this remains, so ordinary requests do no D1 write. */
export const SESSION_RENEW_BELOW_MS = 15 * DAY_MS;

export async function createSession(db: Db, userId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = toBase64Url(randomBytes(32));
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: await sha256Hex(token), userId, expiresAt: expiresAt.toISOString() });
  return { token, expiresAt };
}

export interface ValidSession {
  user: User;
  sessionId: string;
  /** Set when the session was renewed; the cookie must be re-issued with this expiry. */
  renewedUntil?: Date;
}

export async function validateSession(db: Db, token: string, now = new Date()): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const sessionId = await sha256Hex(token);
  const row = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;

  const expiresAt = Date.parse(row.expiresAt);
  if (!(expiresAt > now.getTime())) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  if (expiresAt - now.getTime() < SESSION_RENEW_BELOW_MS) {
    const renewedUntil = new Date(now.getTime() + SESSION_TTL_MS);
    await db.update(sessions).set({ expiresAt: renewedUntil.toISOString() }).where(eq(sessions.id, sessionId));
    return { user: row.user, sessionId, renewedUntil };
  }
  return { user: row.user, sessionId };
}

export async function deleteUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
}
