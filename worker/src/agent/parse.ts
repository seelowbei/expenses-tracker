import { Extraction } from "./schema";

/** Fields that passed their own schema in a reply that failed as a whole (unvalidated together). */
export type PartialExtraction = Partial<Extraction>;

export type ParseResult =
  | { ok: true; value: Extraction }
  | { ok: false; errors: string[]; partial: PartialExtraction };

/** Keeps each normalised field that passes its own field schema; used to pre-fill review after invalid output. */
export function partialFields(normalized: unknown): PartialExtraction {
  if (!normalized || typeof normalized !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(Extraction.shape)) {
    if (!(key in normalized)) continue;
    const r = field.safeParse((normalized as Record<string, unknown>)[key]);
    if (r.success) out[key] = r.data;
  }
  return out as PartialExtraction;
}

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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PRINTED_TIME = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?)?/gi;
const pad2 = (n: number) => String(n).padStart(2, "0");
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : y.length === 4 ? Number(y) : NaN);

function ymd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Converts a date copied as printed to YYYY-MM-DD; the model only copies, because it reorders
 * day/month unreliably. All-number dates are day-first per the spec ("prefer DD/MM") unless the
 * second number can only be a day (11/25/2026), or year-first when they start with 4 digits.
 * Month names ("Sep-03-2026", "October 27, 2026", "12 Oct 26") set the month; a 2-digit year
 * is 20YY. Compact stamps are DDMMYY, YYYYMMDD or DDMMYYYY, alone or before POS codes. Weekdays and times are ignored. Anything else is returned as is for the schema to reject.
 */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  const tokens = s.replace(PRINTED_TIME, " ").toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const nums = tokens.filter((t) => /^\d+$/.test(t));
  const monthIdx = tokens
    .filter((t) => /^[a-z]{3,}$/.test(t))
    .map((t) => MONTHS.indexOf(t.slice(0, 3)))
    .find((i) => i !== -1);

  // A separated all-number date anywhere wins, so trailing POS codes ("07/07/26 8889 SC021") or
  // words that look like months ("Marina") don't matter.
  const separated = s.match(/(?<!\d)(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/);
  const allNumbers = separated ? separated.slice(1, 4) : monthIdx === undefined && nums.length === 3 ? nums : null;
  let out: string | null = null;
  if (allNumbers) {
    const [a, b, c] = allNumbers as [string, string, string];
    if (a.length === 4) {
      out = ymd(Number(a), Number(b), Number(c));
    } else {
      const [day, month] = Number(b) > 12 && Number(a) <= 12 ? [b, a] : [a, b];
      out = ymd(fullYear(c), Number(month), Number(day));
    }
  } else if (monthIdx !== undefined && nums.length === 2) {
    const yearPos = nums.findIndex((n) => n.length === 4);
    const [day, year] = yearPos === -1 ? [nums[0]!, nums[1]!] : [nums[1 - yearPos]!, nums[yearPos]!];
    out = ymd(fullYear(year), monthIdx + 1, Number(day));
  } else if (monthIdx === undefined && nums.length > 0 && tokens[0] === nums[0] && (nums[0]!.length === 6 || nums[0]!.length === 8)) {
    // Compact POS stamps: DDMMYY ("070726"), YYYYMMDD ("20260707") or DDMMYYYY ("07072026"),
    // alone or first, followed by POS codes ("070726 19221 0204 8889").
    const n = nums[0]!;
    const ymdFirst = n.length === 8 && /^(19|20)/.test(n) && Number(n.slice(4, 6)) <= 12;
    out = ymdFirst
      ? ymd(Number(n.slice(0, 4)), Number(n.slice(4, 6)), Number(n.slice(6)))
      : ymd(fullYear(n.slice(4)), Number(n.slice(2, 4)), Number(n.slice(0, 2)));
  }
  return out ?? s;
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

const PAYMENT_METHODS = ["cash", "card", "ewallet", "bank_transfer", "other"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const PAYMENT_KEYWORDS: [RegExp, PaymentMethod][] = [
  [/apple\s*pay|google\s*pay|samsung\s*pay|grab\s*pay|paylah|shopee\s*pay|wallet/, "ewallet"],
  [/visa|master|amex|american express|credit|debit|nets|card|unionpay|jcb/, "card"],
  [/paynow|transfer|giro|bank/, "bank_transfer"],
  [/cash/, "cash"],
];

/**
 * Maps a printed payment method ("Apple Pay", "VISA2") to the enum. Any other string -> "other":
 * payment method is not scored and must never fail an otherwise good extraction.
 */
export function normalizePaymentMethod(raw: unknown): PaymentMethod | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const s = raw.trim().toLowerCase();
  if ((PAYMENT_METHODS as readonly string[]).includes(s)) return s as PaymentMethod;
  return PAYMENT_KEYWORDS.find(([re]) => re.test(s))?.[1] ?? "other";
}

const NUMERIC =/^-?\d+(\.\d+)?$/;
const toNumber = (v: unknown) => (typeof v === "string" && NUMERIC.test(v.trim()) ? Number(v.trim()) : v);

// Mechanical clean-up only: fill omitted nullable keys, coerce numeric strings, upper-case currency,
// reformat printed dates (spec's day-first rule) and times (24-hour; unreadable -> null),
// map payment methods to the enum (unknown -> "other").
function normalize(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  o.tax = o.tax === undefined ? null : toNumber(o.tax);
  o.payment_method = normalizePaymentMethod(o.payment_method);
  o.line_items ??= [];
  o.total = toNumber(o.total);
  // A check field only: cap it instead of failing the extraction.
  o.total_text = typeof o.total_text === "string" && o.total_text.trim() !== "" ? o.total_text.trim().slice(0, 200) : null;
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
    if (!json) return { ok: false, errors: ["No JSON object found in the reply."], partial: {} };
    try {
      candidate = JSON.parse(json);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`], partial: {} };
    }
  }
  const normalized = normalize(candidate);
  const result = Extraction.safeParse(normalized);
  if (result.success) return { ok: true, value: result.data };
  const rawDate = (normalized as { txn_date?: unknown } | null)?.txn_date;
  return {
    ok: false,
    partial: partialFields(normalized),
    errors: result.error.issues.map((i) => {
      const path = i.path.join(".") || "(root)";
      // Show the unreadable date (capped) so eval runs reveal which printed format to support.
      if (path === "txn_date" && typeof rawDate === "string") return `txn_date: unreadable date ${JSON.stringify(rawDate.slice(0, 32))}`;
      return `${path}: ${i.message}`;
    }),
  };
}
