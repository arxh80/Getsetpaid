// The tripwire for entitlementsPermitNetworkPublish(), the EIGHTH
// constant-shaped rule in this codebase to exist in two languages at once, and
// the network sibling of crm-write-access-matches-db.test.ts and
// finance-access-matches-db.test.ts:
//
//   private.crm_write_organisations()       vs entitlementsPermitCrmWrites()
//   private.finance_module_organisations()  vs entitlementsPermitFinance()
//   private.network_publish_organisations() vs entitlementsPermitNetworkPublish()  <- here
//
// ===========================================================================
// WHY THIS IS NOT A COPY OF THE FINANCE ONE WITH A WORD CHANGED
// ===========================================================================
// It is the same SHAPE and a different ANSWER, and the difference is the point.
// All three helpers carry the same "no subscription row => not yet billed =>
// not yet gated" escape and the same past_due grace branch, so on most inputs
// they agree -- and on exactly one input the NETWORK gate must differ from the
// FINANCE one: `starter/active` carries network_publish = true and
// finance_module = false. A network helper that was copy-pasted from the
// finance one (which is how it was written -- 20260904001000's header says so
// in as many words) and left reading `p.finance_module` would agree with the
// finance gate everywhere, agree with TypeScript everywhere, pass every
// assertion the finance test makes, and silently deny every STARTER workspace
// the network publishing its plan sells it. THE DIVERGENCE TEST BELOW IS THE
// ONE THAT CATCHES THAT, and it is asserted on BOTH sides of the mirror.
//
// It must also DIVERGE FROM THE CRM GATE on nothing today (free/starter/pro
// carry crm_writes false/true/true and network_publish false/true/true, which
// are the same three booleans) -- and that coincidence is precisely why a
// copy-paste from crm_write_organisations() would ALSO be undetectable by
// behaviour. The finance divergence is what separates the three, so it is the
// assertion that carries the file.
//
// ===========================================================================
// AND THE MIRROR IS BACKWARDS FROM THE NAIVE READING, SAME AS THE OTHER TWO
// ===========================================================================
// lib/entitlements/policy.ts resolves an organisation with NO subscription row
// to { status: "no-subscription", tier: "free" }, and TIER_MATRIX.free
// .networkPublish is FALSE. private.network_publish_organisations() says the
// opposite for that case, deliberately -- STILL, as of Phase 7 Task A
// (2026-09-08): that task closed the identical escape on private.
// crm_write_organisations() and private.custom_field_limit() (and their
// TypeScript mirrors), but this one and private.finance_module_
// organisations()'s twin are a deliberate, separate follow-up (FOLLOW-UPS.md
// § "Phase 7 -- superuser dashboard"). public.create_organisation() NOW writes
// a Starter subscription row at birth, so "no subscription row" is no longer
// the state every organisation in the product is in -- the organisations this
// test drives are planted by direct inserts into public.organisations
// (`bothSides()` below), bypassing create_organisation() on purpose, which is
// the only way left to reach that state at all. It remains true that reading
// `networkPublish` straight off the resolved entitlements for an organisation
// in that state -- the obvious thing -- would disable its network write
// controls while the database happily accepted the write from anything that
// bypassed the UI.
//
// If this file goes red because a future task removed the
// `s.organisation_id is null` escape from private.network_publish_
// organisations(), the fix is to remove it from lib/network/access.ts in the
// same change -- not to relax the test. (This is exactly what happened to
// tests/integration/crm/crm-write-access-matches-db.test.ts in Task A.)
// FOLLOW-UPS.md § "Phase 7 -- superuser dashboard": an inert gate makes a
// wrong test green, so these assertions are written to be RE-READ at that
// point, not merely re-run.
//
// ===========================================================================
// ALL THREE EXPORTS, NOT JUST THE PURE ONE
// ===========================================================================
// entitlementsPermitNetworkPublish() is pure and is driven directly.
// getNetworkPublishAccess() and getNetworkConnectionAccess() are the
// compositions the pages actually call, and their VALUE is the ORDER of their
// three checks (suspended -> tier -> permission), which no database query can
// see. Both are driven here with their two dependencies mocked -- hasPermission
// and getOrganisationEntitlements -- so the entitlements half is the REAL
// resolveEntitlements() output for the REAL subscription row planted in
// Postgres, and only the session is synthetic.
//
// getNetworkReadAccess() is the third export and is deliberately NOT driven
// against the database: it has no tier term at all (Free is a view-only network
// tier), so there is no mirror to keep. What it owes instead is that it stays
// that way, which is the last assertion in this file.
//
// LOCAL ONLY, everything rolled back. env.ts refuses anything that is not the
// loopback stack.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { TIER_KEYS } from "@/lib/entitlements/tiers";
import type { CrmWriteAccess } from "@/lib/crm/write-access";

