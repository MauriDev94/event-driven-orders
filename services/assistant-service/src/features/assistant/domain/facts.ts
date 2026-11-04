/**
 * The checkable facts of a text besides order and event IDs: amounts and
 * catalog SKUs. Grounding compares the ones in the model's answer with the
 * ones the tools returned.
 *
 * Only these two kinds are checked. Plain integers are left alone because
 * they are mostly counts and quantities ("3 pedidos"), and dates and times
 * would need a parser of their own; flagging them would replace good answers.
 */

// An amount is a number with one or two decimals (25.50, 25,5, 1.250,00) or
// a number after a dollar sign ($20, $1.250, $ 1,250.00). Dates (2026-11-01)
// and times (10:30) never match: they use other separators.
const AMOUNT =
  /\$\s?\d(?:[\d.,]*\d)?|(?<![\d.,])\d{1,3}(?:[.,]\d{3})+[.,]\d{1,2}(?![\d.,]*\d)|(?<![\d.,])\d+[.,]\d{1,2}(?![\d.,]*\d)/g;

// Catalog product IDs (SKU-001). Other product IDs aren't recognizable in
// free text, so they aren't checked.
const SKU = /\bSKU-[A-Za-z0-9._-]*[A-Za-z0-9]/gi;

// A plain decimal as the tools return it ("25.50", or a number).
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** An amount in cents, so 20, 20.0 and 20.00 are the same. */
function cents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Reads an amount written by hand. When it ends in a separator followed by
 * one or two digits, that separator is the decimal point; every other
 * separator groups thousands ($1.250 is one thousand two hundred fifty).
 */
function amountOf(written: string): number {
  const digits = written.replace(/^\$\s?/, '');
  const decimal = /[.,](\d{1,2})$/.exec(digits);
  const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(
    /[.,]/g,
    '',
  );
  return cents(Number(`${whole}.${decimal?.[1] ?? '0'}`));
}

/** The amounts written in a text, in cents. */
export function amountsIn(text: string): Set<number> {
  return new Set([...text.matchAll(AMOUNT)].map(([found]) => amountOf(found)));
}

/** The catalog SKUs written in a text, upper-cased. */
export function skusIn(text: string): Set<string> {
  return new Set([...text.matchAll(SKU)].map(([sku]) => sku.toUpperCase()));
}

/** The amount a tool returned, in cents, if the value is a number. */
export function amountReturned(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return cents(value);
  if (typeof value === 'string' && PLAIN_DECIMAL.test(value)) {
    return cents(Number(value));
  }
  return undefined;
}
