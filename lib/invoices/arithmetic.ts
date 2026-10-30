// Line and VAT arithmetic for invoices -- the TypeScript port of
// private.invoice_line_amounts() (20261107000000). The DATABASE is the source
// of the numbers on an invoice; this port exists for the editor's live
// preview, and tests/unit/invoices/arithmetic-cases.ts holds both to one case
// table. Exact integer arithmetic throughout (BigInt), never floats.
//
// Rule (spec § Arithmetic): net = round_half_up(quantity × unit_price_minor),
// vat = round_half_up(net × rate). Every value here is non-negative, so
// "half up" and Postgres's round(numeric) (half away from zero) agree.

export const VAT_RATES = ["standard_20", "reduced_5", "zero", "exempt", "none"] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const VAT_RATE_LABELS: Record<VatRate, string> = {
  standard_20: "20% (standard)",
  reduced_5: "5% (reduced)",
  zero: "0% (zero-rated)",
  exempt: "Exempt",
  none: "No VAT",
};

const BASIS_POINTS: Record<VatRate, bigint> = {
  standard_20: 2000n,
  reduced_5: 500n,
  zero: 0n,
  exempt: 0n,
  none: 0n,
};

export function isVatRate(value: unknown): value is VatRate {
  return typeof value === "string" && (VAT_RATES as readonly string[]).includes(value);
}

/** A positive quantity with at most two decimals and ten integer digits
 *  (the column is numeric(12,2)), as hundredths; null otherwise. */
export function parseQuantity(raw: string): bigint | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const hundredths = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return hundredths > 0n ? hundredths : null;
}

export function formatQuantity(hundredths: bigint): string {
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}`;
}

/** round_half_up(n / d) for n >= 0, d > 0. */
function divideHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export interface LineAmounts {
  netMinor: number;
  vatMinor: number;
}

export function lineAmounts(quantityHundredths: bigint, unitPriceMinor: number, rate: VatRate): LineAmounts {
  const net = divideHalfUp(quantityHundredths * BigInt(unitPriceMinor), 100n);
  const vat = divideHalfUp(net * BASIS_POINTS[rate], 10000n);
  if (net + vat > MAX_SAFE) throw new RangeError("invoice line amount is too large");
  return { netMinor: Number(net), vatMinor: Number(vat) };
}

export function invoiceTotals(lines: readonly LineAmounts[]): {
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
} {
  let net = 0;
  let vat = 0;
  for (const line of lines) {
    net += line.netMinor;
    vat += line.vatMinor;
  }
  return { netMinor: net, vatMinor: vat, grossMinor: net + vat };
}

/** prefix + the sequence number, zero-padded to four digits below 10 000 and
 *  printed in full from there -- lpad() would truncate (decision 11). The SQL
 *  twin is private.format_invoice_number(). */
export function formatInvoiceNumber(prefix: string, n: number): string {
  return prefix + (n < 10000 ? String(n).padStart(4, "0") : String(n));
}
