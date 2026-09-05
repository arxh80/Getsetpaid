import "server-only";

// May this caller PUBLISH, CONNECT or BROWSE on the network in this
// organisation, and if not, WHY.
//
// The network analogue of lib/crm/finance-access.ts, and it mirrors that
// module's contract exactly -- read its header, and lib/crm/write-access.ts's,
// for the full argument. The differences are three:
//
//   1. THE TIER TERM IS network_publish, NOT financeModule. Network publishing
//      is a PAID-TIER feature (CLAUDE.md § Subscription tiers): Free has
//      networkPublish=false ("No -- view-only network browsing"), Starter and
//      Pro have true. The database mirror is
//      private.network_publish_organisations() (20260904001000), the network
//      analogue of private.finance_module_organisations().
//   2. THERE ARE TWO WRITE GATES, NOT ONE, because there are two write keys:
//      manage_network_profile (publishing an identity) and
//      manage_network_connections (sending, accepting, and linking). They have
//      different role sets (Q77) and different copy, so a caller can hold one
//      and not the other -- a Booker can connect and cannot publish.
//   3. THE READ GATE IS THE BROADEST IN THE PRODUCT. view_network is held by
//      all nine roles, because Free is a view-only network tier and browsing is
//      the one network act everyone can do. The read gate is therefore the
//      suspension-and-MFA gate in practice, and carries NO tier term at all.
//
// ===========================================================================
// THE "WHY" IS THE PRODUCT OF THIS MODULE. THE "MAY" IS NOT.
// ===========================================================================
// Every refusal this module predicts is independently made by an RLS policy on
// the network tables on every attempt, from any client, including one that
// never loads this application (20260904003000). If this file returned
// canWrite: true for everybody, nothing would become writable. What it is for
// is the sentence next to a disabled control, and whether Tasks 2, 3 and 4
// render a control at all. Constraint 12: hiding a button and refusing a write
// are two separate jobs, and this file does only the first.
//
// ===========================================================================
// THE ORDER OF THE CHECKS IS LOAD-BEARING (getCrmWriteAccess's, unchanged)
// ===========================================================================
//   1. suspended    nobody in this workspace can write. Checked FIRST, because
//                   has_permission already returns false for a suspended org
//                   (every network key has survives_suspension=false), so
//                   asking the permission first would tell a suspended
//                   workspace's Owner "you do not have permission", which is
//                   false.
//   2. tier         the plan cannot publish. An Owner can upgrade to Starter;
//                   a Marketing user cannot, and the copy says so.
//   3. permission   this role does not hold the key. Ask an Owner/Admin.
//
// ===========================================================================
// THE TIER CHECK MIRRORS A DATABASE ESCAPE, AND GETTING IT WRONG WOULD DISABLE
// EVERY NETWORK WRITE CONTROL IN THE PRODUCT
// ===========================================================================
// lib/entitlements/policy.ts resolves an organisation with NO subscription row
// to { status: "no-subscription", tier: "free" }, and every organisation has no
// subscription today (create_organisation writes no row).
// private.network_publish_organisations() exempts exactly that case ("not yet
// billed => not yet gated"). So entitlementsPermitNetworkPublish MUST return
// TRUE for "no-subscription" -- reading networkPublish straight off
// TIER_MATRIX.free (which is FALSE) would disable every network write control
// in every workspace while the database happily accepted the write. The mirror
// is explicit and bound by
// tests/integration/network/network-access-matches-db.test.ts, which drives
// BOTH sides across every subscription status and both grace sides; when Phase
// 7 removes the escape from the function, that test goes red here.

import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import { hasPermission, type CurrentOrg } from "@/lib/auth";
import type { CrmWriteAccess } from "@/lib/crm/write-access";
import { PERMISSION_FOR_ENTITY } from "@/lib/crm/custom-fields";
import { NETWORK_ENTITY_KINDS, type NetworkEntityKind } from "@/lib/network/fields";

const EXPLANATION = {
  suspended:
    "This workspace is suspended, so it’s read-only. You can still see everything in it. Contact GetSetPaid support to have it reinstated — an Owner can’t do it from here.",
  tier: "Publishing to the network is a paid feature. An Owner can upgrade the workspace to Starter or Pro to publish a profile and connect.",
  profilePermission:
    "Your role in this workspace can’t change what it publishes to the network. Ask an Owner, Admin or Manager.",
  connectionPermission:
    "Your role in this workspace can’t send or accept connections. Ask an Owner, Admin or Manager.",
} as const;

/**
 * True when a resolved entitlements answer permits NETWORK PUBLISHING.
 *
 * EXPORTED AND PURE so the mirror test can drive it against the database
 * without a session. Mirrors entitlementsPermitFinance clause for clause,
 * reading `networkPublish` where that reads `financeModule`:
 *
 *   "no-subscription"  -> true   (the database escape; not yet billed)
 *   "indeterminate"    -> false  (the conservative half; a failed lookup here
 *                                 disables a button, and disabling is safe)
 *   "resolved"         -> the plan's networkPublish (Starter/Pro true, Free
 *                                 false)
 */
