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
import { echoedValues, field, type FormState } from "@/lib/forms";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  commitWrite,
  CONFLICT_MESSAGE,
  FAILED_MESSAGE,
  REFUSED_MESSAGE,
  UNKNOWN_MESSAGE,
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
import {
  hasUnsafeScheme,
  mergeSocials,
  normaliseWebsite,
  SOCIAL_PLATFORMS,
} from "@/lib/crm/urls";

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
  // A slug that does not exist, belongs to another tenant, or that the caller
  // is only invited to. All three are the same answer, on purpose.
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
  return failureState(result, formData);
}

/**
 * The FormState for a write that did not apply.
 *
 * Split out because `setPrimaryCompanyAction` has no success string to pass --
 * its confirmation depends on whether a company was named -- and calling
 * `stateFor(result, "", formData)` to reach this branch reads as a bug.
 */
function failureState(
  result: Exclude<WriteResult, { outcome: "applied" }>,
  formData: FormData,
): FormState {
  const values = echoedValues(formData);
  // A SWITCH RATHER THAN AN IF-CHAIN WITH A FALLBACK. Four outcomes today and
  // the `never` arm is what makes a fifth a compile error here rather than a
  // wrong sentence in front of a customer -- which is how "Nothing has been
  // changed" came to be shown for a write that had changed something.
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
  //
  // WHAT THIS RETURNS IS THE SIX KEYS THE FORM OWNS, NOT THE WHOLE COLUMN.
  // `createContactAction` stores it as-is (there is nothing to merge with);
  // `updateContactAction` puts it through `mergeSocials()` over the stored
  // object, so a key from an import that the form never rendered is not
  // destroyed by an unrelated edit.
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
  // ECHO WHAT WAS SUBMITTED BACK WITH THE ERRORS. React 19 resets an
  // uncontrolled form after its action resolves, so without this a single
  // mistyped character empties every field -- measured in a browser, see
  // FormState.values.
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

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
  const auth = await authorise(field(formData, "orgSlug"), formData);
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
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };

  const parsed = readContact(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();

  // SOCIALS ARE MERGED, NOT REPLACED, and the read that makes that possible is
  // this one. `socials` is a free-form jsonb object; the form has inputs for
  // six keys and an import can have written any number of others. Writing the
  // six over the column destroyed the rest -- silently, permanently, with no
  // undo and no audit row. See mergeSocials() for the rule.
  //
  // Read through the CALLER'S client and filtered by organisation, so this is
  // not a privileged peek: if the caller cannot read the row, `stored` is
  // empty and the UPDATE below matches nothing and is reported as refused.
  const existing = await supabase
    .from("contacts")
    .select("socials")
    .eq("organisation_id", org.id)
    .eq("id", contactId)
    .maybeSingle();
  if (existing.error && existing.error.code !== "22P02") {
    // A FAILED LOOKUP IS NOT AN EMPTY ONE. Continuing with `{}` here would
    // turn a transient database error into the exact data loss this read
    // exists to prevent.
    console.error("[crm] update contact socials read failed:", existing.error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  const socials = mergeSocials(existing.data?.socials, parsed.values.socials);

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
          socials,
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
  return stateFor(result, "Saved.", formData);
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
  const auth = await authorise(field(formData, "orgSlug"), formData);
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
  return stateFor(result, "Deleted. It is no longer in the contacts list.", formData);
}

export async function restoreContactAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
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
  return stateFor(result, "Restored. It is back in the contacts list.", formData);
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

/**
 * Is this a LIVE row of THIS workspace, reachable by THIS caller?
 *
 * ===========================================================================
 * RLS ANSWERS A DIFFERENT QUESTION FROM THE ONE THE URL ASKS
 * ===========================================================================
 * `contact_companies_*_via_contact` asks "may this caller write this row".
 * The URL asks "is this row the one this workspace's page is about". For a
 * member of one organisation those coincide; multi-org membership ships at
 * MVP, so for an ordinary admin of two workspaces they do not -- and the
 * primary-company RPC, the only write in the task without an explicit
 * organisation term, let workspace A's URL promote a company on workspace B's
 * contact. Every other write in this file carries
 * `.eq("organisation_id", org.id)` for the same reason.
 *
 * ===========================================================================
 * AND ONLY ONE OF THEM ASKS WHETHER THE RECORD IS DELETED
 * ===========================================================================
 * The defect: the detail route serves deleted records on purpose (restore has
 * to be reachable) and it rendered the whole link panel next to the "Deleted"
 * notice. Reproduced in a browser -- a soft-deleted contact's primary company
 * was changed and the write applied. `updateContactAction` refuses the same
 * record with `.is("deleted_at", null)`; these three did not.
 *
 * WHAT IS BEHIND THIS CHECK, EXACTLY, AND WHAT IS NOT:
 *
 *   * THE CONTACT END IS ENFORCED BY THE DATABASE. 20260828235000 adds
 *     `p.deleted_at is null` to the three `contact_companies_*_via_contact`
 *     write policies, so a direct PostgREST PATCH by a member with
 *     'manage_contacts' and the anon key is refused too. Measured at S28.
 *     The first fix round argued a policy term was impossible here on design
 *     note (g); (g) is about SELECT on the row being restored, and restoring
 *     a contact does not touch this table. That reason was wrong.
 *
 *   * THE COMPANY END IS THIS FILE AND NOTHING ELSE. A `companies.deleted_at`
 *     term in the policy would have to read the company row as the caller,
 *     and under Q5 a record-scoped user may link their own contact to a
 *     company they cannot see -- so "deleted" would collapse into "invisible"
 *     and refuse a legitimate write. Left open deliberately, measured at S28b,
 *     and the reason is in 20260828235000's header. Delete the company half of
 *     this check and nothing catches it.
 *
 * Read through the CALLER'S OWN client, so this is not a privileged existence
 * check: a record outside the caller's scope returns nothing here and would
 * have been refused by the policy anyway.
 */
async function liveInOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "contacts" | "companies",
  organisationId: string,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("organisation_id", organisationId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    // 22P02 is an unparseable uuid from the form: no such record, and there
    // never could be. Anything else is a fault, and a fault must not read as
    // "the record is fine" -- fail closed.
    if (error.code !== "22P02") {
      console.error(`[crm] ${table} lookup for a join write failed:`, error.message);
    }
    return false;
  }
  return data !== null;
}

/**
 * The refusal a join write gets when one of its two ends is gone.
 *
 * `DELETED_RECORD_EXPLANATION` verbatim rather than `REFUSED_MESSAGE`, because
 * this refusal is one the user can act on: the panel says the same sentence
 * where the controls would be, and the record is one click from being
 * restored. `REFUSED_MESSAGE` deliberately does not guess why.
 */
function deletedEndState(formData: FormData): FormState {
  return { error: DELETED_RECORD_EXPLANATION, values: echoedValues(formData) };
}

export async function linkCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  const companyId = field(formData, "companyId");
  if (!contactId) return { error: FAILED_MESSAGE };
  if (!companyId) {
    return { fieldErrors: { companyId: "Choose a company to link." } };
  }

  const supabase = await createClient();
  // BOTH ENDS LIVE, AND BOTH IN THIS WORKSPACE. See liveInOrg(): the policies
  // ask neither question, and the panel used to be rendered next to a deleted
  // record's own "Deleted" notice.
  const [contactLive, companyLive] = await Promise.all([
    liveInOrg(supabase, "contacts", org.id, contactId),
    liveInOrg(supabase, "companies", org.id, companyId),
  ]);
  if (!contactLive || !companyLive) return deletedEndState(formData);

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
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  const companyId = field(formData, "companyId");
  if (!contactId || !companyId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  // BOTH ENDS LIVE. Removing a link is still changing the links of a deleted
  // record, and `restore has to bring the record back as it was`
  // (deleteCompanyAction). One rule for all three actions, stated once in
  // DELETED_RECORD_EXPLANATION, rather than a per-verb exception that reads
  // differently depending on which page you are standing on.
  const [contactLive, companyLive] = await Promise.all([
    liveInOrg(supabase, "contacts", org.id, contactId),
    liveInOrg(supabase, "companies", org.id, companyId),
  ]);
  if (!contactLive || !companyLive) return deletedEndState(formData);

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
  return stateFor(result, "Unlinked.", formData);
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
 *
 * THE ORGANISATION IS PASSED, and it used not to be. This was the one write in
 * the task with no workspace term: a member of two organisations, acting from
 * workspace A's URL, promoted a company on workspace B's contact and got
 * `rows_promoted = 1`. 20260828234500 adds `p_organisation_id` to both
 * statements inside the function and drops the 2-arg version so the unscoped
 * path is not reachable by omitting an argument from the RPC body.
 */
export async function setPrimaryCompanyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authorise(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const contactId = field(formData, "contactId");
  if (!contactId) return { error: FAILED_MESSAGE };
  // An absent companyId is "clear the primary", which is a legitimate request.
  const companyId = field(formData, "companyId");

  const supabase = await createClient();
  // THE WORKSPACE AND SOFT-DELETE CHECKS, BEFORE THE RPC. See liveInOrg().
  // The function now takes an organisation and applies it to both statements,
  // so the workspace half is a second lock rather than the only one -- but it
  // is what makes the refusal a sentence instead of a raised 42501, and it
  // stops revalidatePath() being handed this workspace's slug for a write
  // aimed at another one's row. The soft-delete half now HAS a counterpart for
  // the CONTACT -- 20260828235000 put `deleted_at is null` into the three
  // contact_companies write policies, and this RPC is SECURITY INVOKER so they
  // decide both of its statements. For the COMPANY it still has none, by Q5.
  // See liveInOrg().
  //
  // A NULL companyId IS "CLEAR THE PRIMARY", which names no company, so only
  // the contact is checked on that path.
  const [contactLive, companyLive] = await Promise.all([
    liveInOrg(supabase, "contacts", org.id, contactId),
    companyId === null
      ? Promise.resolve(true)
      : liveInOrg(supabase, "companies", org.id, companyId),
  ]);
  if (!contactLive || !companyLive) return deletedEndState(formData);

  const result = await commitWrite(
    `set primary company on contact ${contactId}`,
    async () => {
      const { error } = await supabase.rpc("set_contact_primary_company", {
        p_contact_id: contactId,
        p_company_id: companyId,
        // NEVER FROM THE FORM. `org` is resolved from the slug through
        // getCurrentOrg(), which is RLS-gated -- CLAUDE.md § Tenancy model.
        p_organisation_id: org.id,
      });
      // `count: 1` is not a measured row count and is not pretending to be
      // one. This RPC signals a refusal by RAISING -- deliberately, so the
      // demote half rolls back with it, and so a returned 0 cannot arrive here
      // as a 200 with no error the way a 204 does one layer down. So the count
      // channel is not in play and only the error vocabulary is being reused:
      // 42501 refused, 23505 conflict, anything else a fault.
      return { error, count: 1 };
    },
  );

  if (result.outcome !== "applied") return failureState(result, formData);

  revalidatePath(`/${org.slug}/contacts/${contactId}`);
  if (companyId) revalidatePath(`/${org.slug}/companies/${companyId}`);

  return {
    message: companyId ? "Primary company updated." : "Primary company cleared.",
  };
}
