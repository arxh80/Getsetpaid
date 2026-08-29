"use server";

// Venues: create, edit, soft-delete, restore -- and venue_rooms, managed
// inline on the venue's own page.
//
// The five-step shape lib/crm/contacts.ts states in full, with the plumbing
// imported from lib/crm/actions.ts.
//
// ===========================================================================
// `manage_venues`, AND THE ASYMMETRY IS THE POINT
// ===========================================================================
// A Venue Manager holds this key and does not hold `manage_artists`; a Booker
// is the mirror image (20260828121000). Rooms follow the venue on the same
// key, because `venue_rooms_*_via_venue` reach EXISTS against `venues` alone.
//
// ===========================================================================
// ROOMS ARE INLINE, NOT THEIR OWN ROUTES
// ===========================================================================
// A room is a NAME. 20260827232510: "Name-only at MVP -- PRD 6.4 confirms
// rooms and optional room-level event assignment but gives no room-level
// fields." A five-route CRUD screen for one text field is four routes of
// ceremony around a rename, so the venue detail page carries the whole
// lifecycle: add, rename, close, reopen.
//
// CLOSE AND REOPEN, NOT DELETE AND RESTORE, IN THE COPY. `deleted_at` is what
// the column is, and it was added beyond the plan for a stated reason: Phase 3
// events may reference a room, so hard-deleting a room past events were
// assigned to would either cascade into event history or silently null it out.
// What a venue actually does to a room is close it, and calling the control
// "Delete" invites the user to expect the row to be gone -- which it is not,
// and must not be.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, liveInOrg, refusedEndState, stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { screenAfterCreate } from "@/lib/crm/dedup";
import {
  checkCapacity,
  checkLongText,
  checkName,
  checkShortText,
  type FieldProblem,
} from "@/lib/crm/validate";
import {
  hasUnsafeScheme,
  mergeSocials,
  normaliseWebsite,
  SOCIAL_PLATFORMS,
} from "@/lib/crm/urls";

const PERMISSION = "manage_venues";

// ---------------------------------------------------------------------------
// The venue record
// ---------------------------------------------------------------------------

interface VenueValues {
  name: string;
  address: string | null;
  location: string | null;
  capacity: number | null;
  website: string | null;
  technicalInfo: string | null;
  socials: Record<string, string>;
}

/**
 * Read and validate the venue form.
 *
 * `address` AND `location` ARE BOTH KEPT AND ARE NOT DUPLICATES.
 * 20260827232510: address is the postal address, location is the
 * searchable/displayable place ("Bristol", "South London") that PRD 6.4 lists
 * separately and that contacts carries too. The form labels them so, because
 * two adjacent inputs that look like the same question get the same answer
 * typed into both.
 *
 * `capacity` is the one numeric field in the phase, and `checkCapacity` exists
 * because the obvious implementation (`Number(value) || null`) turns a blank
 * input into 0 -- the exact lie the column is nullable to avoid.
 */
function readVenue(
  formData: FormData,
):
  | { readonly ok: true; readonly values: VenueValues }
  | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const address = field(formData, "address");
  const location = field(formData, "location");
  const technicalInfo = field(formData, "technicalInfo");
  const websiteRaw = field(formData, "website");

  const problems: (FieldProblem | null)[] = [
    checkName(name),
    checkLongText("address", address, "Address"),
    checkShortText("location", location, "Location"),
    checkLongText("technicalInfo", technicalInfo, "Technical information"),
  ];

  const capacity = checkCapacity(field(formData, "capacity"));
  problems.push(capacity.problem);

  const website = normaliseWebsite(websiteRaw);
  const websiteValue = website.ok ? website.value : null;
  if (!website.ok) problems.push({ field: "website", message: website.message });

  // SOCIALS. The same six keys, the same write-side check, and the same
  // reminder that the CONTROL is the render side (lib/crm/urls.ts): PostgREST
  // is reachable from a browser with the anon key, so a stored `javascript:`
  // has to be inert on the way out whatever happened on the way in.
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
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return {
    ok: true,
    values: {
      name: name as string,
      address,
      location,
      capacity: capacity.capacity,
      website: websiteValue,
      technicalInfo,
      socials,
    },
  };
}

