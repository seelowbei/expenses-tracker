// M1 extraction spike routes. Local only: they have no session check, so they answer only when
// DEV_ROUTES === "true" (wrangler.jsonc top-level vars, never the deployed Pulumi config) AND
// APP_ORIGIN is a loopback origin. The second check keeps them off if DEV_ROUTES ever leaks
// into a deployed config, since a deployed APP_ORIGIN is always an https public host.
import { Hono } from "hono";
import { DEFAULT_CATEGORIES } from "../agent/categories";
import { aiClient, extractReceipt, LLAMA_VISION_MODEL, VISION_MODEL, type ImageMode, type ReceiptInput } from "../agent/extract";
import { MODEL_RATES, summarizeUsage } from "../agent/usage";
import type { Bindings } from "../env";
import { MAX_UPLOAD_BYTES, sniffMime } from "../lib/sniff";

export const devRoutes = new Hono<{ Bindings: Bindings }>();

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only for local dev. APP_ORIGIN is config, unlike the request's Host header, which a client controls. */
export function devRoutesEnabled(env: Pick<Bindings, "DEV_ROUTES" | "APP_ORIGIN">): boolean {
  if (env.DEV_ROUTES !== "true") return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(env.APP_ORIGIN).hostname);
  } catch {
    return false;
  }
}

devRoutes.use("*", async (c, next) => {
  if (!devRoutesEnabled(c.env)) return c.notFound();
  await next();
});

// Workers AI confirms the license by throwing "5016: Thank you for agreeing to this model's terms...".
const LICENSE_ACCEPTED = /\b5016\b/;

/** One-time acceptance of Meta's Llama 3.2 license, needed only to compare against it with `eval --model`. */
devRoutes.post("/agree", async (c) => {
  try {
    const out = await c.env.AI.run(LLAMA_VISION_MODEL, { prompt: "agree" });
    // Already accepted earlier: the model just answers the prompt.
    return c.json({ ok: true, status: "already_accepted", response: (out as { response?: unknown }).response ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (LICENSE_ACCEPTED.test(message)) return c.json({ ok: true, status: "accepted" });
    return c.json({ ok: false, error: "ai_error", detail: message }, 502);
  }
});

/** Multipart `file` (JPEG/PNG/PDF). Optional `imageMode` = data_url | bytes; optional `model`, one of MODEL_RATES. */
devRoutes.post("/extract", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "missing_file" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) return c.json({ error: "unsupported_type" }, 415);

  const modeParam = form.get("imageMode");
  const imageMode: ImageMode = modeParam === "bytes" ? "bytes" : "data_url";
  const modelParam = form.get("model");
  if (typeof modelParam === "string" && modelParam !== "" && !(modelParam in MODEL_RATES)) return c.json({ error: "unknown_model" }, 400);
  const model = typeof modelParam === "string" && modelParam !== "" ? modelParam : VISION_MODEL;
  const input: ReceiptInput = mime === "application/pdf" ? { kind: "pdf", bytes } : { kind: "image", mimeType: mime, bytes };

  const started = Date.now();
  const result = await extractReceipt(aiClient(c.env.AI), input, {
    categorySlugs: DEFAULT_CATEGORIES.map((cat) => cat.slug),
    defaultCurrency: c.env.DEFAULT_CURRENCY,
    locale: "en-SG",
    today: new Date().toISOString().slice(0, 10),
    imageMode,
    model,
  });

  return c.json({
    mime,
    sizeBytes: bytes.length,
    imageMode,
    model,
    elapsedMs: Date.now() - started,
    usage: summarizeUsage(result.calls),
    result,
  });
});
