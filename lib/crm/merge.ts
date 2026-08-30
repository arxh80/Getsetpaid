"use server";

// Merging two records, and clearing the review queue.
//
// ===========================================================================
// THE SHAPE IS THE ONE lib/crm/contacts.ts STATES, WITH ONE ADDITION
// ===========================================================================
//   1. resolve the org through getCurrentOrg() -- RLS-gated, so a slug the
//      caller cannot see is null and gets the same refusal as one that does
//      not exist;
//   2. getCrmWriteAccess(org, "merge_records") BEFORE validating, so a
//      read-only role, a suspended workspace and a Free-tier organisation each
//      get a sentence that names their situation;
//   3. validate server-side, whatever the form did;
//   4. write through the CALLER'S OWN client, never the service-role one;
//   5. read the outcome. `commitWrite` / `classifyWrite` -- a PATCH a policy
//      refuses is 204 with count 0 and no error.
//
// THE ADDITION, and it is the reason this file is not a copy of the others: A
// MERGE THAT REPORTS SUCCESS WITHOUT APPLYING IS THE WORST INSTANCE OF THE 204
// DEFECT CLASS IN THIS PHASE. It destroys one of two records. So
// public.merge_records() is written to RAISE on every refusal rather than to
// return a count -- each repoint counts the rows it can see and compares, the
// winner update and the loser soft-delete must each affect exactly one row --
// and this file reuses the `commitWrite` error vocabulary over an RPC whose
// `error is null` genuinely means "all of it applied". Same arrangement as
// saveCustomFieldsAction and setPrimaryCompanyAction, and the same note: the
// `count: 1` below is not a measurement, it is the statement that the
// function's own guarantee has replaced the count.
//
// ===========================================================================
// THE PERMISSION IS merge_records, AND EVERY ROLE THAT HOLDS IT IS FULL-SCOPE
// ===========================================================================
// Owner, Admin and Manager -- read out of public.role_permissions, not
// assumed. private.full_scope_organisations() excludes standard_user and
// read_only, so no record-scoped user can merge anything. That is why nothing
// here worries about a merge reaching across a record-scope boundary: the
// permission matrix closes it, and the merge screen's own read (loadMergePair)
// runs as the caller anyway.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import {
  commitWrite,
  CONFLICT_MESSAGE,
  FAILED_MESSAGE,
  REFUSED_MESSAGE,
  UNKNOWN_MESSAGE,
  type WriteResult,
} from "@/lib/crm/write";
import {
  entityHref,
  isMergeEntityType,
  loadRecordPair,
  MERGEABLE_COLUMNS,
} from "@/lib/crm/dedup";
import { ENTITY_PATH_SEGMENT } from "@/lib/crm/custom-fields";

/** The key every write below is gated on. */
const PERMISSION = "merge_records";

/**
 * Resolve the organisation and check write access in one step.
 *
 * A copy of lib/crm/contacts.ts's `authorise()` down to the echoed values,
 * because the property it protects is the same one: a refused submit that also
 * empties the form has taken the user's work twice. It is a copy rather than a
 * shared helper for the reason Task 4b gave when it made the fifth one --
 * `PERMISSION` differs per module and hoisting it would mean passing the key
 * plus the entity noun plus the redirect target, which is the whole function.
 */
async function authorise(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  const echoed = echoedValues(formData);
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE, values: echoed } };
  const access = await getCrmWriteAccess(org, PERMISSION);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * The FormState for a write that did not apply.
 *
 * A SWITCH WITH NO `default` ARM, which is the point: five outcomes today, and
 * a sixth is a compile error here rather than a wrong sentence in front of
 * somebody who has just destroyed a record. `pnpm typecheck` is what runs it --
 * nothing else in this repository invokes tsc.
 */
function failureState(
  result: Exclude<WriteResult, { outcome: "applied" }>,
  formData: FormData,
): FormState {
  const values = echoedValues(formData);
  switch (result.outcome) {
    case "refused":
      return { error: REFUSED_MESSAGE, values };
    case "conflict":
      return { error: CONFLICT_MESSAGE, values };
    case "unknown":
      return { error: UNKNOWN_MESSAGE, values };
    case "failed":
      return { error: FAILED_MESSAGE, values };
  }
}

/**
 * The sentence for a merge screen whose two records are no longer mergeable.
 *
 * DISTINCT FROM `REFUSED_MESSAGE`, and the distinction is worth a string. A
 * refusal is about the caller ("your access may have changed"); this is about
 * the records ("one of these is already gone"), which happens routinely when
 * two people work the same queue and is not a fault of either of them.
 */
const PAIR_GONE_MESSAGE =
  "One of these records has been deleted or merged already, so there’s nothing left to merge. Reload the page to see where it went.";

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Perform a merge from the field-resolution screen.
 *
 * WHAT COMES FROM THE FORM AND WHAT DOES NOT:
 *   from the form   which record survives, and one choice per field.
 *   NOT from the form   the organisation (resolved from the slug), the actor
 *                       (auth.uid(), pinned inside the database), and the
 *                       surviving VALUES -- the function reads both rows and
 *                       resolves the choices itself, so a forged submit can
 *                       pick the wrong side but cannot inject a value that was
 *                       in neither record.
 *
 * The choice inputs are read against `MERGEABLE_COLUMNS`, so a `choice_`
 * parameter naming a column that is not mergeable for this entity type is
 * dropped here and would be ignored by the function anyway. Two gates for one
 * rule, and the second is the one that counts.
 */