// The two dependencies both compositions share. Everything else in both modules
// -- including resolveEntitlements, which produces the value fed to the mock --
// stays real.
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, hasPermission: vi.fn() };
});
vi.mock("@/lib/entitlements/policy", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/entitlements/policy")>();
  return { ...actual, getOrganisationEntitlements: vi.fn() };
});

const {
  entitlementsPermitNetworkPublish,
  getNetworkPublishAccess,
  getNetworkConnectionAccess,
  getNetworkReadAccess,
} = await import("@/lib/network/access");
const { resolveEntitlements, getOrganisationEntitlements } = await import(
  "@/lib/entitlements/policy"
);
const { hasPermission } = await import("@/lib/auth");

const pool = new Pool({ connectionString: getLocalSupabaseStatus().dbUrl });

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.mocked(hasPermission).mockReset();
  vi.mocked(getOrganisationEntitlements).mockReset();
});

interface Subscription {
  plan: string;
  status: string;
  /** Offset from now, in days, for current_period_end. NOT NULL in the column. */
  periodEndDays: number;
}

interface Sides {
  /** `org in (select private.network_publish_organisations())`, as the caller. */
  networkDb: boolean;
  /** entitlementsPermitNetworkPublish(resolveEntitlements(row)). */
  networkTs: boolean;
  /** `org in (select private.finance_module_organisations())`, the same caller. */
  financeDb: boolean;
  /** `org in (select private.crm_write_organisations())`, the same caller. */
  crmDb: boolean;
  /** getNetworkPublishAccess() with the permission held and the org live. */
  publishCanWrite: boolean;
  publishReason: string;
  /** getNetworkConnectionAccess(), same conditions. */
  connectCanWrite: boolean;
  connectReason: string;
  label: string;
}

/**
 * One organisation, one active Owner membership, and optionally one
 * subscription row. Asks BOTH implementations of the network gate -- and, for
 * the divergence assertions, the finance and CRM gates on the same row -- then
 * rolls the whole thing back.
 *
 * The database side is asked THE WAY A POLICY ASKS IT ("is this org in
 * private.network_publish_organisations()") under `set local role
 * authenticated` with real `request.jwt.claims`, not by reading the function's
 * source. The events phase established why: a source guard could not see `<`
 * changed to `<=`, and a test that rebuilds the expression proves only that two
 * things the test wrote agree.
 *
 * aal2, because private.role_requires_mfa('owner') is true and the whole helper
 * hangs off a membership the caller must actually hold. The MFA gate itself is
 * proved in supabase/tests/rls_phase6_network.sql § NB; this file is about the
 * entitlement term.
 */
