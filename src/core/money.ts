/** Money helpers. Amounts are integers in minor units (kopecks, cents...). */

export const CURRENCY_SYMBOLS = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
  KZT: "₸",
  UZS: "сум",
  UAH: "₴",
  BYN: "Br",
  TRY: "₺",
  GEL: "₾",
} as const;

export type Currency = keyof typeof CURRENCY_SYMBOLS;

export const CURRENCIES = Object.keys(CURRENCY_SYMBOLS) as Currency[];

export function isCurrency(value: string): value is Currency {
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, value);
}

export function currencySymbol(currency: string): string {
  return isCurrency(currency) ? CURRENCY_SYMBOLS[currency] : currency;
}

/** Russian style: 150050 -> "1 500,50 ₽", 150000 -> "1 500 ₽", -5 -> "-0,05 ₽". */
export function formatMoney(amount: number, currency: string = "RUB"): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(amount));
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  const majorStr = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const number = minor ? `${majorStr},${String(minor).padStart(2, "0")}` : majorStr;
  return `${sign}${number} ${currencySymbol(currency)}`;
}
