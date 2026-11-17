import { currencyExponent } from "../../../worker/src/agent/money";

/** Keep exact cents even near MAX_SAFE_INTEGER; division as Number would round them. */
export function formatMoney(minor: number, currency: string): string {
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
