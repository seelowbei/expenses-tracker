// Per-user Drive access: access-token cache, refresh, and the disconnect path.
import { eq } from "drizzle-orm";
import type { AppDeps } from "../app-env";
import { decryptToken, TokenCryptoError } from "../auth/crypto";
import { GoogleInvalidGrantError, refreshAccessToken, type GoogleConfig } from "../auth/google";
import { deleteUserSessions } from "../auth/session";
import type { Db } from "../db/client";
import { users, type User } from "../db/schema";
import type { Bindings } from "../env";
import { log } from "../lib/log";
import { DriveError, driveApi, type DriveApi } from "./client";

/** Google no longer accepts this user's grant. Sessions are gone; the user must sign in again. */
export class DriveDisconnectedError extends Error {
  readonly code = "drive_disconnected";
}

// Access tokens live in isolate memory only, never in D1 or logs.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_MARGIN_MS = 60_000;

export function cacheAccessToken(userId: string, token: string, expiresInSec: number, now = Date.now()): void {
  tokenCache.set(userId, { token, expiresAt: now + expiresInSec * 1000 - EXPIRY_MARGIN_MS });
}

export function clearAccessTokenCache(): void {
  tokenCache.clear();
}

export function googleConfig(env: Bindings, deps: AppDeps): GoogleConfig {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL("/auth/google/callback", env.APP_ORIGIN).toString(),
    fetch: deps.fetch,
  };
}

/** `invalid_grant` / Drive 401: mark disconnected and delete sessions. Ledger data is untouched. */
export async function markDisconnected(db: Db, userId: string): Promise<void> {
  tokenCache.delete(userId);
  await db.update(users).set({ driveStatus: "disconnected" }).where(eq(users.id, userId));
  await deleteUserSessions(db, userId);
}

async function freshToken(env: Bindings, deps: AppDeps, db: Db, user: User): Promise<string> {
  if (!user.refreshTokenEnc || user.driveStatus === "disconnected") throw new DriveDisconnectedError();
  let refreshToken: string;
  try {
    refreshToken = await decryptToken(env.TOKEN_ENC_KEY, user.refreshTokenEnc);
  } catch (e) {
    // Unreadable token (TOKEN_ENC_KEY changed, or a corrupt value). Disconnecting is the only way out:
    // the next sign-in then forces consent and stores a fresh refresh token.
    if (e instanceof TokenCryptoError) {
      log("refresh_token_unreadable", { code: e.code });
      await markDisconnected(db, user.id);
      throw new DriveDisconnectedError();
    }
    throw e;
  }
  try {
    const { accessToken, expiresIn } = await refreshAccessToken(googleConfig(env, deps), refreshToken);
    cacheAccessToken(user.id, accessToken, expiresIn);
    return accessToken;
  } catch (e) {
    if (e instanceof GoogleInvalidGrantError) {
      await markDisconnected(db, user.id);
      throw new DriveDisconnectedError();
    }
    throw e;
  }
}

/**
 * Runs `fn` with a Drive client for `user`. A 401 with a cached token refreshes once and retries;
 * a 401 with a fresh token (or invalid_grant) disconnects the user.
 */
export async function withDrive<T>(env: Bindings, deps: AppDeps, db: Db, user: User, fn: (drive: DriveApi) => Promise<T>): Promise<T> {
  const cached = tokenCache.get(user.id);
  let fromCache = !!cached && cached.expiresAt > Date.now();
  let token = fromCache ? cached!.token : await freshToken(env, deps, db, user);
  for (;;) {
    try {
      return await fn(driveApi(token, deps.fetch));
    } catch (e) {
      if (!(e instanceof DriveError) || e.kind !== "unauthorized") throw e;
      if (!fromCache) {
        await markDisconnected(db, user.id);
        throw new DriveDisconnectedError();
      }
      tokenCache.delete(user.id);
      token = await freshToken(env, deps, db, user);
      fromCache = false;
    }
  }
}

/**
 * Returns the user's folder id, creating it if missing (or `force`, when Drive says it's gone).
 * `name` (DRIVE_FOLDER_NAME) only applies to new folders; empty means the default `Expense Receipts`.
 */
export async function ensureFolder(db: Db, user: User, drive: DriveApi, name: string | undefined, force = false): Promise<string> {
  if (user.driveFolderId && !force) return user.driveFolderId;
  const id = await drive.createFolder(name || undefined);
  await db.update(users).set({ driveFolderId: id }).where(eq(users.id, user.id));
  user.driveFolderId = id;
  return id;
}
