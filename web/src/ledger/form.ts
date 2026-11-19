import type { ReviewCreate, ReviewDraft } from "../../../worker/src/contracts/review";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import { LedgerFields, supportedCurrencies, type LedgerPatch } from "../../../worker/src/contracts/ledger-write";
import { currencyExponent } from "../../../worker/src/agent/money";

export function minorToDecimal(minor: number, currency: string): string {
  const value = BigInt(minor), absolute = value < 0n ? -value : value;
  const exponent = currencyExponent(currency), factor = 10n ** BigInt(exponent);
  return `${value < 0n ? "-" : ""}${absolute / factor}${exponent ? `.${String(absolute % factor).padStart(exponent, "0")}` : ""}`;
}
export function decimalToMinor(input: string, currency: string): number {
  const text = input.trim();
  if (!supportedCurrencies.includes(currency) || text.length > 40 || !/^-?\d+(\.\d+)?$/.test(text)) throw new Error("Enter a decimal amount.");
  const exponent = currencyExponent(currency), [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  if (fraction.length > exponent) throw new Error(`Use at most ${exponent} decimal places for ${currency}.`);
  const amount = BigInt(whole!) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large.");
  return Number(text.startsWith("-") ? -amount : amount);
}
export function entryForm(entry: Partial<Pick<LedgerDetail, keyof ReviewDraft>>) {
  return {
    merchant: entry.merchant ?? "", txn_date: entry.txn_date ?? "", txn_time: entry.txn_time ?? "", currency: entry.currency ?? "",
    total: entry.total_minor == null || !entry.currency ? "" : minorToDecimal(entry.total_minor, entry.currency), tax: entry.tax_minor == null || !entry.currency ? "" : minorToDecimal(entry.tax_minor, entry.currency),
    category_id: entry.category_id ?? "", payment_method: entry.payment_method ?? "", notes: entry.notes ?? "",
    line_items: (entry.currency ? entry.line_items ?? [] : []).map((item) => ({ description: item.description, amount: minorToDecimal(item.amount_minor, entry.currency!) })),
  };
}
export type EntryForm = ReturnType<typeof entryForm>;
export type FormErrors = Record<string, string>;
export function formCreate(form: EntryForm, initialCurrency: string, currencyConfirmed: boolean, keepEmptyItems = false): { body: ReviewCreate; errors?: never } | { errors: FormErrors; body?: never } {
  const errors: FormErrors = {};
  const money = (text: string, field: string) => {
    try { return decimalToMinor(text, form.currency); }
    catch (e) { errors[field] = (e as Error).message; return 0; }
  };
  const currencyChanged = form.currency !== initialCurrency;
  if (currencyChanged && !currencyConfirmed) errors.currency = "Check all amounts in the new currency and confirm below.";
  const values = LedgerFields.safeParse({
    merchant: form.merchant, txn_date: form.txn_date, txn_time: form.txn_time || null, currency: form.currency,
    category_id: form.category_id, total_minor: money(form.total, "total"), tax_minor: form.tax.trim() ? money(form.tax, "tax") : null,
    payment_method: form.payment_method || null, notes: form.notes || null,
    line_items: form.line_items.length || keepEmptyItems ? form.line_items.map((item, i) => ({ description: item.description, amount_minor: money(item.amount, `line_items.${i}.amount`) })) : null,
  });
  if (!values.success) for (const issue of values.error.issues) {
    const path = issue.path.join(".").replace("total_minor", "total").replace("tax_minor", "tax").replace("amount_minor", "amount");
    errors[path] = "Enter a valid value.";
  }
  if (Object.keys(errors).length || !values.success) return { errors };
  return { body: values.data };
}
export function formPatch(form: EntryForm, entry: LedgerDetail, currencyConfirmed: boolean): { patch: LedgerPatch; errors?: never } | { errors: FormErrors; patch?: never } {
  const result = formCreate(form, entry.currency, currencyConfirmed, entry.line_items !== null);
  if (result.errors) return { errors: result.errors };
  const currencyChanged = form.currency !== entry.currency;
  const initial = entryForm(entry);
  const fields = Object.fromEntries(Object.entries(result.body).filter(([key]) => {
    if (currencyChanged && ["total_minor", "tax_minor", "line_items"].includes(key)) return true;
    const field = (key === "total_minor" ? "total" : key === "tax_minor" ? "tax" : key) as keyof EntryForm;
    return JSON.stringify(form[field]) !== JSON.stringify(initial[field]);
  }));
  return { patch: { ...fields, expected_updated_at: entry.updated_at, confirm_review: true, ...(currencyChanged ? { confirm_currency: true } : {}) } };
}
