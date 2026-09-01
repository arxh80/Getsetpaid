import { describe, expect, it } from "vitest";
import { formatGbp, parseGbpToMinor } from "@/lib/format/money";

// The money boundary: minor units (pence) <-> pounds text. Q66.
//
// The round trip is the property that matters -- a value stored as pence, shown
// as pounds, typed back and parsed to pence must be the SAME pence -- so the
// two functions are tested together as well as apart.

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
