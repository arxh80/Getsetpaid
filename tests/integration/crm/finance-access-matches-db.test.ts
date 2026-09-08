// The tripwire for entitlementsPermitFinance(), the SEVENTH constant-shaped
// rule in this codebase to exist in two languages at once, and the finance
// sibling of crm-write-access-matches-db.test.ts:
//
//   private.crm_write_organisations()      vs entitlementsPermitCrmWrites()
//   private.finance_module_organisations() vs entitlementsPermitFinance()  <- here
//
// ===========================================================================
// WHY THIS IS NOT A COPY OF THE CRM ONE WITH A WORD CHANGED
// ===========================================================================
// It is the same SHAPE and a different ANSWER, and the difference is the point.
// Both helpers carry the same "no subscription row => not yet billed => not yet
// gated" escape and the same past_due grace branch, so on most inputs they
// agree -- and on exactly one input they must NOT: `starter/active` carries
// crm_writes = true and finance_module = false. A finance helper that was
// copy-pasted from the CRM one (which is how it was written -- 20260903001000's
// header says so in as many words) and left reading `p.crm_writes` would agree
// with the CRM gate everywhere, agree with TypeScript everywhere, pass every
// assertion the CRM test makes, and silently give every Starter workspace the
// Pro finance module. THE DIVERGENCE TEST BELOW IS THE ONE THAT CATCHES THAT,
// and it is asserted on BOTH sides of the mirror.
//
// ===========================================================================
// AND THE MIRROR IS BACKWARDS FROM THE NAIVE READING, SAME AS THE CRM ONE
// ===========================================================================
// lib/entitlements/policy.ts resolves an organisation with NO subscription row
// to { status: "no-subscription", tier: "free" }, and TIER_MATRIX.free
// .financeModule is FALSE. private.finance_module_organisations() says the
// opposite for that case, deliberately -- STILL, as of Phase 7 Task A
// (2026-09-08): that task closed the identical escape on private.
// crm_write_organisations() and private.custom_field_limit() (and their
// TypeScript mirrors), but this one and private.network_publish_
// organisations()'s twin are a deliberate, separate follow-up (FOLLOW-UPS.md
// § "Phase 7 -- superuser dashboard"). public.create_organisation() NOW writes
// a Starter subscription row at birth, so "no subscription row" is no longer
// the state every organisation in the product is in -- the organisation this
// test drives is planted by a direct insert into public.organisations
// (`bothSides()` below), bypassing create_organisation() on purpose, which is
// the only way left to reach that state at all. It remains true that reading
// `financeModule` straight off the resolved entitlements for an organisation
// in that state -- the obvious thing -- would disable its finance controls
// while the database happily accepted the write from anything that bypassed
// the UI.
//
// If this file goes red because a future task removed the
// `s.organisation_id is null` escape from private.finance_module_
// organisations(), the fix is to remove it from lib/crm/finance-access.ts in
// the same change -- not to relax the test. (This is exactly what happened to
// tests/integration/crm/crm-write-access-matches-db.test.ts in Task A.)
//
// ===========================================================================
// BOTH EXPORTS, NOT JUST THE PURE ONE
// ===========================================================================
// entitlementsPermitFinance() is pure and is driven directly. getFinanceWriteAccess()
// is the composition the pages actually call, and its VALUE is the ORDER of its
// three checks (suspended -> tier -> permission), which no database query can
// see. It is driven here with its two dependencies mocked -- hasPermission and
// getOrganisationEntitlements -- so the entitlements half is the REAL
// resolveEntitlements() output for the REAL subscription row planted in
// Postgres, and only the session is synthetic.
//
// LOCAL ONLY, everything rolled back. env.ts refuses anything that is not the
// loopback stack.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { TIER_KEYS } from "@/lib/entitlements/tiers";
import type { CrmWriteAccess } from "@/lib/crm/write-access";

// The two dependencies getFinanceWriteAccess composes. Everything else in both
// modules -- including resolveEntitlements, which produces the value fed to the
// mock -- stays real.
vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, hasPermission: vi.fn() };
});
vi.mock("@/lib/entitlements/policy", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/entitlements/policy")>();
  return { ...actual, getOrganisationEntitlements: vi.fn() };
});

const { entitlementsPermitFinance, getFinanceWriteAccess } = await import(
  "@/lib/crm/finance-access"
);
const { resolveEntitlements, getOrganisationEntitlements } = await import(
  "@/lib/entitlements/policy"
);
const { hasPermission } = await import("@/lib/auth");

