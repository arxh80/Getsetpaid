// The tripwire for entitlementsPermitCrmWrites(), the SIXTH constant-shaped
// rule in this codebase to exist in two languages at once:
//
//   subscription_plans vs TIER_MATRIX
//   private.role_requires_mfa vs MFA_REQUIRED_ROLES
//   public.has_permission vs private.permitted_organisations
//   private.past_due_grace_days() vs PAST_DUE_GRACE_DAYS
//   private.full_scope_organisations() vs RECORD_SCOPED_ROLES
//   private.crm_write_organisations() vs entitlementsPermitCrmWrites()  <- here
//
// ===========================================================================
// THE DIVERGENCE THIS TEST WAS WRITTEN FOR IS GONE -- PHASE 7 TASK A CLOSED IT
// ===========================================================================
// Before Task A, `lib/entitlements/policy.ts` resolved an organisation with
// NO subscription row to `{ status: "no-subscription", tier: "free" }` (and
// `TIER_MATRIX.free.crmWrites` is FALSE), while `private.crm_write_
// organisations()` did the opposite, in as many words:
//
//     -- No subscription row => not yet billed => not yet gated. Phase 7
//     -- removes this branch in the same migration that backfills the rows.
//     s.organisation_id is null
//
// `public.create_organisation()` wrote no subscription row at the time, so
// every organisation in the product had none, and reading `crmWrites`
// straight off the entitlements result -- the obvious thing -- would have
// rendered every "New contact" button disabled while the database happily
// accepted the write from anything that bypassed the UI.
//
// TASK A (20260908000000) removed the escape from BOTH halves: `public.
// create_organisation()` now writes a Starter row at birth and every
// pre-existing organisation was backfilled one, so "no subscription row" is
// no longer a state a real organisation can be in, and `private.crm_write_
// organisations()` denies it outright. `entitlementsPermitCrmWrites()`
// mirrors that now too (lib/crm/write-access.ts). This test still drives
// BOTH sides for every combination of subscription state the two
// implementations could disagree about most easily -- the "no subscription
// row" case included, now proving agreement on DENIAL rather than on the old
// escape.
//
// LOCAL ONLY, everything rolled back. Same guard as every other integration
// test here: env.ts refuses anything that is not the loopback stack.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { entitlementsPermitCrmWrites } from "@/lib/crm/write-access";
import { resolveEntitlements } from "@/lib/entitlements/policy";
import { TIER_KEYS } from "@/lib/entitlements/tiers";

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

/**
 * One organisation, one active Owner membership, and optionally one
 * subscription row. Asks BOTH implementations whether CRM writes are
 * permitted, then rolls the whole thing back.
 *
 * The database side is asked the way a policy asks it -- "is this org in
 * private.crm_write_organisations()" -- under `set local role authenticated`
 * with a real `request.jwt.claims`, not by reading the function's source. Task
 * 2's fix round 3 established why: a source guard could not see `<` changed to
 * `<=`, and a test that rebuilds the expression proves only that two things
 * the test wrote agree.
 */
async function bothSides(subscription: {
  plan: string;
  status: string;
  /** Offset from now, in days, for current_period_end. Null column if omitted. */
  periodEndDays?: number | null;
} | null): Promise<{ database: boolean; typescript: boolean; label: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const {
      rows: [{ uid }],
    } = await client.query<{ uid: string }>(
      `insert into auth.users (id, instance_id, aud, role, email,
                               encrypted_password, email_confirmed_at,
                               created_at, updated_at)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated',
               'ent-' || gen_random_uuid() || '@example.test',
               'x', now(), now(), now())
       returning id as uid`,
    );
    const {
      rows: [{ org }],
    } = await client.query<{ org: string }>(
      `insert into public.organisations (name, slug)
       values ('Entitlement probe', 'ent-' || replace(gen_random_uuid()::text, '-', ''))
       returning id as org`,
    );
    await client.query(
      `insert into public.organisation_memberships
         (organisation_id, user_id, role, status, joined_at)
       values ($1, $2, 'owner', 'active', now())`,
      [org, uid],
    );

    let periodEnd: string | null = null;
    if (subscription) {
      const days = subscription.periodEndDays;
      const { rows } = await client.query<{ ends: string | null }>(
        days === undefined || days === null
          ? "select null::timestamptz as ends"
          : "select (now() + make_interval(days => $1))::timestamptz as ends",
        days === undefined || days === null ? [] : [days],
      );
      periodEnd = rows[0]!.ends;
      await client.query(
        `insert into public.organisation_subscriptions
           (organisation_id, plan_id, status, billing_cycle, seat_count,
            current_period_end)
         values ($1, $2, $3, 'monthly', 1, $4)`,
        [org, subscription.plan, subscription.status, periodEnd],
      );
    }

    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" }),
    ]);

    const {
      rows: [{ permitted }],
    } = await client.query<{ permitted: boolean }>(
      "select $1::uuid in (select private.crm_write_organisations()) as permitted",
      [org],
    );

    // The TypeScript side is driven through the SAME two functions the app
    // uses -- resolveEntitlements() then entitlementsPermitCrmWrites() -- so
    // this measures the composition the pages actually call, not a
    // re-derivation of it.
    const typescript = entitlementsPermitCrmWrites(
      resolveEntitlements({
        data: subscription
          ? {
              plan_id: subscription.plan,
              status: subscription.status,
              current_period_end: periodEnd as string,
            }
          : null,
        error: null,
      }),
    );

    return {
      database: permitted,
      typescript,
      label: subscription
        ? `${subscription.plan}/${subscription.status}/end+${subscription.periodEndDays ?? "null"}d`
        : "no subscription row",
    };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

