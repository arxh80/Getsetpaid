"use server";

// Artists: create, edit, soft-delete, restore -- and artist_representations,
// edited from both sides.
//
// The five-step shape lib/crm/contacts.ts states in full, with the plumbing
// imported from lib/crm/actions.ts. Every write goes through
// lib/crm/write.ts's `commitWrite`, every URL column goes through
// `safeHref()` on the way out (lib/crm/queries.ts) and `normaliseWebsite()` /
// `hasUnsafeScheme()` on the way in, and every socials edit goes through
// `mergeSocials()`.
//
// ===========================================================================
// `manage_artists`, NOT `manage_contacts`
// ===========================================================================
// 20260828121000: "A Booker holds this and does not hold manage_venues; a
// Venue Manager is the mirror image. That asymmetry is the point of having six
// keys rather than one." It applies to artist_representations and
// artist_fee_history too -- both are scoped by the ARTIST and gated on the
// same key -- so a Booker who cannot create an agency can still record which
// agency represents an artist. That is deliberate and it is asserted in the
// RLS suite rather than argued here.
//
// ===========================================================================
// AUDIT: WHAT IS ALREADY WRITTEN, AND WHY NOTHING HERE ADDS TO IT
// ===========================================================================
// 20260828141000 puts a trigger on the hard-DELETE paths this phase opened.
// Nothing in this file hard-deletes: `artist_representations` carries
// `deleted_at` (added by 20260828001134 precisely so an agency folding cannot
// destroy representation history) and there is no DELETE policy or DELETE
// grant on the table at all. So removal here is an UPDATE, and full CRM write
// auditing -- before/after diffs, their retention, and the viewer that reads
// them -- is Phase 7's feature.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import {
  authoriseOrg,
  failureState,
  liveInOrg,
  refusedEndState,
  stateFor,
} from "@/lib/crm/actions";
import type { RecordPresence } from "@/lib/crm/write-access";
import {
  commitWrite,
  FAILED_MESSAGE,
  REFUSED_MESSAGE,
} from "@/lib/crm/write";
import {
  checkDate,
  checkLongText,
  checkName,
  checkShortText,
  parseGenres,
  type FieldProblem,
} from "@/lib/crm/validate";
import {
  hasUnsafeScheme,
  mergeSocials,
  normaliseWebsite,
  SOCIAL_PLATFORMS,
} from "@/lib/crm/urls";

const PERMISSION = "manage_artists";

// ---------------------------------------------------------------------------
// The artist record
// ---------------------------------------------------------------------------

interface ArtistValues {
  name: string;
  genres: string[];
  country: string | null;
  city: string | null;
  website: string | null;
  notes: string | null;
  socials: Record<string, string>;
}

/**
 * Read and validate the artist form.
 *
 * Every problem is collected rather than returned at the first one: a form
 * that reports one error per submit is a form people give up on, and the
 * fields are independent so there is no reason to stop.
 *
 * `country` IS FREE TEXT AND THERE IS NO COUNTRY PICKER, deliberately.
 * 20260827232510's column comment: "Free text, not an ISO 3166 code. No screen
 * or integration consumes it as a code yet, and a code column would need a
 * lookup table and a migration path for the free-text values the import flow
 * will produce."
 */
function readArtist(
  formData: FormData,
):
  | { readonly ok: true; readonly values: ArtistValues }
  | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const country = field(formData, "country");
  const city = field(formData, "city");
  const notes = field(formData, "notes");
  const websiteRaw = field(formData, "website");

  const problems: (FieldProblem | null)[] = [
    checkName(name),
    checkShortText("country", country, "Country"),
    checkShortText("city", city, "City"),
    checkLongText("notes", notes, "Notes"),
  ];

  const website = normaliseWebsite(websiteRaw);
  const websiteValue = website.ok ? website.value : null;
  if (!website.ok) problems.push({ field: "website", message: website.message });

  const { genres, problem: genreProblem } = parseGenres(field(formData, "genres"));
  problems.push(genreProblem);

  // SOCIALS. The one field group where the database can enforce nothing at all
  // beyond "it is an object" -- 20260827232510's column comment says so -- so
  // this is the only write-side check that exists. It is not the CONTROL,
  // though: lib/crm/urls.ts's render side is, because PostgREST is reachable
  // from a browser with the anon key and rows predating this file exist by
  // assumption.
  //
  // WHAT THIS RETURNS IS THE SIX KEYS THE FORM OWNS, NOT THE WHOLE COLUMN.
  // `createArtistAction` stores it as-is (there is nothing to merge with);
  // `updateArtistAction` puts it through `mergeSocials()` over the stored
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
  // mistyped character empties every field -- measured in a browser by Task 4,
  // see FormState.values.
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return {
    ok: true,
    values: {
      // `name` is non-null here: checkName() returns a problem for null and we
      // returned above if there was one.
      name: name as string,
      genres,
      country,
      city,
      website: websiteValue,
      notes,
      socials,
    },
  };
}

