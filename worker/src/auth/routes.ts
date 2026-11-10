// /auth/*: Google sign-in (spec "Key flows" 1) and logout.
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { nowIso } from "../db/client";
import { users } from "../db/schema";
import { cacheAccessToken, ensureFolder, googleConfig } from "../drive/access";
import { DriveError, driveApi } from "../drive/client";
import { log } from "../lib/log";
import { isAllowedEmail } from "./allowlist";
import { encryptToken, signValue, verifySignedValue } from "./crypto";
import { authorizationUrl, DRIVE_FILE_SCOPE, exchangeCode, GoogleAuthError, newAuthRequest } from "./google";
import { checkOrigin } from "./middleware";
import { clearSessionCookie, createSession, deleteUserSessions, readSessionCookie, setSessionCookie, validateSession } from "./session";

const STATE_COOKIE = "oauth_state";
const STATE_TTL_SEC = 600;

const StatePayload = z.object({
  state: z.string(),
  codeVerifier: z.string(),
  consent: z.boolean(),
  exp: z.number(),
});

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/google", async (c) => {
  const consent = c.req.query("consent") === "1";
  const req = newAuthRequest();
  const payload = JSON.stringify({ ...req, consent, exp: Date.now() + STATE_TTL_SEC * 1000 } satisfies z.infer<typeof StatePayload>);
  setCookie(c, STATE_COOKIE, await signValue(c.env.SESSION_SECRET, payload), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax", // must survive the top-level redirect back from Google
    path: "/auth",
    maxAge: STATE_TTL_SEC,
  });
  const url = await authorizationUrl(googleConfig(c.env, c.var.deps), { ...req, consent });
  return c.redirect(url.toString(), 302);
});

authRoutes.get("/google/callback", async (c) => {
  const fail = (code: string) => {
    log("auth_failed", { code });
    return c.redirect(`/?error=${encodeURIComponent(code)}`, 302);
  };

  const signed = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth", secure: true, httpOnly: true, sameSite: "Lax" });
  const raw = signed ? await verifySignedValue(c.env.SESSION_SECRET, signed) : null;
  let parsed: z.infer<typeof StatePayload> | null = null;
  try {
    const r = raw ? StatePayload.safeParse(JSON.parse(raw)) : null;
    parsed = r?.success ? r.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.exp < Date.now()) return fail("auth_expired");

  const cfg = googleConfig(c.env, c.var.deps);
  let result;
  try {
    result = await exchangeCode(cfg, new URL(c.req.url), parsed);
  } catch (e) {
    return fail(e instanceof GoogleAuthError ? e.code : "auth_failed");
  }

  const email = result.claims.email.toLowerCase();
  if (!isAllowedEmail(c.env.ALLOWED_EMAILS, email)) return fail("not_allowed");
  // Google's granular consent lets the user untick Drive access.
  if (!result.grantedScopes.includes(DRIVE_FILE_SCOPE)) return fail("drive_scope_missing");

  const db = c.var.db;
  const existing = await db.select().from(users).where(eq(users.googleSub, result.claims.sub)).get();
  const hasStoredToken = !!existing?.refreshTokenEnc && existing.driveStatus === "connected";
  if (!result.refreshToken && !hasStoredToken) {
    // Google only returns a refresh token with the consent screen. Ask once more with prompt=consent.
    if (!parsed.consent) return c.redirect("/auth/google?consent=1", 302);
    return fail("no_refresh_token");
  }

  const refreshTokenEnc = result.refreshToken ? await encryptToken(c.env.TOKEN_ENC_KEY, result.refreshToken) : undefined;
  const user = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSub: result.claims.sub,
      email,
      name: result.claims.name ?? null,
      defaultCurrency: c.env.DEFAULT_CURRENCY || "SGD",
      refreshTokenEnc: refreshTokenEnc ?? null,
      driveStatus: "connected",
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email,
        name: result.claims.name ?? null,
        ...(refreshTokenEnc ? { refreshTokenEnc, driveStatus: "connected" as const } : {}),
      },
    })
    .returning()
    .get();

  cacheAccessToken(user.id, result.accessToken, result.expiresIn);
  try {
    await ensureFolder(db, user, driveApi(result.accessToken, c.var.deps.fetch));
  } catch (e) {
    // Not fatal: the upload path creates the folder if it is still missing.
    log("drive_folder_failed", { code: e instanceof DriveError ? e.message : "unknown" });
  }

  const session = await createSession(db, user.id);
  setSessionCookie(c, session.token, session.expiresAt);
  log("signed_in", {});
  return c.redirect("/", 302);
});

/** Deletes all of the user's sessions (spec "Security & privacy"). */
authRoutes.post("/logout", checkOrigin, async (c) => {
  const token = readSessionCookie(c);
  const session = token ? await validateSession(c.var.db, token) : null;
  if (session) await deleteUserSessions(c.var.db, session.user.id);
  clearSessionCookie(c);
  return c.body(null, 204);
});
