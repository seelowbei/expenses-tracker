import { Buffer } from "node:buffer";
import { parseExtraction, type ParseResult } from "./parse";
import { IMAGE_USER_PROMPT, pdfUserPrompt, renderSystemPrompt, repairPrompt } from "./prompt";
import type { Extraction } from "./schema";
import {
  classifyAiError,
  estimateNeurons,
  TO_MARKDOWN_MODEL,
  tokensFrom,
  type AiCallKind,
  type AiCallRecord,
  type InputMode,
} from "./usage";
import { postValidate, type LedgerDraft, type ReviewReason } from "./validate";

export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_TOKENS = 1024; // up to 50 line items
const MAX_MARKDOWN_CHARS = 20_000;

/** Minimal slice of the Workers AI binding, so tests can pass a fake. */
export interface AiClient {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
  toMarkdown(doc: { name: string; blob: Blob }): Promise<{ format: string; data?: string; error?: string; tokens?: number }>;
}

export function aiClient(ai: Ai): AiClient {
  return {
    // The binding's run() is overloaded per model; our inputs are checked by the tests and the eval instead.
    run: (model, input) => ai.run(model as typeof VISION_MODEL, input as never),
    toMarkdown: (doc) => ai.toMarkdown(doc),
  };
}

export type ReceiptInput =
  | { kind: "image"; mimeType: "image/jpeg" | "image/png"; bytes: Uint8Array }
  | { kind: "pdf"; bytes: Uint8Array };

/** How the image reaches the model: a base64 data URL content part, or the legacy top-level byte array. */
export type ImageMode = "data_url" | "bytes";

export interface ExtractContext {
  categorySlugs: readonly string[];
  defaultCurrency: string;
  locale: string;
  today: string; // YYYY-MM-DD, UTC
  imageMode?: ImageMode;
  /** Injectable clock for latency; defaults to Date.now. */
  now?: () => number;
}

export type ExtractErrorCode = "unsupported_scanned_pdf" | "pdf_conversion_failed" | "invalid_output" | "ai_error" | "quota_exceeded";

interface Telemetry {
  /** One record per Workers AI call, in order; becomes `ai_usage` rows in M3. */
  calls: AiCallRecord[];
  /** Raw model replies, for the audit column (raw_extraction). Never log these. */
  replies: unknown[];
}

export type ExtractResult =
  | ({ ok: true; status: "done" | "needs_review"; reasons: ReviewReason[]; extraction: Extraction; draft: LedgerDraft } & Telemetry)
  | ({ ok: false; code: ExtractErrorCode; detail?: string } & Telemetry);

type Message = { role: "system" | "user" | "assistant"; content: string | Record<string, unknown>[] };

