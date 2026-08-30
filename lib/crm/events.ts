"use server";

// Events: create, edit, soft-delete, restore.
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
//              instead, and the 23503 handler is the belt behind it.
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