export async function createArtistAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readArtist(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  // `owner_user_id` IS THE CREATOR, AND FOR A RECORD-SCOPED ROLE IT IS THE
  // ONLY VALUE THE POLICY ACCEPTS. `organisation_id` comes from the RESOLVED
  // org, never from the form -- CLAUDE.md § Tenancy model.
  const { data, error } = await supabase
    .from("artists")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      name: parsed.values.name,
      genres: parsed.values.genres,
      country: parsed.values.country,
      city: parsed.values.city,
      website: parsed.values.website,
      notes: parsed.values.notes,
      socials: parsed.values.socials,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    console.error("[crm] create artist failed:", error.message);
    return { error: FAILED_MESSAGE };
  }
  if (!data) return { error: FAILED_MESSAGE };

  revalidatePath(`/${org.slug}/artists`);
  redirect(`/${org.slug}/artists/${data.id as string}`);
}

export async function updateArtistAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  if (!artistId) return { error: FAILED_MESSAGE };

  const parsed = readArtist(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  // SOCIALS ARE MERGED, NOT REPLACED, and the read that makes that possible is
  // this one. `socials` is a free-form jsonb object; the form has inputs for
  // six keys and an import can have written any number of others. Writing the
  // six over the column destroyed the rest on contacts -- silently,
  // permanently, with no undo and no audit row. See mergeSocials() for the
  // rule, including the case fold that makes `Instagram` removable.
  //
  // Read through the CALLER'S client and filtered by organisation, so this is
  // not a privileged peek: if the caller cannot read the row, `stored` is
  // empty and the UPDATE below matches nothing and is reported as refused.
  const existing = await supabase
    .from("artists")
    .select("socials")
    .eq("organisation_id", org.id)
    .eq("id", artistId)
    .maybeSingle();
  if (existing.error && existing.error.code !== "22P02") {
    // A FAILED LOOKUP IS NOT AN EMPTY ONE. Continuing with `{}` here would
    // turn a transient database error into the exact data loss this read
    // exists to prevent.
    console.error("[crm] update artist socials read failed:", existing.error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  const socials = mergeSocials(existing.data?.socials, parsed.values.socials);

  const result = await commitWrite(`update artist ${artistId}`, () =>
    supabase
      .from("artists")
      .update(
        {
          name: parsed.values.name,
          genres: parsed.values.genres,
          country: parsed.values.country,
          city: parsed.values.city,
          website: parsed.values.website,
          notes: parsed.values.notes,
          socials,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", artistId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/artists`);
    revalidatePath(`/${org.slug}/artists/${artistId}`);
    redirect(`/${org.slug}/artists/${artistId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteArtistAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  if (!artistId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const result = await commitWrite(`delete artist ${artistId}`, () =>
    supabase
      .from("artists")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", artistId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/artists`);
    revalidatePath(`/${org.slug}/artists/deleted`);
    revalidatePath(`/${org.slug}/artists/${artistId}`);
  }
  // NO REDIRECT. The user stays on the record they just deleted, which now
  // renders its deleted state with a Restore control.
  return stateFor(
    result,
    "Deleted. It is out of the artists list; its representations and fee history are still here and come back with it.",
    formData,
  );
}

export async function restoreArtistAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  if (!artistId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const result = await commitWrite(`restore artist ${artistId}`, () =>
    supabase
      .from("artists")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", artistId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/artists`);
    revalidatePath(`/${org.slug}/artists/deleted`);
    revalidatePath(`/${org.slug}/artists/${artistId}`);
  }
  return stateFor(result, "Restored. It is back in the artists list.", formData);
}

// ---------------------------------------------------------------------------
// artist_representations -- editable from BOTH sides
// ---------------------------------------------------------------------------
//
// The same five actions back the "Representation" panel on an artist and the
// "Artists represented" panel on an agency. They are written once and take
// both ids, because the row they operate on is one row either way and a second
// copy keyed the other way round is a second copy that can drift.
//
// WHAT DECIDES ACCESS IS THE ARTIST, NOT THE AGENCY.
// `artist_representations_*_via_artist` (20260828121000) reach EXISTS against
// `artists` alone -- adjudicated as Q3a in Task 1 -- so a record-scoped user
// who owns the artist may record a representation naming an agency they cannot
// see, and may read the `agency_id` and `contact_id` of every representation on
// an artist they own. That is the accepted identifier disclosure recorded in
// FOLLOW-UPS.md (whose original "a display wart, not a disclosure" assessment
// was corrected in Task 4's fix round 1). This file does not narrow it in a
// policy, because narrowing it there would break the legitimate case Q3a
// exists to protect -- the WRITE half is closed in the FORM instead, by
// `loadLinkOptions` offering only rows the caller can read.
//
// THE TWO ENDS ARE NOT EDITABLE IN PLACE, and that is a product decision rather
// than a technical limit. `createRepresentationAction` takes an artist and an
// agency; `updateRepresentationAction` takes neither and changes only the role,
// territory, exclusivity, named contact and dates. Two reasons:
//
//   1. Changing `artist_id` would change which record's history the row is,
//      and therefore which record's SCOPE decides who may read it -- a
//      record-scoped user could move a representation onto an artist they own
//      and read it thereafter. The policy's WITH CHECK would refuse the ones
//      aimed outside their scope, but "edit" is the wrong verb for an
//      operation whose failure mode is a scope change.
//   2. Changing `agency_id` is not an edit either. "Agency X represented them
//      until 2023, Agency Y represents them now" is TWO rows with two periods,
//      which is exactly what a table with `started_at` and `ended_at` is for.
//      Offering it as an edit invites people to overwrite the first fact with
//      the second.

interface RepresentationValues {
  contactId: string | null;
  role: string | null;
  territory: string | null;
  isExclusive: boolean;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Read and validate the representation form.
 *
 * `role` and `territory` ARE FREE TEXT AND STAY FREE TEXT.
 * 20260827232510 forbids inventing a vocabulary in as many words: "Enumerating
 * them here would be inventing product vocabulary ('booking agent' vs
 * 'manager' vs 'management'; 'UK' vs 'GB' vs 'United Kingdom') with no founder
 * input and no usage data." So they get a length cap and nothing else.
 *
 * `is_exclusive` IS A CHECKBOX AND THEREFORE NEEDS THE MARKER, which is the
 * part that is easy to get wrong. HTML submits a checkbox only when it is
 * ticked, so an unticked box is ABSENT from the FormData -- indistinguishable
 * from a form that never had the control. Reading it as `formData.get(...) !==
 * null` is correct for the WRITE; what needs `groupMarkerName` is the ECHO, so
 * that a user who unticks it and then trips a validation error does not get it
 * silently re-ticked. lib/forms.ts's `selectedInGroup` is the rule and
 * components/crm/representation-panel.tsx is where it is applied.
 */
function readRepresentation(
  formData: FormData,
):
  | { readonly ok: true; readonly values: RepresentationValues }
  | { readonly ok: false; readonly state: FormState } {
  const role = field(formData, "role");
  const territory = field(formData, "territory");
  const problems: (FieldProblem | null)[] = [
    checkShortText("role", role, "Role"),
    checkShortText("territory", territory, "Territory"),
  ];

  const started = checkDate("startedAt", field(formData, "startedAt"), "Start date");
  const ended = checkDate("endedAt", field(formData, "endedAt"), "End date");
  problems.push(started.problem, ended.problem);

  // Mirrors `artist_representations_period_ordered`, which only bites when
  // both dates are present. The database refuses it either way; what this adds
  // is a sentence next to the field instead of a raised 23514 rendered as
  // "something went wrong".
  if (
    started.problem === null &&
    ended.problem === null &&
    started.value !== null &&
    ended.value !== null &&
    ended.value < started.value
  ) {
    problems.push({
      field: "endedAt",
      message: "The end date can’t be before the start date.",
    });
  }

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
      contactId: field(formData, "contactId"),
      role,
      territory,
      isExclusive: formData.get("isExclusive") !== null,
      startedAt: started.value,
      endedAt: ended.value,
    },
  };
}

/**
 * The ends of a representation write, each resolved to live / deleted / gone.
 *
 * ARTIST FIRST, because it is the one the database also checks. As of
 * 20260829001000 `artists.deleted_at is null` is a term in both
 * artist_representations write policies, so a direct PostgREST call by a member
 * with `manage_artists` and the anon key is refused too (T28). The AGENCY and
 * CONTACT ends are this file and nothing else, by Q3a -- see
 * lib/crm/actions.ts's `liveInOrg` and T28b.
 *
 * A null `contactId` is "no individual agent named", which is a complete fact
 * on its own, so nothing is checked for it.
 */
async function representationEnds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  artistId: string,
  agencyId: string | null,
  contactId: string | null,
): Promise<RecordPresence[]> {
  return Promise.all([
    liveInOrg(supabase, "artists", organisationId, artistId),
    agencyId === null
      ? Promise.resolve<RecordPresence>("live")
      : liveInOrg(supabase, "agencies", organisationId, agencyId),
    contactId === null
      ? Promise.resolve<RecordPresence>("live")
      : liveInOrg(supabase, "contacts", organisationId, contactId),
  ]);
}

/** Both panels that can show this row, whichever side the write came from. */
function revalidateRepresentation(
  slug: string,
  artistId: string,
  agencyId: string | null,
): void {
  revalidatePath(`/${slug}/artists/${artistId}`);
  if (agencyId) revalidatePath(`/${slug}/agencies/${agencyId}`);
}

export async function createRepresentationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  const agencyId = field(formData, "agencyId");
  if (!artistId) return { fieldErrors: { artistId: "Choose an artist." } };
  if (!agencyId) return { fieldErrors: { agencyId: "Choose an agency." } };

  const parsed = readRepresentation(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  const blocked = refusedEndState(
    await representationEnds(
      supabase,
      org.id,
      artistId,
      agencyId,
      parsed.values.contactId,
    ),
    formData,
  );
  if (blocked) return blocked;

  // ALWAYS is_primary FALSE. Making the representation and making it primary
  // are two operations because the second one has to demote whatever is
  // primary now, and a partial unique index cannot be deferred -- see
  // public.set_artist_primary_representation(). An INSERT with is_primary true
  // would raise 23505 whenever an open-ended primary already exists, which is
  // a database error surfaced as "something went wrong" for an ordinary click.
  //
  // `organisation_id` from the RESOLVED org, never from the form. The
  // composite tenant-scoped foreign keys (20260828001132) refuse a row whose
  // organisation does not match the artist's or the agency's, with 23503, for
  // every writer in every role -- proven at T-B in the RLS suite rather than
  // cited.
  const { error } = await supabase.from("artist_representations").insert({
    organisation_id: org.id,
    artist_id: artistId,
    agency_id: agencyId,
    contact_id: parsed.values.contactId,
    role: parsed.values.role,
    territory: parsed.values.territory,
    is_exclusive: parsed.values.isExclusive,
    is_primary: false,
    started_at: parsed.values.startedAt,
    ended_at: parsed.values.endedAt,
  });

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    // 23503 is the tenant-scoped composite FK refusing an artist, agency or
    // contact that is not this workspace's. It is a refusal, not a fault: the
    // ids came from a form the caller can edit.
    if (error.code === "23503") return { error: REFUSED_MESSAGE };
    console.error("[crm] create representation failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidateRepresentation(org.slug, artistId, agencyId);
  return { message: "Representation added." };
}

export async function updateRepresentationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  const agencyId = field(formData, "agencyId");
  const representationId = field(formData, "representationId");
  if (!artistId || !representationId) return { error: FAILED_MESSAGE };

  const parsed = readRepresentation(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  // The agency is not being changed by this form (see the section header), so
  // it is checked only as the OTHER end that has to still be live for the row
  // to be editable -- the same both-ends-live rule contact_companies carries.
  const blocked = refusedEndState(
    await representationEnds(
      supabase,
      org.id,
      artistId,
      agencyId,
      parsed.values.contactId,
    ),
    formData,
  );
  if (blocked) return blocked;

  const result = await commitWrite(`update representation ${representationId}`, () =>
    supabase
      .from("artist_representations")
      .update(
        {
          contact_id: parsed.values.contactId,
          role: parsed.values.role,
          territory: parsed.values.territory,
          is_exclusive: parsed.values.isExclusive,
          started_at: parsed.values.startedAt,
          ended_at: parsed.values.endedAt,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      // ARTIST_ID AS WELL AS ID. Without it a forged `representationId`
      // belonging to a different artist in the same workspace would be edited
      // from this artist's page -- the policy would permit it, because the
      // policy asks whether the caller may write the row and not whether the
      // row is the one this URL is about.
      .eq("artist_id", artistId)
      .eq("id", representationId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidateRepresentation(org.slug, artistId, agencyId);
  }
  return stateFor(result, "Saved.", formData);
}

/**
 * Remove a representation: a soft delete, because there is no other kind here.
 *
 * `artist_representations.deleted_at` was added by 20260828001134 for a stated
 * reason -- `agencies.deleted_at` exists so that an agency folding does not
 * destroy representation history, "which is incomplete while the history
 * itself can be hard-deleted directly" -- and there is no DELETE policy and no
 * DELETE grant on this table, so a hard delete is not reachable even by a
 * direct PostgREST call.
 *
 * IT DOES NOT CLEAR `is_primary`, deliberately. `deleteAgencyAction`'s
 * contract is the general rule -- restore has to bring the record back as it
 * was -- and the index's predicate already excludes soft-deleted rows, so a
 * removed primary stops blocking a new one the moment it is removed. See
 * `restoreRepresentationAction` for the one price that is paid for this.
 */
export async function deleteRepresentationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  const agencyId = field(formData, "agencyId");
  const representationId = field(formData, "representationId");
  if (!artistId || !representationId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const blocked = refusedEndState(
    await representationEnds(supabase, org.id, artistId, agencyId, null),
    formData,
  );
  if (blocked) return blocked;

  const result = await commitWrite(`remove representation ${representationId}`, () =>
    supabase
      .from("artist_representations")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("artist_id", artistId)
      .eq("id", representationId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidateRepresentation(org.slug, artistId, agencyId);
  }
  return stateFor(result, "Removed. You can put it back below.", formData);
}

/**
 * The conflict sentence for the one write on this table that a user reaches by
 * their own actions rather than by losing a race.
 *
 * ===========================================================================
 * THE SEQUENCE, WHICH IS ORDINARY AND WHICH THE GENERIC MESSAGE DESCRIBES
 * WRONGLY
 * ===========================================================================
 *   1. Agency X is the artist's primary, open-ended.
 *   2. The user REMOVES it. It keeps `is_primary = true`, because restore has
 *      to bring the record back as it was -- and the index's predicate
 *      excludes soft-deleted rows, so nothing complains.
 *   3. The user makes Agency Y primary. The demote finds nothing to demote
 *      (X is excluded by `deleted_at`), the promote succeeds, and Y is now the
 *      one open-ended primary.
 *   4. The user RESTORES X. Two open-ended, live, primary rows -- which is
 *      exactly what artist_representations_one_current_primary_per_artist
 *      forbids. 23505.
 *
 * Nobody else changed anything, so CONFLICT_MESSAGE ("Somebody else changed
 * this record while you were editing it") is false, and "Reload the page and
 * try again" is advice that cannot work -- the same defect N-8 fixed for
 * "restore it first" being told to a user about a record in another workspace.
 * This sentence names the actual obstacle and the actual next move, both of
 * which the product offers.
 *
 * IT IS NOT A RACE AND IT IS NOT RARE. It is what happens when somebody
 * removes the wrong agency, fixes the primary, and then undoes the removal.
 */
const REPRESENTATION_PRIMARY_CONFLICT =
  "This was the artist’s primary representation, and a different one is primary now. Clear the current primary first, then restore this one.";

export async function restoreRepresentationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  const agencyId = field(formData, "agencyId");
  const representationId = field(formData, "representationId");
  if (!artistId || !representationId) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const blocked = refusedEndState(
    await representationEnds(supabase, org.id, artistId, agencyId, null),
    formData,
  );
  if (blocked) return blocked;

  const result = await commitWrite(`restore representation ${representationId}`, () =>
    supabase
      .from("artist_representations")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("artist_id", artistId)
      .eq("id", representationId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidateRepresentation(org.slug, artistId, agencyId);
    return { message: "Restored." };
  }
  // THE ONE CALL SITE IN THIS FILE THAT EARNS A SPECIFIC CONFLICT SENTENCE.
  // Every other action here takes the generic CONFLICT_MESSAGE; see its
  // comment in lib/crm/write.ts for why the default stopped naming an
  // operation.
  return failureState(result, formData, REPRESENTATION_PRIMARY_CONFLICT);
}

/**
 * The conflict sentence for the promote itself.
 *
 * 23505 from `set_artist_primary_representation()` is two callers promoting
 * different representations on the same artist at once -- a real race, unlike
 * the restore case above -- so naming the operation is accurate and tells the
 * user what to look at when they reload.
 */
const PRIMARY_REPRESENTATION_CONFLICT =
  "Somebody else changed this artist’s primary representation. Reload the page and try again.";

/**
 * Set (or clear) an artist's current primary representation.
 *
 * THIS IS THE ONE WRITE IN THE TASK THAT CANNOT BE A SINGLE STATEMENT.
 * `public.set_artist_primary_representation()` is why -- see 20260829000000's
 * header for the measurement, and 20260828230000's for the same measurement
 * taken on contact_companies. supabase-js issues one HTTP request per
 * statement, so a transaction is only reachable through a function.
 *
 * The RPC returns the number of rows promoted, so the same row-count rule
 * applies as everywhere else. It raises 42501 rather than returning 0 when a
 * promote is refused, precisely so the demote half rolls back with it.
 *
 * THE ORGANISATION IS PASSED, and it is mandatory rather than defensive:
 * 20260828234500 measured a multi-org member promoting a company on the other
 * workspace's contact from this workspace's URL, with the courtesy gate
 * running against the wrong organisation and `revalidatePath` invalidating a
 * page that had not changed. There is no 2-arg overload of this function to
 * fall back to.
 */
export async function setPrimaryRepresentationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const artistId = field(formData, "artistId");
  const agencyId = field(formData, "agencyId");
  if (!artistId) return { error: FAILED_MESSAGE };
  // An absent representationId is "clear the primary", a legitimate request.
  const representationId = field(formData, "representationId");

  const supabase = await createClient();
  // THE WORKSPACE AND SOFT-DELETE CHECKS, BEFORE THE RPC. The function takes
  // an organisation and applies it to both statements, so the workspace half
  // is a second lock rather than the only one -- but it is what makes the
  // refusal a sentence instead of a raised 42501, and it stops
  // revalidatePath() being handed this workspace's slug for a write aimed at
  // another one's row. The soft-delete half HAS a counterpart for the ARTIST
  // (20260829001000) and none for the agency, by Q3a.
  const blocked = refusedEndState(
    await representationEnds(supabase, org.id, artistId, agencyId, null),
    formData,
  );
  if (blocked) return blocked;

  const result = await commitWrite(
    `set primary representation on artist ${artistId}`,
    async () => {
      const { error } = await supabase.rpc("set_artist_primary_representation", {
        p_artist_id: artistId,
        p_representation_id: representationId,
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

  if (result.outcome !== "applied") {
    return failureState(result, formData, PRIMARY_REPRESENTATION_CONFLICT);
  }

  revalidateRepresentation(org.slug, artistId, agencyId);
  return {
    message: representationId
      ? "Primary representation updated."
      : "Primary representation cleared.",
  };
}
