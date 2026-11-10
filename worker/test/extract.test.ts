import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "../src/agent/categories";
import { extractReceipt, hasReceiptText, VISION_MODEL, type AiClient, type ExtractContext } from "../src/agent/extract";
import { renderSystemPrompt } from "../src/agent/prompt";

let clock = 0;
const ctx: ExtractContext = {
  categorySlugs: DEFAULT_CATEGORIES.map((c) => c.slug),
  defaultCurrency: "SGD",
  locale: "en-SG",
  today: "2026-11-09",
  now: () => (clock += 100), // every call appears to take 100 ms
};

const good = JSON.stringify({
  merchant: "Grab",
  txn_date: "2026-11-01",
  txn_time: "6:19 PM",
  currency: "SGD",
  total: 18.4,
  total_text: "Total Paid S$18.40",
  tax: null,
  payment_method: "ewallet",
  line_items: [],
  category_slug: "transport",
  confidence: 0.95,
});

const usage = { prompt_tokens: 6800, completion_tokens: 100 };

type Reply = string | Error | { response: string; usage?: object };

function fakeAi(replies: Reply[], markdown?: { format: string; data?: string; error?: string; tokens?: number }) {
  const calls: Record<string, unknown>[] = [];
  const ai: AiClient = {
    run: async (_model, input) => {
      calls.push(input);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === "string" ? { response: next, usage } : next;
    },
    toMarkdown: async () => markdown ?? { format: "markdown", data: "" },
  };
  return { ai, calls };
}

const jpeg = { kind: "image" as const, mimeType: "image/jpeg" as const, bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]) };
const pdf = { kind: "pdf" as const, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) };

