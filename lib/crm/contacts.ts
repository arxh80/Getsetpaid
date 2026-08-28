"use server";

// Contacts: create, edit, soft-delete, restore, and the contact_companies join.
//
// ===========================================================================
// THE SHAPE TASK 4b COPIES, STATED ONCE
// ===========================================================================
//   1. Resolve the org through getCurrentOrg(). It is RLS-gated, so a slug the
//      caller cannot see is null and gets the same refusal as one that does
//      not exist.
//   2. Ask getCrmWriteAccess() BEFORE validating. A read-only role, a
//      suspended workspace and a Free-tier organisation each get a sentence
//      that names their situation, instead of a form that submits and then
//      silently changes nothing.
//   3. Validate. Server-side, always, whatever the form did.
//   4. Write through the CALLER'S OWN client, never the service-role one, so
//      the RLS policy is the decision and this file is the message.
//   5. Read the ROW COUNT. `commitWrite` / `classifyWrite` -- see
//      lib/crm/write.ts for the measurement. An UPDATE a policy refuses is
//      204 with count 0 and no error, and treating that as success is the
//      single most likely way this file could lie to a customer.
//
// Step 2 is a courtesy and step 4 is the control. Both are needed:
// CLAUDE.md § Permissions -- "hiding UI is not enforcement" -- and its
// converse, that enforcement with no explanation is a product people cannot
// use.
//
// ===========================================================================
// AUDIT: WHAT IS ALREADY WRITTEN, AND WHY NOTHING HERE ADDS TO IT
// ===========================================================================
// 20260828141000 puts a trigger on the two hard-DELETE paths this phase opened
// -- contact_companies and custom_field_values -- plus merges, recording
// actor, org, target and an allowlisted identifier payload. `unlinkCompany`
// below is one of those paths, so it is ALREADY audited, in the database,
// including when it is reached by a direct PostgREST call that never touches
// this file. Adding an application-side audit event to the same operation
// would produce two rows per deletion with different correlation ids.
//
// The soft deletes and the field edits are NOT audited, deliberately and not
// by omission: that migration's header records the split, and full CRM write
// auditing (before/after diffs, their retention, and the viewer that reads
// them) is Phase 7's feature. A row that is still there is recoverable from
// itself; what is missing is the previous value, and capturing that well is
// a design, not a line of code.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { field, type FormState } from "@/lib/forms";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import {
  commitWrite,
  FAILED_MESSAGE,
  REFUSED_MESSAGE,
  type WriteResult,
} from "@/lib/crm/write";
import {
  checkEmail,
  checkName,
  checkPhone,
  checkShortText,
  parseTags,
  type FieldProblem,
} from "@/lib/crm/validate";
import { hasUnsafeScheme, normaliseWebsite, SOCIAL_PLATFORMS } from "@/lib/crm/urls";

/** The permission key every write below is gated on. */
const PERMISSION = "manage_contacts";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * Resolve the organisation and check write access in one step.
 *
 * Returns either the org or the FormState to hand straight back. The
 * suspended/tier/permission explanation is used verbatim, so the message next
 * to a disabled control and the message after a submitted form are the same
 * sentence -- which matters, because the form can be submitted by anyone who
 * ignores the disabled attribute, and the two paths disagreeing is how a user
 * concludes one of them is wrong.
 */
async function authorise(
  orgSlug: string | null,
): Promise<
  | { readonly ok: true; readonly org: CurrentOrg }
  | { readonly ok: false; readonly state: FormState }
> {
  if (!orgSlug) return { ok: false, state: { error: FAILED_MESSAGE } };
  const org = await getCurrentOrg(orgSlug);
  // A slug that does not exist, belongs to another tenant, or that the caller
  // is only invited to. All three are the same answer, on purpose.
  if (!org) return { ok: false, state: { error: FAILED_MESSAGE } };

  const access = await getCrmWriteAccess(org, PERMISSION);
  if (!access.canWrite) return { ok: false, state: { error: access.explanation } };
  return { ok: true, org };
}

