// M1 extraction spike routes. Local only: mounted behind DEV_ROUTES === "true",
// which is set in wrangler.jsonc top-level vars and never by the deployed (Pulumi) config.
import { Hono } from "hono";
import { DEFAULT_CATEGORIES } from "../agent/categories";
import { aiClient, extractReceipt, VISION_MODEL, type ImageMode, type ReceiptInput } from "../agent/extract";
import { summarizeUsage } from "../agent/usage";
import type { Bindings } from "../env";
import { MAX_UPLOAD_BYTES, sniffMime } from "../lib/sniff";

export const devRoutes = new Hono<{ Bindings: Bindings }>();

devRoutes.use("*", async (c, next) => {
  if (c.env.DEV_ROUTES !== "true") return c.notFound();
  await next();
});

// Workers AI confirms the license by throwing "5016: Thank you for agreeing to this model's terms...".
const LICENSE_ACCEPTED = /\b5016\b/;

/** One-time acceptance of Meta's Llama 3.2 license for this Cloudflare account. */
devRoutes.post("/agree", async (c) => {
  try {
    const out = await c.env.AI.run(VISION_MODEL, { prompt: "agree" });
    // Already accepted earlier: the model just answers the prompt.
    return c.json({ ok: true, status: "already_accepted", response: (out as { response?: unknown }).response ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (LICENSE_ACCEPTED.test(message)) return c.json({ ok: true, status: "accepted" });
    return c.json({ ok: false, error: "ai_error", detail: message }, 502);
  }
});

/** Multipart `file` (JPEG/PNG/PDF). Optional `imageMode` = data_url | bytes. */
devRoutes.post("/extract", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) return c.json({ error: "unsupported_type" }, 415);

  const modeParam = form.get("imageMode");
  const imageMode: ImageMode = modeParam === "bytes" ? "bytes" : "data_url";
  const input: ReceiptInput = mime === "application/pdf" ? { kind: "pdf", bytes } : { kind: "image", mimeType: mime, bytes };

  const started = Date.now();
  const result = await extractReceipt(aiClient(c.env.AI), input, {
    categorySlugs: DEFAULT_CATEGORIES.map((cat) => cat.slug),
    defaultCurrency: c.env.DEFAULT_CURRENCY,
    locale: "en-SG",
    today: new Date().toISOString().slice(0, 10),
    imageMode,
  });

  return c.json({
    mime,
    sizeBytes: bytes.length,
    imageMode,
    elapsedMs: Date.now() - started,
    usage: summarizeUsage(result.calls),
    result,
  });
});
