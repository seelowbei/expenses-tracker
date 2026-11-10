import { Extraction } from "./schema";

export type ParseResult =
  | { ok: true; value: Extraction }
  | { ok: false; errors: string[] };

// Pulls the first top-level JSON object out of a model reply (handles ``` fences and stray prose).
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const pad2 = (n: string) => n.padStart(2, "0");

/**
 * Converts printed dates to YYYY-MM-DD. Day-first per the spec ("prefer DD/MM"), unless the
 * second number can only be a day (e.g. 11/25/2026). Leaves anything else for the schema to reject.
 */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  const ymd = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${pad2(ymd[2]!)}-${pad2(ymd[3]!)}`;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!dmy) return s;
  const [, a, b, year] = dmy as unknown as [string, string, string, string];
  const [day, month] = Number(b) > 12 && Number(a) <= 12 ? [b, a] : [a, b];
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Converts a printed time to 24-hour HH:MM ("6:19 PM" -> "18:19", "18:19:42" -> "18:19").
 * Returns null when it can't be read: time is optional and must never fail an extraction.
 */
export function normalizeTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[4];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const toNumber = (v: unknown) => (typeof v === "string" && NUMERIC.test(v.trim()) ? Number(v.trim()) : v);

// Mechanical clean-up only: fill omitted nullable keys, coerce numeric strings, upper-case currency,
// reformat printed dates (spec's day-first rule) and times (24-hour; unreadable -> null).
function normalize(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  o.tax = o.tax === undefined ? null : toNumber(o.tax);
  o.payment_method ??= null;
  o.line_items ??= [];
  o.total = toNumber(o.total);
  o.confidence = toNumber(o.confidence);
  if (typeof o.currency === "string") o.currency = o.currency.trim().toUpperCase();
  if (typeof o.txn_date === "string") o.txn_date = normalizeDate(o.txn_date);
  o.txn_time = normalizeTime(o.txn_time);
  if (typeof o.merchant === "string") o.merchant = o.merchant.trim();
  if (Array.isArray(o.line_items)) {
    o.line_items = o.line_items.map((li) =>
      typeof li === "object" && li !== null ? { ...li, amount: toNumber((li as { amount?: unknown }).amount) } : li,
    );
  }
  return o;
}

export function parseExtraction(reply: unknown): ParseResult {
  // Some Workers AI models return already-parsed JSON in `response`.
  let candidate: unknown = reply;
  if (typeof reply === "string") {
    const json = extractJsonObject(reply);
    if (!json) return { ok: false, errors: ["No JSON object found in the reply."] };
    try {
      candidate = JSON.parse(json);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
    }
  }
  const result = Extraction.safeParse(normalize(candidate));
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
