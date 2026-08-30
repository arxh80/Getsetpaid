"use server";

// Agencies: create, edit, soft-delete, restore.
//
// The five-step shape lib/crm/contacts.ts states in full, with the plumbing
// imported from lib/crm/actions.ts rather than copied a third time -- see that
// file's header for what Task 4's per-entity cost estimate left out.
//
//   1. Resolve the org through getCurrentOrg(). RLS-gated, so a slug the
//      caller cannot see is null and gets the same refusal as one that does
//      not exist.
//   2. Ask getCrmWriteAccess() BEFORE validating, so a read-only role, a
//      suspended workspace and a Free-tier organisation each get a sentence
//      that names their situation.
//   3. Validate. Server-side, always, whatever the form did.
//   4. Write through the CALLER'S OWN client, never the service-role one.
//   5. Read the ROW COUNT. `commitWrite` / `classifyWrite` -- lib/crm/write.ts.
//      An UPDATE a policy refuses is 204 with count 0 and no error.
//
// ===========================================================================
// THE PERMISSION KEY IS `manage_contacts`, AND THAT IS NOT A COPY-PASTE SLIP
// ===========================================================================
// There is no `manage_agencies` key. 20260828120000's catalogue has six CRM
// keys and 20260828121000 groups this table with the other two under one
// heading in as many words: "companies / contacts / agencies -- the
// relationship layer, manage_contacts".
//
// AN EARLIER VERSION OF THIS COMMENT NAMED THE WRONG ROLE, and the RLS suite
// caught it (T22c). It said a Booker holds `manage_artists` and not
// `manage_contacts`; read out of role_permissions, a Booker holds BOTH.
// `manage_contacts` is the widest key in the matrix -- every role except
// finance and read_only has it -- so the roles that can write a representation
// and NOT an agency are none, and the roles that can write an agency and NOT a
// representation are venue_manager and marketing. That asymmetry is what the
// agency detail page's two `getCrmWriteAccess` calls are for.
//
// ===========================================================================
// NAME ONLY, AND NOTHING IS INVENTED TO FILL THE FORM OUT
// ===========================================================================
// 20260827232510: "The PRD gives agencies no fields beyond identity, and none
// are invented here; anything an agency needs later (address, contacts,
// socials) arrives as an additive migration when a screen actually needs it."
// A one-field form looks thin and is correct; adding a `website` column so the
// form has three inputs would be a schema decision made for a layout reason.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { screenAfterCreate } from "@/lib/crm/dedup";
import { checkName } from "@/lib/crm/validate";

const PERMISSION = "manage_contacts";

function readAgency(
  formData: FormData,
):
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const problem = checkName(name);
  if (problem) {
    // ECHO WHAT WAS SUBMITTED BACK WITH THE ERROR. React 19 resets an
    // uncontrolled form once the action resolves, so without this a single
    // mistake empties the field. `authoriseOrg` does the same for its
    // refusals; here there is one field and one rule.
    return {
      ok: false,
      state: {
        fieldErrors: { [problem.field]: problem.message },
        values: { name: name ?? "" },
      },
    };
  }
  return { ok: true, name: name as string };
}