export function entitlementsPermitNetworkPublish(result: {
  status: "no-subscription" | "resolved" | "indeterminate";
  entitlements: { networkPublish: boolean };
}): boolean {
  if (result.status === "no-subscription") return true;
  if (result.status === "indeterminate") return false;
  return result.entitlements.networkPublish;
}

/**
 * Resolve NETWORK PROFILE write access for one organisation.
 *
 * The gate on publishing, unpublishing, editing a profile and changing its
 * field visibility -- everything Task 2's editor does. The permission key is
 * fixed at manage_network_profile (owner/admin/manager/marketing, Q77).
 *
 * The same shape as getCrmWriteAccess (CrmWriteAccess), so the sentence next to
 * a disabled publish control and the sentence after a submitted publish form
 * are the same string -- the form can be submitted by anyone who ignores the
 * disabled attribute, and the two paths disagreeing is how a user concludes one
 * is wrong.
 */
export async function getNetworkPublishAccess(
  org: CurrentOrg,
): Promise<CrmWriteAccess> {
  if (org.isSuspended) {
    return { canWrite: false, reason: "suspended", explanation: EXPLANATION.suspended };
  }

  const [entitlements, permitted] = await Promise.all([
    getOrganisationEntitlements(org.id),
    hasPermission(org.id, "manage_network_profile"),
  ]);

  if (!entitlementsPermitNetworkPublish(entitlements)) {
    return { canWrite: false, reason: "tier", explanation: EXPLANATION.tier };
  }
  if (!permitted) {
    return {
      canWrite: false,
      reason: "permission",
      explanation: EXPLANATION.profilePermission,
    };
  }
  return { canWrite: true };
}

/**
 * Resolve CONNECTION write access for one organisation.
 *
 * The gate on sending, accepting, declining and withdrawing a request, and on
 * linking a private record to a network identity. The permission key is
 * manage_network_connections (six roles, Q77) -- a DIFFERENT set from the
 * profile key, which is why this is a separate function and not a parameter:
 * a Booker holds this and not the other, and the two disabled-control sentences
 * are different.
 *
 * THE TIER TERM IS THE SAME ONE. Q76: a Free organisation cannot form a
 * connection either -- it can see a request addressed to it and it cannot
 * accept. The one write the tier does NOT gate is WITHDRAWING, because
 * gating the retraction of a request behind the tier would strand it; that
 * asymmetry lives in the policy (20260904003000's sender-withdraws policy
 * carries no network_publish term) and is noted at the call site in
 * lib/network/connections.ts rather than being folded into this function,
 * which would make its contract two things at once.
 */
export async function getNetworkConnectionAccess(
  org: CurrentOrg,
): Promise<CrmWriteAccess> {
  if (org.isSuspended) {
    return { canWrite: false, reason: "suspended", explanation: EXPLANATION.suspended };
  }

  const [entitlements, permitted] = await Promise.all([
    getOrganisationEntitlements(org.id),
    hasPermission(org.id, "manage_network_connections"),
  ]);

  if (!entitlementsPermitNetworkPublish(entitlements)) {
    return { canWrite: false, reason: "tier", explanation: EXPLANATION.tier };
  }
  if (!permitted) {
    return {
      canWrite: false,
      reason: "permission",
      explanation: EXPLANATION.connectionPermission,
    };
  }
  return { canWrite: true };
}

/**
 * May this caller READ the network surface at all.
 *
 * A SEPARATE GATE from either write gate, and the one Tasks 2, 3 and 4 use to
 * decide whether to render a network page. view_network survives neither the
 * tier nor the suspension question the way write access frames them:
 *
 *   * READS ARE NOT ENTITLEMENT-GATED, and that is the whole shape of the Free
 *     tier -- "view-only network browsing" (CLAUDE.md § Subscription tiers).
 *     Neither SELECT policy carries a network_publish term, and neither does
 *     this. A tier term here would invert the product's own pricing.
 *   * A SUSPENDED workspace's view_network closes with everything else, because
 *     view_network is survives_suspension=false and view_crm is not. Browsing
 *     the industry network is not seeing your own data; it is an outward-facing
 *     surface a suspended workspace has no claim on (20260904002000's header).
 *
 * So the read gate is just the permission, which already folds in aal2 and
 * suspension inside has_permission.
 */
export async function getNetworkReadAccess(org: CurrentOrg): Promise<boolean> {
  return hasPermission(org.id, "view_network");
}

