// Per-call Workers AI usage, shaped like the spec's `ai_usage` rows (persisted from M3).
// Counts and codes only: never prompts, replies or receipt content.

/** Neurons per token, from Cloudflare's published $ prices at $0.011 per 1,000 neurons. */
export const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "@cf/meta/llama-3.2-11b-vision-instruct": {
    input: 0.0485 / 0.011 / 1000, // ~0.00441
    output: 0.676 / 0.011 / 1000, // ~0.0615
  },
  // Eval-only candidates (`/api/dev/extract` model switch); prices from Cloudflare's pricing page, Nov 2026.
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.1 / 0.011 / 1000, output: 0.3 / 0.011 / 1000 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { input: 0.27 / 0.011 / 1000, output: 0.85 / 0.011 / 1000 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { input: 0.351 / 0.011 / 1000, output: 0.555 / 0.011 / 1000 },
  "@cf/qwen/qwen3.8-27b": { input: 0.45 / 0.011 / 1000, output: 3.2 / 0.011 / 1000 },
};

export const TO_MARKDOWN_MODEL = "toMarkdown";

export type AiCallKind = "extract" | "repair" | "to_markdown";
export type AiCallOutcome = "ok" | "invalid_output" | "ai_error" | "quota_exceeded";
export type InputMode = "image" | "pdf_text";

export interface AiCallRecord {
  kind: AiCallKind;
  model: string;
  inputMode: InputMode;
  promptTokens: number | null;
  completionTokens: number | null;
  /** null when tokens are unknown; 0 for free calls (toMarkdown). */
  neuronsEst: number | null;
  latencyMs: number;
  outcome: AiCallOutcome;
  /** Workers AI code (e.g. "4006") or our own code; never message text. */
  errorCode: string | null;
}

export function tokensFrom(output: unknown): { promptTokens: number | null; completionTokens: number | null } {
  const u = (output as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  return {
    promptTokens: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : null,
    completionTokens: typeof u?.completion_tokens === "number" ? u.completion_tokens : null,
  };
}

export function estimateNeurons(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
  const rate = MODEL_RATES[model];
  if (!rate || promptTokens === null || completionTokens === null) return null;
  return promptTokens * rate.input + completionTokens * rate.output;
}

/** Workers AI errors look like "4006: you have used up your daily free allocation...". */
export function classifyAiError(e: unknown): { outcome: AiCallOutcome; errorCode: string | null } {
  const message = e instanceof Error ? e.message : String(e);
  const code = message.match(/^\s*(\d{4})\b/)?.[1] ?? message.match(/\b(\d{4}):/)?.[1] ?? null;
  return { outcome: code === "4006" ? "quota_exceeded" : "ai_error", errorCode: code };
}

export interface UsageSummary {
  calls: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** null if any call's neurons are unknown. */
  neuronsEst: number | null;
}

export function summarizeUsage(calls: readonly AiCallRecord[]): UsageSummary {
  let neurons: number | null = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const c of calls) {
    promptTokens += c.promptTokens ?? 0;
    completionTokens += c.completionTokens ?? 0;
    neurons = neurons === null || c.neuronsEst === null ? null : neurons + c.neuronsEst;
  }
  return {
    calls: calls.length,
    llmCalls: calls.filter((c) => c.kind !== "to_markdown").length,
    promptTokens,
    completionTokens,
    neuronsEst: neurons,
  };
}