describe("renderSystemPrompt", () => {
  it("fills every variable and asks for the time", () => {
    const p = renderSystemPrompt(ctx);
    expect(p).not.toMatch(/\{\{/);
    expect(p).toContain("date copied exactly as printed");
    expect(p).toContain("food-dining, groceries");
    expect(p).toContain("use SGD");
    expect(p).toContain('6:19 PM -> "18:19"');
    expect(p).toContain('"txn_time": "HH:MM" | null');
  });
});

describe("extractReceipt", () => {
  it("sends the image as a data URL and returns a validated draft with the time", async () => {
    const { ai, calls } = fakeAi([good]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(r.ok && r.status).toBe("done");
    expect(r.ok && r.draft.txn_time).toBe("18:19");
    expect(r.calls).toHaveLength(1);
    const user = (calls[0]!.messages as { content: { type: string; image_url?: { url: string } }[] }[])[1]!;
    expect(user.content[1]!.image_url!.url).toBe("data:image/jpeg;base64,/9j/AQI=");
    expect(calls[0]!.temperature).toBe(0);
  });

  it("records usage for each call", async () => {
    const { ai } = fakeAi([good]);
    const r = await extractReceipt(ai, jpeg, ctx);
    const [rec] = r.calls;
    expect(rec).toMatchObject({
      kind: "extract",
      model: VISION_MODEL,
      inputMode: "image",
      promptTokens: 6800,
      completionTokens: 100,
      latencyMs: 100,
      outcome: "ok",
      errorCode: null,
    });
    expect(rec!.neuronsEst).toBeCloseTo(6800 * (0.0485 / 0.011 / 1000) + 100 * (0.676 / 0.011 / 1000), 6);
  });

  it("leaves neurons unknown when the model returns no usage", async () => {
    const { ai } = fakeAi([{ response: good }]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(r.calls[0]).toMatchObject({ promptTokens: null, completionTokens: null, neuronsEst: null });
  });

  it("can send the image as a byte array instead", async () => {
    const { ai, calls } = fakeAi([good]);
    await extractReceipt(ai, jpeg, { ...ctx, imageMode: "bytes" });
    expect(calls[0]!.image).toEqual([0xff, 0xd8, 0xff, 1, 2]);
  });

  it("repairs once with the validation errors and records both calls", async () => {
    const { ai, calls } = fakeAi(['Sorry, here it is: {"merchant": "Grab"}', good]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(r.ok && r.status).toBe("needs_review");
    expect(r.ok && r.reasons).toEqual(["repaired"]);
    expect(r.calls.map((c) => [c.kind, c.outcome])).toEqual([
      ["extract", "invalid_output"],
      ["repair", "ok"],
    ]);
    const msgs = calls[1]!.messages as { role: string; content: unknown }[];
    expect(msgs.at(-2)!.role).toBe("assistant");
    // Plain-language hint, not the raw regex from the schema.
    expect(String(msgs.at(-1)!.content)).toContain("txn_date must be the transaction date copied exactly as printed");
    expect(String(msgs.at(-1)!.content)).not.toContain("pattern");
  });

  it("fails with invalid_output after two bad replies", async () => {
    const { ai } = fakeAi(["nope", "still nope"]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(!r.ok && r.code).toBe("invalid_output");
    expect(r.calls.map((c) => c.outcome)).toEqual(["invalid_output", "invalid_output"]);
  });

  it("reports quota errors distinctly and records the call", async () => {
    const { ai } = fakeAi([new Error("4006: you have used up your daily free allocation of 10,000 neurons")]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(!r.ok && r.code).toBe("quota_exceeded");
    expect(r.calls).toEqual([
      expect.objectContaining({ kind: "extract", outcome: "quota_exceeded", errorCode: "4006", neuronsEst: null }),
    ]);
  });

  it("reports other AI errors without retrying", async () => {
    const { ai } = fakeAi([new Error("3040: Capacity temporarily exceeded")]);
    const r = await extractReceipt(ai, jpeg, ctx);
    expect(!r.ok && r.code).toBe("ai_error");
    expect(r.calls[0]).toMatchObject({ outcome: "ai_error", errorCode: "3040" });
  });

  it("rejects scanned PDFs before any LLM call but records the conversion", async () => {
    const { ai, calls } = fakeAi([good], {
      format: "markdown",
      tokens: 12,
      data: "# receipt.pdf\n## Metadata\n- PDFFormatVersion=1.7\n## Contents\n### Page 1\n",
    });
    const r = await extractReceipt(ai, pdf, ctx);
    expect(!r.ok && r.code).toBe("unsupported_scanned_pdf");
    expect(calls).toHaveLength(0);
    expect(r.calls).toEqual([
      expect.objectContaining({ kind: "to_markdown", model: "toMarkdown", promptTokens: 12, neuronsEst: 0, outcome: "ok" }),
    ]);
  });

  it("sends PDF text inside receipt markers", async () => {
    const { ai, calls } = fakeAi([good], { format: "markdown", data: "### Page 1\nGrab ride 01/11/2026 Total SGD 18.40" });
    const r = await extractReceipt(ai, pdf, ctx);
    expect(r.ok).toBe(true);
    const user = (calls[0]!.messages as { content: string }[])[1]!.content;
    expect(user).toContain("<<<RECEIPT\n### Page 1\nGrab ride");
    expect(calls[0]!.image).toBeUndefined();
    expect(r.calls.map((c) => [c.kind, c.inputMode])).toEqual([
      ["to_markdown", "pdf_text"],
      ["extract", "pdf_text"],
    ]);
  });

  it("reports PDF conversion errors", async () => {
    const { ai } = fakeAi([good], { format: "error", error: "corrupt" });
    const r = await extractReceipt(ai, pdf, ctx);
    expect(!r.ok && r.code).toBe("pdf_conversion_failed");
    expect(r.calls[0]).toMatchObject({ kind: "to_markdown", outcome: "ai_error", errorCode: "pdf_conversion_failed" });
  });
});

describe("hasReceiptText", () => {
  it("ignores headings and the metadata block", () => {
    expect(hasReceiptText("# a.pdf\n## Metadata\n- Producer=Scanner 3000\n- Pages=1\n## Contents\n### Page 1\n")).toBe(false);
    expect(hasReceiptText("## Contents\n### Page 1\nTOTAL 12.30 SGD")).toBe(true);
  });
});