// ===========================================================================
// TASK 2 REVIEW FINDING M4 -- CLOSED HERE
// ===========================================================================
// `manage_network_profile` is granted to owner/admin/manager/marketing
// (20260904002000), but `network_profiles_insert_manage_profile` and
// `network_profiles_update_manage_profile` (20260904003000) ALSO require
// `private.entity_is_manageable(entity_kind, entity_id, organisation_id)`,
// which DISPATCHES PER KIND to manage_contacts / manage_artists /
// manage_venues -- keys `marketing` does not all hold (it holds
// view_crm + manage_contacts and nothing else, 20260828120000). So a
// marketing user can hold manage_network_profile and still be refused by the
// database when the record is an artist or a venue: `getNetworkPublishAccess`
// alone says canWrite:true, and the INSERT/UPDATE policy says 42501. A
// rendered-enabled control the database refuses is a defect this plan's own
// header names.
//
// getNetworkPublishAccess() cannot fix this on its own -- it has no entity to
// ask about, by design, because most of its callers (publish/unpublish,
// editing an existing profile's VALUES) do not change which private record is
// involved. This function is the one that DOES have an entity_kind, and it is
// the write gate Task 2's editor and "Publish a record" picker actually use.
//
// THE RECORD-SCOPE HALF OF entity_is_manageable NEEDS NO MIRROR HERE. That
// function's per-kind branch is
// `permitted_organisations('manage_<kind>') AND (full_scope OR owner_user_id =
// auth.uid())`, and RECORD_SCOPED_ROLES (lib/crm/record-scope.ts) is exactly
// {standard_user, read_only} -- NEITHER of which holds manage_network_profile
// (owner/admin/manager/marketing). Every caller who can reach this function at
// all is therefore ALWAYS full-scope, so the owner_user_id disjunction can
// never be the reason entity_is_manageable disagrees with the permission key
// alone. What is left, and what this closes, is the PERMISSION KEY per kind --
// exactly PERMISSION_FOR_ENTITY, reused rather than re-invented (Constraint
// 19's instruction: "there is an existing TS mirror of the dispatch... reuse
// it, do not invent a second mapping").
//
// tests/unit/network/access.test.ts is the CI-visible proof: it mocks
// hasPermission to answer true for manage_network_profile and false for
// manage_artists/manage_venues -- the marketing shape -- and asserts
// getNetworkPublishAccess(org) stays true while
// getNetworkPublishAccessForEntity(org, "artist") is refused with reason
// "permission". tests/integration/network/entity-kind-permission-mismatch
// .test.ts drives the same shape against the real database: a marketing
// member's raw INSERT into network_profiles for an artist gets 42501 from the
// policy, matching this function's prediction, with a company INSERT (same
// membership, same manage_network_profile) as the positive control.

const ENTITY_KIND_PLURAL: Record<NetworkEntityKind, string> = {
  company: "companies",
  artist: "artists",
  venue: "venues",
  agency: "agencies",
};

/**
 * Resolve NETWORK PROFILE write access for one organisation AND ONE ENTITY
 * KIND -- the gate Task 2's editor and "Publish a record" picker actually use.
 *
 * Combines `getNetworkPublishAccess` (suspended -> tier -> manage_network_
 * profile, unchanged) with the per-kind key `private.entity_is_manageable`
 * dispatches to. A caller who fails the general gate never reaches the
 * per-kind question -- that refusal's sentence (suspended/tier/the profile
 * permission) is more useful than "and also you can't manage artists", which
 * would be true but not the reason.
 */
export async function getNetworkPublishAccessForEntity(
  org: CurrentOrg,
  entityKind: NetworkEntityKind,
): Promise<CrmWriteAccess> {
  const base = await getNetworkPublishAccess(org);
  if (!base.canWrite) return base;

  const key = PERMISSION_FOR_ENTITY[entityKind];
  const permitted = await hasPermission(org.id, key);
  if (!permitted) {
    return {
      canWrite: false,
      reason: "permission",
      explanation: `Your role can publish to the network, but not manage ${ENTITY_KIND_PLURAL[entityKind]}. Ask an Owner, Admin or Manager.`,
    };
  }
  return { canWrite: true };
}

/**
 * The entity kinds this caller may publish -- i.e. `getNetworkPublishAccess
 * ForEntity` would say yes for. Used to build the "Publish a record" picker's
 * kind choices: a marketing user in a Starter workspace is offered `company`
 * and `agency` and never sees `artist` or `venue` in the list at all, rather
 * than picking one and being refused after typing a display name.
 *
 * Returns the empty set (not four refusals) when the general gate fails, so
 * the picker can tell "nothing to publish because you can't publish anything"
 * from "nothing to publish because your role can't manage any of the four
 * kinds" -- both real, and getNetworkPublishAccess(org) is what the caller
 * asks to tell them apart.
 */
export async function manageableNetworkEntityKinds(
  org: CurrentOrg,
): Promise<ReadonlySet<NetworkEntityKind>> {
  const base = await getNetworkPublishAccess(org);
  if (!base.canWrite) return new Set();

  // One hasPermission call per DISTINCT key, not per kind -- company and
  // agency share manage_contacts, so this is at most three round trips rather
  // than four.
  const keys = [...new Set(NETWORK_ENTITY_KINDS.map((k) => PERMISSION_FOR_ENTITY[k]))];
  const results = await Promise.all(keys.map((key) => hasPermission(org.id, key)));
  const permittedKeys = new Set(keys.filter((_, i) => results[i]));
  return new Set(
    NETWORK_ENTITY_KINDS.filter((k) => permittedKeys.has(PERMISSION_FOR_ENTITY[k])),
  );
}