describe("entitlementsPermitCrmWrites mirrors private.crm_write_organisations()", () => {
  it("agrees on NO SUBSCRIPTION ROW, which Phase 7 Task A made impossible for a real organisation and DENIED", async () => {
    // This organisation is planted by a direct INSERT into
    // public.organisations, not through public.create_organisation() -- the
    // same accommodation rls_phase2_crm.sql § N's N1 needs -- so "no
    // subscription row" is still reachable here even though no real
    // organisation is ever in that state any more. Both sides now agree it
    // DENIES: the escape this test used to prove is gone from both halves.
    const result = await bothSides(null);
    expect(result.database, "the database now REFUSES writes with no subscription")
      .toBe(false);
    expect(result.typescript, result.label).toBe(result.database);
  });

  it("agrees on every plan at status active", async () => {
    const disagreements: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.database !== r.typescript) {
        disagreements.push(`${r.label}: db=${r.database} ts=${r.typescript}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("agrees on the past_due grace window, on both sides of its edge", async () => {
    // The window itself is bound by past-due-grace-matches-db.test.ts. What is
    // asserted here is that the WRITE-ACCESS answer the UI renders follows it,
    // which is a different composition and could drift on its own.
    const disagreements: string[] = [];
    for (const days of [-1, -2, -4, -30]) {
      const r = await bothSides({ plan: "pro", status: "past_due", periodEndDays: days });
      if (r.database !== r.typescript) {
        disagreements.push(`${r.label}: db=${r.database} ts=${r.typescript}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("agrees on cancelled, with the period end still inside a grace window", async () => {
    // The period end is deliberately in the FUTURE, so only the status can
    // deny it. Same construction as rls_phase2_crm.sql N15.
    const r = await bothSides({ plan: "pro", status: "cancelled", periodEndDays: 30 });
    expect(r.database, r.label).toBe(false);
    expect(r.typescript, r.label).toBe(r.database);
  });

  it("a fourth status cannot exist, so the two allowlists cannot disagree about one", async () => {
    // Written as a probe rather than as a claim, because the first draft of
    // this file tried to insert 'trialing' and was refused. The status column
    // carries its own CHECK, so `organisation_subscriptions` is a THIRD
    // allowlist alongside the SQL function's and the TypeScript resolver's,
    // and it is the narrowest of the three. Both mirrors are written as
    // allowlists of writing statuses, so a fourth status added later arrives
    // denied on both sides -- and it cannot arrive at all until this CHECK is
    // widened, which is the migration where all three have to move together.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(
        client.query(
          `insert into public.organisation_subscriptions
             (organisation_id, plan_id, status, billing_cycle, seat_count,
              current_period_end)
           values (gen_random_uuid(), 'pro', 'trialing', 'monthly', 1, now())`,
        ),
      ).rejects.toThrow(/organisation_subscriptions_status_check/);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });

  it("denies on an INDETERMINATE lookup, which is deliberately NOT what the database does", async () => {
    // The one place the mirror is asymmetric, and it is asymmetric on purpose.
    // A failed subscription query in the application is not the same event as
    // a missing row in the database, and the consequences differ: here it
    // disables a button, there it would open a gate. Asserted so that
    // "deliberate" is a fact in the suite rather than a claim in a comment.
    expect(
      entitlementsPermitCrmWrites(
        resolveEntitlements({ data: null, error: { message: "boom" } }),
      ),
    ).toBe(false);
  });
});