/** Turn a WriteResult into the FormState a form renders. */
function stateFor(result: WriteResult, success: string): FormState {
  if (result.outcome === "applied") return { message: success };
  if (result.outcome === "refused") return { error: REFUSED_MESSAGE };
  return { error: FAILED_MESSAGE };
}

interface ContactValues {
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  location: string | null;
  website: string | null;
  socials: Record<string, string>;
  tags: string[];
}

/**
 * Read and validate the contact form.
 *
 * Every problem is collected rather than returned at the first one: a form
 * that reports one error per submit is a form people give up on, and the
 * fields are independent so there is no reason to stop.
 */
function readContact(
  formData: FormData,
): { readonly ok: true; readonly values: ContactValues } | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const email = field(formData, "email");
  const phone = field(formData, "phone");
  const title = field(formData, "title");
  const location = field(formData, "location");
  const websiteRaw = field(formData, "website");

  const problems: (FieldProblem | null)[] = [
    checkName(name),
    checkEmail(email),
    checkPhone(phone),
    checkShortText("title", title, "Role"),
    checkShortText("location", location, "Location"),
  ];

  const website = normaliseWebsite(websiteRaw);
  const websiteValue = website.ok ? website.value : null;
  if (!website.ok) problems.push({ field: "website", message: website.message });

  const { tags, problem: tagProblem } = parseTags(field(formData, "tags"));
  problems.push(tagProblem);

  // SOCIALS. The one field group where the database can enforce nothing at all
  // beyond "it is an object" -- 20260827232510's column comment says so -- so
  // this is the only write-side check that exists. It is not the CONTROL,
  // though: lib/crm/urls.ts's render side is, because PostgREST is reachable
  // from a browser with the anon key and rows predating this file exist by
  // assumption.
  const socials: Record<string, string> = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const value = field(formData, `social_${platform.key}`);
    if (value === null) continue;
    if (value.length > 300) {
      problems.push({
        field: `social_${platform.key}`,
        message: "Use 300 characters or fewer.",
      });
      continue;
    }
    if (hasUnsafeScheme(value)) {
      problems.push({
        field: `social_${platform.key}`,
        message:
          "Only http:// and https:// links can be stored. A plain handle is fine too.",
      });
      continue;
    }
    socials[platform.key] = value;
  }

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) {
      fieldErrors[problem.field] = problem.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, state: { fieldErrors } };

  return {
    ok: true,
    values: {
      // `name` is non-null here: checkName() returns a problem for null and we
      // returned above if there was one.
      name: name as string,
      email,
      phone,
      title,
      location,
      website: websiteValue,
      socials,
      tags,
    },
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createContactAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readContact(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE };

  const supabase = await createClient();

  // `owner_user_id` IS THE CREATOR, AND FOR A RECORD-SCOPED ROLE IT IS ALSO
  // THE ONLY VALUE THE POLICY ACCEPTS. contacts_insert_manage_contacts is
  // `full_scope_organisations() OR owner_user_id = auth.uid()`, so a Standard
  // User creating a contact they do not own is refused by the database. It is
  // set here rather than defaulted in the schema because the schema's default
  // would be `auth.uid()` evaluated at insert time, which is the same value
  // reached by a less visible route.
  //
  // `organisation_id` comes from the RESOLVED org, never from the form.
  // CLAUDE.md § Tenancy model: never trust a client-supplied organisation id.
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      name: parsed.values.name,
      email: parsed.values.email,
      phone: parsed.values.phone,
      title: parsed.values.title,
      location: parsed.values.location,
      website: parsed.values.website,
      socials: parsed.values.socials,
      tags: parsed.values.tags,
    })
    .select("id")
    .maybeSingle();

  // AN INSERT IS THE ONE VERB WHERE THE STATUS CODE IS HONEST. A row refused
  // by WITH CHECK raises 42501 and PostgREST answers 403 -- unlike UPDATE and
  // DELETE, which match nothing and answer 204. So this path reads the error,
  // and the row count layer is not needed here. It is still the same
  // vocabulary: 42501 is a refusal, anything else is a fault.
  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    console.error("[crm] create contact failed:", error.message);
    return { error: FAILED_MESSAGE };
  }
  if (!data) return { error: FAILED_MESSAGE };

  revalidatePath(`/${org.slug}/contacts`);
  // Outside any try/catch: redirect() works by throwing.
  redirect(`/${org.slug}/contacts/${data.id as string}`);
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
export async function updateContactAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };

  const parsed = readContact(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();

  const result = await commitWrite(`update contact ${contactId}`, () =>
    supabase
      .from("contacts")
      .update(
        {
          name: parsed.values.name,
          email: parsed.values.email,
          phone: parsed.values.phone,
          title: parsed.values.title,
          location: parsed.values.location,
          website: parsed.values.website,
          socials: parsed.values.socials,
          tags: parsed.values.tags,
        },
        // THE WHOLE POINT. Without this the response is 204/null/null whether
        // fifteen rows changed or none did. See lib/crm/write.ts.
        { count: "exact" },
      )
      // The tenant filter is explicit even though RLS already scopes it, for
      // the same reason lib/list/query.ts writes it: multi-org membership
      // ships at MVP, so RLS alone would permit an id from the caller's OTHER
      // workspace to be edited from this one's URL.
      .eq("organisation_id", org.id)
      .eq("id", contactId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/contacts`);
    revalidatePath(`/${org.slug}/contacts/${contactId}`);
    redirect(`/${org.slug}/contacts/${contactId}`);
  }
  return stateFor(result, "Saved.");
}

// ---------------------------------------------------------------------------
// Soft delete and restore
// ---------------------------------------------------------------------------

/**
 * Soft delete. `deleted_at`, never a hard delete (CLAUDE.md § Non-negotiable
 * rules).
 *
 * `.is("deleted_at", null)` in the predicate makes this idempotent in the
 * honest direction: deleting an already-deleted contact matches no rows and is
 * reported as refused rather than silently re-stamping the timestamp and
 * losing when it was actually deleted.
 */
export async function deleteContactAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const result = await commitWrite(`delete contact ${contactId}`, () =>
    supabase
      .from("contacts")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", contactId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/contacts`);
    revalidatePath(`/${org.slug}/contacts/deleted`);
    revalidatePath(`/${org.slug}/contacts/${contactId}`);
  }
  // NO REDIRECT, deliberately. The user stays on the record they just deleted,
  // which now renders its deleted state with a Restore control -- so undo is
  // one click away at the moment people realise they wanted it, rather than a
  // trip to a list they have to know exists. It is also what makes the detail
  // route work for the restore queue, which links straight into it.
  return stateFor(result, "Deleted. It is no longer in the contacts list.");
}

