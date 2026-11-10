import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptToken } from "../src/auth/crypto";
import { validateSession } from "../src/auth/session";
import { users } from "../src/db/schema";
import { clearAccessTokenCache } from "../src/drive/access";
import { ALL_SCOPES, cookieValue, db, FOLDER_URL, fakeGoogle, idToken, json, makeApp, ORIGIN, seedUser, setCookies, TOKEN_URL, tokenResponse } from "./helpers";

beforeEach(() => clearAccessTokenCache());

/** Starts sign-in, then calls the callback with Google's answer. Returns the final response. */
async function signIn(google: ReturnType<typeof fakeGoogle>, start = "/auth/google") {
  const { request } = makeApp(google);
  const res1 = await request(start);
  expect(res1.status).toBe(302);
  const location = new URL(res1.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  const stateCookie = setCookies(res1).get("oauth_state")!;
  const res2 = await request(`/auth/google/callback?code=c0de&state=${state}&iss=https%3A%2F%2Faccounts.google.com`, {
    headers: { Cookie: `oauth_state=${cookieValue(stateCookie)}` },
  });
  return { location, res: res2 };
}

describe("GET /auth/google", () => {
  it("redirects to Google with exact scopes, PKCE S256 and offline access", async () => {
    const { request } = makeApp();
    const res = await request("/auth/google");
    const url = new URL(res.headers.get("Location")!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/google/callback`);
    expect(url.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.has("prompt")).toBe(false);

    const cookie = setCookies(res).get("oauth_state")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/auth/);
  });

  it("adds prompt=consent when asked", async () => {
    const { request } = makeApp();
    const res = await request("/auth/google?consent=1");
    expect(new URL(res.headers.get("Location")!).searchParams.get("prompt")).toBe("consent");
  });
});

describe("GET /auth/google/callback", () => {
  it("creates the user, encrypts the refresh token, creates the Drive folder and a session", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const google = fakeGoogle({
      [TOKEN_URL]: () => tokenResponse({ sub, email: "Alice@Example.com", refreshToken: "1//rt-new" }),
      [FOLDER_URL]: () => json({ id: "folder-123" }),
    });
    const { res } = await signIn(google);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    const token = google.callsTo(TOKEN_URL)[0]!;
    const form = new URLSearchParams(token.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("c0de");
    expect(form.get("code_verifier")).toMatch(/^[\w-]{43,}$/);

    const folder = google.callsTo(FOLDER_URL)[0]!;
    expect(folder.headers.get("Authorization")).toBe(`Bearer at-${sub}`);
    expect(JSON.parse(folder.body)).toEqual({ name: "Expense Receipts", mimeType: "application/vnd.google-apps.folder" });

    const user = await db().select().from(users).where(eq(users.googleSub, sub)).get();
    expect(user?.email).toBe("alice@example.com");
    expect(user?.driveFolderId).toBe("folder-123");
    expect(user?.driveStatus).toBe("connected");
    expect(user?.refreshTokenEnc).toMatch(/^v1:/);
    expect(await decryptToken(env.TOKEN_ENC_KEY, user!.refreshTokenEnc!)).toBe("1//rt-new");

    const session = setCookies(res).get("session")!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect((await validateSession(db(), cookieValue(session)))?.user.id).toBe(user!.id);
  });

  it("rejects accounts that are not on the allow-list without storing anything", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const google = fakeGoogle({ [TOKEN_URL]: () => tokenResponse({ sub, email: "mallory@example.com", refreshToken: "rt" }) });
    const { res } = await signIn(google);
    expect(res.headers.get("Location")).toBe("/?error=not_allowed");
    expect(setCookies(res).has("session")).toBe(false);
    expect(await db().select().from(users).where(eq(users.googleSub, sub)).get()).toBeUndefined();
  });

  it("rejects unverified emails and a missing Drive scope", async () => {
    const google = fakeGoogle({ [TOKEN_URL]: () => tokenResponse({ sub: "s1", email: "alice@example.com", refreshToken: "rt", emailVerified: false }) });
    expect((await signIn(google)).res.headers.get("Location")).toBe("/?error=id_token_claims");

    google.set(TOKEN_URL, () => tokenResponse({ sub: "s2", email: "alice@example.com", refreshToken: "rt", scope: "openid email profile" }));
    expect((await signIn(google)).res.headers.get("Location")).toBe("/?error=drive_scope_missing");
  });

  it("rejects an ID token issued for another client or issuer, or already expired", async () => {
    const bad = (claims: Record<string, unknown>) => () =>
      json({ access_token: "at", expires_in: 3599, token_type: "Bearer", scope: ALL_SCOPES, refresh_token: "rt", id_token: idToken({ sub: "x", email: "alice@example.com", email_verified: true, ...claims }) });
    for (const claims of [{ aud: "someone-else" }, { iss: "https://evil.example" }, { exp: Math.floor(Date.now() / 1000) - 3600 }]) {
      const { res } = await signIn(fakeGoogle({ [TOKEN_URL]: bad(claims) }));
      expect(res.headers.get("Location")).toBe("/?error=token_exchange_failed");
      expect(setCookies(res).has("session")).toBe(false);
    }
  });

  it("asks for consent once when a new user gets no refresh token, then gives up", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const google = fakeGoogle({ [TOKEN_URL]: () => tokenResponse({ sub, email: "bob@example.com" }) });
    expect((await signIn(google)).res.headers.get("Location")).toBe("/auth/google?consent=1");
    expect((await signIn(google, "/auth/google?consent=1")).res.headers.get("Location")).toBe("/?error=no_refresh_token");
  });

  it("keeps the stored refresh token and folder for a returning user", async () => {
    const seeded = await seedUser({ refreshToken: "rt-old", driveFolderId: "folder-old" });
    const google = fakeGoogle({ [TOKEN_URL]: () => tokenResponse({ sub: `sub-${seeded.id}`, email: "alice@example.com" }) });
    const { res } = await signIn(google);
    expect(res.headers.get("Location")).toBe("/");
    expect(google.callsTo(FOLDER_URL)).toHaveLength(0);
    const user = await db().select().from(users).where(eq(users.id, seeded.id)).get();
    expect(await decryptToken(env.TOKEN_ENC_KEY, user!.refreshTokenEnc!)).toBe("rt-old");
  });

  it("reconnects a disconnected user when Google returns a new refresh token", async () => {
    const seeded = await seedUser({ driveStatus: "disconnected" });
    const sub = `sub-${seeded.id}`;
    const google = fakeGoogle({ [TOKEN_URL]: () => tokenResponse({ sub, email: "alice@example.com" }) });
    // No refresh token and the stored one is dead: force consent.
    expect((await signIn(google)).res.headers.get("Location")).toBe("/auth/google?consent=1");

    google.set(TOKEN_URL, () => tokenResponse({ sub, email: "alice@example.com", refreshToken: "rt-fresh" }));
    expect((await signIn(google, "/auth/google?consent=1")).res.headers.get("Location")).toBe("/");
    const user = await db().select().from(users).where(eq(users.id, seeded.id)).get();
    expect(user?.driveStatus).toBe("connected");
    expect(await decryptToken(env.TOKEN_ENC_KEY, user!.refreshTokenEnc!)).toBe("rt-fresh");
  });

  it("still signs in when folder creation fails", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const google = fakeGoogle({
      [TOKEN_URL]: () => tokenResponse({ sub, email: "alice@example.com", refreshToken: "rt" }),
      [FOLDER_URL]: () => new Response("busy", { status: 503 }),
    });
    const { res } = await signIn(google);
    expect(res.headers.get("Location")).toBe("/");
    expect((await db().select().from(users).where(eq(users.googleSub, sub)).get())?.driveFolderId).toBeNull();
  });

  it("fails without a valid state cookie, on state mismatch and on access_denied", async () => {
    const { request } = makeApp();
    expect((await request("/auth/google/callback?code=x&state=y")).headers.get("Location")).toBe("/?error=auth_expired");
    expect(
      (await request("/auth/google/callback?code=x&state=y", { headers: { Cookie: "oauth_state=forged.value" } })).headers.get("Location"),
    ).toBe("/?error=auth_expired");

    const res1 = await request("/auth/google");
    const cookie = `oauth_state=${cookieValue(setCookies(res1).get("oauth_state")!)}`;
    expect((await request("/auth/google/callback?code=x&state=wrong", { headers: { Cookie: cookie } })).headers.get("Location")).toBe("/?error=bad_callback");

    const state = new URL(res1.headers.get("Location")!).searchParams.get("state");
    expect(
      (await request(`/auth/google/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie } })).headers.get("Location"),
    ).toBe("/?error=access_denied");
  });
});

