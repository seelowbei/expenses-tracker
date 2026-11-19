import { z } from "zod";
import { currencyExponent } from "../agent/money";
import { categoryIdFor } from "../db/categories";
import type { Category } from "../db/schema";
import { LedgerFields } from "./ledger-write";
import type { ReviewDraft } from "./review";

/** Convert the stored JSON number's decimal representation without rounding. */
function exactMinor(value: unknown, currency: string): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const [coefficient, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  let amount = BigInt(whole! + fraction);
  const scale = currencyExponent(currency) + Number(exponent) - fraction.length;
  if (scale >= 0) amount *= 10n ** BigInt(scale);
  else {
    const divisor = 10n ** BigInt(-scale);
    if (amount % divisor !== 0n) return undefined;
    amount /= divisor;
  }
  return amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER) ? undefined : Number(amount);
}

export function reviewDraft(raw: string | null, categories: readonly Category[]): ReviewDraft {
  if (!raw || raw.length > 65536 || new TextEncoder().encode(raw).length > 65536) return {};
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return {}; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
  const input = decoded as Record<string, unknown>;
  const output: ReviewDraft = {};
  const field = <K extends keyof ReviewDraft>(key: K, value: unknown) => {
    const parsed = LedgerFields.shape[key].safeParse(value);
    // Each schema is selected by the same key; TS cannot retain that correlation through safeParse.
    if (parsed.success) Object.assign(output, { [key]: parsed.data });
  };
  for (const key of ["merchant", "txn_date", "txn_time", "currency", "payment_method"] as const) field(key, input[key]);
  if (typeof input.category_slug === "string") {
    const id = categoryIdFor(categories, input.category_slug);
    if (id) field("category_id", id);
  }
  if (output.currency) {
    field("total_minor", exactMinor(input.total, output.currency));
    field("tax_minor", input.tax === null ? null : exactMinor(input.tax, output.currency));
    const items = z.array(z.object({ description: z.string(), amount: z.number() })).max(50).safeParse(input.line_items);
    if (items.success) field("line_items", items.data.map((item) => ({ description: item.description, amount_minor: exactMinor(item.amount, output.currency!) })));
  }
  return output;
}
