import { describe, expect, it } from "vitest";
import { classifyAiError, estimateNeurons, summarizeUsage, type AiCallRecord } from "../src/agent/usage";

const VISION = "@cf/meta/llama-3.2-11b-vision-instruct";

describe("estimateNeurons", () => {
  it("applies the per-model rates", () => {
    expect(estimateNeurons(VISION, 6831, 106)).toBeCloseTo(36.6, 1); // first M1 measurement
  });

  it("is null for unknown models or missing tokens", () => {
    expect(estimateNeurons("@cf/unknown/model", 100, 10)).toBeNull();
    expect(estimateNeurons(VISION, null, 10)).toBeNull();
  });
});

describe("classifyAiError", () => {
  it("maps 4006 to quota_exceeded and keeps only the code", () => {
    expect(classifyAiError(new Error("4006: you have used up your daily free allocation"))).toEqual({
      outcome: "quota_exceeded",
      errorCode: "4006",
    });
  });

  it("finds codes after a prefix and tolerates messages without one", () => {
    expect(classifyAiError(new Error("InferenceUpstreamError: 3040: Capacity exceeded"))).toEqual({ outcome: "ai_error", errorCode: "3040" });
    expect(classifyAiError("network down")).toEqual({ outcome: "ai_error", errorCode: null });
  });
});

describe("summarizeUsage", () => {
  const rec = (over: Partial<AiCallRecord>): AiCallRecord => ({
    kind: "extract", model: VISION, inputMode: "image", promptTokens: 100, completionTokens: 10,
    neuronsEst: 1, latencyMs: 5, outcome: "ok", errorCode: null, ...over,
  });

  it("sums tokens and neurons and counts LLM calls separately", () => {
    const s = summarizeUsage([rec({ kind: "to_markdown", neuronsEst: 0, completionTokens: null }), rec({}), rec({ kind: "repair", neuronsEst: 2 })]);
    expect(s).toEqual({ calls: 3, llmCalls: 2, promptTokens: 300, completionTokens: 20, neuronsEst: 3 });
  });

  it("makes the neuron total unknown if any call's is unknown", () => {
    expect(summarizeUsage([rec({}), rec({ neuronsEst: null })]).neuronsEst).toBeNull();
  });
});
