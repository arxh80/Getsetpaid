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

  // The one that actually matters -- and the one that did not, until fix
  // round 3.
  //
  // AN EARLIER VERSION OF THIS TEST DID NOT BIND WHAT IT CLAIMED TO BIND. It
  // built its OWN `now < end + interval` expression and compared that to
  // TypeScript, which proves the two agree about an expression the test wrote
  // rather than about the one the database enforces. The re-reviewer changed
  // `<` to `<=` inside private.crm_write_organisations(), left the constant,
  // the call and the status branch untouched, and got 5/5 here, 212/212 psql
  // and 39/39 HTTP -- fully green against a deployed function whose boundary
  // had moved.
  //
  // So this now drives THE DEPLOYED FUNCTION. Each offset builds a real
  // organisation, membership and past_due subscription inside a transaction,
  // sets request.jwt.claims the way PostgREST does, asks
  // private.crm_write_organisations() whether that organisation may write, and
  // rolls the whole thing back. That is the same value the RLS policies consume,
  // so an operator change anywhere in the chain shows up here.
  it("the DEPLOYED function agrees with resolveEntitlements() on every side of the boundary", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const graceMs = PAST_DUE_GRACE_DAYS * DAY_MS;

    // Offsets of `current_period_end` relative to the evaluation instant,
    // straddling the window's far edge. `-graceMs` is the boundary itself:
    // `<` denies there and `<=` allows, and it is the only offset that
    // discriminates between them.
    const offsetsMs = [
      +30 * DAY_MS, // period end still in the future -- trivially in grace
      0, // period end is now
      -1 * DAY_MS, // one day into the window
      -(graceMs - 1000), // one second before the window closes
      -graceMs, // EXACTLY on the boundary
      -(graceMs + 1000), // one second after it closes
      -30 * DAY_MS, // long lapsed
      -365 * DAY_MS, // far in the past
    ];

    const client = await pool.connect();
    try {
      for (const offset of offsetsMs) {
        await client.query("begin");
        try {
          // `now()` is transaction_timestamp(), so inside one transaction the
          // instant this fixture is built from and the instant the function
          // compares against are identical -- which is what makes the exact
          // boundary reachable at all. Across transactions the clock advances
          // and `-graceMs` silently becomes "just outside", which is how the
          // psql side missed it too (see rls_phase2_crm.sql N14f).
          // `pg` parses timestamptz into a JS Date, NOT a string. The first
          // draft typed these as `string` and called Date.parse() on the
          // result, which coerces a Date via toString() and SILENTLY DROPS
          // MILLISECONDS -- moving the TypeScript "now" up to a second
          // earlier and making the boundary offset disagree. It failed on
          // exactly the offset this test exists for, which is the right
          // outcome for the wrong reason; both sides now use getTime().
          const { rows: seeded } = await client.query<{
            org: string;
            period_end: Date;
            evaluated_at: Date;
          }>(
            `with u as (
               insert into auth.users (id, instance_id, aud, role, email)
               values (gen_random_uuid(),
                       '00000000-0000-0000-0000-000000000000',
                       'authenticated', 'authenticated',
                       'grace-probe-' || gen_random_uuid() || '@test.local')
               returning id
             ), o as (
               insert into public.organisations (name, slug)
               values ('Grace Probe', 'grace-probe-' || replace(gen_random_uuid()::text,'-',''))
               returning id
             ), m as (
               insert into public.organisation_memberships
                 (organisation_id, user_id, role, status, joined_at)
               select o.id, u.id, 'manager', 'active', now() from o, u
               returning organisation_id, user_id
             ), s as (
               insert into public.organisation_subscriptions
                 (organisation_id, plan_id, billing_cycle, seat_count, status,
                  current_period_end)
               select o.id, 'starter', 'monthly', 1, 'past_due',
                      now() + make_interval(secs => $1::float8 / 1000)
               from o
               returning organisation_id, current_period_end
             )
             select m.organisation_id as org,
                    s.current_period_end as period_end,
                    now() as evaluated_at,
                    set_config('request.jwt.claims',
                      json_build_object('sub', m.user_id, 'role', 'authenticated',
                                        'aal', 'aal1')::text, true) as claims
             from m join s on s.organisation_id = m.organisation_id`,
            [offset],
          );

          const { org, periodEnd, evaluatedAt } = {
            org: seeded[0].org,
            periodEnd: seeded[0].period_end,
            evaluatedAt: seeded[0].evaluated_at,
          };

          // THE DEPLOYED FUNCTION, not a copy of its predicate.
          const { rows: decided } = await client.query<{ may_write: boolean }>(
            `select exists (
               select 1 from private.crm_write_organisations() x where x = $1::uuid
             ) as may_write`,
            [org],
          );

          // The same question, answered by the TypeScript half against the same
          // two instants Postgres used.
          const fromTypeScript = isWithinPastDueGrace(
            periodEnd.toISOString(),
            evaluatedAt.getTime(),
          );

          expect(
            decided[0].may_write,
            `period_end offset ${offset}ms: crm_write_organisations() said ` +
              `${decided[0].may_write}, isWithinPastDueGrace() said ${fromTypeScript}`,
          ).toBe(fromTypeScript);
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
    }
  });

  // Belt and braces around the boundary test above: it drives the real
  // function, so an inlined constant would still be caught by the offsets --
  // but this states the intent directly and fails with a readable message
  // rather than eight timestamp mismatches.
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
