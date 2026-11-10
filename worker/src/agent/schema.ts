import { z } from "zod";

export const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Output schema from the spec ("Extraction agent → Output schema"). Do not loosen without updating the spec.
export const Extraction = z.object({
  merchant: z.string().min(1).max(120),
  txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  txn_time: z.string().regex(TIME_HHMM).nullable(), // HH:MM 24-hour, local as printed
  currency: z.string().length(3),
  total: z.number().nonnegative(),
  total_text: z.string().max(200).nullable(), // line the total was read from, as printed; checked in code
  tax: z.number().nonnegative().nullable(),
  payment_method: z.enum(["cash", "card", "ewallet", "bank_transfer", "other"]).nullable(),
  line_items: z.array(z.object({ description: z.string(), amount: z.number() })).max(50),
  category_slug: z.string(),
  confidence: z.number().min(0).max(1),
});

export type Extraction = z.infer<typeof Extraction>;

// Shown to the model in the prompt. Keep in step with `Extraction`.
export const EXTRACTION_SHAPE = `{
  "merchant": string,                 // 1-120 chars
  "txn_date": string,                 // transaction date exactly as printed
  "txn_time": "HH:MM" | null,         // 24-hour transaction time as printed
  "currency": "ISO 4217 code",
  "total": number,
  "total_text": string | null,        // the line you read total from, copied exactly as printed
  "tax": number | null,
  "payment_method": "cash" | "card" | "ewallet" | "bank_transfer" | "other" | null,
  "line_items": [{ "description": string, "amount": number }],   // max 50, [] if none
  "category_slug": string,
  "confidence": number                // 0..1
}`;
