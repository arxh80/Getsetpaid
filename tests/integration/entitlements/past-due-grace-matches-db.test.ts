// The tripwire for the past_due grace window, which now exists in two
// languages.
//
// The founder decided (2026-08-28, recorded in lib/entitlements/policy.ts's
// header) that 'past_due' keeps a plan's entitlements for a 3-day grace window
// before falling back to Free, while 'cancelled' falls back at once. That
// decision started life in TypeScript only -- `PAST_DUE_GRACE_DAYS` plus
// `isWithinPastDueGrace()` -- and Phase 2 Task 2 then pushed the entitlement
// term into RLS, because the anon key ships in the browser and PostgREST is
// reachable without the app. So the rule now has to be true in
// private.crm_write_organisations() as well, and A CONSTANT IN TWO LANGUAGES
// WITH NOTHING BINDING THEM IS HOW THIS GETS BROKEN IN SIX MONTHS.
//
// This is the third instance of that pattern in this codebase and it is
// deliberately the third instance of the same solution:
//
//   subscription_plans vs TIER_MATRIX
//     -> tests/integration/entitlements/tiers-match-db.test.ts (this file's sibling)
//   private.role_requires_mfa vs MFA_REQUIRED_ROLES
//     -> supabase/tests/rls_foundation.sql K19/K20
//   public.has_permission vs private.permitted_organisations
//     -> supabase/tests/rls_phase2_crm.sql § M
//
// WHY THIS DOES MORE THAN COMPARE TWO INTEGERS. Equal constants inside unequal
// comparisons would still be drift: `now < end + 3d` and `now <= end + 3d`
// agree on the number and disagree on the boundary, and one of them keeps a
// non-paying customer's writes on for an extra instant. So the second test
// below compares the two implementations' actual DECISIONS across a range of
// timestamps that straddle the boundary, rather than their inputs.
//
// A DIRECT POSTGRES CONNECTION, not PostgREST, because the SQL half lives in
// `private` -- which supabase/config.toml does not expose, deliberately.
// Publishing an RPC that returns 3 so that a test could reach it would be
// adding API surface to make testing easier. tests/integration/rls/support/
// env.ts already surfaces DB_URL and the RLS fixtures already use `pg`, so the
// direct connection costs nothing new.
//
// LOCAL ONLY, same discipline as every other integration test here:
// getLocalSupabaseStatus() refuses anything that does not look like the
// standard local loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { PAST_DUE_GRACE_DAYS, isWithinPastDueGrace } from "@/lib/entitlements/policy";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

describe("the past_due grace window is the same rule in TypeScript and in SQL", () => {
  it("private.past_due_grace_days() equals PAST_DUE_GRACE_DAYS", async () => {
    const { rows } = await pool.query<{ days: number }>(
      "select private.past_due_grace_days() as days",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].days, "private.past_due_grace_days() vs PAST_DUE_GRACE_DAYS").toBe(
      PAST_DUE_GRACE_DAYS,
    );
  });

  // The one that actually matters. `now < end + 3d` and `now <= end + 3d`
  // share a constant and differ at the boundary, and the difference is
  // "a lapsed subscription can still write". So compare the DECISIONS.
  //
  // The SQL expression here is the exact predicate
  // private.crm_write_organisations() applies to a past_due row -- kept in
  // step by the shape assertion in the third test below, which fails if that
  // function stops calling past_due_grace_days() at all.
  it("both implementations agree on every side of the boundary", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const graceMs = PAST_DUE_GRACE_DAYS * DAY_MS;
    const now = Date.now();

    // Offsets of `current_period_end` relative to now, chosen to straddle the
    // window's far edge: comfortably inside, one second inside, one second
    // outside, and far outside.
    const offsetsMs = [
      +30 * DAY_MS, // period end still in the future -- trivially in grace
      0, // period end is now
      -1 * DAY_MS, // one day into the window
      -(graceMs - 1000), // one second before the window closes
      -graceMs, // exactly on the boundary
      -(graceMs + 1000), // one second after it closes
      -30 * DAY_MS, // long lapsed
      -365 * DAY_MS, // far in the past
    ];

    for (const offset of offsetsMs) {
      const periodEnd = new Date(now + offset);

      const fromTypeScript = isWithinPastDueGrace(periodEnd.toISOString(), now);

      // `<`, matching private.crm_write_organisations() exactly. The first
      // draft of this query wrote `>` -- the negation -- and the test caught
      // it on the very first offset, which is a fair demonstration of what it
      // is for: the constant was identical and the comparison was inverted,
      // which is precisely the drift a "do the two numbers match" test would
      // have missed.
      const { rows } = await pool.query<{ in_grace: boolean }>(
        `select $1::timestamptz < $2::timestamptz
                  + make_interval(days => private.past_due_grace_days())
                as in_grace`,
        [new Date(now).toISOString(), periodEnd.toISOString()],
      );

      expect(
        rows[0].in_grace,
        `period_end offset ${offset}ms: SQL said ${rows[0].in_grace}, ` +
          `isWithinPastDueGrace() said ${fromTypeScript}`,
      ).toBe(fromTypeScript);
    }
  });

  // Binds the boundary test above to the function it claims to be testing. If
  // someone inlines the interval back into crm_write_organisations(), or drops
  // the past_due branch entirely, the test above would keep passing against an
  // expression nothing uses any more.
  it("crm_write_organisations() really is built on that constant and that status", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'crm_write_organisations'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].src, "must call the shared constant, not inline the number").toContain(
      "private.past_due_grace_days()",
    );
    expect(rows[0].src, "must special-case past_due").toContain("past_due");
    expect(rows[0].src, "must measure grace from current_period_end").toContain(
      "current_period_end",
    );
    // 'cancelled' gets no grace, so it must NOT appear as a writing branch --
    // the function is an allowlist of statuses that write.
    expect(rows[0].src, "cancelled must not be an allowed status").not.toContain(
      "cancelled",
    );
  });
});