export async function restoreContactAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const result = await commitWrite(`restore contact ${contactId}`, () =>
    supabase
      .from("contacts")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", contactId)
      // Mirror of the delete predicate: restoring a live contact matches
      // nothing rather than reporting a success that changed nothing.
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/contacts`);
    revalidatePath(`/${org.slug}/contacts/deleted`);
    revalidatePath(`/${org.slug}/contacts/${contactId}`);
  }
  return stateFor(result, "Restored. It is back in the contacts list.");
}

// ---------------------------------------------------------------------------
// The contact_companies join -- editable from BOTH sides
// ---------------------------------------------------------------------------
//
// The same three actions back the "Companies" panel on a contact and the
// "People" panel on a company. They are written once and take both ids,
// because the row they operate on is one row either way and a second copy
// keyed the other way round is a second copy that can drift.
//
// WHAT DECIDES ACCESS IS THE CONTACT, NOT THE COMPANY.
// contact_companies_*_via_contact (20260828121000) reach EXISTS against
// `contacts` alone -- adjudicated as Q5 in Task 1 -- so a record-scoped user
// who owns the contact may link it to a company they cannot see. That is the
// accepted company-existence oracle recorded in the decisions queue; it is the
// database's decision and this file does not narrow it, because narrowing it
// here and not there is drift that reads as a control.

export async function linkCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  const companyId = field(formData, "companyId");
  if (!contactId) return { error: FAILED_MESSAGE };
  if (!companyId) {
    return { fieldErrors: { companyId: "Choose a company to link." } };
  }

  const supabase = await createClient();
  // ALWAYS is_primary FALSE. Making the link and making it primary are two
  // operations because the second one has to demote whatever is primary now,
  // and a partial unique index cannot be deferred -- see
  // public.set_contact_primary_company(). An INSERT with is_primary true would
  // raise 23505 whenever a primary already exists, which is a database error
  // surfaced as "something went wrong" for an ordinary click.
  const { error } = await supabase.from("contact_companies").insert({
    organisation_id: org.id,
    contact_id: contactId,
    company_id: companyId,
    is_primary: false,
  });

  if (error) {
    // The one link that already exists. `contact_companies_contact_company_unique`
    // is integrity rather than a product rule (20260827232510), so the honest
    // message is "already linked", not an error.
    if (error.code === "23505") {
      return { fieldErrors: { companyId: "That company is already linked." } };
    }
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    console.error("[crm] link company failed:", error.message);
    return { error: FAILED_MESSAGE };
  }

  revalidatePath(`/${org.slug}/contacts/${contactId}`);
  revalidatePath(`/${org.slug}/companies/${companyId}`);
  return { message: "Linked." };
}

export async function unlinkCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  const companyId = field(formData, "companyId");
  if (!contactId || !companyId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  // A HARD DELETE, and the only one in this file. The link row carries no
  // information of its own beyond "these two are connected"; there is nothing
  // to soft-delete and CLAUDE.md's rule is about operational RECORDS. It is
  // audited by the trigger in 20260828141000, which is why nothing here writes
  // an audit event.
  //
  // Same count discipline as an UPDATE: a DELETE a policy refuses also matches
  // nothing and answers 204.
  const result = await commitWrite(
    `unlink company ${companyId} from contact ${contactId}`,
    () =>
      supabase
        .from("contact_companies")
        .delete({ count: "exact" })
        .eq("organisation_id", org.id)
        .eq("contact_id", contactId)
        .eq("company_id", companyId),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/contacts/${contactId}`);
    revalidatePath(`/${org.slug}/companies/${companyId}`);
  }
  return stateFor(result, "Unlinked.");
}

