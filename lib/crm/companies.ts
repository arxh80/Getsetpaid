"use server";

// Companies: create, edit, soft-delete, restore.
//
// The same five-step shape lib/crm/contacts.ts states in full, and Task 4b
// copies. What is worth saying HERE is what did NOT need repeating:
//
//   * The contact_companies join is edited from this side with the SAME three
//     actions (`linkCompanyAction`, `unlinkCompanyAction`,
//     `setPrimaryCompanyAction`) that the contact side uses. There is one row
//     and one policy, so there is one implementation; only the form differs,
//     picking a contact instead of a company. A second copy keyed the other
//     way round is a second copy that can drift, and the RLS policies decide
//     access from the CONTACT either way, so a company-side copy would have
//     been the same query with a misleading name.
//   * The permission key is `manage_contacts`, not a `manage_companies` that
//     does not exist. 20260828120000's catalogue has six CRM keys and this is
//     the one covering contacts, companies and the join -- checked against
//     public.permissions rather than assumed.
//
// ===========================================================================
// `type` IS VALIDATED HERE AND ENFORCED IN THE DATABASE, AND BOTH ARE RIGHT
// ===========================================================================
// `companies_type_allowed` is an element-level CHECK (`type <@ array[...]`),
// so an unknown value is refused by the database whatever this file does. What
// this file adds is that the refusal arrives as a sentence next to the field
// instead of a raised 23514 rendered as "something went wrong" -- and that the
// EMPTY ARRAY is accepted rather than treated as a missing required field,
// because 20260827232510 says in terms that an untyped company is "a
// legitimate half-entered record".

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
import { screenAfterCreate } from "@/lib/crm/dedup";
import { checkName, type FieldProblem } from "@/lib/crm/validate";
import { COMPANY_TYPES } from "@/lib/crm/companies-list";

const PERMISSION = "manage_contacts";

const ALLOWED_TYPES = new Set<string>(COMPANY_TYPES.map((t) => t.value));

async function authorise(
  orgSlug: string | null,
  formData: FormData,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  // EVERY REFUSAL CARRIES THE SUBMITTED VALUES BACK, not just the validation
  // ones. Measured in a browser: with the org suspended mid-edit, the form
  // correctly refused to say it saved -- and threw away the change the user
  // had just typed, because React resets the form and this path returned no
  // `values`. Losing the edit is the same insult whichever gate refused it.
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
 * Turn a WriteResult into the FormState a form renders.
 *
 * `formData` so a refusal echoes the submitted values back with the message --
 * React 19 resets the form after the action, and a refused save that also
 * empties the form has taken the user's work twice.
 */
function stateFor(
  result: WriteResult,
  success: string,
  formData: FormData,
): FormState {
  if (result.outcome === "applied") return { message: success };
  const values = echoedValues(formData);
  // See lib/crm/contacts.ts's copy: a switch with NO `default` arm, so a new
  // outcome is a compile error rather than a wrong sentence. The mechanism is
  // the declared `FormState` return type under `strict` -- a fifth member of
  // the union leaves a path that falls off the end returning `undefined`, and
  // TS2366 says so. There is no `never` arm; an earlier version of this comment
  // said there was. `pnpm typecheck` is the only thing that runs it.
  // `unknown` in particular must not be told "Nothing has been changed",
  // because that is exactly what is not known.
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

interface CompanyValues {
  name: string;
  type: string[];
}

function readCompany(
  formData: FormData,
): { readonly ok: true; readonly values: CompanyValues } | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const problems: (FieldProblem | null)[] = [checkName(name)];

  // `getAll` because the control is a group of checkboxes sharing one name --
  // the honest HTML for "zero or more of a fixed set", and the one that
  // degrades to a working multi-select with no JavaScript.
  //
  // Every value is checked against the vocabulary and duplicates are dropped:
  // a repeated value would be stored twice in the array, which passes the
  // CHECK (containment does not care) and then renders the same chip twice.
  const seen = new Set<string>();
  const type: string[] = [];
  for (const raw of formData.getAll("type")) {
    if (typeof raw !== "string") continue;
    if (!ALLOWED_TYPES.has(raw)) {
      problems.push({ field: "type", message: "That isn’t a company type we recognise." });
      break;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    type.push(raw);
  }

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) {
      fieldErrors[problem.field] = problem.message;
    }
  }
  // See lib/crm/contacts.ts's copy: React 19 resets the form after the action,
  // so the submitted values have to come back with the errors.
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return { ok: true, values: { name: name as string, type } };
}

export async function createCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readCompany(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      name: parsed.values.name,
      type: parsed.values.type,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    console.error("[crm] create company failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/companies`);
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
  const screened = await screenAfterCreate(org.id, "company", data.id as string);

  // AUTO-MERGED AWAY. The record just created shared an email address, exactly
  // and case-insensitively, with an older one -- so it no longer exists as a
  // separate record and redirecting to its own page would be a 404 the user
  // caused by saving a form. They go to the record their data is now on.
  if (screened.mergedInto) {
    revalidatePath(`/${org.slug}/companies`);
    redirect(`/${org.slug}/companies/${screened.mergedInto}?merged=1`);
  }

  redirect(`/${org.slug}/companies/${data.id as string}`);
}

export async function updateCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const companyId = field(formData, "companyId");
  if (!companyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readCompany(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update company ${companyId}`, () =>
    supabase
      .from("companies")
      .update(
        { name: parsed.values.name, type: parsed.values.type },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", companyId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/companies`);
    revalidatePath(`/${org.slug}/companies/${companyId}`);
    redirect(`/${org.slug}/companies/${companyId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const companyId = field(formData, "companyId");
  if (!companyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete company ${companyId}`, () =>
    supabase
      .from("companies")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", companyId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/companies`);
    revalidatePath(`/${org.slug}/companies/deleted`);
    revalidatePath(`/${org.slug}/companies/${companyId}`);
  }
  // SOFT-DELETING A COMPANY DOES NOT UNLINK ITS CONTACTS, and that is the
  // point of soft delete: restore has to bring the record back as it was. The
  // links stay, and the contact detail page marks a linked company that has
  // been deleted rather than hiding it -- hiding it would make the contact
  // look unaffiliated while the row still says otherwise.
  return stateFor(result, "Deleted. It is no longer in the companies list.", formData);
}

export async function restoreCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const companyId = field(formData, "companyId");
  if (!companyId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore company ${companyId}`, () =>
    supabase
      .from("companies")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", companyId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/companies`);
    revalidatePath(`/${org.slug}/companies/deleted`);
    revalidatePath(`/${org.slug}/companies/${companyId}`);
  }
  return stateFor(result, "Restored. It is back in the companies list.", formData);
}