/**
 * Narrow a CrmWriteAccess to its refusal half.
 *
 * The type is a discriminated union, so `result.reason` is unreachable until
 * `canWrite` is proven false -- and `expect(...).toBe(false)` is a runtime
 * assertion the compiler cannot read. This does the narrowing and fails loudly
 * (rather than returning undefined) if the call unexpectedly succeeded, which
 * is what keeps every "the reason is X" assertion below non-vacuous.
 */
function refusal(result: CrmWriteAccess, label: string): {
  reason: "suspended" | "tier" | "permission";
  explanation: string;
} {
  if (result.canWrite) {
    throw new Error(`expected ${label} to be REFUSED, but it was permitted`);
  }
  return { reason: result.reason, explanation: result.explanation };
}

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
  /**
   * Offset from now, in days, for current_period_end.
   *
   * REQUIRED, unlike the sibling crm-write-access-matches-db.test.ts's optional
   * version: organisation_subscriptions.current_period_end is NOT NULL, so a
   * null-column case cannot be planted at all -- proved by the NOT NULL test
   * below rather than left as an unreachable branch here.
   */
  periodEndDays: number;
}

interface Sides {
  /** `org in (select private.finance_module_organisations())`, as the caller. */
  financeDb: boolean;
  /** entitlementsPermitFinance(resolveEntitlements(row)). */
  financeTs: boolean;
  /** `org in (select private.crm_write_organisations())`, the same caller. */
  crmDb: boolean;
  /** getFinanceWriteAccess() with the permission held and the org live. */
  accessCanWrite: boolean;
  accessReason: string;
  label: string;
}

