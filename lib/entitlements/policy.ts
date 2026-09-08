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
// NOT BUILT HERE, ON PURPOSE: comp_expires_at auto-revert
// (organisation_subscriptions.comp_expires_at is set for time-boxed
// superuser comps/overrides) is not evaluated at all in this file.
// organisation_subscriptions has no column recording which tier a comp
// should revert TO, so "auto-revert to the org's actual paid tier" is not
// expressible from this schema yet -- inventing one here would be scope
// creep into Phase 7 (superuser billing overrides), which is where this
// belongs. See task-9-report.md for the gap and a cheap partial mitigation
// that was considered and deliberately not built.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { TIER_MATRIX, isTierKey, type TierEntitlements, type TierKey } from "./tiers";

export type EntitlementsStatus = "no-subscription" | "resolved" | "indeterminate";

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
 * {data, error} shape, what entitlements apply?
 *
 * Extracted as a pure function -- same motive as
 * lib/auth/mfa-gate.ts's roleCheckRequiresMfa() -- so the three-way
 * "no row" / "row" / "error" split (including the active-vs-not status
 * branch and the unknown-plan_id fail-closed branch) is unit-testable
 * (tests/unit/entitlements/policy.test.ts) without provoking a real
 * PostgREST failure through the integration harness.
 */
export function resolveEntitlements(
  result: SubscriptionQueryResult,
  now: number = Date.now(),
): EntitlementsResult {
  if (result.error) {
    return { status: "indeterminate", tier: null, entitlements: TIER_MATRIX.free };
  }

  if (!result.data) {
    return { status: "no-subscription", tier: "free", entitlements: TIER_MATRIX.free };
  }

  const { plan_id: planId, status, current_period_end: currentPeriodEnd } = result.data;

  // 'cancelled' -- and any status this mirror does not recognise -- falls back
  // to Free at once. Only 'past_due' earns the grace window, and only while it
  // lasts. See the STATUS GATING note above this file's imports.
  const inGrace = status === "past_due" && isWithinPastDueGrace(currentPeriodEnd, now);

  if (status !== "active" && !inGrace) {
    return { status: "resolved", tier: "free", entitlements: TIER_MATRIX.free };
  }

  if (!isTierKey(planId)) {
    // subscription_plans.key is only FK-constrained to exist in that table,
    // not to be one of the three keys this mirror currently knows about.
    // Fail closed rather than trust an unrecognised plan_id.
    console.error(
      `[entitlements] organisation_subscriptions.plan_id "${planId}" is not a key TIER_MATRIX recognises; failing to indeterminate/free-shaped-deny.`,
    );
    return { status: "indeterminate", tier: null, entitlements: TIER_MATRIX.free };
  }

  return { status: "resolved", tier: planId, entitlements: TIER_MATRIX[planId] };
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

    const { data, error } = await supabase
      .from("organisation_subscriptions")
      .select("plan_id, status, current_period_end")
      .eq("organisation_id", organisationId)
      .maybeSingle();

    const result = resolveEntitlements({
      data:
        (data as {
          plan_id: string;
          status: string;
          current_period_end: string;
        } | null) ?? null,
      error: error ? { message: error.message } : null,
    });

    if (result.status === "indeterminate" && error) {
      console.error(
        `[entitlements] organisation_subscriptions lookup failed for org ${organisationId}; failing to indeterminate/free-shaped-deny rather than silently granting a permissive default:`,
        error.message,
      );
    }

    return result;
  },
);
