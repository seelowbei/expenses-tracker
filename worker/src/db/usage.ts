// `ai_usage` rows from the agent's per-call records. Counts and codes only, never receipt content.
import type { AiCallRecord } from "../agent/usage";
import type { NewAiUsage } from "./schema";

export function usageRows(
  records: readonly AiCallRecord[],
  ctx: { userId: string; receiptId: string; attempt: number; createdAt: string },
): NewAiUsage[] {
  return records.map((r) => ({
    id: crypto.randomUUID(),
    userId: ctx.userId,
    receiptId: ctx.receiptId,
    attempt: ctx.attempt,
    kind: r.kind,
    model: r.model,
    inputMode: r.inputMode,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    neuronsEst: r.neuronsEst,
    latencyMs: r.latencyMs,
    outcome: r.outcome,
    errorCode: r.errorCode,
    createdAt: ctx.createdAt,
  }));
}
