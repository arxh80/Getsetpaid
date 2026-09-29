import "server-only";

// Server helper resolving an organisation's live subscription entitlements.
//
// CLAUDE.md § Permissions: entitlement is one of the five factors an action
// must satisfy (platform policy ∩ subscription entitlement ∩ organisation
// role ∩ record scope ∩ user-specific exception), and "entitlements are
// enforced server-side -- hiding UI is not enforcement." This file is the
// subscription-entitlement factor. It deliberately ships no gate/paywall
// component and no feature-specific check -- there is no CRM entity yet for
// any of that to gate (Phase 2 builds those). The deliverable here is only
// the read: organisation_subscriptions joined to subscription_plans,
// resolved to a TierEntitlements shape later phases can build gates on top
// of.
//
// THE DATABASE IS AUTHORITATIVE. lib/entitlements/tiers.ts's TIER_MATRIX is
// a compile-time mirror, not a second source of truth -- every real decision
// below reads Postgres through the caller's own RLS-scoped client (see
// lib/supabase/server.ts), the same way lib/auth/index.ts's getCurrentOrg()
// resolves a client-supplied org id: the query is RLS-scoped
// (organisation_subscriptions_select_member requires active membership), so
// a foreign or non-existent organisationId simply returns no row rather than
// someone else's subscription. This file adds no parallel org-resolution
// path -- callers are expected to have already resolved/authorised the
// organisationId (e.g. via lib/auth's getCurrentOrg()) before asking for its
// entitlements.
//
// THREE OUTCOMES, DELIBERATELY NOT COLLAPSED INTO ONE:
//   "no-subscription"  organisation_subscriptions has no row for this org.
//                       BEFORE PHASE 7 TASK A this was legitimate and
//                       expected -- create_organisation() did not also
//                       create a subscription row, so every organisation
//                       was in this state. Task A made create_organisation()
//                       write a Starter row at birth and backfilled one onto
//                       every organisation that predates it
//                       (20260908000000), so this state should not occur for
//                       a real organisation any more -- it is handled the
//                       same way (Free's entitlements, not an error) because
//                       collapsing it into "indeterminate" would treat a
//                       clean empty query result the same as a failed one,
//                       but reaching it now most likely means the invariant
//                       above was violated rather than that billing has not
//                       started yet.
//   "resolved"          A subscription row exists. Its plan's entitlements
//                       apply if status = 'active'; otherwise (see below)
//                       Free's entitlements apply, still under "resolved"
//                       because the query itself succeeded.
//   "indeterminate"      The query errored, or returned a plan_id this
//                       mirror does not recognise. NOT silently treated as
//                       Free (that would misrepresent a real failure as a
//                       legitimate empty state) and NOT thrown as an
//                       exception a caller might let slip past a decision
//                       point. The safe-default `entitlements` field is
//                       still populated -- with Free's, the most
//                       restrictive shape available -- so a caller that
//                       forgets to branch on `status` fails toward denial,
//                       not toward granting Pro-shaped trust to a query
//                       that never actually resolved.
//
// This is the SAME asymmetry lib/auth/mfa-gate.ts's roleCheckRequiresMfa()
// draws, and deliberately does NOT copy lib/auth/index.ts:126's
// getMemberships(), which still collapses a real query error and a genuine
// zero-row result into the same `[]` -- a known, already-flagged wart in
// that file, not a pattern worth propagating into a new one.
//
// STATUS GATING (founder decision, 2026-08-28): 'active' grants the plan's
// entitlements outright. 'past_due' keeps them for a 3-DAY GRACE WINDOW, then
// falls back to Free. 'cancelled' falls back to Free immediately, with no
// grace at all.
//
// Why the two non-active statuses are treated differently: 'cancelled' is
// something the customer chose, so honouring it at once is respecting a
// decision. 'past_due' is something that happened TO them -- a card expired,
// a bank declined a routine renewal -- and taking a paying customer's
// features away the same hour their card bounced punishes them for their
// bank's timing. Three days is enough for a retry to clear or for someone to
// update a card, and short enough that it is not a free month.
//
// Falling back to Free when the grace expires still satisfies CLAUDE.md
// § Subscription tiers: downgrading "makes features read-only or limited; it
// must never silently delete data" -- Free limits what a user can do and
// deletes no rows.
//
// GRACE IS MEASURED FROM current_period_end, and that deserves stating
// plainly because it is a proxy, not the real thing. The honest clock would
// start when the subscription actually entered past_due, but no column
// records that -- organisation_subscriptions has no `past_due_since`. In the
// ordinary case the two coincide: a renewal is attempted at period end and
// fails, so period end IS when the trouble started. Where they diverge, the
// proxy is conservative in the customer's favour, never against them.
//
// When a payment processor is wired (Phase 7 / open decision), its webhook
// knows the real transition moment: add an explicit `past_due_since` or
// `grace_expires_at` column then and measure from it. Do not keep deriving
// the grace from period end once something better is available.
//
// BUILT HERE AS OF PHASE 7 TASK 4: billing overrides.
//
// organisation_subscriptions.comp_expires_at (Foundation schema) was never
// wired to anything -- it names no column recording which tier a comp should
// revert TO, so "auto-revert to the org's actual paid tier" was never
// expressible from it. Task 4 does not use that column at all: it adds a
// SEPARATE table, organisation_billing_overrides, precisely because writing
// an override into organisation_subscriptions's own row would be the "silent
// permanent edit" CLAUDE.md forbids -- there would be nothing left recording
// the org's real plan once the override lapsed. comp_expires_at stays
// unused; a future task that wants to retire it can, without this file
// depending on it.
//
// getOrganisationEntitlements() below now also asks whether an ACTIVE
// billing override exists (organisation_billing_overrides, filtered exactly
// as private.active_billing_override() filters it: not revoked, started,
// not yet expired) and, if one names a tier, resolveEntitlements() uses that
// tier's entitlements OUTRIGHT -- bypassing the subscription's own status
// entirely. That is deliberate: an override exists specifically to grant a
// tier's features regardless of billing state (a goodwill extension to a
// cancelled account, a Pro trial for a Starter customer), so gating it on
// the very status it is meant to override would defeat it. Auto-revert is
// READ-TIME EXPIRY -- once `expires_at` passes, the query above simply stops
// returning the row, and resolution falls straight back to the real
// subscription with nothing to write. private.effective_organisation_plan()
// is the SQL-side twin of this same rule;
// tests/integration/entitlements/billing-override-matches-db.test.ts binds
// the two, including the override-active and override-expired cases.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { TIER_MATRIX, isTierKey, type TierEntitlements, type TierKey } from "./tiers";

