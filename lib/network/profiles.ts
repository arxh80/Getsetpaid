"use server";

// Network profiles: create, edit, set field visibility, publish, unpublish,
// soft-delete. PRD § 8, Q71/Q74/Q75/Q81.
//
// The five-step shape lib/crm/events.ts states in full, with the plumbing
// imported from lib/crm/actions.ts. Five things about it are NOT a copy of the
// CRM/finance modules, and each is the reason this header exists.
//
// ===========================================================================
// 1. THE WRITE GATE IS THE NETWORK'S, NOT THE CRM'S
// ===========================================================================
// Every CRM entity module authorises through `authoriseOrg`, whose tier term is
// `crm_writes`. Network publishing is gated on a DIFFERENT entitlement column
// (`network_publish`), so this file authorises through `authoriseNetwork`
// below, which calls getNetworkPublishAccess (lib/network/access.ts). The
// database mirror is the same split: the network policies name
// private.network_publish_organisations(), not private.crm_write_organisations()
// (20260904003000). Using authoriseOrg here would check the wrong tier and
// disagree with the policy that actually runs -- and disagree in the FREE
// direction, since Free has crm_writes=false and network_publish=false but
// STARTER has both true, so the two only diverge on... nothing today. That is
// exactly why it must be written correctly now rather than discovered later:
// the two columns are independent and a future plan can separate them.
//
// ===========================================================================
// 2. SETTING A FIELD TO `hidden` NULLS ITS VALUE COLUMN IN THE SAME UPDATE
// ===========================================================================
// N3. `network_profiles_hidden_fields_are_null` REFUSES any other order, so
// this is not a nicety the action could forget -- it is the only way the write
// succeeds. What the action owes beyond that is not surfacing the refusal as a
// raw 23514: `visibilityUpdate()` below builds the value columns from the
// visibility map, so a hidden field's column is set to null in the same
// statement and the CHECK is never reached by this path. The CHECK remains the
// control for a direct PostgREST PATCH, which is the writer it exists for.
//
// ===========================================================================
// 3. `website_url` GOES THROUGH THE EXISTING PROTOCOL VALIDATION
// ===========================================================================
// Global Constraints: "This is the phase where user content becomes
// cross-tenant. A published website_url and a published bio are written by org
// A and rendered in org B's browser." So the URL goes through
// `normaliseWebsite` from lib/crm/urls.ts -- the SAME function the four
// `website` columns already use, which parses with `new URL()` after stripping
// exactly what the WHATWG parser strips, and rejects any scheme but http(s).
//
// DEVIATION FROM THE BRIEF'S LETTER, STATED (Constraint 13): the brief names
// "the existing lib/crm/validate.ts protocol check". lib/crm/validate.ts has no
// protocol check and never has -- the URL validation lives in lib/crm/urls.ts
// (`safeHref`, `hasUnsafeScheme`, `normaliseWebsite`), which is where
// FOLLOW-UPS.md routed it. This module calls the real one. Constraint 19 is
// precisely about this: shipping the validator and not calling it is the Phase
// 5 I2 defect repeating, and calling a validator that does not exist would be a
// worse version of it.
//
// ===========================================================================
// 4. NO DUPLICATE SCREENING
// ===========================================================================
// A network profile is not an identity the dedup engine knows about -- it is a
// PUBLISHED VIEW of one that already went through it -- so there is no
// screenAfterCreate call and no dead merge branch, like events and finance and
// unlike the five Phase 2 entity modules. `network_profiles_entity_unique`
// (Q74, one profile per private record) is the only uniqueness there is, and it
// is a constraint rather than a screening step.
//
// ===========================================================================
// 5. PUBLISH AND UNPUBLISH ARE THE SAME UPDATE, TWICE, IN OPPOSITE DIRECTIONS
// ===========================================================================
// Q81: `network_profiles_published_at_iff_published` requires
// (status='published') = (published_at is not null), so publishing and
// unpublishing each move TWO columns and neither can move one alone. They are
// separate ACTIONS rather than one toggle because a toggle whose current state
// is read from a hidden input is a race: two tabs open on the same profile, and
// the second submit un-publishes what the first just published. Each action
// states the direction it means and the `.eq("status", ...)` guard makes the
// wrong direction a refusal rather than a silent no-op.

