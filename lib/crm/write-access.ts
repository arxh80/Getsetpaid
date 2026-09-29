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
// THE TIER CHECK USED TO MIRROR A DATABASE ESCAPE -- PHASE 7 TASK A REMOVED IT
// ===========================================================================
// Before Task A, `private.crm_write_organisations()` read a MISSING
// organisation_subscriptions row as "not yet billed, therefore not yet
// gated" and permitted the write, while `lib/entitlements/policy.ts` resolved
// the same missing row to `{ status: "no-subscription", tier: "free" }` --
// and `TIER_MATRIX.free.crmWrites` is false. `public.create_organisation()`
// wrote no subscription row at the time, so EVERY ORGANISATION IN THE PRODUCT
// was in that state, and reading `crmWrites` straight off the entitlements
// result would have disabled every write control in every workspace while the
// database happily accepted the write from anything that bypassed the UI.
// That divergence was the reason for an explicit, named mirror function here.
//
// TASK A (20260908000000) CLOSED THE GAP AT THE SOURCE instead:
// `public.create_organisation()` now writes a Starter row at birth, and every
// organisation that predates it was backfilled one, so "no subscription row"
// is no longer a state a real organisation is in. The escape is gone from
// `private.crm_write_organisations()`, and it is gone here too -- this
// function no longer special-cases "no-subscription" and simply reads
// `entitlements.crmWrites`, which `resolveEntitlements()` already sets to
// Free's `false` for that status. The mirror function stays (a UI hint still
// needs somewhere to read the tier reason from), and so does the test that
// drives both sides at once
// (tests/integration/crm/crm-write-access-matches-db.test.ts) -- the same
// treatment `record-scope-matches-db`, `tiers-match-db` and
// `past-due-grace-matches-db` give the other three places where one rule is
// written in two languages.

import { getOrganisationEntitlements } from "@/lib/entitlements/policy";
import { hasPermission, type CurrentOrg } from "@/lib/auth";
// One direction only: lib/crm/write.ts imports nothing from here, so this is
// not a cycle. REFUSED_MESSAGE is the sentence that declines to guess WHY, and
// joinEndExplanation() below needs exactly that for the case where guessing
// would be wrong.
import { REFUSED_MESSAGE } from "@/lib/crm/write";

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
 * Why a deleted record's child panel has no controls.
 *
 * ONE STRING, for the reason `authorise()` returns `access.explanation`
 * verbatim: the sentence next to an absent control and the sentence after a
 * submitted form have to be the same, because the form can be submitted by
 * anyone who ignores the UI and two different answers is how a user concludes
 * one of them is wrong.
 *
 * A CHILD IS ONLY EDITABLE WHILE BOTH ENDS ARE LIVE, and that rule is one
 * sentence on purpose. The alternative -- "the anchor must be live, and the
 * other end may be deleted if the operation is a removal" -- is defensible and
 * unstateable: it reads differently from a contact than from a company, so the
 * same button would work on one page and refuse on the other. `restore has to
 * bring the record back as it was` (deleteCompanyAction) is what decides it:
 * if the children of a deleted record can be edited while it is deleted,
 * restore brings back something else.
 *
 * ===========================================================================
 * IT USED TO SAY "ITS LINKS", AND TASK 4b's BROWSER PASS FOUND THAT WRONG
 * ===========================================================================
 * Written for `contact_companies`, where "link" is exactly right. Task 4b
 * points three more panels at it, and on a soft-deleted VENUE the sentence
 * rendered as
 *
 *     Rooms
 *     …
 *     This record is deleted, so its links can't be changed.
 *
 * A room is not a link. It is a child record with a name, and a user reading
 * that sentence under a heading called "Rooms" has to work out that the
 * product means the rooms -- or concludes the page is showing them somebody
 * else's message. Seen in a browser on a real deleted venue; the BEHAVIOUR was
 * correct (no controls rendered, the write refused, nothing changed in the
 * database), only the noun was wrong.
 *
 * "What's attached to it" is true of all three: a company link on a contact, a
 * representation on an artist or an agency, a room in a venue. Changing the
 * constant rather than parameterising the noun keeps the property this file's
 * header is about -- one string, so the disabled state and the refusal cannot
 * disagree.
 *
 * EDITING THIS FILE IS THE ONE THING TASK 4b's BRIEF SAYS TO RECORD BEFORE
 * DOING. Recorded in that task's report § 5: the copy did not need
 * write-access.ts to change in order to WORK, and the mechanism it provides
 * (`joinEndExplanation`, `RecordPresence`, `getCrmWriteAccess(org, key)`)
 * copied without an edit. What needed changing was one noun in one sentence,
 * which is a copy defect rather than a design finding.
 */
