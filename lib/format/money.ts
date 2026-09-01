// Money, formatted and parsed once, in minor units. Q66.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHY IT IS NOT `lib/format/date.ts`'s SIBLING BY
// ACCIDENT
// ===========================================================================
// `financial_entries.amount_minor` is a `bigint` of PENCE (20260903000000
// note 5). The database stores minor units; the UI shows pounds. This is the
// one boundary that conversion happens at, so it happens in one place -- the
// same argument lib/format/date.ts makes for its UTC<->London pinning, and for
// the same failure mode (a drifted copy renders money wrong with nothing to
// catch it).
//
// PURE, and safe in a Server Component, a Client Component and a vitest file
// alike -- it touches nothing but its string/number arguments.
//
// ===========================================================================
// NO FLOAT EVER TOUCHES THE MINOR-UNITS VALUE ON THE WAY IN
// ===========================================================================
// `parseGbpToMinor` assembles the pence as a STRING (integer part followed by
// the two-digit fraction) rather than multiplying by 100, so "0.29" can never
// arrive as 28.999999999999996. This mirrors `parsePounds` in lib/crm/finance.ts
// clause for clause -- deliberately a parallel implementation rather than a
// shared one, because that parser lives in a `"use server"` module and returns
// a FieldProblem message for the form, while this one is the pure, importable,
// round-trip-tested surface the brief names. Both reject the same set (negatives,
// more than two decimal places, values past Number.MAX_SAFE_INTEGER pence);
// tests/unit/format/money.test.ts pins this one, and finance.ts's own parser is
// pinned where its action is tested.

/**
 * The largest amount, in pence, that round-trips as an exact JS number.
 *
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991). Above it a JS number is no
 * longer an exact integer, and finance reads amount_minor back as a `Number`
 * (lib/crm/finance-list.ts), so a value that could not round-trip is rejected
 * here rather than silently corrupted. The database floor is the CHECK
 * `amount_minor >= 0`; the same ceiling is enforced server-side in finance.ts.
 */
const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
});

/**
 * Minor units (pence) -> a GBP string: `123456` -> `"£1,234.56"`.
 *
 * The output is TABULAR-NUMS-FRIENDLY -- it is digits, a grouping comma and a
 * decimal point, no letters that would break alignment down a money column, so
 * a cell with `font-variant-numeric: tabular-nums` lines up decimals. The `£`
 * and the two decimal places come from `Intl.NumberFormat('en-GB', GBP)`.
 *
 * `amountMinor` is divided by 100 for the formatter, which is a float step --
 * but only for DISPLAY, and only on a value already capped at MAX_AMOUNT_MINOR
 * on the way in, so the quotient stays a value the formatter rounds to two
 * places exactly. Nothing derived from this string is ever stored.
 */
export function formatGbp(amountMinor: number): string {
  return GBP.format(amountMinor / 100);
}

/**
 * A pounds-and-pence text input -> minor units, or `null` when it is not a
 * plain non-negative amount.
 *
 * Strips a leading £, thousands commas and surrounding whitespace, then
 * requires digits with at most two decimal places and no sign. Returns `null`
 * (not a thrown error and not a clamped value) for anything else, so a caller
 * renders a message rather than storing a guess.
 *
 *   ""            -> null   (empty)
 *   "-5"          -> null   (negative; the pattern has no sign)
 *   "£1.005"      -> null   (more than two decimal places)
 *   "1e9"         -> null   (not a plain decimal)
 *   "£1,234.56"   -> 123456
 *   "1,234.5"     -> 123450
 *   "500"         -> 50000
 *   "90071992547409.92" -> null (over MAX_AMOUNT_MINOR once in pence)
 */
export function parseGbpToMinor(input: string): number | null {
  const cleaned = input.replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [intPart, fracPart = ""] = cleaned.split(".");
  const frac = (fracPart + "00").slice(0, 2);
  // Digits of the minor-units value; leading zeros trimmed but never to empty.
  const minorDigits = (intPart + frac).replace(/^0+(?=\d)/, "");
  const minor = Number(minorDigits);
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) return null;
  return minor;
}