describe("POST /auth/logout", () => {
  it("requires our Origin", async () => {
    const { cookie } = await seedUser();
    const { request } = makeApp();
    const res = await request("/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("deletes all of the user's sessions and clears the cookie", async () => {
    const { cookie, token } = await seedUser();
    const { request } = makeApp();
    const res = await request("/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(204);
    expect(setCookies(res).get("session")).toMatch(/Max-Age=0/);
    expect(await validateSession(db(), token)).toBeNull();
  });
});

describe("GET /api/me", () => {
  it("returns the profile and Drive status for the session user", async () => {
    const { cookie, id } = await seedUser({ driveFolderId: "f1" });
    const { request } = makeApp();
    const res = await request("/api/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Alice",
      email: "alice@example.com",
      defaultCurrency: "SGD",
      driveStatus: "connected",
      driveFolderLink: "https://drive.google.com/drive/folders/f1",
    });
    expect(id).toBeTruthy();
  });

  it("ends the sessions of an account removed from ALLOWED_EMAILS", async () => {
    const { cookie, token } = await seedUser({ email: "carol@example.com" });
    const { request } = makeApp();
    const res = await request("/api/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not_allowed" });
    expect(setCookies(res).get("session")).toMatch(/Max-Age=0/);
    expect(await validateSession(db(), token)).toBeNull();
  });

  it("is 401 without a session", async () => {
    const { request } = makeApp();
    expect((await request("/api/me")).status).toBe(401);
    expect((await request("/api/me", { headers: { Cookie: "session=bogus" } })).status).toBe(401);
  });
});