export const DELETED_RECORD_EXPLANATION =
  "This record is deleted, so what’s attached to it can’t be changed. Restore it first and these controls come back.";

/**
 * What a lookup for one end of a join actually found.
 *
 * THREE ANSWERS, NOT TWO, AND THE THIRD IS THE POINT. `liveInOrg()` used to
 * return a boolean, and `false` covered four different situations that got one
 * sentence between them:
 *
 *   the record really is soft-deleted        "deleted -- restore it first"  OK
 *   the record is in another workspace       "deleted -- restore it first"  wrong
 *   the record does not exist                "deleted -- restore it first"  wrong
 *   the record is outside a record-scoped
 *     user's scope                           "deleted -- restore it first"  wrong
 *
 * Measured by the re-review: a live `Make primary` form's hidden `companyId`
 * repointed at a LIVE company in another workspace was correctly refused, and
 * told the user to restore a record that is not deleted -- an instruction they
 * cannot carry out, about a record they cannot see.
 *
 * "gone" IS NOT AN EXISTENCE ORACLE. All three of the wrong rows above collapse
 * into it, byte-identically, because the lookup runs through the CALLER'S OWN
 * client: a row in another workspace, a row outside the caller's record scope
 * and a row that never existed are all `data === null` from one query, and
 * nothing downstream can tell them apart. That is the same discipline
 * `REFUSED_MESSAGE` applies deliberately -- see lib/crm/write.ts's header --
 * and it is why the fix is to stop guessing rather than to guess better.
 */
export type RecordPresence = "live" | "deleted" | "gone";

/**
 * The sentence a join write gets when an end is not live, or null if all are.
 *
 * WHY "gone" ANYWHERE WINS OVER "deleted" ANYWHERE. `DELETED_RECORD_EXPLANATION`
 * ends "Restore it first and these controls come back", which is a promise:
 * undo the deletion and the write will work. That is only true when being
 * deleted is the ONLY thing wrong. If any end is `gone` -- another workspace,
 * out of scope, or absent -- restoring the deleted one changes nothing, so the
 * honest answer is `REFUSED_MESSAGE`, which deliberately does not say why.
 *
 * Pure and exported so the three branches are a unit test rather than three
 * browser walks; `lib/crm/contacts.ts` holds the queries that produce the
 * inputs.
 */
export function joinEndExplanation(
  ends: readonly RecordPresence[],
): string | null {
  if (ends.some((end) => end === "gone")) return REFUSED_MESSAGE;
  if (ends.some((end) => end === "deleted")) return DELETED_RECORD_EXPLANATION;
  return null;
}

/**
 * True when a resolved entitlements answer permits CRM writes.
 *
 * EXPORTED AND PURE so the mirror test can drive it against the database
 * without a session, and so the reason PHASE 7 TASK A removed the
 * "no-subscription" branch (see this file's header) is one expression with a
 * name rather than a condition repeated at three call sites.
 *
 * "indeterminate" (the subscription lookup failed) denies. That is the
 * conservative half of the mirror and it is deliberately NOT what the database
 * does -- a failed query in the application is not the same event as a missing
 * row in the database, and the consequence of getting it wrong differs: here
 * it disables a button, there it would open a gate. "no-subscription" now
 * falls through to `entitlements.crmWrites`, which resolveEntitlements()
 * already sets to Free's `false` for that status -- the same safe default,
 * for the same reason.
 */
export function entitlementsPermitCrmWrites(result: {
  status: "no-subscription" | "resolved" | "indeterminate";
  entitlements: { crmWrites: boolean };
}): boolean {
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
