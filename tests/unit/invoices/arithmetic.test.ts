import { describe, expect, it } from "vitest";
import {
  VAT_RATES,
  formatInvoiceNumber,
  formatQuantity,
  invoiceTotals,
  isVatRate,
  lineAmounts,
  parseQuantity,
} from "@/lib/invoices/arithmetic";
import { ARITHMETIC_CASES } from "./arithmetic-cases";

describe("lineAmounts over the shared case table", () => {
  it.each(ARITHMETIC_CASES)("$quantity × $unitPriceMinor at $rate", (c) => {
    const q = parseQuantity(c.quantity);
    expect(q).not.toBeNull();
    expect(lineAmounts(q as bigint, c.unitPriceMinor, c.rate)).toEqual({
      netMinor: c.netMinor,
      vatMinor: c.vatMinor,
    });
  });

  it("refuses a product past Number.MAX_SAFE_INTEGER rather than rounding it", () => {
    expect(() => lineAmounts(999999999999n, Number.MAX_SAFE_INTEGER, "none")).toThrow(RangeError);
  });
});

describe("parseQuantity / formatQuantity", () => {
  it("reads up to two decimals as hundredths", () => {
    expect(parseQuantity("2.5")).toBe(250n);
    expect(parseQuantity(" 12.34 ")).toBe(1234n);
    expect(parseQuantity("3")).toBe(300n);
  });
  it("refuses zero, negatives, three decimals, more than ten integer digits and junk", () => {
    for (const raw of ["0", "0.00", "-1", "1.005", "12345678901", "1e3", "", "abc", "1,5"]) {
      expect(parseQuantity(raw), raw).toBeNull();
    }
  });
  it("formats hundredths back to two decimals", () => {
    expect(formatQuantity(250n)).toBe("2.50");
    expect(formatQuantity(1n)).toBe("0.01");
  });
});

describe("invoiceTotals", () => {
  it("sums the line values; gross is net plus VAT", () => {
    expect(invoiceTotals([{ netMinor: 300000, vatMinor: 60000 }, { netMinor: 30000, vatMinor: 6000 }]))
      .toEqual({ netMinor: 330000, vatMinor: 66000, grossMinor: 396000 });
    expect(invoiceTotals([])).toEqual({ netMinor: 0, vatMinor: 0, grossMinor: 0 });
  });
});

describe("formatInvoiceNumber", () => {
  it("pads to four digits and never truncates", () => {
    expect(formatInvoiceNumber("INV-", 1)).toBe("INV-0001");
    expect(formatInvoiceNumber("", 42)).toBe("0042");
    expect(formatInvoiceNumber("INV-", 9999)).toBe("INV-9999");
    expect(formatInvoiceNumber("INV-", 12345)).toBe("INV-12345");
  });
});

describe("the VAT vocabulary", () => {
  it("is exactly the five spec rates", () => {
    expect([...VAT_RATES]).toEqual(["standard_20", "reduced_5", "zero", "exempt", "none"]);
    expect(isVatRate("standard_20")).toBe(true);
    expect(isVatRate("standard")).toBe(false);
  });
});