/**
 * One organisation, one active Owner membership, and optionally one
 * subscription row. Asks BOTH implementations of the finance gate -- and, for
 * the divergence assertions, the CRM gate on the same row -- then rolls the
 * whole thing back.
 *
 * The database side is asked THE WAY A POLICY ASKS IT ("is this org in
 * private.finance_module_organisations()") under `set local role authenticated`
 * with real `request.jwt.claims`, not by reading the function's source. Task 2
 * of the events phase established why: a source guard could not see `<` changed
 * to `<=`, and a test that rebuilds the expression proves only that two things
 * the test wrote agree.
 *
 * aal2, because private.role_requires_mfa('finance') is true and the whole
 * helper hangs off a membership the caller must actually hold. The MFA gate
 * itself is proved in supabase/tests/rls_phase5_finance.sql section FF; this
 * file is about the entitlement term.
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
               'fin-' || gen_random_uuid() || '@example.test',
               'x', now(), now(), now())
       returning id as uid`,
    );
    const uid = user!.uid;
    const {
      rows: [orgRow],
    } = await client.query<{ org: string }>(
      `insert into public.organisations (name, slug)
       values ('Finance entitlement probe',
               'fin-' || replace(gen_random_uuid()::text, '-', ''))
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
    } = await client.query<{ finance: boolean; crm: boolean }>(
      `select $1::uuid in (select private.finance_module_organisations()) as finance,
              $1::uuid in (select private.crm_write_organisations())      as crm`,
      [org],
    );

    // The TypeScript side goes through the SAME two functions the app composes
    // -- resolveEntitlements() then entitlementsPermitFinance() -- so this
    // measures the composition the pages call, not a re-derivation of it.
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
    const financeTs = entitlementsPermitFinance(resolved);

    // ...and getFinanceWriteAccess, the thing a page calls, with the permission
    // HELD and the organisation LIVE so the tier term is the only one that can
    // refuse. Its answer must track the database gate exactly.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(resolved);
    vi.mocked(hasPermission).mockResolvedValue(true);
    const access = await getFinanceWriteAccess({
      id: org,
      name: "Finance entitlement probe",
      role: "owner",
      slug: "fin-probe",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    });

    return {
      financeDb: gates!.finance,
      financeTs,
      crmDb: gates!.crm,
      accessCanWrite: access.canWrite,
      accessReason: access.canWrite ? "-" : (access.reason ?? "-"),
      label: subscription
        ? `${subscription.plan}/${subscription.status}/end+${subscription.periodEndDays}d`
        : "no subscription row",
    };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

describe("entitlementsPermitFinance mirrors private.finance_module_organisations()", () => {
  it("agrees on NO SUBSCRIPTION ROW, which is every organisation today", async () => {
    const r = await bothSides(null);
    expect(
      r.financeDb,
      "the database permits finance writes with no subscription row",
    ).toBe(true);
    expect(r.financeTs, r.label).toBe(r.financeDb);
    expect(r.accessCanWrite, `getFinanceWriteAccess: ${r.label}`).toBe(true);
  });

  it("agrees on every plan at status active", async () => {
    const disagreements: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.financeDb !== r.financeTs) {
        disagreements.push(`${r.label}: db=${r.financeDb} ts=${r.financeTs}`);
      }
      if (r.accessCanWrite !== r.financeDb) {
        disagreements.push(
          `${r.label}: db=${r.financeDb} getFinanceWriteAccess=${r.accessCanWrite}`,
        );
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("PRO is the only active plan that permits finance -- with the count as its denominator", async () => {
    // The naked fact underneath the agreement above. Without it, "the two sides
    // agree on every plan" is satisfied by two sides that both say false three
    // times, which is the bug this file's header is about.
    const permitting: string[] = [];
    for (const plan of TIER_KEYS) {
      const r = await bothSides({ plan, status: "active", periodEndDays: 30 });
      if (r.financeDb) permitting.push(plan);
    }
    expect(permitting, `of ${TIER_KEYS.length} plans`).toEqual(["pro"]);
  });

  it("DIVERGES from the CRM gate on starter/active -- on BOTH sides of the mirror", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. finance_module_organisations() was
    // written by copying crm_write_organisations() and substituting
    // p.crm_writes -> p.finance_module (20260903001000's header). A missed
    // substitution is invisible to every other test in the repo: the two
    // helpers agree on free, on pro, on no-subscription, on cancelled and on
    // both sides of the grace window. `starter/active` is the ONLY input that
    // separates them, and it separates them in the direction that matters --
    // Starter would silently get the Pro finance module.
    const r = await bothSides({
      plan: "starter",
      status: "active",
      periodEndDays: 30,
    });
    expect(r.crmDb, `${r.label}: Starter carries crm_writes`).toBe(true);
    expect(r.financeDb, `${r.label}: Starter does NOT carry finance_module`).toBe(
      false,
    );
    expect(r.financeTs, `${r.label}: and TypeScript says the same`).toBe(false);
    expect(r.accessReason, `${r.label}: the refusal is the TIER, not the role`).toBe(
      "tier",
    );
  });

  it("agrees on the past_due grace window, on both sides of its edge", async () => {
    // The window itself is bound by past-due-grace-matches-db.test.ts. What is
    // asserted here is that the FINANCE answer follows it -- a different
    // composition, which can drift on its own, and which is a separate branch
    // of the SQL function from the `status = 'active'` one above.
    const disagreements: string[] = [];
    for (const days of [-1, -2, -4, -30]) {
      const r = await bothSides({
        plan: "pro",
        status: "past_due",
        periodEndDays: days,
      });
      if (r.financeDb !== r.financeTs) {
        disagreements.push(`${r.label}: db=${r.financeDb} ts=${r.financeTs}`);
      }
      if (r.accessCanWrite !== r.financeDb) {
        disagreements.push(
          `${r.label}: db=${r.financeDb} getFinanceWriteAccess=${r.accessCanWrite}`,
        );
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("the grace window is genuinely OPEN inside it and CLOSED outside it", async () => {
    // Both sides of the edge, as VALUES rather than as an agreement -- a window
    // that never opens and one that never closes both pass the agreement test
    // above, and they are opposite bugs (rls_phase2_crm.sql section N makes the
    // same point for the CRM gate).
    const inside = await bothSides({
      plan: "pro",
      status: "past_due",
      periodEndDays: -1,
    });
    const outside = await bothSides({
      plan: "pro",
      status: "past_due",
      periodEndDays: -4,
    });
    expect(inside.financeDb, inside.label).toBe(true);
    expect(outside.financeDb, outside.label).toBe(false);
  });

  it("agrees on past_due for a plan that has no finance module anyway", async () => {
    // Starter inside the grace window: the grace branch keeps the PLAN's
    // entitlements, and Starter's finance entitlement is false, so grace grants
    // nothing. Written out because "past_due keeps the paid entitlements" reads
    // like "past_due is permissive" until you name the plan.
    const r = await bothSides({
      plan: "starter",
      status: "past_due",
      periodEndDays: -1,
    });
    expect(r.financeDb, r.label).toBe(false);
    expect(r.financeTs, r.label).toBe(r.financeDb);
  });

  it("agrees on cancelled, with the period end still inside a grace window", async () => {
    // The period end is deliberately in the FUTURE, so only the status can deny
    // it. Same construction as rls_phase2_crm.sql N15.
    const r = await bothSides({
      plan: "pro",
      status: "cancelled",
      periodEndDays: 30,
    });
    expect(r.financeDb, r.label).toBe(false);
    expect(r.financeTs, r.label).toBe(r.financeDb);
  });

  it("cannot be handed a NULL current_period_end at all -- the column forbids it", async () => {
    // 20260903001000's header calls the grace branch "NULL-safe by three-valued
    // logic: a NULL period end makes the grace comparison NULL, which is not
    // true, which denies". MEASURED, that branch is unreachable from the
    // database side: the column is NOT NULL, so the state it defends against
    // cannot be stored. Written as a probe rather than as a claim, because the
    // first draft of this test tried to plant the row and was refused by the
    // constraint -- the honest finding, recorded here rather than smoothed into
    // a passing assertion about a case that cannot happen.
    //
    // If a later migration makes the column nullable, this test goes red and
    // the three-valued-logic branch becomes live and needs its own case.
    const client = await pool.connect();
    try {
      await client.query("begin");
      const {
        rows: [col],
      } = await client.query<{ nullable: string }>(
        `select is_nullable as nullable from information_schema.columns
          where table_schema='public' and table_name='organisation_subscriptions'
            and column_name='current_period_end'`,
      );
      expect(col!.nullable, "organisation_subscriptions.current_period_end").toBe(
        "NO",
      );
      await expect(
        client.query(
          `insert into public.organisation_subscriptions
             (organisation_id, plan_id, status, billing_cycle, seat_count,
              current_period_end)
           values (gen_random_uuid(), 'pro', 'past_due', 'monthly', 1, null)`,
        ),
      ).rejects.toThrow(/not-null constraint/);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }

    // ...and the TypeScript half, where a NULL CAN arrive (the resolver takes
    // whatever the query returned), still denies. That is the reachable half,
    // so it is the half that is driven.
    expect(
      entitlementsPermitFinance(
        resolveEntitlements({
          data: {
            plan_id: "pro",
            status: "past_due",
            current_period_end: null as unknown as string,
          },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("covers every status the column permits -- with the allowlist as its denominator", async () => {
    // The denominator for "every subscription status": the CHECK on
    // organisation_subscriptions.status is a THIRD allowlist alongside the SQL
    // function's and the TypeScript resolver's, and it is the narrowest. This
    // reads it out of the database and drives each value, so a fourth status
    // added later fails HERE (unhandled) rather than passing silently.
    const client = await pool.connect();
    let statuses: string[];
    try {
      const { rows } = await client.query<{ s: string }>(
        `select (regexp_matches(pg_get_constraintdef(oid),
                                '''([a-z_]+)''::text', 'g'))[1] as s
           from pg_constraint
          where conrelid = 'public.organisation_subscriptions'::regclass
            and conname = 'organisation_subscriptions_status_check'`,
      );
      statuses = rows.map((r) => r.s).filter(Boolean);
    } finally {
      client.release();
    }
    expect(statuses.sort(), "the status allowlist read out of the CHECK").toEqual(
      ["active", "cancelled", "past_due"],
    );

    const disagreements: string[] = [];
    for (const status of statuses) {
      const r = await bothSides({ plan: "pro", status, periodEndDays: 30 });
      if (r.financeDb !== r.financeTs) {
        disagreements.push(`${r.label}: db=${r.financeDb} ts=${r.financeTs}`);
      }
    }
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });

  it("denies on an INDETERMINATE lookup, which is deliberately NOT what the database does", async () => {
    // The one place the mirror is asymmetric, and it is asymmetric on purpose.
    // A failed subscription query in the application is not the same event as a
    // missing row in the database, and the consequences differ: here it
    // disables a button, there it would open a gate. Asserted so "deliberate"
    // is a fact in the suite rather than a claim in a comment.
    expect(
      entitlementsPermitFinance(
        resolveEntitlements({ data: null, error: { message: "boom" } }),
      ),
    ).toBe(false);
  });

  it("getFinanceWriteAccess checks SUSPENDED before TIER, and TIER before PERMISSION", async () => {
    // The order is load-bearing and stated in lib/crm/finance-access.ts's
    // header: asking the permission first would tell a suspended workspace's
    // Owner "you do not have permission", which is false and unactionable. No
    // database query can see an ORDER, so it is asserted here, at the only
    // layer that has one.
    //
    // Every case below is a real refusal with the OTHER terms also failing, so
    // the assertion is about precedence rather than about a single gate.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({
        data: {
          plan_id: "starter",
          status: "active",
          current_period_end: new Date(Date.now() + 8.64e7).toISOString(),
        },
        error: null,
      }),
    );
    vi.mocked(hasPermission).mockResolvedValue(false);

    const suspended = await getFinanceWriteAccess({
      id: "00000000-0000-0000-0000-0000000000aa",
      name: "x",
      role: "owner",
      slug: "x",
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
    });
    expect(
      refusal(suspended, "a suspended workspace").reason,
      "suspension outranks both other terms",
    ).toBe("suspended");

    const tier = await getFinanceWriteAccess({
      id: "00000000-0000-0000-0000-0000000000aa",
      name: "x",
      role: "owner",
      slug: "x",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    });
    expect(
      refusal(tier, "a Starter workspace whose caller also lacks the key").reason,
      "tier outranks permission",
    ).toBe("tier");

    // ...and with the tier satisfied, the permission is what is left.
    vi.mocked(getOrganisationEntitlements).mockResolvedValue(
      resolveEntitlements({ data: null, error: null }),
    );
    const permission = await getFinanceWriteAccess({
      id: "00000000-0000-0000-0000-0000000000aa",
      name: "x",
      role: "read_only",
      slug: "x",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    });
    expect(refusal(permission, "a read_only caller on an ungated plan").reason).toBe(
      "permission",
    );

    // CONTROL: all three satisfied, so the three refusals above are each a
    // term and not a function that always refuses.
    vi.mocked(hasPermission).mockResolvedValue(true);
    const allowed = await getFinanceWriteAccess({
      id: "00000000-0000-0000-0000-0000000000aa",
      name: "x",
      role: "finance",
      slug: "x",
      isSuspended: false,
      // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
      // these fixtures: nothing here exercises impersonation, and a fixture
      // that quietly claimed to would be asserting about the wrong feature.
      // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
      // every fixture here is.
      lifecycle: null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    });
    expect(allowed.canWrite).toBe(true);
  });

  it("every refusal carries an explanation, and the three are distinct", async () => {
    // CrmWriteAccess's contract: the sentence next to a disabled control and
    // the sentence after a submitted form are the same string. Three refusals
    // sharing one explanation would make "why" useless without failing a type
    // check.
    const seen = new Map<string, string>();
    const cases: Array<[string, () => Promise<CrmWriteAccess>]> =
      [
        [
          "suspended",
          async () => {
            vi.mocked(getOrganisationEntitlements).mockResolvedValue(
              resolveEntitlements({ data: null, error: null }),
            );
            vi.mocked(hasPermission).mockResolvedValue(true);
            return getFinanceWriteAccess({
              id: "00000000-0000-0000-0000-0000000000aa",
              name: "x",
              role: "owner",
              slug: "x",
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
            });
          },
        ],
        [
          "tier",
          async () => {
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
            return getFinanceWriteAccess({
              id: "00000000-0000-0000-0000-0000000000aa",
              name: "x",
              role: "owner",
              slug: "x",
              isSuspended: false,
              // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
              // these fixtures: nothing here exercises impersonation, and a fixture
              // that quietly claimed to would be asserting about the wrong feature.
              // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
              // every fixture here is.
              lifecycle: null,
              isImpersonated: false,
              impersonationExpiresAt: null,
            });
          },
        ],
        [
          "permission",
          async () => {
            vi.mocked(getOrganisationEntitlements).mockResolvedValue(
              resolveEntitlements({ data: null, error: null }),
            );
            vi.mocked(hasPermission).mockResolvedValue(false);
            return getFinanceWriteAccess({
              id: "00000000-0000-0000-0000-0000000000aa",
              name: "x",
              role: "booker",
              slug: "x",
              isSuspended: false,
              // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
              // these fixtures: nothing here exercises impersonation, and a fixture
              // that quietly claimed to would be asserting about the wrong feature.
              // Phase 7 Task 3 added `lifecycle`: null for an ACTIVE workspace, which
              // every fixture here is.
              lifecycle: null,
              isImpersonated: false,
              impersonationExpiresAt: null,
            });
          },
        ],
      ];

    for (const [expected, run] of cases) {
      const refused = refusal(await run(), expected);
      expect(refused.reason, expected).toBe(expected);
      expect(refused.explanation, expected).toBeTruthy();
      seen.set(expected, refused.explanation);
    }
    expect(seen.size, "three refusal reasons inspected").toBe(3);
    expect(
      new Set(seen.values()).size,
      "and three DISTINCT explanations among them",
    ).toBe(3);
  });
});