/**
 * Set (or clear) a contact's primary company.
 *
 * THIS IS THE ONE WRITE IN THE PHASE THAT CANNOT BE A SINGLE STATEMENT, and
 * `public.set_contact_primary_company()` is why -- see 20260828230000's header
 * for the measurement. supabase-js issues one HTTP request per statement, so
 * a transaction is only reachable through a function.
 *
 * The RPC returns the number of rows promoted, so the same row-count rule
 * applies as everywhere else: 0 means the caller's write did not apply. It
 * raises 42501 rather than returning 0 when a promote is refused, precisely so
 * the demote half rolls back with it.
 */
export async function setPrimaryCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"));
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };
  // An absent companyId is "clear the primary", which is a legitimate request.
  const companyId = field(formData, "companyId");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_contact_primary_company", {
    p_contact_id: contactId,
    p_company_id: companyId,
  });

  if (error) {
    // 42501 covers all three refusals the function can make: the promote
    // matched nothing, the clear had nothing to clear, or a policy refused the
    // caller outright. They are deliberately one answer -- see the function's
    // own comment on why distinguishing them would be an existence oracle.
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    console.error("[crm] set primary company failed:", error.message);
    return { error: FAILED_MESSAGE };
  }

  // No row-count check here, and that is not an exception to the rule -- it is
  // the rule moved inside the function. `set_contact_primary_company()` raises
  // rather than returning 0 for every case where nothing applied, precisely
  // because a returned 0 would arrive here as a 200 with no error, which is
  // the same trap as a 204 one layer down.
  revalidatePath(`/${org.slug}/contacts/${contactId}`);
  if (companyId) revalidatePath(`/${org.slug}/companies/${companyId}`);

  return {
    message: companyId ? "Primary company updated." : "Primary company cleared.",
  };
}
