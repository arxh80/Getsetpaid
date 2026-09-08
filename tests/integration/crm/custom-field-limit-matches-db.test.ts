// The tripwire for the custom-field tier limit, which now exists in two
// languages.
//
// The rule -- Free 0, Starter 5 per entity type, Pro unlimited, with the
// founder's 3-day past_due grace and the "not yet billed, not yet gated"
// escape -- is enforced in private.custom_field_limit() (20260829010500) and
// mirrored in lib/crm/custom-fields.ts's customFieldLimit(). Two copies of a
// rule with nothing binding them is how this gets broken in six months, and
// this codebase has solved that four times already with the same solution:
//
//   subscription_plans vs TIER_MATRIX
//     -> tests/integration/entitlements/tiers-match-db.test.ts
//   private.role_requires_mfa vs MFA_REQUIRED_ROLES
//     -> supabase/tests/rls_foundation.sql K19/K20
//   public.has_permission vs private.permitted_organisations
//     -> supabase/tests/rls_phase2_crm.sql § M
//   private.past_due_grace_days vs PAST_DUE_GRACE_DAYS
//     -> tests/integration/entitlements/past-due-grace-matches-db.test.ts
//
// This is the fifth, and it copies the fourth's discipline rather than its
// weakest earlier draft: IT DRIVES THE DEPLOYED FUNCTION. An earlier version of
// the grace test built its own predicate and compared that to TypeScript, which
// proves the two agree about an expression the test wrote. Every case below
// calls private.custom_field_limit() itself, inside a transaction that is
// rolled back.
//
// A DIRECT POSTGRES CONNECTION, not PostgREST, because the SQL half lives in
// `private` -- which supabase/config.toml does not expose, deliberately.
//
// LOCAL ONLY: getLocalSupabaseStatus() refuses anything that does not look like
// the standard local loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { resolveEntitlements } from "@/lib/entitlements/policy";
import { customFieldLimit } from "@/lib/crm/custom-fields";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One subscription state to drive both halves with.
 *
 * PHASE 7 TASK A: `plan: null` ("no organisation_subscriptions row at all")
 * used to be a scenario in this array, comparing private.custom_field_limit()
 * (which returned NULL, "unlimited") against customFieldLimit() (which also
 * returned null). Task A removed that escape in both halves AND changed its
 * shape asymmetrically: the SQL function now RAISES for an organisation that
 * exists with no subscription row (a violated invariant, not a legitimate
 * lookup outcome -- see its comment), while the TypeScript half returns 0
 * (Free's shape, the same safe default "indeterminate" already used). A raise
 * and a return value are not comparable through this array's uniform
 * `.toBe()` assertion, so that state is now its own dedicated test below
 * ("the SQL invariant") rather than a row in this table.
 */
interface Scenario {
  readonly name: string;
  readonly plan: "free" | "starter" | "pro";
  readonly status?: "active" | "past_due" | "cancelled";
  /** current_period_end relative to now, in ms. */
  readonly periodEndOffsetMs?: number;
  /** What TIER_MATRIX says this plan's limit is, for the TypeScript half. */
  readonly planLimit?: number | null;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "free/active",
    plan: "free",
    status: "active",
    periodEndOffsetMs: 30 * DAY_MS,
    planLimit: 0,
  },
  {
    name: "starter/active",
    plan: "starter",
    status: "active",
    periodEndOffsetMs: 30 * DAY_MS,
    planLimit: 5,
  },
  {
    name: "pro/active (unlimited)",
    plan: "pro",
    status: "active",
    periodEndOffsetMs: 30 * DAY_MS,
    planLimit: null,
  },
  {
    name: "pro/past_due INSIDE the grace window -- still Pro",
    plan: "pro",
    status: "past_due",
    periodEndOffsetMs: -1 * DAY_MS,
    planLimit: null,
  },
  {
    name: "pro/past_due AFTER the grace window -- falls to Free's 0",
    plan: "pro",
    status: "past_due",
    periodEndOffsetMs: -30 * DAY_MS,
    planLimit: null,
  },
  {
    name: "pro/cancelled INSIDE what would be a window -- no grace at all",
    plan: "pro",
    status: "cancelled",
    periodEndOffsetMs: -1 * DAY_MS,
    planLimit: null,
  },
  {
    name: "starter/past_due AFTER the window",
    plan: "starter",
    status: "past_due",
    periodEndOffsetMs: -30 * DAY_MS,
    planLimit: 5,
  },
];

