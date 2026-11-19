import { describe, expect, it } from "vitest";
import { WORKER_CSP } from "../src/lib/security-headers";
import { d1WithHook, makeApp, ORIGIN, requestWithEnv } from "./helpers";

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("Content-Security-Policy")).toBe(WORKER_CSP);
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
}

describe("security headers on Worker responses", () => {
  const { app, request } = makeApp();

  it("are set on a public API route", async () => {
    const res = await request("/api/health");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it("are set when the request is rejected before the handler", async () => {
    const unauthenticated = await request("/api/me");
    expect(unauthenticated.status).toBe(401);
    expectSecurityHeaders(unauthenticated);

    const badOrigin = await request("/api/categories", { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(badOrigin.status).toBe(403);
    expectSecurityHeaders(badOrigin);
  });

  it("are set on auth redirects", async () => {
    const res = await request("/auth/google/callback");
    expect(res.status).toBe(302);
    expectSecurityHeaders(res);
  });

  it("are set on unhandled errors", async () => {
    // The session lookup throws, so onError answers.
    const failing = requestWithEnv(app, { DB: d1WithHook(/sessions/, async () => { throw new Error("d1_down"); }) });
    const res = await failing("/api/me", { headers: { Cookie: "session=abc", Origin: ORIGIN } });
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });
});
