import { currencyExponent } from "../../../worker/src/agent/money";

/** Keep exact cents even near MAX_SAFE_INTEGER; division as Number would round them. */
export function formatMoney(minor: number | bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const factor = 10n ** BigInt(exponent);
  const whole = (absolute / factor).toLocaleString("en-SG");
  const fraction = exponent ? `.${(absolute % factor).toString().padStart(exponent, "0")}` : "";
  return `${currency} ${value < 0n ? "-" : ""}${whole}${fraction}`;
}

export function monthRange(month: string) {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { from: `${month}-01`, to: last.toISOString().slice(0, 10) };
}

export function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function localMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export type RangePreset = "month" | "1m" | "3m" | "1y" | "custom";

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Shift a YYYY-MM-DD date by whole months, clamping to the target month's last day (May 31 − 3 → Feb 28). */
export function shiftDate(day: string, months: number) {
  const target = shiftMonth(day.slice(0, 7), months);
  const last = Number(monthRange(target).to.slice(8));
  return `${target}-${String(Math.min(Number(day.slice(8)), last)).padStart(2, "0")}`;
}

/** Rolling ranges ending today. "1y" starts on the 1st, 11 months back: the API accepts at most 12 calendar months. */
export function presetRange(preset: "1m" | "3m" | "1y", today: string) {
  if (preset === "1y") return { from: `${shiftMonth(today.slice(0, 7), -11)}-01`, to: today };
  return { from: shiftDate(today, preset === "1m" ? -1 : -3), to: today };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (day: string, year: boolean) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8))}${year ? `, ${day.slice(0, 4)}` : ""}`;

/** "Oct 19 – Nov 19, 2026"; the year shows on both ends only when they differ. */
export function rangeLabel(from: string, to: string) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return from === to ? dayLabel(from, true) : `${dayLabel(from, !sameYear)} – ${dayLabel(to, true)}`;
}

export function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" });
}
