import { z } from "zod";
import { Extraction } from "../agent/schema";

// Intl's currency inventory rejects syntactically valid placeholders such as XXX/ZZZ.
export const supportedCurrencies = Intl.supportedValuesOf("currency").filter((code) => code !== "XXX");
export const HumanCurrency = z.string().refine((code) => supportedCurrencies.includes(code));
const minor = z.number().int().safe().nonnegative();
export const LedgerFields = z.object({
  merchant: Extraction.shape.merchant.trim().min(1),
  txn_date: Extraction.shape.txn_date.pipe(z.iso.date()),
  txn_time: Extraction.shape.txn_time,
  currency: HumanCurrency,
  total_minor: minor,
  tax_minor: minor.nullable(),
  category_id: z.string().min(1).max(120),
  payment_method: Extraction.shape.payment_method,
  line_items: z.array(z.object({ description: z.string().trim().min(1).max(200), amount_minor: z.number().int().safe() }).strict()).max(50).nullable(),
  notes: z.string().trim().max(2000).transform((s) => s || null).nullable(),
}).strict();
export const LedgerDelete = z.strictObject({
  expected_updated_at: z.iso.datetime({ precision: 3 }),
});
export const LedgerPatch = LedgerFields.partial().extend({
  ...LedgerDelete.shape,
  confirm_review: z.literal(true).optional(),
  confirm_currency: z.literal(true).optional(),
}).strict().refine((v) => v.confirm_review || Object.keys(LedgerFields.shape).some((key) => key in v));
export type LedgerPatch = z.infer<typeof LedgerPatch>;
