"use server";

// Events: create, edit, soft-delete, restore -- and, since Phase 3 Task 5, the
// four writes on `public.event_lineup` that hang off them. The lineup section
// is at the BOTTOM of this file with a header of its own; the four points
// below are about the EVENT record and § 4's "two ends" is not the same
// asymmetry the lineup has (there, the parent is checked on every write and
// the artist on one).
//
// The five-step shape lib/crm/contacts.ts states in full, with the plumbing
// imported from lib/crm/actions.ts, and structurally a copy of
// lib/crm/venues.ts. Four things about it are NOT a copy, and each is the
// reason this header exists rather than a pointer to that one.
//
// ===========================================================================
// 1. NO DUPLICATE SCREENING, AND NO DEAD BRANCH EITHER
// ===========================================================================
// The five Phase 2 entity modules end their create action with
// `screenAfterCreate(...)` followed by an `if (screened.mergedInto)` branch
// that, for four of the five, can never fire -- kept there deliberately so the
// five files read alike (see createVenueAction's comment).
//
// THIS FILE HAS NEITHER, and that is a decision with a name.
// 20260901001000 § (c) -- Q30 -- did NOT add an 'event' arm to
// private.dedup_entity_table(), so `screenAfterCreate(org.id, "event", id)`
// would not return null: there is no branch for it to take, and the RPC would
// fail rather than answer. The argument for the absence is in that migration
// and in the constraint comment on the function itself: a name is a FUZZY
// signal only (20260829020000 DECISION 1), a recurring club night shares its
// name with every previous instalment BY DESIGN, and `public.events` has no
// email column, so the `exact_email` branch that is the only auto-merge path
// is unreachable for events by construction. Every candidate pair would be
// fuzzy_name noise that trains users to dismiss the review queue.
//
// So there is no call and no dead `if`. Said here because every other create
// action in lib/crm/ has both, and an unexplained absence reads as an omission.
// tests/integration/crm/entity-dispatch-branches-match-db.test.ts asserts the
// ABSENCE of the 'event' arm in the database, from the other side.
//
// ===========================================================================
// 2. THE COPY IS THIS FILE'S OWN, NOT lib/crm/validate.ts's
// ===========================================================================
// `checkName` says "Enter a name."; this form says "Give the event a name."
// `checkLongText` caps at MAX_LONG_TEXT = 4,000; `events.notes` is capped at
// 5,000 here. The strings and the caps are the brief's, verbatim, so the
// shared helpers are deliberately NOT reused for name/location/notes -- reusing
// them would mean either changing five other forms' copy or passing three more
// parameters through a helper whose whole point is that it does not take any.
// `normaliseWebsite()` IS reused for the ticket link, messages included.
//
// ===========================================================================
// 3. A `datetime-local` VALUE IS INTERPRETED AS Europe/London, EXPLICITLY
// ===========================================================================
// `new Date("2026-09-04T22:00")` reads the wall clock in the SERVER'S zone,
// which is right on a UK laptop and an hour out on a UTC box. Every parse here
// goes through `londonWallClockToInstant` (lib/format/date.ts), which pins the
// zone by name and resolves the two ambiguous hours a year explicitly. The
// column is `timestamptz` and stores the instant: UTC in the database, UK
// local in the UI, per CLAUDE.md § Non-negotiable rules.
//
// ===========================================================================
// 4. TWO ENDS, AND ONLY ONE OF THEM IS APPLICATION-ONLY
// ===========================================================================
//   venue      `liveInOrg` + `refusedEndState`, so a soft-deleted venue
//              refuses the save with a sentence the user can act on. The
//              DATABASE holds the tenant half (events_venue_fkey is composite
//              on (venue_id, organisation_id)), but NOT the deleted half --
//              there is no `deleted_at` term in the events write policies, on
//              purpose, so this file is the only thing that refuses it.
//   room       events_venue_room_fkey is composite on
//              (venue_room_id, venue_id, organisation_id), so the DATABASE
//              refuses a room that is not in the chosen venue with 23503. The
//              check below exists to produce a sentence next to the field
//              instead.
//
//              THE 23503 HANDLER IS ON THE CREATE PATH ONLY, and fix round 1's
//              M-3 is right that the sentence used to imply otherwise. It is
//              reachable only when `roomIsInVenue` has FAILED OPEN on a lookup
//              error (see that function), which is a fault rather than a
//              mistyped form; on create the FK violation is then rendered as
//              the room sentence, and on update it reaches `classifyWrite`,
//              which maps anything that is not 42501/23505 to
//              `{outcome:"failed"}` and shows FAILED_MESSAGE attached to no
//              field. NOT EQUALISED, deliberately: the update path goes
//              through `commitWrite`, whose `MutationResponse` carries no
//              error CODE (lib/crm/write.ts), so handling 23503 there means
//              either widening that contract for one branch of one action or
//              going round the helper every write in the CRM uses. The
//              residue is a generic sentence on a fault that has already
//              failed a lookup. Recorded rather than hidden.
//
// A CLOSED ROOM IS ACCEPTED. `venue_rooms.deleted_at` was added
// (20260827232510) precisely so a past event can go on naming a room that has
// since closed, so refusing one here would break the thing the column exists
// for.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, liveInOrg, refusedEndState, stateFor } from "@/lib/crm/actions";
import type { RecordPresence } from "@/lib/crm/write-access";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { normaliseWebsite } from "@/lib/crm/urls";
import {
  EVENT_STATUSES,
  EVENT_TYPES,
  type EventStatus,
  type EventType,
} from "@/lib/crm/event-status";
import { londonWallClockToInstant } from "@/lib/format/date";
import type { FieldProblem } from "@/lib/crm/validate";
// PHASE 3 TASK 5. The lineup's vocabulary and its one pure parser live in the
// list spec module, so both are reachable from a node test -- `readPosition`
// is exactly the shape of thing lib/crm/event-picker.ts was extracted for.
import {
  isBilling,
  MIN_POSITION,
  POSITION_PROBLEM,
  readPosition,
  type Billing,
} from "@/lib/crm/lineup-list";