describe("the custom-field limit is the same rule in TypeScript and in SQL", () => {
  it("private.custom_field_limit() agrees with customFieldLimit() on every subscription state", async () => {
    const client = await pool.connect();
    try {
      for (const scenario of SCENARIOS) {
        await client.query("begin");
        try {
          const { rows } = await client.query<{
            org: string;
            period_end: Date;
          }>(
            `with o as (
               insert into public.organisations (name, slug)
               values ('Limit Probe',
                       'limit-probe-' || replace(gen_random_uuid()::text,'-',''))
               returning id
             ), s as (
               insert into public.organisation_subscriptions
                 (organisation_id, plan_id, billing_cycle, seat_count, status,
                  current_period_end)
               select o.id, $1::text, 'monthly', 1, $2::text,
                      now() + make_interval(secs => $3::float8 / 1000)
               from o
               returning organisation_id, current_period_end
             )
             select o.id as org, s.current_period_end as period_end
             from o join s on s.organisation_id = o.id`,
            [scenario.plan, scenario.status ?? "active", scenario.periodEndOffsetMs ?? 0],
          );

          const org = rows[0].org;

          // THE DEPLOYED FUNCTION, not a copy of its CASE expression.
          const { rows: decided } = await client.query<{ lim: number | null }>(
            "select private.custom_field_limit($1::uuid) as lim",
            [org],
          );

          // The TypeScript half, given the same row lib/entitlements/policy.ts
          // would have read out of PostgREST. `resolveEntitlements` is what
          // getOrganisationEntitlements() calls, so this drives the real
          // decision chain rather than a hand-built EntitlementsResult.
          const fromTypeScript = customFieldLimit(
            resolveEntitlements({
              data: {
                plan_id: scenario.plan,
                status: scenario.status ?? "active",
                current_period_end: rows[0].period_end.toISOString(),
              },
              error: null,
            }),
          );

          expect(
            decided[0].lim,
            `${scenario.name}: private.custom_field_limit() said ${decided[0].lim}, ` +
              `customFieldLimit() said ${fromTypeScript}`,
          ).toBe(fromTypeScript);
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
    }
  });

  // PHASE 7 TASK A: the invariant the migration comment claims but never
  // measured until now. An organisation that EXISTS with NO
  // organisation_subscriptions row is, after Task A, a state
  // public.create_organisation() and the 20260908000000 backfill together
  // make impossible for a real organisation -- so private.custom_field_limit()
  // RAISES rather than returning 0 (Free) or NULL (unlimited), either of
  // which would silently reintroduce one of the two defects this task closed.
  // Driven directly against the deployed function, the same way the sweep
  // above is, rather than asserted from the migration's source text.
  it("private.custom_field_limit() raises for an organisation with no subscription row", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ org: string }>(
        `insert into public.organisations (name, slug)
         values ('No Subscription Probe',
                 'no-sub-probe-' || replace(gen_random_uuid()::text,'-',''))
         returning id as org`,
      );
      const org = rows[0].org;

      // The TypeScript half's OWN answer for the same shape, for contrast in
      // the failure message -- it does NOT raise; see customFieldLimit()'s
      // header for why 0 (Free's shape) is its safe default instead.
      const fromTypeScript = customFieldLimit(
        resolveEntitlements({ data: null, error: null }),
      );
      expect(fromTypeScript, "the TypeScript half's safe default is 0, not unlimited").toBe(0);

      await expect(
        client.query("select private.custom_field_limit($1::uuid)", [org]),
      ).rejects.toThrow(/no organisation_subscriptions row/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  // Belt and braces around the sweep above. It drives the real function, so a
  // changed operator would already be caught -- this states the intent
  // directly and fails with one readable line rather than eight limit
  // mismatches.
  it("custom_field_limit() is built on the shared constant and the same allowlist", async () => {
    const { rows } = await pool.query<{ src: string }>(
      "select prosrc as src from pg_proc p" +
        " join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'private' and p.proname = 'custom_field_limit'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].src, "must call the shared grace constant, not inline 3").toContain(
      "private.past_due_grace_days()",
    );
    expect(rows[0].src, "must special-case past_due").toContain("past_due");
    expect(rows[0].src, "must measure grace from current_period_end").toContain(
      "current_period_end",
    );
    // Free's 0 is read out of subscription_plans rather than written into the
    // function, so a pricing change in a migration cannot leave this behind.
    expect(rows[0].src, "must read Free's limit from the plans table").toContain(
      "public.subscription_plans",
    );
    // An allowlist of writing statuses, so a fourth status arrives denied.
    expect(rows[0].src, "cancelled must not be an allowed status").not.toContain(
      "cancelled",
    );
  });

  it("the slot predicate counts LIVE definitions only (founder decision Q12)", async () => {
    // The decision that makes a removed field give its slot back. Driven
    // against the deployed function with real rows rather than asserted from
    // its source: soft-delete one of two definitions and watch the answer
    // change while the row is still there.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ org: string }>(
        `with o as (
           insert into public.organisations (name, slug)
           values ('Slot Probe',
                   'slot-probe-' || replace(gen_random_uuid()::text,'-',''))
           returning id
         ), s as (
           insert into public.organisation_subscriptions
             (organisation_id, plan_id, billing_cycle, seat_count, status,
              current_period_end)
           select o.id, 'starter', 'monthly', 1, 'active', now() + interval '30 days'
           from o
         ), d as (
           insert into public.custom_field_definitions
             (organisation_id, entity_type, key, label, field_type)
           select o.id, 'contact', 'k' || g, 'K' || g, 'text'
           from o, generate_series(1, 5) g
         )
         select id as org from o`,
      );
      const org = rows[0].org;

      const available = async (): Promise<boolean> => {
        const { rows: r } = await client.query<{ ok: boolean }>(
          "select private.custom_field_slot_available($1::uuid, 'contact') as ok",
          [org],
        );
        return r[0].ok;
      };

      expect(await available(), "five of five used -> no slot").toBe(false);

      await client.query(
        "update public.custom_field_definitions set deleted_at = now()" +
          " where organisation_id = $1 and key = 'k5'",
        [org],
      );
      expect(await available(), "a REMOVED definition frees its slot (Q12)").toBe(true);

      // ...and the row it freed the slot for is still there, with its values
      // reachable. "The data is still there" is only a good answer if
      // something can still see it.
      const { rows: still } = await client.query<{ n: string }>(
        "select count(*)::text as n from public.custom_field_definitions" +
          " where organisation_id = $1",
        [org],
      );
      expect(still[0].n, "the removed definition is soft-deleted, not gone").toBe("5");

      // A different entity type has its OWN five: the limit is per entity
      // type, not per organisation (CLAUDE.md § Subscription tiers).
      const { rows: venue } = await client.query<{ ok: boolean }>(
        "select private.custom_field_slot_available($1::uuid, 'venue') as ok",
        [org],
      );
      expect(venue[0].ok, "contacts being full must not close venues").toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
