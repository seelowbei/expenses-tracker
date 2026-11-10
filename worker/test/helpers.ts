// Test helpers: a scripted fake for Google (OAuth token endpoint + Drive) and seeded users with sessions.
import { env } from "cloudflare:workers";
import type { Fetcher } from "../src/app-env";
import { encryptToken } from "../src/auth/crypto";
import { createSession } from "../src/auth/session";
import { getDb, nowIso } from "../src/db/client";
import { users } from "../src/db/schema";
import { createApp } from "../src/index";
import { toBase64Url } from "../src/lib/encoding";

export const ORIGIN = "http://localhost:8787";
export const TOKEN_URL = "POST https://oauth2.googleapis.com/token";
export const FOLDER_URL = "POST https://www.googleapis.com/drive/v3/files";
export const UPLOAD_URL = "POST https://www.googleapis.com/upload/drive/v3/files";

type Handler = (req: Request) => Response | Promise<Response>;

export interface FakeCall {
  key: string;
  url: URL;
  headers: Headers;
  body: string;
}

export function fakeGoogle(routes: Record<string, Handler | Handler[]> = {}) {
  const calls: FakeCall[] = [];
  const queues = new Map<string, Handler[]>();
  for (const [k, v] of Object.entries(routes)) queues.set(k, Array.isArray(v) ? [...v] : [v]);
  const fetch: Fetcher = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.origin}${url.pathname}`;
    calls.push({ key, url, headers: req.headers, body: new TextDecoder().decode(await req.clone().arrayBuffer()) });
    const q = queues.get(key);
    // A list of handlers is consumed in order; the last one repeats.
    const h = q && (q.length > 1 ? q.shift() : q[0]);
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(req);
  };
  return { fetch, calls, callsTo: (key: string) => calls.filter((c) => c.key === key), set: (k: string, v: Handler | Handler[]) => queues.set(k, Array.isArray(v) ? [...v] : [v]) };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const payload = { iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, iat: now, exp: now + 3600, ...claims };
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.c2ln`;
}

export const ALL_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file";

export function tokenResponse(opts: { sub: string; email: string; refreshToken?: string; scope?: string; emailVerified?: boolean }) {
  return json({
    access_token: `at-${opts.sub}`,
    expires_in: 3599,
    token_type: "Bearer",
    scope: opts.scope ?? ALL_SCOPES,
    id_token: idToken({ sub: opts.sub, email: opts.email, email_verified: opts.emailVerified ?? true, name: "Test User" }),
    ...(opts.refreshToken ? { refresh_token: opts.refreshToken } : {}),
  });
}

export function makeApp(fake = fakeGoogle()) {
  const app = createApp({ fetch: fake.fetch });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  return { app, fake, request };
}

export const db = () => getDb(env.DB);

/** Runs app requests against the test env with some bindings replaced. */
export function requestWithEnv(app: ReturnType<typeof makeApp>["app"], overrides: Partial<typeof env>) {
  const patched = { ...env, ...overrides };
  return (path: string, init: RequestInit = {}) => app.request(path, init, patched);
}

const RUN_METHODS = new Set<PropertyKey>(["first", "run", "all", "raw"]);

/** Delegates to the real object, keeping `this` bound for native D1 methods. */
function passThrough<T extends object>(target: T, prop: PropertyKey) {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
}

function hookedStatement(stmt: D1PreparedStatement, before: () => Promise<void>): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => hookedStatement(target.bind(...values), before);
      if (RUN_METHODS.has(prop)) {
        const run = passThrough(target, prop) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          await before();
          return run(...args);
        };
      }
      return passThrough(target, prop);
    },
  });
}

/** The test D1 database, but `before` runs just before any statement whose SQL matches `sql` executes. */
export function d1WithHook(sql: RegExp, before: () => Promise<void>): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const stmt = target.prepare(query);
          return sql.test(query) ? hookedStatement(stmt, before) : stmt;
        };
      }
      return passThrough(target, prop);
    },
  });
}

export async function seedUser(opts: { email?: string; refreshToken?: string | null; driveFolderId?: string | null; driveStatus?: "connected" | "disconnected" } = {}) {
  const id = crypto.randomUUID();
  const refreshToken = opts.refreshToken === undefined ? `rt-${id}` : opts.refreshToken;
  await db()
    .insert(users)
    .values({
      id,
      googleSub: `sub-${id}`,
      email: opts.email ?? "alice@example.com",
      name: "Alice",
      defaultCurrency: "SGD",
      driveFolderId: opts.driveFolderId === undefined ? `folder-${id}` : opts.driveFolderId,
      refreshTokenEnc: refreshToken ? await encryptToken(env.TOKEN_ENC_KEY, refreshToken) : null,
      driveStatus: opts.driveStatus ?? "connected",
      createdAt: nowIso(),
    });
  const { token } = await createSession(db(), id);
  return { id, token, cookie: `session=${token}` };
}

/** Parses `Set-Cookie` headers into name -> raw cookie string. */
export function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of res.headers.getSetCookie()) out.set(c.split("=")[0]!, c);
  return out;
}

export const cookieValue = (raw: string) => raw.split(";")[0]!.split("=").slice(1).join("=");
