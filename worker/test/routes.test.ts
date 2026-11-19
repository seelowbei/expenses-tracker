import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sniffMime } from "../src/lib/sniff";

const DEV_ENV = { DEV_ROUTES: "true", APP_ORIGIN: "http://localhost:8787" };

describe("dev routes", () => {
  it("are hidden unless DEV_ROUTES is true", async () => {
    const res = await app.request("/api/dev/extract", { method: "POST" }, {});
    expect(res.status).toBe(404);
  });

  it.each([
    ["a deployed origin", "https://expense-tracker.example.workers.dev"],
    ["a host merely starting with localhost", "https://localhost.example.com"],
    ["a missing origin", undefined],
  ])("stay hidden with DEV_ROUTES=true but %s", async (_name, origin) => {
    const res = await app.request("/api/dev/extract", { method: "POST" }, { DEV_ROUTES: "true", APP_ORIGIN: origin });
    expect(res.status).toBe(404);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])("are enabled for loopback origin %s", async (origin) => {
    const res = await app.request("/api/dev/extract", { method: "POST" }, { DEV_ROUTES: "true", APP_ORIGIN: origin });
    expect(res.status).toBe(400); // reached the handler: not multipart
  });

  it("return 400 when the body is not multipart", async () => {
    const res = await app.request("/api/dev/extract", { method: "POST" }, DEV_ENV);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_file" });
  });

  it("reject unsupported file types", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], "x.gif"));
    const res = await app.request("/api/dev/extract", { method: "POST", body: form }, DEV_ENV);
    expect(res.status).toBe(415);
  });
});

describe("POST /api/dev/agree", () => {
  const envWith = (run: () => Promise<unknown>) => ({ ...DEV_ENV, AI: { run } });

  it("treats Workers AI error 5016 as the license being accepted", async () => {
    const env = envWith(async () => {
      throw new Error("5016: Thank you for agreeing to this model's terms. You may now use the model.");
    });
    const res = await app.request("/api/dev/agree", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
  });

  it("reports already_accepted when the model simply answers", async () => {
    const res = await app.request("/api/dev/agree", { method: "POST" }, envWith(async () => ({ response: "Hi" })));
    expect(await res.json()).toMatchObject({ ok: true, status: "already_accepted" });
  });

  it("returns 502 for other AI errors", async () => {
    const env = envWith(async () => {
      throw new Error("4006: daily free allocation exceeded");
    });
    const res = await app.request("/api/dev/agree", { method: "POST" }, env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "ai_error" });
  });
});

describe("sniffMime", () => {
  it("detects JPEG, PNG and PDF by magic bytes", () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(new TextEncoder().encode("<svg>"))).toBeNull();
  });
});
