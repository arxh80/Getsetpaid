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