export async function createVenueAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readVenue(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venues")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      name: parsed.values.name,
      address: parsed.values.address,
      location: parsed.values.location,
      capacity: parsed.values.capacity,
      website: parsed.values.website,
      technical_info: parsed.values.technicalInfo,
      socials: parsed.values.socials,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    console.error("[crm] create venue failed:", error.message);
    return { error: FAILED_MESSAGE };
  }
  if (!data) return { error: FAILED_MESSAGE };

  revalidatePath(`/${org.slug}/venues`);
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
  const screened = await screenAfterCreate(org.id, "venue", data.id as string);

  // AUTO-MERGED AWAY. The record just created shared an email address, exactly
  // and case-insensitively, with an older one -- so it no longer exists as a
  // separate record and redirecting to its own page would be a 404 the user
  // caused by saving a form. They go to the record their data is now on.
  if (screened.mergedInto) {
    revalidatePath(`/${org.slug}/venues`);
    redirect(`/${org.slug}/venues/${screened.mergedInto}`);
  }

  redirect(`/${org.slug}/venues/${data.id as string}`);
}

export async function updateVenueAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  // fix round 1, I-2: the same omission representation-panel.tsx's create form
  // had, on a hidden field this time -- effectively unreachable through the
  // rendered form, but the same line.
  if (!venueId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readVenue(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();
  // SOCIALS ARE MERGED, NOT REPLACED. See lib/crm/urls.ts's mergeSocials():
  // the six keys the form owns are authoritative, everything else is carried
  // through, and an emptied input CLEARS rather than reverting. Read through
  // the caller's own client and filtered by organisation, so it is not a
  // privileged peek.
  const existing = await supabase
    .from("venues")
    .select("socials")
    .eq("organisation_id", org.id)
    .eq("id", venueId)
    .maybeSingle();
  if (existing.error && existing.error.code !== "22P02") {
    // A FAILED LOOKUP IS NOT AN EMPTY ONE.
    console.error("[crm] update venue socials read failed:", existing.error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  const socials = mergeSocials(existing.data?.socials, parsed.values.socials);

  const result = await commitWrite(`update venue ${venueId}`, () =>
    supabase
      .from("venues")
      .update(
        {
          name: parsed.values.name,
          address: parsed.values.address,
          location: parsed.values.location,
          capacity: parsed.values.capacity,
          website: parsed.values.website,
          technical_info: parsed.values.technicalInfo,
          socials,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", venueId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/venues`);
    revalidatePath(`/${org.slug}/venues/${venueId}`);
    redirect(`/${org.slug}/venues/${venueId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteVenueAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  // fix round 1, I-2: same omission, hidden field, same line.
  if (!venueId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`delete venue ${venueId}`, () =>
    supabase
      .from("venues")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", venueId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/venues`);
    revalidatePath(`/${org.slug}/venues/deleted`);
    revalidatePath(`/${org.slug}/venues/${venueId}`);
  }
  // SOFT-DELETING A VENUE DOES NOT CLOSE ITS ROOMS, and that is the point of
  // soft delete: restore has to bring the record back as it was. What it does
  // do -- as of 20260829001000 -- is make the rooms unwritable until the venue
  // is restored, which the panel says on the page rather than leaving the user
  // to discover through a refused click.
  return stateFor(
    result,
    "Deleted. It is out of the venues list; its rooms are still here and come back with it.",
    formData,
  );
}

export async function restoreVenueAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  // fix round 1, I-2: same omission, hidden field, same line.
  if (!venueId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore venue ${venueId}`, () =>
    supabase
      .from("venues")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", venueId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/venues`);
    revalidatePath(`/${org.slug}/venues/deleted`);
    revalidatePath(`/${org.slug}/venues/${venueId}`);
  }
  return stateFor(result, "Restored. It is back in the venues list.", formData);
}

// ---------------------------------------------------------------------------
// venue_rooms
// ---------------------------------------------------------------------------

/**
 * Warn on a duplicate room name in the same venue, or null.
 *
 * ===========================================================================
 * THE DECISION: THE APPLICATION REFUSES IT; THE SCHEMA STILL DOES NOT
 * ===========================================================================
 * Task 1's report recorded that name uniqueness within a venue is NOT enforced
 * and left the call to whoever built the screen. This is that call, and it has
 * two halves.
 *
 * WHY THE APPLICATION REFUSES IT. Two rooms called "Main Room" in one venue is
 * a data-entry mistake with a real downstream consequence, not an aesthetic
 * one: PRD 6.4's "optional room-level event assignment" means Phase 3 will
 * offer these names in a picker, and two identical entries in a picker cannot
 * be told apart by the person choosing. Catching it at the moment of typing
 * costs one query; catching it in Phase 3 costs a data-cleanup exercise.
 *
 * WHY NOT A UNIQUE INDEX. Three reasons, in order of weight. (1) It is a
 * PRODUCT rule, and 20260827232510's convention (5) draws exactly this line --
 * value domains are integrity and belong in the schema, "no two rooms with the
 * same name in a venue" is a product rule that changes how the UI has to
 * write. Task 1 declined to impose it and this task is not the place to
 * overturn that silently. (2) A partial unique index on
 * `(venue_id, lower(name)) where deleted_at is null` would turn a legitimate
 * bulk import or a Phase 6 merge into a failed statement rather than a queued
 * review, which is the same argument `contacts_org_email_lower_idx` is
 * deliberately NOT unique for. (3) It would have to be case- and
 * whitespace-normalised to be worth anything, and "Room 1" vs "room 1" vs
 * "Room  1" is a normalisation policy nobody has been asked about.
 *
 * SO THIS IS A COURTESY AND IT LOSES A RACE. Two submits at the same instant
 * both pass this check and both insert. Said plainly rather than hidden: the
 * consequence of losing is two rooms with the same name, which the user can
 * see and rename, with no data loss and nothing silently wrong. That is a
 * proportionate residue for a rule the schema deliberately does not hold.
 *
 * A CLOSED ROOM DOES NOT BLOCK THE NAME. `deleted_at is null` is in the query
 * because reopening "Basement" after closing it should not be blocked by the
 * closed "Basement" -- and if it were, the user would have no way to act on
 * the message, since the closed room is the thing they are trying to replace.
 */
async function duplicateRoomName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  venueId: string,
  name: string,
  exceptRoomId: string | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("venue_rooms")
    .select("id, name")
    .eq("organisation_id", organisationId)
    .eq("venue_id", venueId)
    .is("deleted_at", null)
    .limit(100);
  if (error || !data) {
    // FAIL OPEN, DELIBERATELY, AND THIS IS THE ONE PLACE IN THE PHASE THAT
    // DOES. Everything else here fails closed because it is a control; this is
    // a courtesy warning about a rule no constraint holds, so a failed lookup
    // must not become a refusal to add a room. The user's write is still
    // decided by the policy.
    if (error) console.error("[crm] room name check failed:", error.message);
    return false;
  }
  const wanted = name.trim().toLowerCase();
  return data.some(
    (row) =>
      String(row.id) !== exceptRoomId &&
      String(row.name).trim().toLowerCase() === wanted,
  );
}

const DUPLICATE_ROOM_MESSAGE =
  "This venue already has a room with that name. Give it something the person picking it can tell apart.";

export async function addRoomAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  // fix round 1, I-2: same omission, hidden field, same line.
  if (!venueId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const name = field(formData, "roomName");
  const problem = checkName(name);
  if (problem) {
    return {
      // The input is called `roomName`, so the error has to be keyed to that
      // and not to `name`, or it renders next to nothing at all -- which is a
      // WCAG failure wearing a validation message's clothes.
      fieldErrors: { roomName: problem.message },
      values: echoedValues(formData),
    };
  }

  const supabase = await createClient();
  // The venue must be live. As of 20260829001000 the DATABASE says so too --
  // `p.deleted_at is null` in venue_rooms_insert_via_venue -- so this is the
  // sentence and the policy is the control. T29 measures the policy.
  const blocked = refusedEndState(
    [await liveInOrg(supabase, "venues", org.id, venueId)],
    formData,
  );
  if (blocked) return blocked;

  if (await duplicateRoomName(supabase, org.id, venueId, name as string, null)) {
    return {
      fieldErrors: { roomName: DUPLICATE_ROOM_MESSAGE },
      values: echoedValues(formData),
    };
  }

  // `organisation_id` from the RESOLVED org. The tenant-scoped composite
  // foreign key venue_rooms_venue_fkey (20260828001132) is what makes a row
  // naming another tenant's venue impossible for EVERY writer -- this is the
  // table Task 1's review broke into end to end, and the FK is the fix; the
  // policy refuses an `authenticated` caller first, with 42501.
  const { error } = await supabase.from("venue_rooms").insert({
    organisation_id: org.id,
    venue_id: venueId,
    name: name as string,
  });

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE };
    if (error.code === "23503") return { error: REFUSED_MESSAGE };
    console.error("[crm] add room failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidatePath(`/${org.slug}/venues/${venueId}`);
  return { message: "Room added." };
}

export async function renameRoomAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  const roomId = field(formData, "roomId");
  // fix round 1, I-2: same omission, hidden fields, same line.
  if (!venueId || !roomId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const name = field(formData, "roomName");
  const problem = checkName(name);
  if (problem) {
    return {
      fieldErrors: { roomName: problem.message },
      values: echoedValues(formData),
    };
  }

  const supabase = await createClient();
  const blocked = refusedEndState(
    [await liveInOrg(supabase, "venues", org.id, venueId)],
    formData,
  );
  if (blocked) return blocked;

  if (await duplicateRoomName(supabase, org.id, venueId, name as string, roomId)) {
    return {
      fieldErrors: { roomName: DUPLICATE_ROOM_MESSAGE },
      values: echoedValues(formData),
    };
  }

  const result = await commitWrite(`rename room ${roomId}`, () =>
    supabase
      .from("venue_rooms")
      .update({ name: name as string }, { count: "exact" })
      .eq("organisation_id", org.id)
      // VENUE_ID AS WELL AS ID. Without it a forged `roomId` belonging to a
      // different venue in the same workspace would be renamed from this
      // venue's page: the policy asks whether the caller may write the row,
      // not whether the row is the one this URL is about.
      .eq("venue_id", venueId)
      .eq("id", roomId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidatePath(`/${org.slug}/venues/${venueId}`);
  return stateFor(result, "Renamed.", formData);
}

/**
 * Close a room. A soft delete, and the copy says "close" because that is what
 * it is.
 *
 * `deleted_at` on this table exists so that Phase 3's events can reference a
 * room that has since closed (20260827232510) -- so this must never become a
 * hard delete, and there is no DELETE policy or grant on the table for it to
 * become one through.
 */
export async function closeRoomAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  const roomId = field(formData, "roomId");
  // fix round 1, I-2: same omission, hidden fields, same line.
  if (!venueId || !roomId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const blocked = refusedEndState(
    [await liveInOrg(supabase, "venues", org.id, venueId)],
    formData,
  );
  if (blocked) return blocked;

  const result = await commitWrite(`close room ${roomId}`, () =>
    supabase
      .from("venue_rooms")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("venue_id", venueId)
      .eq("id", roomId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidatePath(`/${org.slug}/venues/${venueId}`);
  return stateFor(result, "Closed. You can reopen it below.", formData);
}

export async function reopenRoomAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const venueId = field(formData, "venueId");
  const roomId = field(formData, "roomId");
  // fix round 1, I-2: same omission, hidden fields, same line.
  if (!venueId || !roomId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const blocked = refusedEndState(
    [await liveInOrg(supabase, "venues", org.id, venueId)],
    formData,
  );
  if (blocked) return blocked;

  // NO DUPLICATE-NAME CHECK ON REOPEN, and it is a deliberate gap rather than
  // an oversight. Reopening a room whose name has since been reused would
  // produce the duplicate this file otherwise warns about -- but the only
  // honest resolutions are to refuse the reopen (leaving the user with a
  // closed room they cannot recover and a message about a name they may not be
  // able to change) or to rename it for them (silently rewriting a record).
  // The third option is to allow it and let the user rename whichever one they
  // meant, which is what happens: two visible rooms with one name, no data
  // lost, and the rename control right there. Recorded in the task report.
  const result = await commitWrite(`reopen room ${roomId}`, () =>
    supabase
      .from("venue_rooms")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("venue_id", venueId)
      .eq("id", roomId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") revalidatePath(`/${org.slug}/venues/${venueId}`);
  return stateFor(result, "Reopened.", formData);
}