import { revalidatePath } from "next/cache";
import { getCurrentUser, getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { normaliseWebsite } from "@/lib/crm/urls";
import {
  checkEmail,
  checkLongText,
  checkName,
  checkShortText,
  type FieldProblem,
} from "@/lib/crm/validate";
import {
  getNetworkPublishAccess,
  getNetworkPublishAccessForEntity,
} from "@/lib/network/access";
import {
  isNetworkEntityKind,
  isPublishableField,
  isVisibilityLevel,
  PUBLISHABLE_FIELDS,
  type FieldVisibility,
  type NetworkEntityKind,
  type PublishableField,
} from "@/lib/network/fields";

// THE CAPS ARE lib/crm/validate.ts's OWN, NOT NEW ONES. `checkShortText` caps
// at MAX_SHORT_TEXT (200) and `checkLongText` at MAX_LONG_TEXT (4000), and
// neither takes a length parameter -- the cap is the function's, so that the
// six short published fields and the one long one are bounded by exactly the
// same numbers as every private CRM column. A separate network cap would be a
// second limit to keep in step for no gain.
//
// NOTE what those caps are and are NOT: a LENGTH cap, never a sanitiser. Every
// published string is rendered as TEXT by Task 3, never as HTML and never
// through `dangerouslySetInnerHTML` -- which matters more here than anywhere
// else in the product, because this is the one place org A's text renders in
// org B's browser (Global Constraints).

// ---------------------------------------------------------------------------
// The profile form
// ---------------------------------------------------------------------------

/**
 * The seven publishable values plus the two that are always shown.
 *
 * `visibility` is authoritative over the seven: `valuesFor()` below reads a
 * field's value ONLY when its level is not `hidden`, so a value submitted for a
 * field the user just hid is DISCARDED rather than stored. That is N3 in the
 * request, and it is why the CHECK is never reached from this path.
 */
interface ProfileValues {
  displayName: string;
  visibility: FieldVisibility;
  headline: string | null;
  bio: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
}

/**
 * Read the submitted per-field visibility map.
 *
 * EVERY KEY IS FILTERED THROUGH `isPublishableField` AND EVERY VALUE THROUGH
 * `isVisibilityLevel`, so a hand-crafted post naming `display_name` (which the
 * database rejects as a key on purpose -- a level that cannot be set cannot be
 * mis-set) or `phone` or a misspelt `netwrok` is DROPPED HERE rather than
 * reaching the CHECK as a raw 23514 the user cannot act on. A dropped key reads
 * as `hidden`, which is the fail-closed direction.
 *
 * The input names are `visibility_<field>`, one `<select>` per field. Task 2's
 * editor is the largest radio/select group in the product, which is why every
 * refusal below carries `echoedValues(formData)` -- a refusal that silently
 * reset it would re-hide fields the user had just chosen to show, or appear to
 * have published fields it did not (Constraint 11).
 */
function readVisibility(formData: FormData): FieldVisibility {
  const out: FieldVisibility = {};
  for (const name of PUBLISHABLE_FIELDS) {
    const raw = field(formData, `visibility_${name}`);
    if (raw === null) continue;
    if (!isVisibilityLevel(raw)) continue;
    out[name] = raw;
  }
  return out;
}

/**
 * The value to store for one field, given its level.
 *
 * N3 IN ONE FUNCTION: a hidden field stores NULL, whatever the form sent. The
 * `hidden` case is checked FIRST and returns before the submitted value is even
 * read, so there is no path on which a hidden field's value reaches the insert.
 */
function valueFor(
  formData: FormData,
  visibility: FieldVisibility,
  name: PublishableField,
): string | null {
  if ((visibility[name] ?? "hidden") === "hidden") return null;
  return field(formData, name);
}

/**
 * Re-key a shared validator's FieldProblem onto this form's input name.
 *
 * `checkName` always reports against "name" and `checkEmail` against "email",
 * because every other form in the product names those inputs that way. This
 * form does not -- it has "displayName" and "contact_email", the latter because
 * the COLUMN is contact_email and the visibility map is keyed on column names.
 * A FieldProblem whose `field` does not match an input name renders no error at
 * all: the message is dropped on the floor and the user sees a form that
 * refused with no explanation. So the re-key is not cosmetic.
 */
function renameProblem(
  problem: FieldProblem | null,
  name: string,
): FieldProblem | null {
  return problem === null ? null : { field: name, message: problem.message };
}

/**
 * Read and validate the profile form.
 *
 * PURE, AND IT DOES NOT TOUCH THE DATABASE. The one check that needs a query --
 * is the private record this profile speaks for still manageable -- is the
 * database's, through `private.entity_is_manageable` inside the policy; there
 * is no application pre-check for it, deliberately, because a pre-check read
 * through the caller's own client would answer "I cannot see it" for a
 * record-scoped user and turn a legitimate publish into a confusing refusal
 * (the artists-end argument 20260901011000 makes for event_lineup).
 */
function readProfile(
  formData: FormData,
):
  | { readonly ok: true; readonly values: ProfileValues }
  | { readonly ok: false; readonly state: FormState } {
  const problems: (FieldProblem | null)[] = [];
  const visibility = readVisibility(formData);

  // `checkName` reports against the field name "name"; this form's input is
  // "displayName", so the problem is re-keyed. Re-keying rather than renaming
  // the input, because "name" is what every OTHER form in the product calls its
  // required-name field and `echoedValues` round-trips by input name.
  const displayName = field(formData, "displayName");
  problems.push(renameProblem(checkName(displayName), "displayName"));

  // Each of the seven is read THROUGH `valueFor`, so a hidden field is null
  // before it is validated -- and a null value passes every check below, which
  // is correct: there is nothing to validate about a field that is not being
  // published.
  const headline = valueFor(formData, visibility, "headline");
  problems.push(checkShortText("headline", headline, "Headline"));

  const bio = valueFor(formData, visibility, "bio");
  problems.push(checkLongText("bio", bio, "About"));

  const city = valueFor(formData, visibility, "city");
  problems.push(checkShortText("city", city, "City"));

  const region = valueFor(formData, visibility, "region");
  problems.push(checkShortText("region", region, "Region"));

  const country = valueFor(formData, visibility, "country");
  problems.push(checkShortText("country", country, "Country"));

  // THE CROSS-TENANT STRING. This value is written by org A and rendered in org
  // B's browser, so it goes through the SAME protocol validation the four
  // private `website` columns use -- `new URL()` as the oracle, http(s) only,
  // `javascript:` and `data:` refused. Task 3 additionally renders it through
  // `safeHref` on the way OUT, because a row predating this check, an import or
  // a direct PATCH can all put anything in the column and the render side is
  // the control (lib/crm/urls.ts's header states the argument).
  const websiteRaw = valueFor(formData, visibility, "website_url");
  const website = normaliseWebsite(websiteRaw);
  const websiteUrl = website.ok ? website.value : null;
  if (!website.ok) {
    problems.push({ field: "website_url", message: website.message });
  }

  // `checkEmail` reports against "email"; this form's input is "contact_email".
  const contactEmail = valueFor(formData, visibility, "contact_email");
  problems.push(renameProblem(checkEmail(contactEmail), "contact_email"));

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (problem && !fieldErrors[problem.field]) {
      fieldErrors[problem.field] = problem.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return {
    ok: true,
    values: {
      displayName: displayName as string,
      visibility,
      headline,
      bio,
      city,
      region,
      country,
      websiteUrl,
      contactEmail,
    },
  };
}

/**
 * The seven value columns plus the map, as one object for an insert or update.
 *
 * ONE BUILDER FOR BOTH WRITE PATHS, so create and update cannot disagree about
 * which columns N3 governs -- a create that stored a hidden field's value and
 * an update that did not would be the same bug in one direction only, and the
 * CHECK would catch it on create and hide it on update.
 */
function profileColumns(values: ProfileValues) {
  return {
    display_name: values.displayName,
    field_visibility: values.visibility,
    headline: values.headline,
    bio: values.bio,
    city: values.city,
    region: values.region,
    country: values.country,
    website_url: values.websiteUrl,
    contact_email: values.contactEmail,
  };
}

/**
 * Resolve the organisation and check NETWORK PROFILE write access in one step.
 *
 * The network analogue of lib/crm/actions.ts's authoriseOrg: same shape, same
 * verbatim-explanation discipline, but through getNetworkPublishAccess (the
 * network_publish tier term and the manage_network_profile key) rather than
 * getCrmWriteAccess.
 *
 * EVERY REFUSAL CARRIES THE SUBMITTED VALUES BACK: React 19 resets the form
 * after the action, so a refusal that returns no `values` throws away what the
 * user typed -- and on THIS form that means the whole visibility ladder they
 * just set (Constraint 11's highest-exposure case).
 */
async function authoriseNetwork(
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

  const access = await getNetworkPublishAccess(org);
  if (!access.canWrite) {
    return { ok: false, state: { error: access.explanation, values: echoed } };
  }
  return { ok: true, org };
}

/**
 * The routes a network write can change, revalidated together.
 *
 * TASK 2 ADDITION: `/${orgSlug}/network/profiles` -- the "this organisation's
 * own profiles" list Task 2 ships. Task 1 revalidated only `/${orgSlug}/
 * network` (a hub route no task has built yet) and the one profile's own
 * editor page, so a profile created or deleted here would not have shown up
 * or disappeared from the list without a hard refresh: `revalidatePath` does
 * not error on a route that has never been rendered, so the gap was silent
 * rather than a thrown exception. The four private detail pages
 * (companies/[id] etc.) are NOT revalidated from here: they read this
 * organisation's OWN network_profiles row fresh on every request (no
 * `fetch` cache and no static generation on a per-org route), so there is
 * nothing there for `revalidatePath` to invalidate.
 */
function revalidateNetwork(orgSlug: string, profileId?: string) {
  revalidatePath(`/${orgSlug}/network`);
  revalidatePath(`/${orgSlug}/network/profiles`);
  if (profileId) revalidatePath(`/${orgSlug}/network/profiles/${profileId}`);
}

// ---------------------------------------------------------------------------
// The six actions
// ---------------------------------------------------------------------------

export async function createNetworkProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const entityKind = field(formData, "entityKind");
  const entityId = field(formData, "entityId");
  // Both are hidden fields carrying the private record the editor was opened
  // from: a missing or malformed one is structural, not something a user can
  // correct, so it is FAILED_MESSAGE rather than a field error.
  if (!isNetworkEntityKind(entityKind) || !entityId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // THE M4 CLOSURE, AT THE WRITE PATH AS WELL AS THE RENDER GATE.
  // `authoriseNetwork` above already checked manage_network_profile (the
  // GENERAL gate); it cannot check the PER-KIND one because it does not know
  // the entity kind yet. The database's INSERT policy enforces the per-kind
  // key regardless (private.entity_is_manageable, 20260904003000) -- so this
  // call cannot open a write the policy would refuse -- but without it a
  // marketing user publishing an artist gets the generic REFUSED_MESSAGE from
  // a 42501 instead of the specific "you can't manage artists" sentence the
  // editor shows for the exact same caller. Same discipline as every other
  // refusal in this file: the sentence next to a disabled control and the
  // sentence after a submitted form must be the same string.
  const entityAccess = await getNetworkPublishAccessForEntity(org, entityKind);
  if (!entityAccess.canWrite) {
    return { error: entityAccess.explanation, values: echoedValues(formData) };
  }

  const parsed = readProfile(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();

  // A PROFILE IS CREATED AS A DRAFT, ALWAYS. `status` and `published_at` are
  // not read from the form: publishing is publishNetworkProfileAction's job,
  // and it is a separate, deliberate act. Creating straight into `published`
  // would make the single most consequential write in the product a side effect
  // of filling in a form.
  const { data, error } = await supabase
    .from("network_profiles")
    .insert({
      organisation_id: org.id,
      // `created_by` EXPLICITLY, though the column defaults to auth.uid(): the
      // same discipline events.ts applies to owner_user_id -- a write and a
      // policy that agree only because a column default happens to match are a
      // latent break.
      created_by: user.id,
      entity_kind: entityKind as NetworkEntityKind,
      entity_id: entityId,
      status: "draft",
      published_at: null,
      ...profileColumns(parsed.values),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 42501 is the RLS refusal: a role without manage_network_profile, a
    // Free-tier org (the network_publish WITH CHECK), a below-aal2 session, or
    // a private record the caller could not manage. All four are "you cannot
    // publish this", not a fault.
    if (error.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    // 23505 is network_profiles_entity_unique: this record already has a live
    // profile (Q74, one per record). A better sentence than "refused", because
    // the user's next move is to go and edit the one that exists.
    if (error.code === "23505") {
      return {
        error:
          "This record already has a network profile. Edit that one instead of creating a second.",
        values: echoedValues(formData),
      };
    }
    console.error("[network] create profile failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidateNetwork(org.slug, data.id);
  return { message: "Saved as a draft. Nobody else can see it yet." };
}

export async function updateNetworkProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const profileId = field(formData, "profileId");
  if (!profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readProfile(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const result = await commitWrite(`update network profile ${profileId}`, () =>
    supabase
      .from("network_profiles")
      // THE VALUE COLUMNS AND THE MAP MOVE TOGETHER, IN ONE STATEMENT. That is
      // N3: `network_profiles_hidden_fields_are_null` is checked at the END of
      // the statement, so hiding a field and nulling its column in two
      // statements would leave the first one refused. `profileColumns` builds
      // both halves from the same parsed values, so they cannot disagree.
      .update(profileColumns(parsed.values), { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", profileId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug, profileId);
  return stateFor(result, "Saved.", formData);
}

/**
 * Change one field's visibility, and null its value if it is being hidden.
 *
 * THE NARROW ACTION BESIDE THE WIDE ONE, and it exists because the editor
 * offers a per-row control as well as a Save button: a user who flips one field
 * from `network` to `hidden` should not have to re-submit the whole form, and a
 * whole-form submit built from a stale page would carry six other fields'
 * values back over whatever another tab changed.
 *
 * IT READS THE STORED MAP FIRST, then applies the one change. The alternative
 * -- trusting a hidden input carrying the current map -- is client-supplied
 * state governing which fields stay published, which is the same class of
 * mistake `mergeSocials` records in lib/crm/urls.ts.
 */
export async function setFieldVisibilityAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const profileId = field(formData, "profileId");
  const fieldName = field(formData, "fieldName");
  const level = field(formData, "level");
  if (!profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  if (!isPublishableField(fieldName) || !isVisibilityLevel(level)) {
    // A field or level outside the vocabulary is a hand-crafted post, not
    // something the editor can produce -- the <select> is generated from
    // PUBLISHABLE_FIELDS and VISIBILITY_LEVELS. Refused before any statement
    // runs, so the CHECK is never reached as a raw 23514.
    return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("network_profiles")
    .select("field_visibility")
    .eq("organisation_id", org.id)
    .eq("id", profileId)
    .is("deleted_at", null)
    .maybeSingle();

  if (readError) {
    console.error("[network] read profile visibility failed:", readError.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!current) return { error: REFUSED_MESSAGE, values: echoedValues(formData) };

  // The stored map, plus the one change. Unknown keys in the stored map are
  // impossible (the CHECK forbids them), so this is a plain spread rather than
  // a filtered merge.
  const nextVisibility = {
    ...(current.field_visibility as Record<string, string>),
    [fieldName]: level,
  };

  const result = await commitWrite(
    `set ${fieldName} visibility on network profile ${profileId}`,
    () =>
      supabase
        .from("network_profiles")
        .update(
          {
            field_visibility: nextVisibility,
            // N3, IN THE SAME UPDATE. Hiding a field REMOVES its value; the
            // CHECK refuses any other order, and doing it here means the user
            // never sees that refusal. Only the one field is touched -- the
            // others keep whatever they hold, which is what makes this a narrow
            // action rather than a whole-form save in disguise.
            ...(level === "hidden" ? { [fieldName]: null } : {}),
          },
          { count: "exact" },
        )
        .eq("organisation_id", org.id)
        .eq("id", profileId)
        .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug, profileId);
  return stateFor(
    result,
    level === "hidden"
      ? "Hidden. That field’s value has been removed from the profile."
      : "Saved.",
    formData,
  );
}

export async function publishNetworkProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const profileId = field(formData, "profileId");
  if (!profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`publish network profile ${profileId}`, () =>
    supabase
      .from("network_profiles")
      // BOTH COLUMNS, BECAUSE THE CHECK REQUIRES BOTH (Q81):
      // (status='published') = (published_at is not null). Moving one alone is
      // a 23514 for every writer.
      .update(
        { status: "published", published_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", profileId)
      .is("deleted_at", null)
      // THE DIRECTION GUARD. Two tabs open on the same profile and a toggle
      // that read its current state from a hidden input would let the second
      // submit undo the first; pinning the FROM state makes the wrong direction
      // a refusal (count 0) rather than a silent reversal.
      .eq("status", "draft"),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug, profileId);
  return stateFor(
    result,
    "Published. Every GetSetPaid customer can now find this profile.",
    formData,
  );
}

export async function unpublishNetworkProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const profileId = field(formData, "profileId");
  if (!profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`unpublish network profile ${profileId}`, () =>
    supabase
      .from("network_profiles")
      .update({ status: "draft", published_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", profileId)
      .is("deleted_at", null)
      .eq("status", "published"),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug, profileId);
  return stateFor(
    result,
    "Unpublished. It is out of the directory and back to a draft.",
    formData,
  );
}

/**
 * Soft-delete a profile.
 *
 * AN UPDATE, LIKE EVERY OTHER DELETE IN THIS SCHEMA -- there is no DELETE grant
 * and no DELETE policy on network_profiles. It deliberately does NOT also move
 * `status`: a soft-deleted published profile stays `published` in the column
 * and vanishes from both views through their `deleted_at is null` predicate, so
 * restoring it later puts it back exactly as it was rather than silently
 * demoting it to a draft.
 */
export async function deleteNetworkProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseNetwork(field(formData, "orgSlug"), formData);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const profileId = field(formData, "profileId");
  if (!profileId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete network profile ${profileId}`, () =>
    supabase
      .from("network_profiles")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", profileId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidateNetwork(org.slug);
  return stateFor(
    result,
    "Deleted. It is out of the network directory.",
    formData,
  );
}
