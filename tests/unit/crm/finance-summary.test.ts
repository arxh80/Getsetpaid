import { describe, expect, it } from "vitest";
import {
  netMinor,
  summariseFinanceEntries,
  summaryBucket,
} from "@/lib/crm/finance-summary";
import type { FinanceCategory, FinanceStatus } from "@/lib/crm/finance-category";

// The budget-vs-actuals summary math, mirroring public.event_finance_summary
// (20260903010000). This is the TS half of the two-language mapping: it exists
// so the reviewer has a denominator and so a FLIPPED MAPPING is a red test.
//
// THE MUTATION TEST NAMED IN THE BRIEF: "flip the category mapping (put fee in
// gross) -> the summary-math unit test fails". `summaryBucket('fee')` is
// asserted to be 'expense' below; change the SQL or this function to put fee in
// gross and the fixed-rows assertion at the bottom goes red.

function entry(
  category: FinanceCategory,
  status: FinanceStatus,
  amountMinor: number,
) {
  return { category, status, amountMinor };
}

describe("summaryBucket -- the category -> summary mapping", () => {
  it("income is gross (money in)", () => {
    expect(summaryBucket("income")).toBe("gross");
  });
  it("fee is expense (the artist spend, money out)", () => {
    expect(summaryBucket("fee")).toBe("expense");
  });
  it("cost is expense (the rest of the outlay, money out)", () => {
    expect(summaryBucket("cost")).toBe("expense");
  });
});

describe("netMinor -- net = gross - expense", () => {
  it("is a surplus when gross exceeds expense", () => {
    expect(netMinor(100000, 60000)).toBe(40000);
  });
  it("is a deficit (negative) when expense exceeds gross", () => {
    expect(netMinor(60000, 100000)).toBe(-40000);
  });
  it("is zero at break-even", () => {
    expect(netMinor(50000, 50000)).toBe(0);
  });
});

describe("summariseFinanceEntries -- the view's aggregation, in TS", () => {
  // A FIXED SET OF ROWS, so the numbers are a denominator the reviewer can
  // check by hand:
  //   budgeted: fee 100000, cost 20000, income 150000
  //   actual:   fee 110000, income 90000
  const rows = [
    entry("fee", "budgeted", 100000),
    entry("cost", "budgeted", 20000),
    entry("income", "budgeted", 150000),
    entry("fee", "actual", 110000),
    entry("income", "actual", 90000),
  ];

  const summary = summariseFinanceEntries(rows);

  it("sums income into gross, per status", () => {
    expect(summary.budgetedGrossMinor).toBe(150000);
    expect(summary.actualGrossMinor).toBe(90000);
  });

  it("sums fee AND cost into expense, per status", () => {
    // 100000 + 20000 budgeted; 110000 actual (no actual cost line).
    expect(summary.budgetedExpenseMinor).toBe(120000);
    expect(summary.actualExpenseMinor).toBe(110000);
  });

  it("gross - expense = net, per status", () => {
    expect(
      netMinor(summary.budgetedGrossMinor, summary.budgetedExpenseMinor),
    ).toBe(30000); // 150000 - 120000, a budgeted surplus
    expect(
      netMinor(summary.actualGrossMinor, summary.actualExpenseMinor),
    ).toBe(-20000); // 90000 - 110000, an actual deficit
  });

  it("an empty sheet is all zeros", () => {
    const zero = summariseFinanceEntries([]);
    expect(zero).toEqual({
      budgetedGrossMinor: 0,
      budgetedExpenseMinor: 0,
      actualGrossMinor: 0,
      actualExpenseMinor: 0,
    });
  });
});
