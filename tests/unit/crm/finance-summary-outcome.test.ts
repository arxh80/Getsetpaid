import { describe, expect, it, vi } from "vitest";

// `loadEventFinanceSummary`'s THREE outcomes -- review finding I3.
//
// ===========================================================================
// WHY THIS NEEDS A FAKE RATHER THAN THE LOCAL STACK
// ===========================================================================
// The state under test is A FAILED QUERY. There is no fixture that makes
// PostgREST return an error for a well-formed read the caller is entitled to
// make, which is exactly why the bug survived: the integration suite proves the
// view's ACCESS CONTROL (tests/integration/crm/event-finance-summary-rls.test.ts,
// psql § FD, the HTTP block) and none of it can reach the branch where the
// query itself breaks. So the client is faked, the same way
// tests/unit/list/fetch-list-page.test.ts fakes it and for the same reason.
//
// WHAT WAS WRONG. "No row" and "the query failed" both returned the same
// all-zeros summary, so a broken read rendered `£0.00 · break-even` above a
// list that was still showing the event's real money. The three assertions
// below are the discrimination itself: `empty` and `unavailable` must not be
// the same value, and `loaded` must carry the numbers.

interface FakeResult {
  data?: Record<string, unknown> | null;
  error?: { message: string } | null;
}

/**
 * `supabase.from(...).select(...).eq(...).eq(...).maybeSingle()`.
 *
 * A proxy rather than a hand-written chain: the loader's exact call sequence is
 * not what is under test, and pinning it here would make this file red for a
 * refactor that changed nothing about the outcome. `maybeSingle` is the one
 * method that resolves.
 */
function fakeClient(result: FakeResult) {
  const chain: unknown = new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (key === "maybeSingle") {
        return async () => ({
          data: result.data ?? null,
          error: result.error ?? null,
        });
      }
      return () => chain;
    },
  });
  return { from: () => chain };
}

let current: FakeResult = {};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeClient(current),
}));

const { loadEventFinanceSummary } = await import("@/lib/crm/finance-queries");

const ORG = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";

describe("loadEventFinanceSummary -- an error is not an empty event", () => {
  it("a returned row is `loaded`, carrying the four aggregates", async () => {
    // THE DENOMINATOR for the two negatives below: without it, a loader that
    // returned `unavailable` for everything would satisfy them both.
    current = {
      data: {
        budgeted_gross_minor: 250000,
        budgeted_expense_minor: 175000,
        actual_gross_minor: 0,
        actual_expense_minor: 50000,
      },
    };
    expect(await loadEventFinanceSummary(ORG, EVENT)).toEqual({
      outcome: "loaded",
      summary: {
        budgetedGrossMinor: 250000,
        budgetedExpenseMinor: 175000,
        actualGrossMinor: 0,
        actualExpenseMinor: 50000,
      },
    });
  });

  it("NO ROW is `empty` -- an event with no finance lines, honestly zero", async () => {
    current = { data: null };
    expect(await loadEventFinanceSummary(ORG, EVENT)).toEqual({
      outcome: "empty",
    });
  });

  it("A FAILED QUERY is `unavailable`, NOT zeros", async () => {
    // The finding itself. Before the fix this returned the all-zeros summary,
    // indistinguishable from the case above, and the panel rendered
    // "£0.00 · break-even" over a list of real money.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      current = { error: { message: "boom" } };
      const result = await loadEventFinanceSummary(ORG, EVENT);
      expect(result).toEqual({ outcome: "unavailable" });
      // ...and it is a DIFFERENT answer from the empty case, which is the
      // whole point: the panel branches on exactly this.
      expect(result.outcome).not.toBe("empty");
      expect(spy, "the failure is still logged").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("no outcome carries a summary except `loaded`", async () => {
    // A structural guard on the union: an `unavailable` that also carried a
    // zeroed summary would let a careless consumer render it and reintroduce
    // the defect without changing this file's other assertions.
    current = { error: { message: "boom" } };
    expect(
      Object.keys(await loadEventFinanceSummary(ORG, EVENT)),
    ).toEqual(["outcome"]);
    current = { data: null };
    expect(
      Object.keys(await loadEventFinanceSummary(ORG, EVENT)),
    ).toEqual(["outcome"]);
  });
});