const PERMISSION = "manage_events";

/** `name` is the identity of the record, same bound as every other entity. */
const MAX_EVENT_NAME = 200;
/** "TBC, south London" -- the short free-text place, not a paragraph. */
const MAX_EVENT_LOCATION = 200;
/**
 * Longer than MAX_LONG_TEXT (4,000) on purpose: an event's notes are the
 * running sheet -- door times, guest list, who is bringing the CDJs -- and the
 * brief sets the cap at 5,000. The column is unbounded `text`; this is the
 * only thing between it and a pasted megabyte.
 */
const MAX_EVENT_NOTES = 5000;

const ROOM_NEEDS_A_VENUE = "Choose the venue first, then its room.";
const ROOM_NOT_IN_VENUE = "That room isn’t part of the venue you chose.";

// ---------------------------------------------------------------------------
// The event record
// ---------------------------------------------------------------------------

interface EventValues {
  name: string;
  eventType: EventType;
  status: EventStatus;
  /** An ISO instant, already resolved out of the Europe/London wall clock. */
  startsAt: string;
  endsAt: string | null;
  venueId: string | null;
  venueRoomId: string | null;
  location: string | null;
  ticketLink: string | null;
  notes: string | null;
}

function isStatus(value: string | null): value is EventStatus {
  return value !== null && (EVENT_STATUSES as readonly string[]).includes(value);
}

