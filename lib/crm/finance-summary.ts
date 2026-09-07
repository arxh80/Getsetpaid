// The budget-vs-actuals summary: the shape of public.event_finance_summary,
// and the SAME aggregation in TypeScript so the SQL mapping has a mirror a
// unit test can pin.
//
// ===========================================================================
// TWO IMPLEMENTATIONS OF ONE MAPPING, ON PURPOSE
// ===========================================================================
// The panel reads the SQL view (loadEventFinanceSummary, lib/crm/finance-
// queries.ts) -- the view is the source of truth at run time, because
// `security_invoker` makes it the access control too (a caller without
// view_finance gets no rows). `summariseFinanceEntries` below reproduces the
// view's category->bucket mapping in TS purely so the reviewer has a
// denominator and so a flipped mapping is a RED unit test rather than a wrong
// number on a page nobody opened. tests/unit/crm/finance-summary.test.ts drives
// it against a fixed set of rows; the mutation "put fee in gross" turns it red.
//
// THE MAPPING, VERBATIM WITH 20260903010000's HEADER:
//   gross   = Σ income                 -- money in
//   expense = Σ (fee + cost)          -- money out (an artist fee and any
//                                         other cost are both outgoings)
//   net     = gross - expense         -- computed here, never stored
//
// NO REACT, NO SERVER DIRECTIVE -- importable from a Server Component, a Client
// Component and a vitest file alike, the same discipline as finance-category.ts.

import type {
  FinanceCategory,
  FinanceStatus,
} from "@/lib/crm/finance-category";

/**
 * public.event_finance_summary, one row, camelCased.
 *
 * A FAITHFUL PROJECTION of the view's four columns. Each is a non-negative
 * bigint of pence, returned by PostgREST as a JS number; the finance actions
 * cap every stored amount at Number.MAX_SAFE_INTEGER (lib/crm/finance.ts), and
 * a per-event sum of capped rows stays inside that range for any real event.
 */
export interface EventFinanceSummary {
  budgetedGrossMinor: number;
  budgetedExpenseMinor: number;
  actualGrossMinor: number;
  actualExpenseMinor: number;
}

/** The all-zeros summary: an event with no finance lines, which is what a
 *  caller who holds view_finance honestly sees when the view returns no row. */
export const ZERO_FINANCE_SUMMARY: EventFinanceSummary = {
  budgetedGrossMinor: 0,
  budgetedExpenseMinor: 0,
  actualGrossMinor: 0,
  actualExpenseMinor: 0,
};

/**
 * What a summary read produced. THREE states, not two -- review finding I3.
 *
 * ===========================================================================
 * £0.00 AND "break-even" ARE CLAIMS ABOUT THE CUSTOMER'S MONEY
 * ===========================================================================
 * `loadEventFinanceSummary` used to collapse "the view returned no row" and
 * "the query failed" into the same all-zeros object. The failure mode that
 * produces is the worst one on the page: the LINE LIST below the summary has
 * its own outcome and still renders the real lines, so a Finance user saw a
 * populated sheet of money under a Gross/Expense/Net block reading
 * £0.00 · break-even, with nothing to tell it apart from a genuinely empty
 * event. The panel already takes the opposite disposition twelve lines away
 * for the list -- "A FAILED QUERY IS NOT AN EMPTY SHEET" -- and this is the
 * same rule applied to the block above it.
 *
 *   `loaded`       the view returned a row; render it.
 *   `empty`        the view returned NO row, which is the ordinary case for an
 *                  event with no finance lines. Renders zeros, honestly.
 *   `unavailable`  the query failed. Says so; claims nothing about the money.
 *
 * `empty` is kept distinct from `loaded`-with-zeros even though they render
 * identically, so the discrimination the loader makes is visible to a test and
 * a future surface (a "no lines yet" teaching state, say) does not have to
 * re-derive it by comparing four numbers to zero.
 */
export type EventFinanceSummaryOutcome =
  | { readonly outcome: "loaded"; readonly summary: EventFinanceSummary }
  | { readonly outcome: "empty" }
  | { readonly outcome: "unavailable" };

/**
 * Which summary bucket a category lands in.
 *
 * THE ONE PLACE THE MAPPING IS WRITTEN IN TS. `income` is gross (money in);
 * `fee` and `cost` are both expense (money out). Exhaustive over the union, so
 * a category added to FINANCE_CATEGORIES without a bucket here is a compile
 * error rather than a silently uncounted line.
 */
export function summaryBucket(category: FinanceCategory): "gross" | "expense" {
  switch (category) {
    case "income":
      return "gross";
    case "fee":
    case "cost":
      return "expense";
  }
}

/** net = gross - expense. A surplus is positive, a deficit negative. */
export function netMinor(grossMinor: number, expenseMinor: number): number {
  return grossMinor - expenseMinor;
}

/**
 * The view's aggregation, in TypeScript, for the unit-test denominator.
 *
 * Sums `amount_minor` by (status, bucket) exactly as the SQL `filter` clauses
 * do. Rows are assumed live (the view filters `deleted_at is null`); callers
 * that hold soft-deleted rows must not pass them.
 */
export function summariseFinanceEntries(
  entries: readonly {
    category: FinanceCategory;
    status: FinanceStatus;
    amountMinor: number;
  }[],
): EventFinanceSummary {
  const summary: EventFinanceSummary = { ...ZERO_FINANCE_SUMMARY };
  for (const entry of entries) {
    const bucket = summaryBucket(entry.category);
    if (entry.status === "budgeted") {
      if (bucket === "gross") summary.budgetedGrossMinor += entry.amountMinor;
      else summary.budgetedExpenseMinor += entry.amountMinor;
    } else {
      if (bucket === "gross") summary.actualGrossMinor += entry.amountMinor;
      else summary.actualExpenseMinor += entry.amountMinor;
    }
  }
  return summary;
}
