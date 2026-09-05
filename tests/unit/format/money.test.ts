import { describe, expect, it } from "vitest";
import {
  formatGbp,
  minorToPoundsInput,
  parseGbpDetailed,
  parseGbpToMinor,
} from "@/lib/format/money";

// The money boundary: minor units (pence) <-> pounds text. Q66.
//
// The round trip is the property that matters -- a value stored as pence, shown
// as pounds, typed back and parsed to pence must be the SAME pence -- so the
// functions are tested together as well as apart.
//
// ===========================================================================
// THIS FILE NOW PINS THE PARSER PRODUCTION ACTUALLY RUNS (review finding I2)
// ===========================================================================
// It used to pin `parseGbpToMinor` while every real write went through a
// SECOND, parallel implementation (`parsePounds` in lib/crm/finance.ts) that
// nothing tested, and a THIRD converter (`minorToPoundsInput`) lived
// module-private in components/crm/finance-panel.tsx rendering every stored
// amount back into the edit form. Three implementations of one boundary on the
// product's money column, two of them unguarded.
//
// There is one parser now -- `parseGbpDetailed` -- and the other two surfaces
// are its faces: `parseGbpToMinor` is the `number | null` one, and
// `parsePounds` maps its failure REASON to a sentence. `parsePounds` cannot be
// imported here (every export of a `"use server"` module is a server action),
// so what covers it is `parseGbpDetailed` below plus the source-shape
// assertion in tests/unit/crm/source-shape.test.ts that no second regex or
// ceiling has grown back in lib/crm/finance.ts.

describe("formatGbp -- minor units to a GBP string", () => {
  it("renders pence as pounds with the symbol, grouping and two places", () => {
    expect(formatGbp(123456)).toBe("£1,234.56");
    expect(formatGbp(50000)).toBe("£500.00");
    expect(formatGbp(29)).toBe("£0.29");
    expect(formatGbp(0)).toBe("£0.00");
  });

  it("shows a negative net (gross - expense can be a deficit) with a minus", () => {
    expect(formatGbp(-50000)).toBe("-£500.00");
  });
});