function isEventType(value: string | null): value is EventType {
  return value !== null && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Read and validate the event form.
 *
 * PURE, AND IT DOES NOT TOUCH THE DATABASE. The two checks that need a query
 * -- is the venue live, is the room in it -- are the caller's, because they
 * need a client and because their refusals are `refusedEndState`'s sentences
 * rather than field errors.
 *
 * `venueId` IS NOT CHECKED FOR UUID SHAPE HERE. `liveInOrg` answers "gone" for
 * an unparseable uuid (22P02) exactly as it does for a record in another
 * workspace, and `joinEndExplanation` turns that into REFUSED_MESSAGE. A
 * separate "that is not a uuid" message would be a sentence about a value the
 * user never typed -- the picker is a `<select>` -- and a second, more precise
 * answer to a question the phase deliberately answers vaguely.
 */
function readEvent(
  formData: FormData,
):
  | { readonly ok: true; readonly values: EventValues }
  | { readonly ok: false; readonly state: FormState } {
  const name = field(formData, "name");
  const status = field(formData, "status");
  const eventType = field(formData, "eventType");
  const location = field(formData, "location");
  const notes = field(formData, "notes");
  const venueId = field(formData, "venueId");
  const venueRoomId = field(formData, "venueRoomId");

  const problems: (FieldProblem | null)[] = [];

  if (name === null) {
    problems.push({ field: "name", message: "Give the event a name." });
  } else if (name.length > MAX_EVENT_NAME) {
    problems.push({
      field: "name",
      message: `That name is too long — ${MAX_EVENT_NAME} characters at most.`,
    });
  }

  // THE START IS REQUIRED BECAUSE THE COLUMN IS. 20260901000000: `starts_at`
  // is NOT NULL "deliberately ... a nullable sort column makes keyset ordering
  // non-total. An event with no date agreed yet is a `draft` carrying a
  // placeholder date".
  const startsRaw = field(formData, "startsAt");
  let startsAt: string | null = null;
  if (startsRaw === null) {
    problems.push({
      field: "startsAt",
      message: "An event needs a date and a start time.",
    });
  } else {
    startsAt = londonWallClockToInstant(startsRaw);
    if (startsAt === null) {
      problems.push({
        field: "startsAt",
        message: "That doesn’t look like a date and time.",
      });
    }
  }

  const endsRaw = field(formData, "endsAt");
  let endsAt: string | null = null;
  if (endsRaw !== null) {
    endsAt = londonWallClockToInstant(endsRaw);
    if (endsAt === null) {
      problems.push({
        field: "endsAt",
        message: "That doesn’t look like a date and time.",
      });
    } else if (startsAt !== null && endsAt <= startsAt) {
      // STRICTLY AFTER, mirroring `events_ends_after_starts`. Equal counts:
      // an event that ends the instant it starts is the same mistake as one
      // that ends before, and the CHECK would raise 23514 either way -- which
      // reaches the user as a fault rather than as a field error.
      //
      // Comparing ISO STRINGS is safe because both come out of
      // `Date.toISOString()`: same length, same zone, lexicographic order is
      // chronological order.
      problems.push({
        field: "endsAt",
        message: "The end time is before the start time.",
      });
    }
  }

  // The two vocabularies. A value outside either set is a 23514 at write time
  // for every writer including one that reaches PostgREST directly; this is
  // the sentence, `events_status_check` is the control.
  if (!isStatus(status)) {
    problems.push({ field: "status", message: "Choose a status from the list." });
  }
  if (!isEventType(eventType)) {
    problems.push({
      field: "eventType",
      message: "Choose an event type from the list.",
    });
  }

  // `events_room_needs_a_venue` is the CHECK; this is its sentence. Without a
  // venue there is nothing for the room to belong to, and the FK could not be
  // satisfied either.
  if (venueRoomId !== null && venueId === null) {
    problems.push({ field: "venueRoomId", message: ROOM_NEEDS_A_VENUE });
  }

  if (location !== null && location.length > MAX_EVENT_LOCATION) {
    problems.push({
      field: "location",
      message: `That location is too long — ${MAX_EVENT_LOCATION} characters at most.`,
    });
  }
  if (notes !== null && notes.length > MAX_EVENT_NOTES) {
    problems.push({
      field: "notes",
      message: `Those notes are too long — ${MAX_EVENT_NOTES.toLocaleString("en-GB")} characters at most.`,
    });
  }

  // The ticket link goes through the SAME normaliser as every `website`
  // column, messages included: `ra.co/events/1234` is what people paste, and
  // it is stored as `https://ra.co/events/1234`. A non-http(s) scheme is
  // refused here and rendered inert on the way out regardless
  // (lib/crm/urls.ts: "the render side is the control").
  const ticket = normaliseWebsite(field(formData, "ticketLink"));
  const ticketLink = ticket.ok ? ticket.value : null;
  if (!ticket.ok) problems.push({ field: "ticketLink", message: ticket.message });

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
      eventType: eventType as EventType,
      status: status as EventStatus,
      startsAt: startsAt as string,
      endsAt,
      venueId,
      venueRoomId,
      location,
      ticketLink,
      notes,
    },
  };
}