export type EntitlementsStatus = "no-subscription" | "resolved" | "indeterminate";

/**
 * A currently-ACTIVE billing override, as `getOrganisationEntitlements()`
 * reads it -- i.e. already filtered to "not revoked, started, not yet
 * expired" (organisation_billing_overrides_select_member / private.
 * active_billing_override()'s predicate). Never pass a revoked or expired
 * row here: the caller is responsible for the filter, this type carries no
 * flag to re-check it.
 */
export interface ActiveBillingOverride {
  /** The overridden tier, or null for a seats-only override (which does not
   * change tier resolution -- see resolveEntitlements()). */
  readonly tier: TierKey | null;
  /** The overridden seat count. Carried through for completeness/audit only
   * -- no gate in this schema enforces a seat ceiling today (the real
   * subscription's own seat_count isn't consumed by any gate either), so
   * this has no effect on `entitlements` below. */
  readonly seats: number | null;
}

export interface EntitlementsResult {
  status: EntitlementsStatus;
  /** The resolved tier, or null when `status` is "indeterminate" -- there is
   * no real tier to report, only the safe default below. */
  tier: TierKey | null;
  /** Always populated with a safe, well-formed value. On "indeterminate"
   * this is deliberately Free's entitlements (the most restrictive shape),
   * not a guess -- a caller that reads only this field, without branching on
   * `status`, still fails toward denial rather than toward granting access a
   * failed query never actually confirmed. */
  entitlements: TierEntitlements;
  /** True iff an ACTIVE billing override (rather than the organisation's own
   * subscription) is what produced `tier`/`entitlements`. False for a
   * seats-only override, which does not change tier resolution. */
  override: boolean;
}

/** The shape of the single-row query result this module's decision logic
 * operates on -- PostgREST's own {data, error}, narrowed to the two columns
 * actually read. */
