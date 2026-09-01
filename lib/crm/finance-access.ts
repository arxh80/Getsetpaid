import "server-only";

// May this caller WRITE financial entries in this organisation, and if not, WHY.
//
// The finance analogue of lib/crm/write-access.ts's getCrmWriteAccess, and it
// mirrors that module's contract exactly -- read its header for the full
// argument. The differences are two, and only two:
//
//   1. THE TIER TERM IS finance_module, NOT crmWrites. Finance is a Pro-only
//      module (CLAUDE.md § Subscription tiers): Free and Starter have
//      financeModule=false, Pro has true. So the tier gate here reads
//      `financeModule` off the resolved entitlements, where getCrmWriteAccess
//      reads `crmWrites`. The database mirror is private.finance_module_
//      organisations() (20260903001000), the finance analogue of
//      private.crm_write_organisations().
//   2. THE PERMISSION KEY IS manage_finance (write) / view_finance (read),
//      not manage_contacts. getFinanceWriteAccess hardcodes manage_finance
//      because there is exactly one finance write key -- unlike the per-area
//      CRM catalogue getCrmWriteAccess takes a key parameter for.
//
// ===========================================================================
// THE "WHY" IS THE PRODUCT OF THIS MODULE. THE "MAY" IS NOT.
// ===========================================================================
// Every refusal this module predicts is independently made by an RLS policy on
// public.financial_entries on every attempt, from any client, including one
// that never loads this application (20260903003000). If this file returned
// canWrite: true for everybody, nothing would become writable. What it is for
// is the sentence next to a disabled control, and whether Task 2 renders the
// finance panel at all.
//
// ===========================================================================
// THE ORDER OF THE CHECKS IS LOAD-BEARING (same as getCrmWriteAccess)
// ===========================================================================
//   1. suspended    nobody in this workspace can write. Checked FIRST, because
//                   has_permission already returns false for a suspended org
//                   (manage_finance has survives_suspension=false), so asking
//                   the permission first would tell a suspended workspace's
//                   Owner "you do not have permission", which is false.
//   2. tier         the plan has no finance module. An Owner can upgrade to
//                   Pro; a Finance user cannot, and the copy says so.
//   3. permission   this role does not hold manage_finance. Ask an Owner/Admin.
//
// ===========================================================================
// THE TIER CHECK MIRRORS A DATABASE ESCAPE, AND GETTING IT WRONG WOULD DISABLE
// EVERY FINANCE CONTROL IN THE PRODUCT
// ===========================================================================
// lib/entitlements/policy.ts resolves an organisation with NO subscription row
// to { status: "no-subscription" }, and every organisation has no subscription
// today (create_organisation writes no row). private.finance_module_
// organisations() exempts exactly that case ("not yet billed => not yet
// gated"). So entitlementsPermitFinance MUST return true for "no-subscription"
// -- reading financeModule straight off TIER_MATRIX.free (which is false) would
// disable every finance control in every workspace while the database happily
// accepted the write. The mirror is explicit and bound by Task 4's finance
// analogue of tests/integration/crm/crm-write-access-matches-db.test.ts; when
// Phase 7 removes the escape from the function, that test goes red here.

import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import { hasPermission, type CurrentOrg } from "@/lib/auth";
import type { CrmWriteAccess } from "@/lib/crm/write-access";

const EXPLANATION = {
  suspended:
    "This workspace is suspended, so it’s read-only. You can still see everything in it. Contact GetSetPaid support to have it reinstated — an Owner can’t do it from here.",
  tier: "Finance is a Pro feature. An Owner can upgrade the workspace to add budget and actuals.",
  permission:
    "Your role in this workspace can’t change finance. Ask an Owner, Admin or someone with the Finance role.",
} as const;

/**
 * True when a resolved entitlements answer permits FINANCE writes.
 *
 * EXPORTED AND PURE so Task 4's mirror test can drive it against the database
 * without a session. Mirrors entitlementsPermitCrmWrites clause for clause,
 * reading `financeModule` where that reads `crmWrites`:
 *
 *   "no-subscription"  -> true   (the database escape; not yet billed)
 *   "indeterminate"    -> false  (the conservative half; a failed lookup here
 *                                 disables a button, and disabling is safe)
 *   "resolved"         -> the plan's financeModule (Pro true, else false)
 */
export function entitlementsPermitFinance(result: {
  status: "no-subscription" | "resolved" | "indeterminate";
  entitlements: { financeModule: boolean };
}): boolean {
  if (result.status === "no-subscription") return true;
  if (result.status === "indeterminate") return false;
  return result.entitlements.financeModule;
}

/**
 * Resolve finance WRITE access for one organisation.
 *
 * The same shape as getCrmWriteAccess (CrmWriteAccess), so the sentence next to
 * a disabled finance control and the sentence after a submitted finance form
 * are the same string -- the form can be submitted by anyone who ignores the
 * disabled attribute, and the two paths disagreeing is how a user concludes one
 * is wrong. The permission key is fixed at manage_finance; a separate read gate
 * (view_finance) below decides whether Task 2 renders the panel at all.
 */
export async function getFinanceWriteAccess(
  org: CurrentOrg,
): Promise<CrmWriteAccess> {
  if (org.isSuspended) {
    return { canWrite: false, reason: "suspended", explanation: EXPLANATION.suspended };
  }

  const [entitlements, permitted] = await Promise.all([
    getOrganisationEntitlements(org.id),
    hasPermission(org.id, "manage_finance"),
  ]);

  if (!entitlementsPermitFinance(entitlements)) {
    return { canWrite: false, reason: "tier", explanation: EXPLANATION.tier };
  }
  if (!permitted) {
    return { canWrite: false, reason: "permission", explanation: EXPLANATION.permission };
  }
  return { canWrite: true };
}

/**
 * May this caller READ the finance surface at all.
 *
 * A SEPARATE GATE from write access, and the one Task 2 uses to decide whether
 * to render the finance panel. view_finance survives neither the tier nor the
 * suspension question the way write access frames them: reads are NOT
 * entitlement-gated (Q67, a downgrade must not hide existing data -- the SELECT
 * policy carries no finance_module term), and a suspended org's view_finance
 * closes with everything else because view_finance is not view_crm. So the read
 * gate is just the permission, which already folds in aal2 and suspension
 * inside has_permission.
 */
export async function getFinanceReadAccess(org: CurrentOrg): Promise<boolean> {
  return hasPermission(org.id, "view_finance");
}
