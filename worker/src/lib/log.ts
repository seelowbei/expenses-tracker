// Structured logs. Only ids, statuses and error codes: never OCR text, amounts, emails or tokens.
type Safe = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, Safe>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