interface SubscriptionQueryResult {
  data: {
    plan_id: string;
    status: string;
    /** ISO 8601, UTC. The clock the past_due grace window is measured from --
     * see the STATUS GATING note above this file's imports for why this is a
     * proxy for the real transition moment and what should replace it. */
    current_period_end: string;
  } | null;
  error: { message: string } | null;
}

/** How long a past_due subscription keeps its paid entitlements before
 * falling back to Free. Founder decision, 2026-08-28. */
export const PAST_DUE_GRACE_DAYS = 3;

const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Is a past_due subscription still inside its grace window?
 *
 * Fails CLOSED on an unparseable or missing timestamp: a row whose
 * current_period_end cannot be read is not evidence that grace applies, and
 * "could not determine" must never be the branch that keeps paid features
 * switched on. Same asymmetry the MFA gate draws.
 */
export function isWithinPastDueGrace(
  currentPeriodEnd: string,
  now: number = Date.now(),
): boolean {
  const periodEnd = Date.parse(currentPeriodEnd);
  if (Number.isNaN(periodEnd)) {
    console.error(
      `[entitlements] organisation_subscriptions.current_period_end "${currentPeriodEnd}" is not a parseable timestamp; treating the past_due grace window as expired rather than granting paid entitlements on an unreadable date.`,
    );
    return false;
  }
  return now < periodEnd + PAST_DUE_GRACE_MS;
}

/**
 * Pure decision: given the organisation_subscriptions query's own
 * {data, error} shape (and, since Phase 7 Task 4, a currently-active billing
 * override if one exists), what entitlements apply?
 *
 * Extracted as a pure function -- same motive as
 * lib/auth/mfa-gate.ts's roleCheckRequiresMfa() -- so the three-way
 * "no row" / "row" / "error" split (including the active-vs-not status
 * branch, the unknown-plan_id fail-closed branch, and now the override
 * branch) is unit-testable (tests/unit/entitlements/policy.test.ts) without
 * provoking a real PostgREST failure through the integration harness.
 *
 * THE OVERRIDE IS CHECKED FIRST AND WINS OUTRIGHT. An override naming a tier
 * bypasses the subscription's status entirely -- even a `result.error` or a
 * cancelled subscription does not stop it, because the whole point of a
 * superuser override is to grant a tier's features regardless of the
 * organisation's own billing state. This exactly mirrors private.
 * effective_organisation_plan()'s status_ok, which is true the instant an
 * override is active regardless of the real subscription's status.
 */
export function resolveEntitlements(
  result: SubscriptionQueryResult,
  now: number = Date.now(),
  override: ActiveBillingOverride | null = null,
): EntitlementsResult {
  if (override?.tier) {
    return {
      status: "resolved",
      tier: override.tier,
      entitlements: TIER_MATRIX[override.tier],
      override: true,
    };
  }

  if (result.error) {
    return {
      status: "indeterminate",
      tier: null,
      entitlements: TIER_MATRIX.free,
      override: false,
    };
  }

  if (!result.data) {
    return {
      status: "no-subscription",
      tier: "free",
      entitlements: TIER_MATRIX.free,
      override: false,
    };
  }

  const { plan_id: planId, status, current_period_end: currentPeriodEnd } = result.data;

  // 'cancelled' -- and any status this mirror does not recognise -- falls back
  // to Free at once. Only 'past_due' earns the grace window, and only while it
  // lasts. See the STATUS GATING note above this file's imports.
  const inGrace = status === "past_due" && isWithinPastDueGrace(currentPeriodEnd, now);

  if (status !== "active" && !inGrace) {
    return {
      status: "resolved",
      tier: "free",
      entitlements: TIER_MATRIX.free,
      override: false,
    };
  }

  if (!isTierKey(planId)) {
    // subscription_plans.key is only FK-constrained to exist in that table,
    // not to be one of the three keys this mirror currently knows about.
    // Fail closed rather than trust an unrecognised plan_id.
    console.error(
      `[entitlements] organisation_subscriptions.plan_id "${planId}" is not a key TIER_MATRIX recognises; failing to indeterminate/free-shaped-deny.`,
    );
    return {
      status: "indeterminate",
      tier: null,
      entitlements: TIER_MATRIX.free,
      override: false,
    };
  }

  return {
    status: "resolved",
    tier: planId,
    entitlements: TIER_MATRIX[planId],
    override: false,
  };
}

