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
// NO FLOAT EVER TOUCHES THE MINOR-UNITS VALUE, IN EITHER DIRECTION
// ===========================================================================
// `parseGbpDetailed` assembles the pence as a STRING (integer part followed by
// the two-digit fraction) rather than multiplying by 100, so "0.29" can never
// arrive as 28.999999999999996. `minorToPoundsInput` is its inverse and does
// the same thing in reverse -- string slicing, never a division -- so a large
// stored amount cannot pick up rounding error on its way back into the edit
// form.
//
// ===========================================================================
// ONE PARSER. THERE USED TO BE THREE (review finding I2)
// ===========================================================================
// Until the post-review fix this file's parser was DEAD -- its only caller was
// its own test -- while every real write went through a deliberately parallel
// `parsePounds` in lib/crm/finance.ts that no unit test touched, and a third
// converter, `minorToPoundsInput`, lived module-private inside components/crm/
// finance-panel.tsx and rendered every stored amount back into the edit form
// untested. Three implementations of one boundary, two of them unguarded, on
// the product's money column. The argument written here for the duplication
// ("both reject the same set") was exactly the property nothing checked.
//
// Now: ONE regex, ONE ceiling, ONE assembly, in `parseGbpDetailed` below.
// lib/crm/finance.ts's `parsePounds` is a thin wrapper that maps this
// function's failure REASON to the sentence the form shows -- it must stay
// module-private there, because every export of a `"use server"` module is a
// server action, so the mapping is what lives there and the parsing does not.
// components/crm/finance-panel.tsx imports `minorToPoundsInput` from here.
// tests/unit/format/money.test.ts pins all three surfaces, and
// tests/unit/crm/source-shape.test.ts asserts there is no second regex or
// second ceiling left in lib/crm/finance.ts -- a behavioural test cannot see a
// re-introduced copy that happens to agree today.

/**
 * The largest amount, in pence, that round-trips as an exact JS number.
 *
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991). Above it a JS number is no
 * longer an exact integer, and finance reads amount_minor back as a `Number`
 * (lib/crm/finance-list.ts), so a value that could not round-trip is rejected
 * here rather than silently corrupted. The database floor is the CHECK
 * `amount_minor >= 0`; the same ceiling is enforced server-side in finance.ts.
 */
export const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * The ONE pattern a pounds input has to match: digits, optionally a decimal
 * point and one or two more digits. No sign (so a negative is rejected by
 * construction rather than by a comparison), no exponent, no third decimal.
 *
 * Exported for nothing -- it is module-private on purpose, because a second
 * copy of it somewhere else is the defect this consolidation removed.
 */
const POUNDS = /^\d+(\.\d{1,2})?$/;

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
  const parsed = parseGbpDetailed(input);
  return parsed.ok ? parsed.minor : null;
}

/**
 * Why a pounds input was rejected. Three reasons, because the form needs to
 * say three different things and `null` cannot tell them apart:
 *
 *   `empty`      nothing was typed (or the field was absent altogether).
 *   `malformed`  not a plain non-negative decimal with at most two fractional
 *                digits -- a minus sign, a third decimal, `1e9`, letters.
 *   `too-large`  a well-formed amount past MAX_AMOUNT_MINOR once in pence.
 */
export type GbpParseFailure = "empty" | "malformed" | "too-large";

/**
 * THE PARSER. A pounds-and-pence text input -> minor units, or the reason it
 * is not a plain non-negative amount.
 *
 * `parseGbpToMinor` above is the `number | null` face of this for callers that
 * only need the value; `parsePounds` in lib/crm/finance.ts is the face that
 * turns a `GbpParseFailure` into the sentence the finance form shows. Both go
 * through here, so there is one regex, one ceiling and one string assembly in
 * the product.
 *
 * Strips a leading £, thousands commas and surrounding whitespace, then
 * requires POUNDS. Never throws and never clamps: a caller renders a message
 * rather than storing a guess.
 *
 *   ""            -> empty
 *   "-5"          -> malformed   (negative; the pattern has no sign)
 *   "£1.005"      -> malformed   (more than two decimal places)
 *   "1e9"         -> malformed   (not a plain decimal)
 *   "£1,234.56"   -> 123456
 *   "1,234.5"     -> 123450
 *   "500"         -> 50000
 *   "90071992547409.92" -> too-large (over MAX_AMOUNT_MINOR once in pence)
 */
export function parseGbpDetailed(
  input: string | null,
):
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly reason: GbpParseFailure } {
  if (input === null) return { ok: false, reason: "empty" };
  const cleaned = input.replace(/[£,\s]/g, "");
  if (cleaned === "") return { ok: false, reason: "empty" };
  if (!POUNDS.test(cleaned)) return { ok: false, reason: "malformed" };
  const [intPart, fracPart = ""] = cleaned.split(".");
  const frac = (fracPart + "00").slice(0, 2);
  // Digits of the minor-units value; leading zeros trimmed but never to empty.
  const minorDigits = (intPart + frac).replace(/^0+(?=\d)/, "");
  const minor = Number(minorDigits);
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, minor };
}

/**
 * Minor units -> the plain pounds string an edit form's text input shows:
 * `123456` -> `"1234.56"`, `7` -> `"0.07"`.
 *
 * THE INVERSE OF `parseGbpDetailed`, and the round trip is pinned in
 * tests/unit/format/money.test.ts in both directions. Integer pence to a
 * decimal string by SLICING, never by dividing by 100 -- so a large stored
 * amount cannot come back with a rounding error in the box the user is about
 * to save again. No £ and no thousands commas: this is an `<input value>`, not
 * a rendered figure (that is `formatGbp`), and the parser accepts either.
 *
 * Lives here rather than beside its one caller because it is half of this
 * file's boundary; it was module-private in components/crm/finance-panel.tsx
 * and therefore untestable until review finding I2.
 */
export function minorToPoundsInput(minor: number): string {
  const digits = String(minor);
  if (digits.length <= 2) return `0.${digits.padStart(2, "0")}`;
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