/** toMarkdown output includes headings and a metadata block even for scanned PDFs; look for real text. */
export function hasReceiptText(markdown: string): boolean {
  const body = markdown
    .replace(/^#+\s*metadata[\s\S]*?(?=^#+\s|(?![\s\S]))/gim, "")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join(" ");
  return (body.match(/[\p{L}\p{N}]/gu) ?? []).length >= 10;
}

class AiCallFailed extends Error {
  constructor(
    readonly code: "ai_error" | "quota_exceeded",
    message: string,
  ) {
    super(message);
  }
}

export async function extractReceipt(ai: AiClient, input: ReceiptInput, ctx: ExtractContext): Promise<ExtractResult> {
  const now = ctx.now ?? Date.now;
  const t: Telemetry = { calls: [], replies: [] };
  const inputMode: InputMode = input.kind === "pdf" ? "pdf_text" : "image";
  const system = renderSystemPrompt(ctx);

  let messages: Message[];
  let extra: Record<string, unknown> = {};

  if (input.kind === "pdf") {
    const started = now();
    let md: Awaited<ReturnType<AiClient["toMarkdown"]>>;
    try {
      md = await ai.toMarkdown({ name: "receipt.pdf", blob: new Blob([input.bytes], { type: "application/pdf" }) });
    } catch (e) {
      const { errorCode } = classifyAiError(e);
      t.calls.push(markdownRecord(now() - started, null, "ai_error", errorCode ?? "pdf_conversion_failed"));
      return { ok: false, code: "pdf_conversion_failed", detail: (e as Error).message, ...t };
    }
    if (md.format === "error") {
      t.calls.push(markdownRecord(now() - started, null, "ai_error", "pdf_conversion_failed"));
      return { ok: false, code: "pdf_conversion_failed", detail: md.error, ...t };
    }
    t.calls.push(markdownRecord(now() - started, md.tokens ?? null, "ok", null));
    const text = md.data ?? "";
    if (!hasReceiptText(text)) return { ok: false, code: "unsupported_scanned_pdf", ...t };
    messages = [
      { role: "system", content: system },
      { role: "user", content: pdfUserPrompt(text.slice(0, MAX_MARKDOWN_CHARS)) },
    ];
  } else if ((ctx.imageMode ?? "data_url") === "data_url") {
    const url = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
    messages = [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: IMAGE_USER_PROMPT }, { type: "image_url", image_url: { url } }] },
    ];
  } else {
    messages = [
      { role: "system", content: system },
      { role: "user", content: IMAGE_USER_PROMPT },
    ];
    extra = { image: Array.from(input.bytes) };
  }

  /** One LLM call, recorded whatever happens. Throws AiCallFailed on a Workers AI error. */
  const call = async (kind: AiCallKind, msgs: Message[]): Promise<{ reply: unknown; parsed: ParseResult }> => {
    const started = now();
    let out: unknown;
    try {
      out = await ai.run(VISION_MODEL, { messages: msgs, ...extra, max_tokens: MAX_TOKENS, temperature: 0 });
    } catch (e) {
      const { outcome, errorCode } = classifyAiError(e);
      t.calls.push({
        kind, model: VISION_MODEL, inputMode, promptTokens: null, completionTokens: null,
        neuronsEst: null, latencyMs: now() - started, outcome, errorCode,
      });
      throw new AiCallFailed(outcome === "quota_exceeded" ? "quota_exceeded" : "ai_error", (e as Error).message);
    }
    const reply = (out as { response?: unknown } | null)?.response ?? "";
    const parsed = parseExtraction(reply);
    const { promptTokens, completionTokens } = tokensFrom(out);
    t.calls.push({
      kind, model: VISION_MODEL, inputMode, promptTokens, completionTokens,
      neuronsEst: estimateNeurons(VISION_MODEL, promptTokens, completionTokens),
      latencyMs: now() - started,
      outcome: parsed.ok ? "ok" : "invalid_output",
      errorCode: parsed.ok ? null : "invalid_output",
    });
    t.replies.push(reply);
    return { reply, parsed };
  };

  try {
    let { reply, parsed } = await call("extract", messages);
    if (!parsed.ok) {
      // One repair attempt with plain-language hints (spec: "retry once with a repair prompt").
      const previous = typeof reply === "string" ? reply : JSON.stringify(reply);
      ({ reply, parsed } = await call("repair", [
        ...messages,
        { role: "assistant", content: previous },
        { role: "user", content: repairPrompt(parsed.errors) },
      ]));
      if (!parsed.ok) return { ok: false, code: "invalid_output", detail: parsed.errors.join("; "), ...t };
    }
    const v = postValidate(parsed.value, ctx.categorySlugs, ctx.today);
    return { ok: true, status: v.status, reasons: v.reasons, extraction: parsed.value, draft: v.draft, ...t };
  } catch (e) {
    if (e instanceof AiCallFailed) return { ok: false, code: e.code, detail: e.message, ...t };
    throw e;
  }
}

function markdownRecord(
  latencyMs: number,
  tokens: number | null,
  outcome: AiCallRecord["outcome"],
  errorCode: string | null,
): AiCallRecord {
  return {
    kind: "to_markdown",
    model: TO_MARKDOWN_MODEL,
    inputMode: "pdf_text",
    promptTokens: tokens,
    completionTokens: null,
    neuronsEst: outcome === "ok" ? 0 : null, // free for PDFs per Cloudflare docs; confirm in M1
    latencyMs,
    outcome,
    errorCode,
  };
}
