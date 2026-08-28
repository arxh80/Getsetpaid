import "server-only";

// May this caller write CRM records in this organisation, and if not, WHY.
//
// ===========================================================================
// THE "WHY" IS THE PRODUCT OF THIS MODULE. THE "MAY" IS NOT.
// ===========================================================================
// CLAUDE.md § Permissions: "Entitlements are enforced server-side -- hiding UI
// is not enforcement." Every refusal this module predicts is independently
// made by an RLS policy on every attempt, from any client, including one that
// never loads this application. If this file returned `canWrite: true` for
// everybody, nothing would become writable.
//
// What it is for is the sentence next to a disabled control. A disabled
// control with no explanation is worse than an enabled one that fails, because
// the user cannot tell whether the product is broken, whether they are the
// wrong person, or whether they should ask somebody. DESIGN.md and WCAG 2.2
// both want the reason attached to the control; this is where the reason comes
// from.
//
// ===========================================================================
// THE ORDER OF THE CHECKS IS LOAD-BEARING, AND IT IS NOT THE OBVIOUS ONE
// ===========================================================================
// SUSPENSION IS CHECKED FIRST, ahead of the permission. It has to be, because
// `public.has_permission()` ALREADY RETURNS FALSE for a suspended
// organisation -- 20260828210000 joins public.permissions and requires
// `(o.deleted_at is null or perm.survives_suspension)`, and `manage_contacts`
// has survives_suspension = false. So asking the permission first would tell
// the Owner of a suspended workspace "you do not have permission to add
// contacts", which is false, unfixable by them, and points them at their
// administrator instead of at the platform.
//
// Checked in the order a user can act on:
//
//   1. suspended    nobody in this workspace can write. Not the user's role.
//   2. tier         the organisation's plan has no CRM writes. An Owner can
//                   fix it; a Booker cannot, and the copy says so.
//   3. permission   this role does not have the key. Ask an Owner or Admin.
//
// ===========================================================================
// THE TIER CHECK MIRRORS A DATABASE ESCAPE, AND GETTING THAT WRONG WOULD HAVE
// DISABLED EVERY BUTTON IN THE PRODUCT
// ===========================================================================
// `lib/entitlements/policy.ts` resolves an organisation with NO subscription
// row to `{ status: "no-subscription", tier: "free" }`, and
// `TIER_MATRIX.free.crmWrites` is false. `private.crm_write_organisations()`
// does the opposite, deliberately and in as many words:
//
//     -- No subscription row => not yet billed => not yet gated. Phase 7
//     -- removes this branch in the same migration that backfills the rows.
//     s.organisation_id is null
//
// `public.create_organisation()` writes no subscription row, so TODAY EVERY
// ORGANISATION IN THIS PRODUCT HAS NO SUBSCRIPTION. Reading `crmWrites`
// straight off the entitlements result would have disabled every write control
// in every workspace, with the reason "your plan does not include this", while
// the database happily accepted the write from anything that bypassed the UI.
//
// So the mirror is explicit, it is named, and it is bound by a test that
// drives BOTH sides (tests/integration/crm/crm-write-access-matches-db.test.ts)
// -- the same treatment `record-scope-matches-db`, `tiers-match-db` and
// `past-due-grace-matches-db` already give the other four places where one
// rule is written in two languages. When Phase 7 removes the escape from the
// function, that test goes red here.

import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import { hasPermission, type CurrentOrg } from "@/lib/auth";

export type WriteBlockedReason = "suspended" | "tier" | "permission";

export type CrmWriteAccess =
  | { readonly canWrite: true }
  | {
      readonly canWrite: false;
      readonly reason: WriteBlockedReason;
      /**
       * The accessible explanation, attached to every disabled control.
       * One sentence, no jargon, and it names who can change the situation.
       */
      readonly explanation: string;
    };

const EXPLANATION: Record<WriteBlockedReason, string> = {
  suspended:
    "This workspace is suspended, so it’s read-only. You can still see everything in it. Contact GetSetPaid support to have it reinstated — an Owner can’t do it from here.",
  tier: "Your plan doesn’t include adding or editing records. An Owner can upgrade the workspace to change that.",
  permission:
    "Your role in this workspace can view records but not change them. Ask an Owner or Admin if you need to.",
};

/**
 * Why the link panel's controls are not there on a deleted record.
 *
 * ONE STRING, for the reason `authorise()` returns `access.explanation`
 * verbatim: the sentence next to an absent control and the sentence after a
 * submitted form have to be the same, because the form can be submitted by
 * anyone who ignores the UI and two different answers is how a user concludes
 * one of them is wrong.
 *
 * A LINK IS ONLY EDITABLE WHILE BOTH ENDS ARE LIVE, and that rule is one
 * sentence on purpose. The alternative -- "the anchor must be live, and the
 * other end may be deleted if the operation is a removal" -- is defensible and
 * unstateable: it reads differently from a contact than from a company, so the
 * same button would work on one page and refuse on the other. `restore has to
 * bring the record back as it was` (deleteCompanyAction) is what decides it:
 * if the links of a deleted record can be edited while it is deleted, restore
 * brings back something else.
 */
export const DELETED_RECORD_EXPLANATION =
  "This record is deleted, so its links can’t be changed. Restore it first and these controls come back.";

/**
 * True when a resolved entitlements answer permits CRM writes.
 *
 * EXPORTED AND PURE so the mirror test can drive it against the database
 * without a session, and so the "no subscription" branch is one expression
 * with a name rather than a condition repeated at three call sites.
 *
 * "indeterminate" (the subscription lookup failed) denies. That is the
 * conservative half of the mirror and it is deliberately NOT what the database
 * does -- a failed query in the application is not the same event as a missing
 * row in the database, and the consequence of getting it wrong differs: here
 * it disables a button, there it would open a gate.
 */
export function entitlementsPermitCrmWrites(result: {
  status: "no-subscription" | "resolved" | "indeterminate";
  entitlements: { crmWrites: boolean };
}): boolean {
  if (result.status === "no-subscription") return true;
  if (result.status === "indeterminate") return false;
  return result.entitlements.crmWrites;
}

/**
 * Resolve write access for one organisation.
 *
 * `permissionKey` because the CRM permission catalogue is per-area:
 * `manage_contacts` covers contacts, companies and the join between them;
 * `manage_artists` and `manage_venues` cover what Task 4b builds. Passing it
 * rather than hardcoding one is what makes this file copyable without an
 * edit -- and passing a key that does not exist gets `false` from
 * `has_permission()`, which fails closed.
 */
export async function getCrmWriteAccess(
  org: CurrentOrg,
  permissionKey: string,
): Promise<CrmWriteAccess> {
  if (org.isSuspended) {
    return { canWrite: false, reason: "suspended", explanation: EXPLANATION.suspended };
  }

  // Both round trips at once: neither answer depends on the other, and this is
  // on the render path of every CRM page.
  const [entitlements, permitted] = await Promise.all([
    getOrganisationEntitlements(org.id),
    hasPermission(org.id, permissionKey),
  ]);

  if (!entitlementsPermitCrmWrites(entitlements)) {
    return { canWrite: false, reason: "tier", explanation: EXPLANATION.tier };
  }
  if (!permitted) {
    return { canWrite: false, reason: "permission", explanation: EXPLANATION.permission };
  }
  return { canWrite: true };
}
