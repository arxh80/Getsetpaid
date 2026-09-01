import "server-only";

// The plumbing every CRM entity's Server Actions need, written once.
//
// ===========================================================================
// WHY THIS FILE EXISTS, AND WHAT TASK 4's COST ESTIMATE MISSED
// ===========================================================================
// Task 4's report priced the per-entity cost of a CRUD screen at "one spec
// file, one list page, one detail page, one edit page, one new page, one
// deleted page, and two migrations' worth of indexes". That is the SCREEN
// cost and it is accurate. It leaves out the ACTION cost, which Task 4 paid
// twice without noticing because two copies of a thing still look like a
// pattern: `authorise()`, `stateFor()`, `failureState()`, `liveInOrg()` and
// `refusedEndState()` are byte-for-byte identical in lib/crm/contacts.ts and
// lib/crm/companies.ts apart from one permission-key constant.
//
// At five entities that is five copies of the exhaustive `switch` over
// `WriteResult`, and the whole point of that switch (N-2) is that adding a
// sixth outcome is a COMPILE ERROR rather than a wrong sentence. Five copies
// means five places to fix and four places to forget, and `pnpm typecheck`
// would catch the forgetting -- which is the good case. The bad case is the
// one this phase has already had: `CONFLICT_MESSAGE` naming one operation and
// being rendered by eight actions.
//
// So the three new entity modules import their plumbing from here.
//
// ===========================================================================
// WHAT WAS NOT TOUCHED, DELIBERATELY
// ===========================================================================
// lib/crm/contacts.ts and lib/crm/companies.ts still carry their own copies
// and are UNCHANGED by this task. Refactoring them onto this module would be a
// diff across the only two entity modules that have been through a review, a
// fix round, a re-review and a second fix round, for no behavioural gain --
// and Task 4b's job is to test whether the shape copies, not to rewrite the
// thing it is copying. The duplication is named here rather than removed, and
// the entity modules point at it. If a sixth entity arrives, or if Task 6's
// merge changes the outcome vocabulary, that is the moment to fold the two
// older modules in; the tests that would catch a divergence
// (tests/unit/crm/source-shape.test.ts) already read every file in lib/crm/.
//
// NOT `"use server"`. A "use server" module may only export async functions,
// and half of what is here is pure -- so this is an ordinary server-only
// module that "use server" modules import. lib/crm/write.ts, write-access.ts
// and lib/list/ were NOT edited to make any of this work; that is the claim
// Task 4b exists to test and it held.

import { getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import type { createClient } from "@/lib/supabase/server";
import { echoedValues, type FormState } from "@/lib/forms";
import {
  getCrmWriteAccess,
  joinEndExplanation,
  type RecordPresence,
} from "@/lib/crm/write-access";
import {
  CONFLICT_MESSAGE,
  FAILED_MESSAGE,
  REFUSED_MESSAGE,
  UNKNOWN_MESSAGE,
  type WriteResult,
} from "@/lib/crm/write";

/**
 * Resolve the organisation and check write access in one step.
 *
 * Returns either the org or the FormState to hand straight back. The
 * suspended/tier/permission explanation is used verbatim, so the message next
 * to a disabled control and the message after a submitted form are the same
 * sentence -- which matters, because the form can be submitted by anyone who
 * ignores the disabled attribute, and the two paths disagreeing is how a user
 * concludes one of them is wrong.
 *
 * `permissionKey` is a parameter rather than a module constant because the CRM
 * permission catalogue is per-area (20260828120000): `manage_contacts` covers
 * contacts, companies, agencies and the link between them; `manage_artists`
 * covers artists, their representations and their fee history;
 * `manage_venues` covers venues and rooms. A Booker holds the second and not
 * the third; a Venue Manager is the mirror image. Passing a key that does not
 * exist gets `false` from `has_permission()`, which fails closed.
 */
export async function authoriseOrg(
  orgSlug: string | null,
  formData: FormData,
  permissionKey: string,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  // EVERY REFUSAL CARRIES THE SUBMITTED VALUES BACK, not just the validation
  // ones. Measured in a browser by Task 4: with the org suspended mid-edit,
  // the form correctly refused to say it saved -- and threw away the change
  // the user had just typed, because React 19 resets a `<form action>` and
  // this path returned no `values`. Losing the edit is the same insult
  // whichever gate refused it.
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  // A slug that does not exist, belongs to another tenant, or that the caller
  // is only invited to. All three are the same answer, on purpose.
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };

  const access = await getCrmWriteAccess(org, permissionKey);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * The FormState for a write that did not apply.
 *
 * Split out from `stateFor` because the primary-representation action has no
 * success string to pass -- its confirmation depends on whether a
 * representation was named -- and calling `stateFor(result, "", formData)` to
 * reach this branch reads as a bug.
 *
 * `conflictMessage` defaults to the generic sentence. Only a call site that
 * has EARNED a specific one passes it: N-9 measured `CONFLICT_MESSAGE` naming
 * "this contact's primary company" while eight actions rendered it, so the
 * rule is that the specific wording lives at the one place it is true.
 */
export function failureState(
  result: Exclude<WriteResult, { outcome: "applied" }>,
  formData: FormData,
  conflictMessage: string = CONFLICT_MESSAGE,
): FormState {
  const values = echoedValues(formData);
  // A SWITCH RATHER THAN AN IF-CHAIN WITH A FALLBACK, and NO `default` arm.
  // Four outcomes today; a fifth is a compile error here rather than a wrong
  // sentence in front of a customer -- which is how "Nothing has been changed"
  // came to be shown for a write that HAD changed something. The mechanism is
  // the declared `FormState` return type under `strict`: with every arm
  // returning and no default, a new member of the union leaves a path that
  // falls off the end returning `undefined`, and TS2366 says so. There is no
  // `never` arm and none is needed. `pnpm typecheck` is what runs it, and
  // nothing else in this repository does.
  switch (result.outcome) {
    case "refused":
      return { error: REFUSED_MESSAGE, values };
    case "conflict":
      return { error: conflictMessage, values };
    case "unknown":
      return { error: UNKNOWN_MESSAGE, values };
    case "failed":
      return { error: FAILED_MESSAGE, values };
  }
}

/**
 * Turn a WriteResult into the FormState a form renders.
 *
 * `formData` so a refusal echoes the submitted values back with the message --
 * React 19 resets the form after the action, and a refused save that also
 * empties the form has taken the user's work twice.
 */
export function stateFor(
  result: WriteResult,
  success: string,
  formData: FormData,
  conflictMessage?: string,
): FormState {
  if (result.outcome === "applied") return { message: success };
  return failureState(result, formData, conflictMessage);
}

/**
 * The parent tables a child/join write has to check an end against.
 *
 * A closed union rather than `string`, so a typo is a compile error rather
 * than a query against a table that does not exist -- which PostgREST answers
 * with a 404 that this helper would read as `error`, and therefore as "gone",
 * and therefore as a refusal the user cannot act on. `contacts` is here
 * because artist_representations names a contact as the individual agent.
 *
 * `companies` was added by Task 5: custom field values hang off all FIVE
 * entity types, and companies is the one this union did not already have --
 * Task 4 had kept its company checks in lib/crm/contacts.ts's own copy of
 * liveInOrg rather than in this shared one. That copy is gone (final review
 * I-3) and contacts.ts now imports this function, so the union really is the
 * whole set of parents the CRM checks.
 *
 * `events` was added by PHASE 3 TASK 1, when custom field values became
 * attachable to a sixth entity type (20260901001000). PARENT_TABLE in
 * lib/crm/custom-field-actions.ts is keyed on CustomFieldEntityType and has to
 * be total over it, and a `Record` entry naming a table this union does not
 * have is exactly the typo this union exists to catch.
 *
 * THE EVENT WRITE PATH ARRIVED IN PHASE 3 TASK 4 and calls
 * liveInOrg("venues", ...), not liveInOrg("events", ...) -- an event's ends
 * are a venue and a room, and the event is nobody's parent yet. The first real
 * caller of the `events` arm is Task 5's `event_lineup`, whose parent IS an
 * event. Stated because this note used to say "there is no event write path
 * until Phase 3 Task 3", which stopped being true without the arm gaining a
 * caller, and a reader checking the claim would have concluded the union was
 * wrong rather than early.
 */
export type ParentTable =
  | "artists"
  | "agencies"
  | "venues"
  | "contacts"
  | "companies"
  | "events"
  // PHASE 4 TASK 1: the four operational entities are the PARENT end of the
  // four *_links tables (20260902002000). Their arms arrive here BEFORE their
  // first caller -- the link write paths are later Phase 4 tasks -- exactly as
  // the `events` arm did in Phase 3 Task 1 (see the note above). A union member
  // with no caller is harmless type-widening: nothing switches exhaustively on
  // ParentTable, and PARENT_TABLE in custom-field-actions.ts is keyed on
  // CustomFieldEntityType (unchanged), so widening the value type adds no
  // obligation there.
  | "tasks"
  | "meetings"
  | "notes"
  | "documents"
  // PHASE 5 TASK 3: financial_entries is the parent table of a finance line's
  // custom-field values. It is the honest value for PARENT_TABLE.financial_entry
  // in custom-field-actions.ts, though that entry is never dereferenced --
  // saveCustomFieldValuesAction refuses `financial_entry` before reading the
  // map, because finance values are written by lib/crm/finance.ts, not the
  // generic panel. Union-widening ahead of (or without) a caller is harmless:
  // nothing switches exhaustively on ParentTable. Same shape as the Phase 4
  // operational arms above.
  | "financial_entries";

/**
 * Is this a LIVE row of THIS workspace, reachable by THIS caller?
 *
 * THE ONLY COPY. It began as lib/crm/contacts.ts's `liveInOrg` generalised
 * over the table, and for one phase both existed byte-for-byte identical --
 * final review I-3 deleted the private one, so every join and child write in
 * the CRM now goes through this function.
 *
 * ===========================================================================
 * RLS ANSWERS A DIFFERENT QUESTION FROM THE ONE THE URL ASKS
 * ===========================================================================
 * `artist_representations_*_via_artist` asks "may this caller write this row".
 * The URL asks "is this row the one this workspace's page is about". For a
 * member of one organisation those coincide; multi-org membership ships at
 * MVP, so for an ordinary admin of two workspaces they do not.
 *
 * ===========================================================================
 * THREE ANSWERS, BECAUSE A BOOLEAN MADE THE PRODUCT LIE (N-8)
 * ===========================================================================
 * `false` used to cover a soft-deleted record, a record in another workspace,
 * one outside a record-scoped user's scope, and one that does not exist -- all
 * told "This record is deleted... Restore it first", which is an instruction
 * the user cannot carry out about a record they cannot see. See
 * `RecordPresence` in lib/crm/write-access.ts for why "gone" is not an
 * existence oracle, and `joinEndExplanation()` for which sentence each case
 * earns.
 *
 * NOTE THE MISSING `.is("deleted_at", null)`. It was the filter; it is now the
 * column being read. Filtering it is what made "deleted" indistinguishable
 * from "not there", and SELECT on a soft-deleted row is permitted on purpose
 * (design note (g)) -- the restore route depends on it.
 *
 * ===========================================================================
 * WHAT IS BEHIND THIS CHECK AND WHAT IS NOT, PER TABLE
 * ===========================================================================
 *   artists  as the parent of a representation: ALSO enforced by the database
 *            (20260829001000 puts `p.deleted_at is null` in the two
 *            artist_representations write policies). T28 measures it.
 *   venues   as the parent of a room: likewise. T29 measures it.
 *   agencies and contacts as the OTHER ends of a representation: THIS FILE AND
 *            NOTHING ELSE. A policy term reading those rows would be evaluated
 *            as the caller, and Q3a deliberately permits a record-scoped user
 *            who owns the artist to record a representation naming an agency
 *            they cannot see -- so "deleted" would collapse into "invisible"
 *            and refuse a legitimate write. T28b measures the database still
 *            saying yes, so nobody deletes this check thinking a policy is
 *            behind it.
 *   contacts as the contact end of a contact_companies link: ALSO enforced by
 *            the database (20260828235000 puts `p.deleted_at is null` in the
 *            three `contact_companies_*_via_contact` write policies, so a
 *            direct PostgREST PATCH with the anon key is refused too).
 *            Measured at S28.
 *   companies as the OTHER end of that link: THIS FILE AND NOTHING ELSE, for
 *            the same reason as agencies above -- a policy term reading the
 *            company row would be evaluated as the caller, and a record-scoped
 *            user is deliberately allowed to link a contact to a company they
 *            cannot see. Measured at S28b; 20260828235000's header carries the
 *            argument. Delete the company half of this check and nothing
 *            catches it.
 *
 * Read through the CALLER'S OWN client, so this is not a privileged existence
 * check: a record outside the caller's scope returns nothing here and would
 * have been refused by the policy anyway.
 */
export async function liveInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: ParentTable,
  organisationId: string,
  id: string,
): Promise<RecordPresence> {
  const { data, error } = await supabase
    .from(table)
    .select("deleted_at")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    // 22P02 is an unparseable uuid from the form: no such record, and there
    // never could be. Anything else is a fault, and a fault must not read as
    // "the record is fine" -- fail closed, and fail into the sentence that
    // claims the least.
    if (error.code !== "22P02") {
      console.error(`[crm] ${table} lookup for a child write failed:`, error.message);
    }
    return "gone";
  }
  // ONE BRANCH FOR FOUR SITUATIONS, DELIBERATELY. Another workspace, out of
  // scope, and never existed are all `null` here through the caller's own
  // client, and telling them apart would be the oracle this file is careful
  // not to build.
  if (data === null) return "gone";
  return data.deleted_at === null ? "live" : "deleted";
}

/**
 * The FormState a child write gets when an end is not live, or null when all
 * are and the write should go ahead.
 *
 * The sentence is chosen by `joinEndExplanation()` --
 * `DELETED_RECORD_EXPLANATION` only when being deleted is the only thing
 * wrong, because that string ends with an instruction ("Restore it first") and
 * an instruction that will not help is worse than no explanation. Everything
 * else gets `REFUSED_MESSAGE`, which does not guess.
 *
 * `values` for the same reason every other refusal carries them: React 19
 * resets the form after the action, and a refused save that also empties it
 * has taken the user's work twice.
 */
export function refusedEndState(
  ends: readonly RecordPresence[],
  formData: FormData,
): FormState | null {
  const explanation = joinEndExplanation(ends);
  if (explanation === null) return null;
  return { error: explanation, values: echoedValues(formData) };
}