async function bothSides(subscription: Subscription | null): Promise<Sides> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const {
      rows: [user],
    } = await client.query<{ uid: string }>(
      `insert into auth.users (id, instance_id, aud, role, email,
                               encrypted_password, email_confirmed_at,
                               created_at, updated_at)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated',
               'net-' || gen_random_uuid() || '@example.test',
               'x', now(), now(), now())
       returning id as uid`,
    );
    const uid = user!.uid;
    const {
      rows: [orgRow],
    } = await client.query<{ org: string }>(
      `insert into public.organisations (name, slug)
       values ('Network entitlement probe',
               'net-' || replace(gen_random_uuid()::text, '-', ''))
       returning id as org`,
    );
    const org = orgRow!.org;
    await client.query(
      `insert into public.organisation_memberships
         (organisation_id, user_id, role, status, joined_at)
       values ($1, $2, 'owner', 'active', now())`,
      [org, uid],
    );

    let periodEnd: string | null = null;
    if (subscription) {
      const { rows } = await client.query<{ ends: string }>(
        "select (now() + make_interval(days => $1))::timestamptz as ends",
        [subscription.periodEndDays],
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
      rows: [gates],
    } = await client.query<{
      network: boolean;
      finance: boolean;
      crm: boolean;
    }>(
      `select $1::uuid in (select private.network_publish_organisations()) as network,
              $1::uuid in (select private.finance_module_organisations())  as finance,
              $1::uuid in (select private.crm_write_organisations())       as crm`,
      [org],
    );

    // The TypeScript side goes through the SAME two functions the app composes
    // -- resolveEntitlements() then entitlementsPermitNetworkPublish() -- so
    // this measures the composition the pages call, not a re-derivation of it.
    const resolved = resolveEntitlements({
      data: subscription
        ? {
            plan_id: subscription.plan,
            status: subscription.status,
            current_period_end: periodEnd as string,
          }
        : null,
      error: null,
    });
    const networkTs = entitlementsPermitNetworkPublish(resolved);

    // ...and BOTH compositions a page calls, with the permission HELD and the
    // organisation LIVE so the tier term is the only one that can refuse. Their
    // answers must track the database gate exactly, and each other.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(resolved);
    vi.mocked(hasPermission).mockResolvedValue(true);
    const orgArg = {
      id: org,
      name: "Network entitlement probe",
      role: "owner" as const,
      slug: "net-probe",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    };
    const publish = await getNetworkPublishAccess(orgArg);
    const connect = await getNetworkConnectionAccess(orgArg);

    return {
      networkDb: gates!.network,
      networkTs,
      financeDb: gates!.finance,
      crmDb: gates!.crm,
      publishCanWrite: publish.canWrite,
      publishReason: publish.canWrite ? "-" : (publish.reason ?? "-"),
      connectCanWrite: connect.canWrite,
      connectReason: connect.canWrite ? "-" : (connect.reason ?? "-"),
      label: subscription
        ? `${subscription.plan}/${subscription.status}/end+${subscription.periodEndDays}d`
        : "no subscription row",
    };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** Narrow a CrmWriteAccess to its refusal half, failing loudly if it permitted. */
function refusal(result: CrmWriteAccess, label: string): {
  reason: "suspended" | "tier" | "permission";
} {
  if (result.canWrite) {
    throw new Error(`expected ${label} to be REFUSED, but it was permitted`);
  }
  return { reason: result.reason };
}

describe("entitlementsPermitNetworkPublish mirrors private.network_publish_organisations()", () => {
  it("agrees on NO SUBSCRIPTION ROW, which is every organisation today", async () => {
    const r = await bothSides(null);
    expect(
      r.networkDb,
      "the database permits network writes with no subscription row",
    ).toBe(true);
    expect(r.networkTs, r.label).toBe(r.networkDb);
    expect(r.publishCanWrite, `getNetworkPublishAccess: ${r.label}`).toBe(true);
    expect(r.connectCanWrite, `getNetworkConnectionAccess: ${r.label}`).toBe(true);
  });

  it("agrees on every plan at status active, on all three exports", async () => {
    const disagreements: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.networkDb !== r.networkTs) {
        disagreements.push(`${r.label}: db=${r.networkDb} ts=${r.networkTs}`);
      }
      if (r.publishCanWrite !== r.networkDb) {
        disagreements.push(
          `${r.label}: db=${r.networkDb} getNetworkPublishAccess=${r.publishCanWrite}`,
        );
      }
      if (r.connectCanWrite !== r.networkDb) {
        disagreements.push(
          `${r.label}: db=${r.networkDb} getNetworkConnectionAccess=${r.connectCanWrite}`,
        );
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("FREE is the only active plan that CANNOT publish -- with the count as its denominator", async () => {
    // The naked fact underneath the agreement above. Without it, "the two sides
    // agree on every plan" is satisfied by two sides that both say true three
    // times, which is the bug this file's header is about -- and here the
    // permissive direction is the dangerous one, unlike the finance test where
    // it is the restrictive one.
    const permitting: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.networkDb) permitting.push(plan);
    }
    expect(permitting.sort(), `of ${TIER_KEYS.length} plans`).toEqual([
      "pro",
      "starter",
    ]);
  });

  it("DIVERGES from the FINANCE gate on starter/active -- on BOTH sides of the mirror", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. network_publish_organisations() was
    // written by copying finance_module_organisations() and substituting
    // p.finance_module -> p.network_publish (20260904001000's header). A missed
    // substitution is invisible to every other test in the repo: the two
    // helpers agree on free, on pro, on no-subscription, on cancelled and on
    // both sides of the grace window. `starter/active` is the ONLY input that
    // separates them, and it separates them in the direction that matters --
    // Starter would be silently denied the network publishing its plan sells.
    const r = await bothSides({
      plan: "starter",
      status: "active",
      periodEndDays: 30,
    });
    expect(r.financeDb, `${r.label}: Starter has NO finance module`).toBe(false);
    expect(r.networkDb, `${r.label}: Starter DOES carry network_publish`).toBe(
      true,
    );
    expect(r.networkTs, `${r.label}: and TypeScript says the same`).toBe(true);
    expect(r.publishCanWrite, `${r.label}: so the publish control is enabled`).toBe(
      true,
    );
  });

  it("agrees with the CRM gate on every plan -- which is WHY the finance divergence carries this file", async () => {
    // Recorded rather than left implicit. free/starter/pro carry crm_writes
    // false/true/true and network_publish false/true/true, so a
    // network_publish_organisations() that had been copy-pasted from
    // crm_write_organisations() WITHOUT the substitution would be behaviourally
    // undetectable today. That is not a reason to skip the assertion; it is the
    // reason the finance divergence above is the load-bearing one, and this
    // states the coincidence so a future plan change that breaks it (a tier
    // with CRM writes and no network publishing, say) turns this red and tells
    // whoever reads it that a new divergence case is now available.
    const disagreements: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.networkDb !== r.crmDb) {
        disagreements.push(`${r.label}: network=${r.networkDb} crm=${r.crmDb}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("the FREE refusal is the TIER, not the role -- on both write gates", async () => {
    // Q76 at the copy layer. The permission is HELD in bothSides(), so a
    // "permission" reason here would mean the check ORDER had been reversed and
    // a Free-tier Owner would be told to ask an Owner.
    const r = await bothSides({ plan: "free", status: "active", periodEndDays: 30 });
    expect(r.networkDb, `${r.label}: the database refuses`).toBe(false);
    expect(r.publishReason, `${r.label}: publish refusal reason`).toBe("tier");
    expect(r.connectReason, `${r.label}: connect refusal reason`).toBe("tier");
  });

  it("agrees on the past_due grace window, on both sides of its edge", async () => {
    const disagreements: string[] = [];
    for (const days of [-1, -2, -4, -30]) {
      const r = await bothSides({
        plan: "starter",
        status: "past_due",
        periodEndDays: days,
      });
      if (r.networkDb !== r.networkTs) {
        disagreements.push(`${r.label}: db=${r.networkDb} ts=${r.networkTs}`);
      }
      if (r.publishCanWrite !== r.networkDb) {
        disagreements.push(
          `${r.label}: db=${r.networkDb} getNetworkPublishAccess=${r.publishCanWrite}`,
        );
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("the grace window is genuinely OPEN inside it and CLOSED outside it", async () => {
    // Both sides of the edge, as VALUES rather than as an agreement -- a window
    // that never opens and one that never closes both pass the agreement test
    // above, and they are opposite bugs.
    const inside = await bothSides({
      plan: "starter",
      status: "past_due",
      periodEndDays: -1,
    });
    const outside = await bothSides({
      plan: "starter",
      status: "past_due",
      periodEndDays: -4,
    });
    expect(inside.networkDb, inside.label).toBe(true);
    expect(outside.networkDb, outside.label).toBe(false);
  });

  it("agrees on past_due for a plan that cannot publish anyway", async () => {
    // Free inside the grace window: the grace branch keeps the PLAN's
    // entitlements, and Free's is false, so grace grants nothing. Written out
    // because "past_due keeps the paid entitlements" reads like "past_due is
    // permissive" until you name the plan.
    const r = await bothSides({
      plan: "free",
      status: "past_due",
      periodEndDays: -1,
    });
    expect(r.networkDb, r.label).toBe(false);
    expect(r.networkTs, r.label).toBe(r.networkDb);
  });

  it("agrees on EVERY plan x status the column permits -- nine cells, with the count as its denominator", async () => {
    // PHASE 6 TASK 5. The tests above cover every plan at `active`, both sides
    // of the past_due grace edge for `starter`, past_due for `free`, and
    // `cancelled` for `pro`. That is eight of the nine cells the schema can
    // hold and it took five tests to say so -- which means the ninth
    // (`cancelled`/`starter`) was uncovered and nothing in the file made that
    // visible.
    //
    // organisation_subscriptions.status is CHECK-constrained to exactly
    // ('active','past_due','cancelled') (20260826151656:148) and TIER_KEYS is
    // exactly (free, starter, pro), so the product is closed at nine and the
    // count below is a real denominator rather than a number this test chose.
    // The status list is asserted against the constraint itself, so a fourth
    // status added to the column turns this red instead of silently going
    // unswept.
    const {
      rows: [check],
    } = await pool.query<{ src: string }>(
      `select pg_get_constraintdef(c.oid) as src
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'organisation_subscriptions' and c.contype = 'c'
          and pg_get_constraintdef(c.oid) like '%status%'`,
    );
    const statuses = ["active", "past_due", "cancelled"] as const;
    for (const s of statuses) {
      expect(check!.src, `the status CHECK no longer permits ${s}`).toContain(`'${s}'`);
    }
    expect(
      Array.from(check!.src.matchAll(/'[a-z_]+'/g)).length,
      `the status CHECK permits a status this test does not sweep: ${check!.src}`,
    ).toBe(statuses.length);

    const disagreements: string[] = [];
    let cells = 0;
    for (const plan of TIER_KEYS) {
      for (const status of statuses) {
        // The period end is in the FUTURE for every cell, so `past_due` here
        // is INSIDE the grace window -- a subscription whose payment failed
        // but whose paid-for period has not yet elapsed. That is the realistic
        // shape of a card decline and it keeps the plan's entitlements; the
        // EXPIRED side of the edge has its own two tests above.
        const r = await bothSides({ plan, status, periodEndDays: 30 });
        cells += 1;
        if (r.networkDb !== r.networkTs) {
          disagreements.push(`${r.label}: db=${r.networkDb} ts=${r.networkTs}`);
        }
        if (r.publishCanWrite !== r.networkDb) {
          disagreements.push(
            `${r.label}: db=${r.networkDb} getNetworkPublishAccess=${r.publishCanWrite}`,
          );
        }
        if (r.connectCanWrite !== r.networkDb) {
          disagreements.push(
            `${r.label}: db=${r.networkDb} getNetworkConnectionAccess=${r.connectCanWrite}`,
          );
        }
      }
    }
    expect(cells, "plan x status cells driven").toBe(TIER_KEYS.length * statuses.length);
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("...and exactly FOUR of those nine cells permit publishing -- named, not counted", async () => {
    // The naked fact underneath the agreement above, for the same reason the
    // active-plan test carries one: "the two sides agree on nine cells" is
    // satisfied by two sides that both say false nine times, which would deny
    // every paying customer the feature they bought.
    //
    // MEASURED, AND THE TWO past_due CELLS ARE THE POINT. `past_due` with a
    // period end 30 days in the FUTURE is a payment that failed inside a
    // period the customer has already paid for, and
    // isWithinPastDueGrace()/the SQL mirror both keep the PLAN's entitlements
    // there. So a Starter workspace whose card bounced this morning can still
    // publish, and a Free one still cannot -- grace preserves the plan, it
    // does not upgrade it (the free/past_due test below says the same thing
    // from the other side). Naming the four rather than counting them is what
    // makes a future change to the grace branch land here as a legible diff.
    const permitting: string[] = [];
    for (const plan of TIER_KEYS) {
      for (const status of ["active", "past_due", "cancelled"] as const) {
        const r = await bothSides({ plan, status, periodEndDays: 30 });
        if (r.networkDb) permitting.push(`${plan}/${status}`);
      }
    }
    expect(permitting.sort(), "of 9 plan x status cells").toEqual([
      "pro/active",
      "pro/past_due",
      "starter/active",
      "starter/past_due",
    ]);
  });

  it("agrees on cancelled, with the period end still inside a grace window", async () => {
    // The period end is deliberately in the FUTURE, so only the status can deny
    // it. `cancelled` is something the customer chose, so it is honoured at
    // once and gets no grace.
    const r = await bothSides({
      plan: "pro",
      status: "cancelled",
      periodEndDays: 30,
    });
    expect(r.networkDb, r.label).toBe(false);
    expect(r.networkTs, r.label).toBe(r.networkDb);
  });
});

describe("the three checks happen in the order the copy depends on", () => {
  // suspended -> tier -> permission. No database query can see this, and
  // getting it wrong is not a security hole -- it is a WRONG SENTENCE, which is
  // its own kind of defect: telling a suspended workspace's Owner "you do not
  // have permission" is false, and they will go looking for a role change that
  // will not help.
  const suspendedOrg = {
    id: "00000000-0000-0000-0000-0000000000aa",
    name: "Suspended probe",
    role: "owner" as const,
    slug: "suspended-probe",
    isSuspended: true,
    // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
    // these fixtures: nothing here exercises impersonation, and a fixture
    // that quietly claimed to would be asserting about the wrong feature.
    // Phase 7 Task 3 added `lifecycle`. A suspended workspace really does
    // carry one -- getCurrentOrg() never returns isSuspended with a null
    // lifecycle for a member -- so the fixture carries the shape the
    // database would actually produce rather than a convenient null.
    lifecycle: {
      state: "suspended" as const,
      changedAt: "2026-09-08T00:00:00.000Z",
      reason: "fixture",
      retentionExpiresAt: "2026-11-07T00:00:00.000Z",
      networkPresenceUntil: "2026-10-08T00:00:00.000Z",
    },
    isImpersonated: false,
    impersonationExpiresAt: null,
  };

  it("SUSPENDED wins over both the tier and the permission, on both write gates", async () => {
    // The entitlements and the permission are set to their WORST values, so
    // anything but "suspended" would mean the order is wrong.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({ data: null, error: null }),
    );
    vi.mocked(hasPermission).mockResolvedValue(false);
    expect(refusal(await getNetworkPublishAccess(suspendedOrg), "publish").reason).toBe(
      "suspended",
    );
    expect(
      refusal(await getNetworkConnectionAccess(suspendedOrg), "connect").reason,
    ).toBe("suspended");
  });

  it("...and it does not even ASK the permission or the entitlements", async () => {
    // The measurable half of "checked first". A suspended organisation short-
    // circuits before either dependency is touched, which is what makes the
    // sentence reliable rather than incidental.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({ data: null, error: null }),
    );
    vi.mocked(hasPermission).mockResolvedValue(true);
    await getNetworkPublishAccess(suspendedOrg);
    expect(vi.mocked(hasPermission)).not.toHaveBeenCalled();
    expect(vi.mocked(getOrganisationEntitlements)).not.toHaveBeenCalled();
  });

  it("an INDETERMINATE entitlements lookup DISABLES the control (the conservative half)", async () => {
    // A failed lookup disables a button, and disabling is safe. The opposite --
    // failing open in the UI -- would render an enabled control whose write the
    // database then refuses, which is the worst of both.
    expect(
      entitlementsPermitNetworkPublish({
        status: "indeterminate",
        entitlements: { networkPublish: true },
      }),
    ).toBe(false);
  });
});

describe("the READ gate has no tier term, and that is the shape of the Free tier", () => {
  it("getNetworkReadAccess is the permission alone -- a Free workspace still browses", async () => {
    // CLAUDE.md § Subscription tiers: Free is "view-only network browsing". So
    // the read gate must NOT consult the entitlements at all, and neither
    // SELECT policy carries a network_publish term either (20260904003000). A
    // tier term here would invert the product's own pricing.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({
        data: {
          plan_id: "free",
          status: "active",
          current_period_end: new Date(Date.now() + 8.64e7).toISOString(),
        },
        error: null,
      }),
    );
    vi.mocked(hasPermission).mockResolvedValue(true);
    const org = {
      id: "00000000-0000-0000-0000-0000000000bb",
      name: "Free probe",
      role: "read_only" as const,
      slug: "free-probe",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    };
    expect(await getNetworkReadAccess(org)).toBe(true);
    // ...and it did not ask the entitlements to decide that.
    expect(vi.mocked(getOrganisationEntitlements)).not.toHaveBeenCalled();
    expect(vi.mocked(hasPermission)).toHaveBeenCalledWith(org.id, "view_network");
  });

  it("...while the WRITE gate on the same Free workspace refuses on the tier", async () => {
    // The paired control. Without it, "the read gate says true" is satisfied by
    // a helper that says true to everything.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({
        data: {
          plan_id: "free",
          status: "active",
          current_period_end: new Date(Date.now() + 8.64e7).toISOString(),
        },
        error: null,
      }),
    );
    vi.mocked(hasPermission).mockResolvedValue(true);
    const org = {
      id: "00000000-0000-0000-0000-0000000000bb",
      name: "Free probe",
      role: "owner" as const,
      slug: "free-probe",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    };
    expect(refusal(await getNetworkPublishAccess(org), "free publish").reason).toBe(
      "tier",
    );
  });
});