export async function mergeRecordsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityType = field(formData, "entityType");
  const keepId = field(formData, "keepId");
  const duplicateId = field(formData, "duplicateId");
  if (!entityType || !isMergeEntityType(entityType) || !keepId || !duplicateId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (keepId === duplicateId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // WHICH RECORD SURVIVES. Defaults to the one the queue proposed (the older
  // of the two), and the form can swap it -- a merge is a judgement about
  // which record is better filled in, and the older one is not always it.
  const survivor = field(formData, "survivor") === "duplicate" ? "duplicate" : "keep";
  const winnerId = survivor === "duplicate" ? duplicateId : keepId;
  const loserId = survivor === "duplicate" ? keepId : duplicateId;

  // BOTH RECORDS ARE RE-READ BEFORE THE WRITE, through the caller's own client.
  // Not for authorisation -- merge_records() decides that -- but so the two
  // failure modes that are NOT refusals get their own sentence: a record
  // deleted or merged by somebody else between the page rendering and the
  // submit is the common case on a shared queue, and "your access may have
  // changed" would be the wrong thing to tell the second reviewer.
  const pair = await loadRecordPair(org.id, entityType, keepId, duplicateId);
  if (!pair) {
    return { error: PAIR_GONE_MESSAGE, values: echoedValues(formData) };
  }

  const fieldChoices = readChoices(formData, "choice_", MERGEABLE_COLUMNS[entityType]);
  const customChoices = readChoices(
    formData,
    "custom_",
    pair.definitions.map((definition) => definition.id),
  );

  // The choices are recorded relative to `keep`/`duplicate`, which is what the
  // form knows. The function speaks winner/loser. Flipping the survivor has to
  // flip every choice with it, or a user who swaps the direction silently
  // inverts every field they picked.
  const flip = (choice: string): string =>
    survivor === "keep"
      ? choice === "duplicate"
        ? "loser"
        : "winner"
      : choice === "duplicate"
        ? "winner"
        : "loser";

  const supabase = await createClient();
  const result = await commitWrite(
    `merge ${entityType} ${loserId} into ${winnerId}`,
    async () => {
      const { error } = await supabase.rpc("merge_records", {
        p_organisation_id: org.id,
        p_entity_type: entityType,
        p_winner_id: winnerId,
        p_loser_id: loserId,
        p_field_choices: Object.fromEntries(
          Object.entries(fieldChoices).map(([key, value]) => [key, flip(value)]),
        ),
        p_custom_field_choices: Object.fromEntries(
          Object.entries(customChoices).map(([key, value]) => [key, flip(value)]),
        ),
      });
      // NOT A MEASUREMENT. public.merge_records() raises on every refusal --
      // each repoint compares against the rows it could see, the winner update
      // and the loser soft-delete must each affect exactly one row -- so a null
      // error means the whole merge applied and there is no count to read. Same
      // arrangement, and the same caveat, as saveCustomFieldsAction.
      return { error, count: 1 };
    },
  );

  if (result.outcome !== "applied") return failureState(result, formData);

  const segment = ENTITY_PATH_SEGMENT[entityType];
  revalidatePath(`/${org.slug}/${segment}`);
  revalidatePath(`/${org.slug}/${segment}/${winnerId}`);
  revalidatePath(`/${org.slug}/duplicates`);
  // Outside any try/catch: redirect() works by throwing. Straight to the
  // surviving record, because "where did my data go" is the question a merge
  // leaves behind and the answer is a page.
  redirect(entityHref(org.slug, entityType, winnerId));
}

/**
 * Read a group of `<name>_<key>` radio inputs into `{ key: choice }`.
 *
 * Keys come from an ALLOWLIST the caller supplies, never from the form, so a
 * forged `choice_organisation_id=duplicate` is not read at all. Values are
 * narrowed to the two the form can legitimately send; anything else is dropped
 * and the function's own default (the winner keeps its value, unless it has
 * none and the loser has one) applies.
 */
function readChoices(
  formData: FormData,
  prefix: string,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = field(formData, `${prefix}${key}`);
    if (value === "keep" || value === "duplicate") out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

/**
 * Take a pair off the queue without merging them.
 *
 * "These two are different people" is the answer most of the time -- a queue
 * that can only be cleared by destroying a record is a queue people stop
 * opening. The row is soft-deleted with `resolution = 'dismissed'` rather than
 * removed, so the pair is not re-flagged on the next screening of either
 * record and the decision is auditable.
 *
 * A PATCH, so `count: "exact"` is not optional: read_only and booker hold no
 * merge_records, the UPDATE policy filters the row out, and PostgREST answers
 * 204 with a row count of zero -- byte-identical to a real dismissal apart
 * from the Content-Range header. Measured over HTTP in run-rls-tests.sh: a
 * refused dismissal reports a total of 0 and a real one reports 1, and nothing
 * else about the two responses differs.
 */
export async function dismissCandidateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const candidateId = field(formData, "candidateId");
  if (!candidateId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  // `resolved_by` is sent because the WITH CHECK pins it to auth.uid() and a
  // NULL would fail the merge_candidates_resolution_complete constraint. The
  // value is not trusted for a moment: the policy compares it to the session's
  // own uid, so a forged one is a refusal rather than a mis-attribution. It is
  // read from the VERIFIED claims (getCurrentUser, which calls getClaims and
  // not the cookie's contents) and is cached for this request.
  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();

  const result = await commitWrite(
    `dismiss merge candidate ${candidateId}`,
    () =>
      supabase
        .from("merge_candidates")
        .update(
          {
            deleted_at: new Date().toISOString(),
            resolution: "dismissed",
            resolved_by: user.id,
          },
          { count: "exact" },
        )
        .eq("organisation_id", org.id)
        .eq("id", candidateId)
        .is("deleted_at", null),
  );

  if (result.outcome !== "applied") return failureState(result, formData);

  revalidatePath(`/${org.slug}/duplicates`);
  return { message: "Dismissed. These two records are no longer flagged." };
}