/**
 * Is this room part of that venue, in this workspace?
 *
 * FAILS OPEN ON A LOOKUP ERROR, and this is the one place in the file that
 * does -- for the same reason `duplicateRoomName` in lib/crm/venues.ts does:
 * the DATABASE holds this rule. `events_venue_room_fkey` is composite on
 * (venue_room_id, venue_id, organisation_id), so a mismatch is a 23503 whether
 * this function runs or not, and the callers turn that code into the same
 * sentence. A failed lookup must not become a refusal the user cannot act on.
 *
 * `deleted_at` IS NOT FILTERED. A closed room stays valid on the event that
 * already names it -- that is what the column was added for -- and the FK does
 * not care either.
 */
async function roomIsInVenue(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  venueId: string,
  roomId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("venue_rooms")
    .select("id")
    .eq("organisation_id", organisationId)
    .eq("venue_id", venueId)
    .eq("id", roomId)
    .maybeSingle();
  if (error) {
    // 22P02 is an unparseable uuid from a forged post: no such room, and the
    // FK will say so too.
    if (error.code === "22P02") return false;
    console.error("[crm] room/venue check failed:", error.message);
    return true;
  }
  return data !== null;
}

/** The field error a room/venue mismatch gets, or null. */
function roomProblem(formData: FormData): FormState {
  return {
    fieldErrors: { venueRoomId: ROOM_NOT_IN_VENUE },
    values: echoedValues(formData),
  };
}

// ---------------------------------------------------------------------------
// The four actions
// ---------------------------------------------------------------------------
//
// THE VENUE END IS CHECKED INLINE IN BOTH WRITES RATHER THAN FACTORED OUT.
// lib/crm/artists.ts hides its three ends behind `representationEnds()`, which
// is right there: three ends, five callers. Here there is ONE end and TWO
// callers, and hiding it would make tests/unit/crm/source-shape.test.ts's
// "every action containing `liveInOrg(` also contains
// `refusedEndState(ends, formData)`" pass VACUOUSLY -- no action would contain
// either token. So the four lines are written twice, on purpose.