describe("parseGbpToMinor -- pounds text to minor units", () => {
  it("parses plain, symboled, grouped and short-fraction input", () => {
    expect(parseGbpToMinor("1234.56")).toBe(123456);
    expect(parseGbpToMinor("£1,234.56")).toBe(123456);
    expect(parseGbpToMinor("1,234.5")).toBe(123450);
    expect(parseGbpToMinor("500")).toBe(50000);
    expect(parseGbpToMinor("£500")).toBe(50000);
    expect(parseGbpToMinor("0.29")).toBe(29);
  });

  it("rejects negatives -- a cost and an income are told apart by category", () => {
    expect(parseGbpToMinor("-5")).toBeNull();
    expect(parseGbpToMinor("-£5.00")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(parseGbpToMinor("£1.005")).toBeNull();
    expect(parseGbpToMinor("1.999")).toBeNull();
  });

  it("rejects things that are not a plain decimal", () => {
    expect(parseGbpToMinor("")).toBeNull();
    expect(parseGbpToMinor("1e9")).toBeNull();
    expect(parseGbpToMinor("abc")).toBeNull();
    expect(parseGbpToMinor("£")).toBeNull();
  });

  it("rejects a value past Number.MAX_SAFE_INTEGER pence", () => {
    // 90071992547409.92 -> 9007199254740992 pence = MAX_SAFE_INTEGER + 1.
    expect(parseGbpToMinor("90071992547409.92")).toBeNull();
  });

  it("assembles minor units by string math, so no float can creep in", () => {
    // 0.29 * 100 in float is 28.999999999999996; the string path gives 29.
    expect(parseGbpToMinor("0.29")).toBe(29);
    expect(parseGbpToMinor("0.07")).toBe(7);
  });
});

describe("the round trip -- pence -> pounds -> pence is identity", () => {
  for (const minor of [0, 29, 7, 50000, 123456, 100, 999999999]) {
    it(`${minor} survives formatGbp then parseGbpToMinor`, () => {
      expect(parseGbpToMinor(formatGbp(minor))).toBe(minor);
    });
  }
});

// ===========================================================================
// parseGbpDetailed -- THE PARSER EVERY FINANCE WRITE GOES THROUGH
// ===========================================================================
// The same table of inputs as parseGbpToMinor above, asserted at the level the
// finance form needs: WHICH failure, not just that there was one. That
// distinction is the whole reason lib/crm/finance.ts once carried a second
// implementation -- it needed three different sentences and `null` gives one.
describe("parseGbpDetailed -- the reason, not just the refusal", () => {
  it("accepts the same set parseGbpToMinor accepts, with the value", () => {
    expect(parseGbpDetailed("1234.56")).toEqual({ ok: true, minor: 123456 });
    expect(parseGbpDetailed("£1,234.56")).toEqual({ ok: true, minor: 123456 });
    expect(parseGbpDetailed("1,234.5")).toEqual({ ok: true, minor: 123450 });
    expect(parseGbpDetailed("500")).toEqual({ ok: true, minor: 50000 });
    expect(parseGbpDetailed("£500")).toEqual({ ok: true, minor: 50000 });
    expect(parseGbpDetailed(" £1,000.00 ")).toEqual({ ok: true, minor: 100000 });
    expect(parseGbpDetailed("0")).toEqual({ ok: true, minor: 0 });
    expect(parseGbpDetailed("0.00")).toEqual({ ok: true, minor: 0 });
  });

  it("PENCE ROUNDING: a one-digit fraction is tenths, not hundredths", () => {
    // "1.5" is £1.50 = 150p, NOT 15p. Getting this backwards is a silent
    // ten-fold error on every amount a user types without trailing zeros.
    expect(parseGbpDetailed("1.5")).toEqual({ ok: true, minor: 150 });
    expect(parseGbpDetailed("0.5")).toEqual({ ok: true, minor: 50 });
    expect(parseGbpDetailed("0.05")).toEqual({ ok: true, minor: 5 });
    // And no float step: 0.29 * 100 is 28.999999999999996 in IEEE 754.
    expect(parseGbpDetailed("0.29")).toEqual({ ok: true, minor: 29 });
    expect(parseGbpDetailed("0.07")).toEqual({ ok: true, minor: 7 });
    expect(parseGbpDetailed("0.1")).toEqual({ ok: true, minor: 10 });
  });

  it("reports `empty` for nothing typed, and for a bare currency symbol", () => {
    // `null` is the field being absent from the FormData altogether -- what
    // lib/crm/finance.ts's `field()` returns for a missing input.
    expect(parseGbpDetailed(null)).toEqual({ ok: false, reason: "empty" });
    expect(parseGbpDetailed("")).toEqual({ ok: false, reason: "empty" });
    expect(parseGbpDetailed("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseGbpDetailed("£")).toEqual({ ok: false, reason: "empty" });
  });

  it("reports `malformed` for negatives -- category tells a cost from an income", () => {
    expect(parseGbpDetailed("-5")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("-£5.00")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("£-5")).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports `malformed` for more than two decimal places", () => {
    expect(parseGbpDetailed("£1.005")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("1.999")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("1.")).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports `malformed` for garbage and for anything not a plain decimal", () => {
    expect(parseGbpDetailed("1e9")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("abc")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("12abc")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("1.2.3")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("Infinity")).toEqual({ ok: false, reason: "malformed" });
    expect(parseGbpDetailed("+5")).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports `too-large` past MAX_SAFE_INTEGER pence, and NOT one penny below", () => {
    // 90071992547409.91 -> 9007199254740991 = MAX_SAFE_INTEGER exactly, the
    // largest amount that round-trips as a JS number. One penny more is out.
    // The accepted half is the denominator: without it "too-large" would also
    // pass against a parser that rejected every large value.
    expect(parseGbpDetailed("90071992547409.91")).toEqual({
      ok: true,
      minor: Number.MAX_SAFE_INTEGER,
    });
    expect(parseGbpDetailed("90071992547409.92")).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(parseGbpDetailed("900719925474099999")).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("is the one parser: parseGbpToMinor agrees with it on every input above", () => {
    // THE PROPERTY THE OLD DUPLICATION CLAIMED AND NEVER CHECKED. Now trivially
    // true (one is a wrapper over the other), and asserted anyway so a future
    // fork of the two is red rather than merely disagreeing in production.
    const inputs = [
      "1234.56", "£1,234.56", "1,234.5", "500", "£500", "0", "0.00", "1.5",
      "0.29", "0.07", "", "   ", "£", "-5", "-£5.00", "£1.005", "1.999", "1.",
      "1e9", "abc", "12abc", "1.2.3", "+5", "90071992547409.91",
      "90071992547409.92",
    ];
    for (const input of inputs) {
      const detailed = parseGbpDetailed(input);
      expect(parseGbpToMinor(input), `disagreed on ${JSON.stringify(input)}`)
        .toBe(detailed.ok ? detailed.minor : null);
    }
  });
});

// ===========================================================================
// minorToPoundsInput -- WHAT THE EDIT FORM SHOWS
// ===========================================================================
// Untested until review finding I2, while rendering every stored amount back
// into the box the user is about to save again. A wrong value here is a silent
// corruption on the next save, not a visible error.
describe("minorToPoundsInput -- pence to the edit form's text value", () => {
  it("renders whole pounds, pence and the sub-£1 cases", () => {
    expect(minorToPoundsInput(123456)).toBe("1234.56");
    expect(minorToPoundsInput(50000)).toBe("500.00");
    expect(minorToPoundsInput(100)).toBe("1.00");
    expect(minorToPoundsInput(29)).toBe("0.29");
    expect(minorToPoundsInput(7)).toBe("0.07");
    expect(minorToPoundsInput(0)).toBe("0.00");
  });

  it("carries NO symbol and NO grouping -- it is an <input value>, not a figure", () => {
    // formatGbp is the rendered figure and has both; putting either in the
    // input would make the field show something the parser has to strip again.
    expect(minorToPoundsInput(123456)).not.toContain("£");
    expect(minorToPoundsInput(123456)).not.toContain(",");
    expect(formatGbp(123456)).toBe("£1,234.56");
  });

  it("uses string slicing, so a large amount picks up no division error", () => {
    // 9007199254740991 / 100 is 90071992547409.92 in IEEE 754 -- one penny out.
    expect(minorToPoundsInput(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
  });

  for (const minor of [0, 7, 29, 100, 50000, 123456, 999999999, Number.MAX_SAFE_INTEGER]) {
    it(`${minor} survives minorToPoundsInput then parseGbpDetailed`, () => {
      expect(parseGbpDetailed(minorToPoundsInput(minor))).toEqual({
        ok: true,
        minor,
      });
    });
  }
});
