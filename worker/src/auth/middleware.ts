import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-env";
import { isAllowedEmail } from "./allowlist";
import { clearSessionCookie, deleteUserSessions, readSessionCookie, setSessionCookie, validateSession } from "./session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** State-changing requests must come from the app's own origin (CSRF defence on top of SameSite=Lax). */
export const checkOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN) {
    return c.json({ error: "bad_origin" }, 403);
  }
  await next();
});

/** Resolves the session cookie to `c.var.user`; 401 otherwise. user_id always comes from here. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = readSessionCookie(c);
  const session = token ? await validateSession(c.var.db, token) : null;
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  // Re-checked per request so removing an email from ALLOWED_EMAILS ends that account's sessions too.
  if (!isAllowedEmail(c.env.ALLOWED_EMAILS, session.user.email)) {
    await deleteUserSessions(c.var.db, session.user.id);
    clearSessionCookie(c);
    return c.json({ error: "not_allowed" }, 401);
  }
  if (session.renewedUntil && token) setSessionCookie(c, token, session.renewedUntil);
  c.set("user", session.user);
  await next();
});