export async function createEventAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const parsed = readEvent(formData);
  if (!parsed.ok) return parsed.state;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();

  const ends: RecordPresence[] = [];
  if (parsed.values.venueId !== null) {
    ends.push(await liveInOrg(supabase, "venues", org.id, parsed.values.venueId));
  }
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  if (parsed.values.venueId !== null && parsed.values.venueRoomId !== null) {
    const ok = await roomIsInVenue(
      supabase,
      org.id,
      parsed.values.venueId,
      parsed.values.venueRoomId,
    );
    if (!ok) return roomProblem(formData);
  }

  // `owner_user_id` EXPLICITLY, though the column defaults to auth.uid().
  // events_insert_manage_events requires `owner_user_id = auth.uid()` for a
  // record-scoped role, and relying on a column default to satisfy a policy
  // means the policy and the write agree only as long as nobody changes the
  // default. The five Phase 2 creates all pass it; so does this one.
  const { data, error } = await supabase
    .from("events")
    .insert({
      organisation_id: org.id,
      owner_user_id: user.id,
      name: parsed.values.name,
      event_type: parsed.values.eventType,
      status: parsed.values.status,
      starts_at: parsed.values.startsAt,
      ends_at: parsed.values.endsAt,
      venue_id: parsed.values.venueId,
      venue_room_id: parsed.values.venueRoomId,
      location: parsed.values.location,
      ticket_link: parsed.values.ticketLink,
      notes: parsed.values.notes,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    // The FK behind `roomIsInVenue`, reached when that check failed open.
    if (error.code === "23503") return roomProblem(formData);
    console.error("[crm] create event failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }
  if (!data) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  revalidatePath(`/${org.slug}/events`);
  // NO `screenAfterCreate` AND NO DEAD MERGE BRANCH. See § 1 of this file's
  // header: 20260901001000 § (c) (Q30) deliberately did not give
  // private.dedup_entity_table() an 'event' arm, so the call would fail rather
  // than return null.
  redirect(`/${org.slug}/events/${data.id as string}`);
}

export async function updateEventAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  // A hidden field, so effectively unreachable through the rendered form --
  // and it carries `values` for the same reason every other refusal does
  // (final review I-1): React 19 resets the form after the action.
  if (!eventId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const parsed = readEvent(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();

  const ends: RecordPresence[] = [];
  if (parsed.values.venueId !== null) {
    ends.push(await liveInOrg(supabase, "venues", org.id, parsed.values.venueId));
  }
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  if (parsed.values.venueId !== null && parsed.values.venueRoomId !== null) {
    const ok = await roomIsInVenue(
      supabase,
      org.id,
      parsed.values.venueId,
      parsed.values.venueRoomId,
    );
    if (!ok) return roomProblem(formData);
  }

  const result = await commitWrite(`update event ${eventId}`, () =>
    supabase
      .from("events")
      .update(
        {
          name: parsed.values.name,
          event_type: parsed.values.eventType,
          status: parsed.values.status,
          starts_at: parsed.values.startsAt,
          ends_at: parsed.values.endsAt,
          venue_id: parsed.values.venueId,
          venue_room_id: parsed.values.venueRoomId,
          location: parsed.values.location,
          ticket_link: parsed.values.ticketLink,
          notes: parsed.values.notes,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", eventId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/events`);
    revalidatePath(`/${org.slug}/events/${eventId}`);
    redirect(`/${org.slug}/events/${eventId}`);
  }
  return stateFor(result, "Saved.", formData);
}

export async function deleteEventAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  if (!eventId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  // NO VENUE CHECK ON DELETE OR RESTORE, deliberately. Neither touches
  // `venue_id`, and refusing to delete an event because its venue has been
  // deleted would leave the user with a record they cannot remove and an
  // instruction ("restore the venue first") about a decision somebody else
  // made. The venue is an end of the SAVE, not of the lifecycle.
  const supabase = await createClient();
  const result = await commitWrite(`delete event ${eventId}`, () =>
    supabase
      .from("events")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", eventId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/events`);
    revalidatePath(`/${org.slug}/events/deleted`);
    revalidatePath(`/${org.slug}/events/${eventId}`);
  }
  // SAYS WHAT ELSE WENT WITH IT. 20260901011000 leaves a lineup row unreachable
  // for writes while its parent event is soft-deleted, so a deleted event is a
  // deleted bill and not just a deleted date -- and the user finds that out
  // here rather than through a refused click on the restored record.
  return stateFor(
    result,
    "Deleted. It is out of the events list; its lineup comes back with it.",
    formData,
  );
}

export async function restoreEventAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  if (!eventId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const supabase = await createClient();
  const result = await commitWrite(`restore event ${eventId}`, () =>
    supabase
      .from("events")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", eventId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/events`);
    revalidatePath(`/${org.slug}/events/deleted`);
    revalidatePath(`/${org.slug}/events/${eventId}`);
  }
  return stateFor(result, "Restored. It is back in the events list.", formData);
}

// ---------------------------------------------------------------------------
// PHASE 3 TASK 5 -- the lineup
// ---------------------------------------------------------------------------
//
// Four more actions on `public.event_lineup`, and three things about them are
// not a copy of the four above.
//
// ===========================================================================
// A. TWO ENDS, AND THE ASYMMETRY IS THE OPPOSITE WAY ROUND FROM § 4
// ===========================================================================
// A slot names two parents. Each write below checks the ends it actually has,
// and each end has a different amount of database behind it:
//
//   event    THE PARENT, and it is checked on ALL FOUR writes, because all
//            four write a row whose scope is this event's. The DATABASE holds
//            this end too: `p.deleted_at is null` sits in all three
//            event_lineup write policies (20260901011000), in BOTH the USING
//            and the WITH CHECK of the UPDATE one -- so a direct PostgREST
//            call with the anon key is refused as well. What the check here
//            buys is the SENTENCE: without it a soft-deleted event's lineup
//            write is an `ok(0)` that reaches the user as REFUSED_MESSAGE
//            ("your access may have changed"), which is a guess, instead of
//            DELETED_RECORD_EXPLANATION, which is the fact and carries the
//            instruction that fixes it.
//
//   artist    ONLY ON THE ADD, because it is the only write that names an
//            artist -- `updateLineupEntryAction` cannot move a slot to a
//            different artist and deliberately does not offer the field. And
//            for the soft-deleted half THIS CODE IS THE ONLY CONTROL. There is
//            no policy behind it and there must not be: 20260901011000's
//            header spells out why an `artists` term in a lineup policy would
//            be evaluated AS THE CALLER, so for a record-scoped user who owns
//            the event and not the artist "the artist is deleted" would
//            collapse into "I cannot see the artist" and legitimate writes
//            against live artists would start being refused.
//            rls_phase3_events.sql § EH2/§ EH5 assert that absence from both
//            sides. The CROSS-TENANT half is held by
//            `event_lineup_artist_fkey (artist_id, organisation_id)`, for
//            every writer in every role. DO NOT DELETE THE liveInOrg CALL
//            BELIEVING A POLICY IS BEHIND IT.
//
// Written INLINE in each action rather than factored into a `lineupEnds()`
// helper, for § 4's stated reason: hiding them would make
// tests/unit/crm/source-shape.test.ts's "every action containing `liveInOrg(`
// also contains `refusedEndState(ends, formData)`" pass VACUOUSLY. The
// per-action test below asserts the DENOMINATOR as well -- exactly which
// action checks which end.
//
// ===========================================================================
// B. A 23505 HERE IS THE ANSWER, NOT A CONFLICT
// ===========================================================================
// `event_lineup_event_artist_live_unique (event_id, artist_id) where
// deleted_at is null` is integrity rather than a race: adding an artist who is
// already on the bill is a thing a user does, not a thing two users do at
// once. So it is handled BEFORE `classifyWrite` ever sees it -- exactly as
// `linkCompanyAction` handles its own 23505 -- and gets
// LINEUP_DUPLICATE_ARTIST rather than CONFLICT_MESSAGE's "somebody else
// changed this record while you were editing it", which would be a sentence
// about a person who does not exist.
//
// THE PICKER DOES NOT PRE-EXCLUDE THEM, and that is why this path is ordinary
// rather than defensive: the panel is paginated, so the caller holds one page
// of the bill and an exclusion list built from it would be arbitrary by page.
// `loadArtistsForPicker` in lib/crm/queries.ts carries that argument.
//
// ===========================================================================
// C. `position` IS VALIDATED HERE, IN ONE PURE FUNCTION, AND NOT BY Number()
// ===========================================================================
// `readPosition` (lib/crm/lineup-list.ts) is pure and unit-tested, because the
// three ways a number field goes wrong are all silent: `Number("")` is 0, so
// an omitted field would become position zero; `Number("1e3")` is 1000, past
// the CHECK, so the user meets a 23514 as "something went wrong"; and
// `Number("1.5")` is 1.5 against an integer column, which is a 22P02. Each is
// refused here with POSITION_PROBLEM, next to the field.

/** The 23505 this table can actually produce, and it is not a conflict. */
const LINEUP_DUPLICATE_ARTIST = "That artist is already on this lineup.";

/**
 * Lineup notes are a cue line -- "on at 23:00, needs two CDJs" -- not the
 * event's running sheet, which is `events.notes` at MAX_EVENT_NOTES (5,000).
 * The column is unbounded `text`; this is the only thing between it and a
 * pasted megabyte.
 */
const MAX_LINEUP_NOTES = 2000;

const SET_ENDS_NEEDS_A_START = "A set that ends needs a start time too.";

interface LineupValues {
  position: number | null;
  billing: Billing;
  /** ISO instants, already resolved out of the Europe/London wall clock. */
  setStartsAt: string | null;
  setEndsAt: string | null;
  notes: string | null;
}

/**
 * Read and validate the five editable fields of a slot.
 *
 * PURE, AND IT DOES NOT TOUCH THE DATABASE, for `readEvent`'s reason: the
 * checks that need a query -- is the event live, is the artist live -- are the
 * caller's, because their refusals are `refusedEndState`'s sentences rather
 * than field errors.
 *
 * `position` may be null: the add form leaves it blank and the column defaults
 * to 0. `null` is therefore OMITTED from the insert rather than written, so
 * the default is what applies and the two never disagree.
 */
function readLineup(
  formData: FormData,
):
  | { readonly ok: true; readonly values: LineupValues }
  | { readonly ok: false; readonly state: FormState } {
  const problems: FieldProblem[] = [];

  const position = readPosition(field(formData, "position"));
  if (position === "invalid") {
    problems.push({ field: "position", message: POSITION_PROBLEM });
  }

  // The vocabulary. A value outside the set is a 23514 at write time for every
  // writer including one that reaches PostgREST directly; this is the
  // sentence, `event_lineup`'s billing CHECK is the control.
  const billing = field(formData, "billing");
  if (!isBilling(billing)) {
    problems.push({ field: "billing", message: "Choose a billing from the list." });
  }

  const startsRaw = field(formData, "setStartsAt");
  let setStartsAt: string | null = null;
  if (startsRaw !== null) {
    setStartsAt = londonWallClockToInstant(startsRaw);
    if (setStartsAt === null) {
      problems.push({
        field: "setStartsAt",
        message: "That doesn’t look like a date and time.",
      });
    }
  }

  const endsRaw = field(formData, "setEndsAt");
  let setEndsAt: string | null = null;
  if (endsRaw !== null) {
    setEndsAt = londonWallClockToInstant(endsRaw);
    if (setEndsAt === null) {
      problems.push({
        field: "setEndsAt",
        message: "That doesn’t look like a date and time.",
      });
    } else if (startsRaw === null) {
      // `event_lineup_set_ends_after_starts` requires the start when the end
      // is present. This is its sentence; the CHECK is the control, and it
      // would reach the user as a 23514 rendered as "something went wrong".
      problems.push({ field: "setEndsAt", message: SET_ENDS_NEEDS_A_START });
    } else if (setStartsAt !== null && setEndsAt <= setStartsAt) {
      // STRICTLY AFTER, mirroring the CHECK. Comparing ISO STRINGS is safe
      // because both come out of `Date.toISOString()`: same length, same zone,
      // lexicographic order is chronological order.
      problems.push({
        field: "setEndsAt",
        message: "The end time is before the start time.",
      });
    }
  }

  const notes = field(formData, "notes");
  if (notes !== null && notes.length > MAX_LINEUP_NOTES) {
    problems.push({
      field: "notes",
      message: `Those notes are too long — ${MAX_LINEUP_NOTES.toLocaleString("en-GB")} characters at most.`,
    });
  }

  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    if (!fieldErrors[problem.field]) fieldErrors[problem.field] = problem.message;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, state: { fieldErrors, values: echoedValues(formData) } };
  }

  return {
    ok: true,
    values: {
      position: position as number | null,
      billing: billing as Billing,
      setStartsAt,
      setEndsAt,
      notes,
    },
  };
}

/** Both routes a lineup change shows up on. */
function revalidateLineup(orgSlug: string, eventId: string): void {
  revalidatePath(`/${orgSlug}/events/${eventId}`);
  // The events list renders no lineup today, and the timeline branch Task 6
  // adds to `public.activity_events` is on the EVENT's page. Revalidating the
  // list as well would be a line nobody can point at a consumer for, so it is
  // deliberately not here.
}

export async function addLineupEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  if (!eventId) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const artistId = field(formData, "artistId");
  if (!artistId) {
    return {
      fieldErrors: { artistId: "Choose an artist to add." },
      values: echoedValues(formData),
    };
  }

  const parsed = readLineup(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();

  // BOTH ENDS, AND SEE § A OF THIS SECTION'S HEADER FOR WHAT IS BEHIND EACH.
  // The EVENT end is also a policy term (`p.deleted_at is null` in
  // event_lineup_insert_via_event); the ARTIST end is this line and nothing
  // else, deliberately, per 20260901011000's header and § EH of
  // rls_phase3_events.sql.
  const ends: RecordPresence[] = [
    await liveInOrg(supabase, "events", org.id, eventId),
    await liveInOrg(supabase, "artists", org.id, artistId),
  ];
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  // `position` OMITTED WHEN BLANK, so the column default (0) applies rather
  // than this file writing a second copy of it.
  const { error } = await supabase.from("event_lineup").insert({
    organisation_id: org.id,
    event_id: eventId,
    artist_id: artistId,
    ...(parsed.values.position === null ? {} : { position: parsed.values.position }),
    billing: parsed.values.billing,
    set_starts_at: parsed.values.setStartsAt,
    set_ends_at: parsed.values.setEndsAt,
    notes: parsed.values.notes,
  });

  if (error) {
    // THE ONE ARTIST WHO IS ALREADY ON THE BILL. Handled here rather than in
    // `classifyWrite`, which would map it to CONFLICT_MESSAGE -- a sentence
    // about somebody else editing this record, when what happened is that the
    // user picked a name that is already in the list above the form. See § B.
    if (error.code === "23505") {
      return { error: LINEUP_DUPLICATE_ARTIST, values: echoedValues(formData) };
    }
    if (error.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[crm] add lineup entry failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidateLineup(org.slug, eventId);
  // NO SUCCESS STRING. The confirmation is the artist appearing in the list
  // above the form, which shows the actual new state instead of asserting that
  // something happened -- and a Client Component's `useActionState` result
  // outlives the thing it describes, because revalidation does not remount it
  // (components/crm/room-panel.tsx measured that).
  return {};
}

export async function updateLineupEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  const lineupId = field(formData, "lineupId");
  if (!eventId || !lineupId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const parsed = readLineup(formData);
  if (!parsed.ok) return parsed.state;

  const supabase = await createClient();

  // THE EVENT END ONLY. This write names no artist -- a slot cannot be moved
  // to a different artist and the form does not offer the field -- so there is
  // no artist end to check. See § A.
  const ends: RecordPresence[] = [
    await liveInOrg(supabase, "events", org.id, eventId),
  ];
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  // `position` FALLS BACK TO 0 HERE, not to "leave it alone". The row form
  // always renders the input with the stored value, so a blank one is a user
  // clearing it, and the honest reading of a cleared order field is "first" --
  // which is the column default. An UPDATE that silently skipped the column
  // would leave the input showing blank and the record showing 7.
  const result = await commitWrite(`update lineup entry ${lineupId}`, () =>
    supabase
      .from("event_lineup")
      .update(
        {
          position: parsed.values.position ?? MIN_POSITION,
          billing: parsed.values.billing,
          set_starts_at: parsed.values.setStartsAt,
          set_ends_at: parsed.values.setEndsAt,
          notes: parsed.values.notes,
        },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("event_id", eventId)
      .eq("id", lineupId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidateLineup(org.slug, eventId);
  return stateFor(result, "Saved.", formData);
}

export async function removeLineupEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  const lineupId = field(formData, "lineupId");
  if (!eventId || !lineupId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const ends: RecordPresence[] = [
    await liveInOrg(supabase, "events", org.id, eventId),
  ];
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  // A SOFT DELETE, AND THERE IS NO OTHER KIND HERE: `public.event_lineup` has
  // no DELETE grant and no DELETE policy (20260901000000), so removal IS an
  // UPDATE. Two more reasons it must stay one: the partial unique index is
  // `where deleted_at is null`, which is what lets the same artist be re-added
  // afterwards, and Task 6's `link_removed` timeline branch reads the surviving
  // row.
  const result = await commitWrite(`remove lineup entry ${lineupId}`, () =>
    supabase
      .from("event_lineup")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("event_id", eventId)
      .eq("id", lineupId)
      .is("deleted_at", null),
  );

  if (result.outcome === "applied") revalidateLineup(org.slug, eventId);
  return stateFor(
    result,
    "Removed. They are under “Removed from this lineup”, and can be put back.",
    formData,
  );
}

export async function restoreLineupEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const eventId = field(formData, "eventId");
  const lineupId = field(formData, "lineupId");
  if (!eventId || !lineupId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const ends: RecordPresence[] = [
    await liveInOrg(supabase, "events", org.id, eventId),
  ];
  const blocked = refusedEndState(ends, formData);
  if (blocked) return blocked;

  const result = await commitWrite(`restore lineup entry ${lineupId}`, () =>
    supabase
      .from("event_lineup")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("event_id", eventId)
      .eq("id", lineupId)
      .filter("deleted_at", "not.is", null),
  );

  // THE 23505 THIS ONE CAN HIT, and it is a genuine conflict rather than the
  // add path's answer: restoring a slot for an artist who has since been
  // re-added violates `event_lineup_event_artist_live_unique`, and the user's
  // next move really is to reload and look, because what they are looking at
  // is out of date. `classifyWrite` maps it to `conflict` and CONFLICT_MESSAGE
  // says exactly that, so no special handling is written here.
  if (result.outcome === "applied") revalidateLineup(org.slug, eventId);
  return stateFor(result, "Put back on the lineup.", formData);
}
