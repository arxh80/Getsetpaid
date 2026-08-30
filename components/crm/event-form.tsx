"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createEventAction, updateEventAction } from "@/lib/crm/events";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  EVENT_STATUSES,
  EVENT_TYPES,
  STATUS_LABELS,
  TYPE_LABELS,
} from "@/lib/crm/event-status";
import type { PickerRoom, PickerVenue } from "@/lib/crm/event-picker";
import { Field, SelectField, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit an event. One form, two actions, same shape as VenueForm.
//
// ===========================================================================
// UNCONTROLLED, SO IT WORKS WITH JAVASCRIPT DISABLED
// ===========================================================================
// Every input carries a `defaultValue` and nothing carries `value`. React 19
// resets a `<form action>` once the action resolves, so each default reads
// `state.values?.<name> ?? values.<name>`: the echo wins when there is one (it
// is newer than the record the page loaded with) and the stored value stands
// otherwise. Without that, mistyping one character in the ticket link empties
// the whole form -- lib/forms.ts's header has the measurement.
//
// THE TEN ECHOES ARE WRITTEN OUT ONE BY ONE rather than routed through a
// `shown()` closure the way components/crm/venue-form.tsx does. That is a
// deliberate step backwards in tidiness for a testable property: a closure
// leaves exactly one `state.values?.` in the file, so a field added without an
// echo is invisible to a census, and this is the defect no automated gate in
// the repository can otherwise see. tests/unit/crm/source-shape.test.ts counts
// them and names all ten.
//
// ===========================================================================
// AND A `defaultValue` IS NOT ENOUGH ON A `<select>` -- MEASURED IN A BROWSER
// ===========================================================================
// The four `<select>`s carry a `key` as well as a `defaultValue`, and it is
// load-bearing rather than tidy. React syncs a text input's `defaultValue` to
// the DOM `defaultValue` property on every update, so `form.reset()` restores
// the echoed value. It does NOT do the equivalent for a `<select>`: the
// default lives in the `selected` ATTRIBUTE of an `<option>`, which React
// writes at MOUNT and then leaves alone unless `multiple` changes. So the
// reset restores the option the select had when the page first rendered.
//
// Measured on the first Rule 17 walk of this form, and it is the exact defect
// lib/forms.ts exists for wearing different clothes: type a name, pick "Club
// night", "On sale", a venue and a room, mistype the ticket link, submit --
// the four text fields come back correctly and all four SELECTS snap back to
// "Other", "Draft" and no venue. Retrying the submit then saves a record with
// four fields the user did not choose, which is worse than losing them.
//
// The `key` forces a remount when the shown value changes, so the new element
// mounts with the right `selected` option. Same mechanism, same reason, as
// components/crm/merge-form.tsx keying its field rows on the survivor (final
// review I-2): uncontrolled DOM state does not follow a re-render.
//
// ===========================================================================
// NO CHECKBOX GROUP ON THIS FORM, SO NO `groupMarkerName` MARKER
// ===========================================================================
// Every other form in components/crm/ carries one, because an unticked
// checkbox submits NOTHING and "the answer was none" then collides with "the
// form never asked" (lib/forms.ts). This form has no checkbox and no
// multi-select: `status` and `eventType` are `<select>`s over closed
// vocabularies and a `<select>` always submits its current option. A marker
// here would be dead input. Said out loud because its absence would otherwise
// read as the I-2 bug rather than as a property of the controls.
//
// ===========================================================================
// THE ROOM PICKER HAS NO CASCADE, AND THAT IS THE NO-JAVASCRIPT ANSWER
// ===========================================================================
// With JavaScript off there is nothing to repopulate the room `<select>` when
// the venue `<select>` changes, so EVERY live room in the workspace is
// rendered, grouped under its venue with `<optgroup>` -- a native control a
// keyboard, a screen reader and a phone all already understand. Picking a room
// from the wrong group is refused by the server with a sentence beside the
// field, and by `events_venue_room_fkey` beneath that. A JavaScript
// enhancement that filtered the groups live would be an improvement and is not
// in this task's scope; it must not become the only way the control works.
//
// ===========================================================================
// TIMES ARE UK LOCAL, TYPED AS UK LOCAL
// ===========================================================================
// `<input type="datetime-local">` submits a wall clock with no zone.
// `londonWallClockToInstant` (lib/format/date.ts) interprets it as
// Europe/London on the server, and the edit page fills these inputs back in
// through the inverse. Nothing here does any timezone arithmetic -- the values
// this component sees are already London wall clocks, in and out.

export interface EventFormValues {
  id?: string;
  name: string;
  /** A Europe/London wall clock, `YYYY-MM-DDTHH:mm`, never an instant. */
  startsAt: string;
  endsAt: string;
  eventType: string;
  status: string;
  venueId: string;
  venueRoomId: string;
  location: string;
  ticketLink: string;
  notes: string;
}

/**
 * What an option in the venue picker says.
 *
 * THREE STATES, AND THE THIRD HAS NO NAME TO SHOW. `unreadable` means the
 * event names a venue this caller's SELECT policy does not return -- so the
 * option carries the stored id and a label that describes the SITUATION rather
 * than the record. It is here so the value round-trips: an option missing from
 * the list is a `venue_id = null` written by a save the user thought was about
 * the event's name (fix round 1, I-1; lib/crm/event-picker.ts has the full
 * argument, including why this discloses nothing new).
 *
 * The copy lives in the component, where copy belongs, and the ORDERING is the
 * server's -- `assemblePicker` puts the nameless entry last rather than
 * sorting it to the top on an empty string.
 */
function venueLabel(venue: PickerVenue): string {
  if (venue.state === "unreadable") return "A venue outside your access";
  return venue.state === "deleted" ? `${venue.name} (deleted)` : venue.name;
}

function roomLabel(room: PickerRoom): string {
  if (room.state === "unreadable") return "A room outside your access";
  // A closed room stays valid on the event that already names it -- that is
  // what `venue_rooms.deleted_at` was added for (20260827232510) -- so this is
  // a label, not a warning.
  return room.state === "deleted" ? `${room.name} (closed)` : room.name;
}

export function EventForm({
  orgSlug,
  values,
  venues,
  cancelHref,
}: {
  orgSlug: string;
  values: EventFormValues;
  /** Bounded by the SERVER (lib/crm/queries.ts), not by this control. */
  venues: readonly PickerVenue[];
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateEventAction : createEventAction,
    EMPTY_FORM_STATE,
  );

  // THE TEN ECHOES. One local per rendered field, so a field added without one
  // is visible to a census (tests/unit/crm/source-shape.test.ts counts them and
  // names all ten). The echo wins when there is one -- it is newer than the
  // record the page loaded with.
  const name = state.values?.name ?? values.name;
  const startsAt = state.values?.startsAt ?? values.startsAt;
  const endsAt = state.values?.endsAt ?? values.endsAt;
  const eventType = state.values?.eventType ?? values.eventType;
  const status = state.values?.status ?? values.status;
  const venueId = state.values?.venueId ?? values.venueId;
  const venueRoomId = state.values?.venueRoomId ?? values.venueRoomId;
  const location = state.values?.location ?? values.location;
  const ticketLink = state.values?.ticketLink ?? values.ticketLink;
  const notes = state.values?.notes ?? values.notes;

  const rooms = venues.filter((venue) => venue.rooms.length > 0);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="eventId" value={values.id} /> : null}

      <div className="flex flex-col gap-5">
        <Field
          label="Name"
          name="name"
          defaultValue={name}
          autoComplete="off"
          required
          maxLength={200}
          hint="What the night is called. This is what every list and search matches on."
          error={state.fieldErrors?.name}
        />

        <Field
          label="Starts"
          name="startsAt"
          type="datetime-local"
          defaultValue={startsAt}
          required
          hint="UK time. Doors, not load-in — an event with no date agreed yet is a draft with a placeholder."
          error={state.fieldErrors?.startsAt}
          className="tabular-nums"
        />

        <Field
          label="Ends"
          name="endsAt"
          type="datetime-local"
          defaultValue={endsAt}
          hint="Leave it blank if the finish isn’t announced. It has to be after the start."
          error={state.fieldErrors?.endsAt}
          className="tabular-nums"
        />

        <SelectField
          key={`eventType:${eventType}`}
          label="Type"
          name="eventType"
          defaultValue={eventType}
          required
          hint="“Other” is a complete answer — nothing here forces a night into the wrong box."
          error={state.fieldErrors?.eventType}
        >
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </SelectField>

        <SelectField
          key={`status:${status}`}
          label="Status"
          name="status"
          defaultValue={status}
          required
          hint="Where the night has got to. “Hold” and “Confirmed” are labels on this record, not a contracts workflow."
          error={state.fieldErrors?.status}
        >
          {EVENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <SelectField
          key={`venueId:${venueId}`}
          label="Venue"
          name="venueId"
          defaultValue={venueId}
          hint="Only venues you can see are listed. Leave it blank until the venue is booked and use Location below."
          error={state.fieldErrors?.venueId}
        >
          <option value="">No venue yet</option>
          {venues.map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venueLabel(venue)}
            </option>
          ))}
        </SelectField>

        <SelectField
          key={`venueRoomId:${venueRoomId}`}
          label="Room"
          name="venueRoomId"
          defaultValue={venueRoomId}
          hint="Grouped by venue. Pick one from the venue you chose above — a room from anywhere else is refused when you save."
          error={state.fieldErrors?.venueRoomId}
        >
          <option value="">No particular room</option>
          {rooms.map((venue) => (
            <optgroup key={venue.id} label={venueLabel(venue)}>
              {venue.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {roomLabel(room)}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectField>

        <Field
          label="Location"
          name="location"
          defaultValue={location}
          autoComplete="off"
          maxLength={200}
          hint="Free text, for when the venue isn’t a record yet — “TBC, south London”."
          error={state.fieldErrors?.location}
        />

        <Field
          label="Ticket link"
          name="ticketLink"
          type="url"
          defaultValue={ticketLink}
          autoComplete="off"
          inputMode="url"
          hint="ra.co/events/1234 works — it is stored as https://ra.co/events/1234. Only http:// and https:// links are kept."
          error={state.fieldErrors?.ticketLink}
        />

        <TextAreaField
          label="Notes"
          name="notes"
          defaultValue={notes}
          maxLength={5000}
          hint="Door times, guest list, who is bringing the CDJs. Plain text."
          error={state.fieldErrors?.notes}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create event"}
        </Button>
        <Link
          href={cancelHref}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
