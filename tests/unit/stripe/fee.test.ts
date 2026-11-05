import { describe, expect, it } from "vitest";
import { applicationFeeMinor } from "@/lib/stripe/fee";

describe("applicationFeeMinor (round half up, minor units)", () => {
  it.each([
    [200000, 100, 2000],  // £2,000 at 1% = £20
    [12345, 100, 123],    // 123.45 -> 123
    [12350, 100, 124],    // 123.5 -> 124 (half up)
    [1, 100, 0],
    [50, 100, 1],         // 0.5 -> 1
    [99999, 0, 0],
    [100000, 1000, 10000],
  ])("%i at %i bps is %i", (gross, bps, fee) => expect(applicationFeeMinor(gross, bps)).toBe(fee));
  it.each([[-1, 100], [100, -1], [100, 1001], [1.5, 100]])("refuses gross %s / bps %s", (g, b) => {
    expect(() => applicationFeeMinor(g, b)).toThrow();
  });
});
