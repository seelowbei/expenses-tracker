// Amounts are stored as integer minor units using the currency's ISO 4217 exponent.
const EXPONENT_OVERRIDES: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, PYG: 0, XAF: 0, XOF: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
};

export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

export function currencyExponent(code: string): number {
  if (!isCurrencyCode(code)) throw new RangeError(`Invalid currency code: ${code}`);
  const override = EXPONENT_OVERRIDES[code];
  if (override !== undefined) return override;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function toMinor(amount: number, currency: string): number {
  const exp = currencyExponent(currency);
  // toFixed first avoids float artefacts like 1.005 * 100 = 100.49999.
  return Math.round(Number((amount * 10 ** exp).toFixed(6)));
}
