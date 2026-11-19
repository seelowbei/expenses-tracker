import { currencyExponent } from "../agent/money";

/** Exact decimal text for integer minor units ("1234" SGD → "12.34"); no grouping, so spreadsheets parse it. */
export function decimalAmount(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const factor = 10n ** BigInt(exponent);
  const fraction = exponent ? `.${(absolute % factor).toString().padStart(exponent, "0")}` : "";
  return `${value < 0n ? "-" : ""}${absolute / factor}${fraction}`;
}

/**
 * RFC 4180 cell. Free text (merchant, notes, receipt-derived values) is untrusted: a leading
 * =, +, -, @, tab or CR would run as a formula in Excel/Sheets, so it gets a ' prefix.
 * Numbers we format ourselves pass through as `trusted` so negative amounts stay numeric.
 */
export function csvCell(value: string | null, trusted = false): string {
  if (value === null) return "";
  const safe = !trusted && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvRow(cells: string[]): string {
  return `${cells.join(",")}\r\n`;
}