export async function createAgencyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readAgency(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  // `owner_user_id` IS THE CREATOR, AND FOR A RECORD-SCOPED ROLE IT IS THE
  // ONLY VALUE THE POLICY ACCEPTS: agencies_insert_manage_contacts is
  // `full_scope_organisations() OR owner_user_id = auth.uid()`.
  // `organisation_id` comes from the RESOLVED org, never from the form --
  // CLAUDE.md § Tenancy model.
  const { data, error } = await supabase
    .from("agencies")
    .insert({ organisation_id: org.id, owner_user_id: user.id, name: parsed.name })
    .select("id")
    .maybeSingle();

  // AN INSERT IS THE ONE VERB WHERE THE STATUS CODE IS HONEST. A row refused
  // by WITH CHECK raises 42501 and PostgREST answers 403 -- unlike UPDATE and
  // DELETE, which match nothing and answer 204.
  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    console.error("[crm] create agency failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/agencies`);
  // Outside any try/catch: redirect() works by throwing.
  // DUPLICATE SCREENING, ON CREATE AND NOWHERE ELSE.
  //
  // On create rather than on edit, because the destructive half of it -- the
  // auto-merge -- is bounded here to a record nobody has worked in yet, and on
  // an edit it would destroy months of history as a side effect of fixing a
  // typo in an email address. 20260829020000's DECISION 2 has the full
  // argument.
  //
  // AFTER the insert and BEFORE the redirect: it needs the id, and its result
  // decides where the user lands. `screenAfterCreate` never throws and never
  // fails the create -- the record is already saved and the user has already
  // been told so, and a missed screening is a missed hint rather than lost
  // data.
  const screened = await screenAfterCreate(org.id, "agency", data.id as string);

  // AUTO-MERGE: THIS BRANCH CANNOT FIRE FOR AN AGENCY, AND IS KEPT DELIBERATELY.
  //
  // The comment here used to describe a live behaviour ("the record just
  // created shared an email address ... they go to the record their data is
  // now on"), which was a false claim -- final review L946. `agency` has no
  // `email` column: MERGEABLE_COLUMNS lists `["name"]` for it (lib/crm/dedup.ts:66),
  // and `screen_for_duplicates` labels a pair `exact_email` only when both
  // rows carry a non-null, case-insensitively equal email
  // (20260829020000:383-385). An agency therefore only ever screens as `fuzzy_name`,
  // which is flagged for review and never merged -- so `screened.mergedInto`
  // is always null here.
  //
  // The branch stays rather than being deleted for two reasons: the day
  // agencies gain an email column, the redirect is already correct, and
  // deleting it would make the five create actions differ from each other for
  // a reason no reader could see. `screened.mergedInto` is null, so it costs
  // one comparison.
  if (screened.mergedInto) {
    revalidatePath(`/${org.slug}/agencies`);
    redirect(`/${org.slug}/agencies/${screened.mergedInto}?merged=1`);
  }

  redirect(`/${org.slug}/agencies/${data.id as string}`);
}

export async function updateAgencyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const agencyId = field(formData, "agencyId");
  if (!agencyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readAgency(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update agency ${agencyId}`, () =>
    supabase
      .from("agencies")
      .update(
        { name: parsed.name },
        // THE WHOLE POINT. Without this the response is 204/null/null whether
        // one row changed or none did. See lib/crm/write.ts.
        { count: "exact" },
      )
      // The tenant filter is explicit even though RLS already scopes it:
      // multi-org membership ships at MVP, so RLS alone would permit an id
      // from the caller's OTHER workspace to be edited from this one's URL.
      .eq("organisation_id", org.id)
      .eq("id", agencyId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/agencies`);
    revalidatePath(`/${org.slug}/agencies/${agencyId}`);
    redirect(`/${org.slug}/agencies/${agencyId}`);
  }
  return stateFor(result, "Saved.", formData);
}

/**
 * Soft delete. `deleted_at`, never a hard delete.
 *
 * `.is("deleted_at", null)` in the predicate makes this idempotent in the
 * honest direction: deleting an already-deleted agency matches no rows and is
 * reported as refused rather than silently re-stamping the timestamp and
 * losing when it was actually deleted.
 *
 * THIS IS THE SOFT DELETE THE SCHEMA WAS CHANGED FOR. 20260827232510 added
 * `deleted_at` to `agencies` beyond the plan's field list because
 * `artist_representations` references this table ON DELETE CASCADE -- so a
 * hard delete of an agency that has folded would take the representation
 * history of every artist it ever handled with it. Nothing here hard-deletes,
 * and there is no DELETE grant on the table for it to reach anyway.
 */
export async function deleteAgencyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const agencyId = field(formData, "agencyId");
  if (!agencyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete agency ${agencyId}`, () =>
    supabase
      .from("agencies")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", agencyId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/agencies`);
    revalidatePath(`/${org.slug}/agencies/deleted`);
    revalidatePath(`/${org.slug}/agencies/${agencyId}`);
  }
  // NO REDIRECT, deliberately. The user stays on the record they just deleted,
  // which now renders its deleted state with a Restore control -- so undo is
  // one click away at the moment people realise they wanted it.
  return stateFor(
    result,
    "Deleted. It is no longer in the agencies list; the representations it holds are still recorded.",
    formData,
  );
}

export async function restoreAgencyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const agencyId = field(formData, "agencyId");
  if (!agencyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore agency ${agencyId}`, () =>
    supabase
      .from("agencies")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", agencyId)
      // Mirror of the delete predicate: restoring a live agency matches
      // nothing rather than reporting a success that changed nothing.
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/agencies`);
    revalidatePath(`/${org.slug}/agencies/deleted`);
    revalidatePath(`/${org.slug}/agencies/${agencyId}`);
  }
  return stateFor(result, "Restored. It is back in the agencies list.", formData);
}