/**
 * The signed-in caller's live entitlements for one organisation.
 *
 * `organisationId` is exactly as untrusted as any client-supplied org id
 * elsewhere in this codebase (CLAUDE.md § Tenancy model) -- see the file
 * header for why that is safe here: the query is RLS-scoped, not this
 * function.
 *
 * Wrapped in React's `cache()` so repeated calls for the same org within one
 * render are one round trip, matching lib/auth/index.ts's and
 * lib/auth/mfa-gate.ts's convention. `cache()` keys on argument identity, so
 * two different organisationId values are cached separately within the same
 * request -- correct for a multi-org workspace switcher.
 */
export const getOrganisationEntitlements = cache(
  async (organisationId: string): Promise<EntitlementsResult> => {
    const supabase = await createClient();
    const nowIso = new Date().toISOString();

    // BOTH ROUND TRIPS AT ONCE: neither answer depends on the other. The
    // override query reads organisation_billing_overrides under the
    // caller's own RLS (organisation_billing_overrides_select_member --
    // ANY active member, not just Owner/Admin, per that policy's own
    // comment: every role's entitlement resolution needs to see an active
    // override or it would silently not apply to anyone but an admin's own
    // page loads) and applies the SAME "currently active" predicate private.
    // active_billing_override() applies in SQL: not revoked, started, not
    // yet expired.
    const [subscription, overrideRow] = await Promise.all([
      supabase
        .from("organisation_subscriptions")
        .select("plan_id, status, current_period_end")
        .eq("organisation_id", organisationId)
        .maybeSingle(),
      supabase
        .from("organisation_billing_overrides")
        .select("override_tier, override_seats")
        .eq("organisation_id", organisationId)
        .is("revoked_at", null)
        .lte("starts_at", nowIso)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    // A FAILED OVERRIDE READ IS TREATED AS "NO OVERRIDE", NOT AS AN ERROR
    // THAT PROPAGATES -- and the trade-off is stated honestly rather than
    // claimed away (review M2 corrected this comment's first version, which
    // asserted "an override only ever GRANTS more" -- false: a DOWNGRADE
    // override deliberately lowers the effective tier, see
    // OVERRIDE_TIER_CHOICES). For an UPGRADE override this direction is
    // conservative (denies the extra grant rather than inventing one from an
    // unconfirmed read). For a DOWNGRADE override it transiently fails toward
    // the org's HIGHER real tier at the app layer -- accepted as the least-bad
    // direction because the alternative (propagating the error) would deny
    // the whole org on any transient failure, the failure lasts only as long
    // as the read failure does, and the SQL gates remain the enforcement: any
    // actual DB write is still refused by private.effective_organisation_plan()
    // regardless of what this layer resolved.
    let override: ActiveBillingOverride | null = null;
    if (overrideRow.error) {
      console.error(
        `[entitlements] organisation_billing_overrides lookup failed for org ${organisationId}; proceeding as if no override is active:`,
        overrideRow.error.message,
      );
    } else if (overrideRow.data) {
      const { override_tier: overrideTier, override_seats: overrideSeats } =
        overrideRow.data as { override_tier: string | null; override_seats: number | null };
      if (overrideTier !== null && !isTierKey(overrideTier)) {
        // subscription_plans.key is only FK-constrained to exist in that
        // table -- an override could in principle name a plan added after
        // this mirror last learned about it. Fail closed: treat as no tier
        // override (seats, if any, still apply) rather than crash or trust
        // an unrecognised key.
        console.error(
          `[entitlements] organisation_billing_overrides.override_tier "${overrideTier}" is not a key TIER_MATRIX recognises; ignoring the tier override for org ${organisationId}.`,
        );
        override = { tier: null, seats: overrideSeats };
      } else {
        override = { tier: overrideTier as TierKey | null, seats: overrideSeats };
      }
    }

    const { data, error } = subscription;
    const result = resolveEntitlements(
      {
        data:
          (data as {
            plan_id: string;
            status: string;
            current_period_end: string;
          } | null) ?? null,
        error: error ? { message: error.message } : null,
      },
      Date.now(),
      override,
    );

    if (result.status === "indeterminate" && error) {
      console.error(
        `[entitlements] organisation_subscriptions lookup failed for org ${organisationId}; failing to indeterminate/free-shaped-deny rather than silently granting a permissive default:`,
        error.message,
      );
    }

    return result;
  },
);
