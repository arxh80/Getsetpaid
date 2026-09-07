// The event form's venue/room picker, assembled.
//
// ===========================================================================
// WHY THIS IS A SEPARATE, PURE MODULE
// ===========================================================================
// It began as thirty lines inside `loadVenuesForPicker` in lib/crm/queries.ts,
// interleaved with four PostgREST calls -- and fix round 1's Important 1 was a
// defect in exactly those thirty lines that no test in this repository could
// see, because `tests/unit` is pure functions only (vitest.config.ts's own
// rule) and a query module cannot be imported into a node test.
//
// So the QUERIES stay in lib/crm/queries.ts and the ASSEMBLY is here, taking
// rows and returning options. `tests/unit/crm/event-picker.test.ts` drives it
// directly, including the case the defect was in. Nothing here imports
// `server-only`, `next/*` or a Supabase client, deliberately -- that is what
// makes it testable and what lets the Client Component import its types
// without reaching a server module.
//
// ===========================================================================
// THE DEFECT THIS SHAPE EXISTS TO PREVENT (fix round 1, I-1)
// ===========================================================================
// A `<select>` that does not contain the value the record holds SILENTLY
// SUBMITS A DIFFERENT ONE. The browser selects the first `<option>`, which is
// `value=""`; `field()` maps `""` to null; the UPDATE writes `venue_id = null`.
// A user who edited only the event's name loses its venue with nothing said.
//
// The first version closed that for a soft-deleted venue and for one past the
// cap, and left it open for a venue the caller CANNOT READ -- with a comment
// calling that "the correct answer". It is the correct answer to the oracle
// question and the wrong one to the data question, and the data question is
// the one with a customer's record in it. `venues_select_view_crm` is
// record-scoped, so a user downgraded from a full-scope role keeps ownership
// of events pointing at venues they can no longer read; an import or a `psql`
// write produces the same state.
//
// ===========================================================================
// AND THE OPAQUE OPTION DISCLOSES NOTHING NEW
// ===========================================================================
// The unreadable end is rendered as an option with the stored id as its value
// and NO NAME -- the form labels it "A venue outside your access". What that
// tells the caller is that this event names some venue they cannot read.
//
// They already know. `events_select_view_crm` hands them the whole row,
// `venue_id` included, and PostgREST is reachable from the browser with the
// anon key -- `GET /events?id=eq.X&select=venue_id` answers it directly. This
// is the same disposition `RepresentationEnd` in lib/crm/queries.ts records
// for Q3a: an accepted IDENTIFIER disclosure, bounded by the fact that no
// ATTRIBUTE leaks. No name, no address, no capacity crosses this boundary.
//
// IT IS DELIBERATELY MORE THAN THE DETAIL PAGE SAYS, and the asymmetry is not
// an inconsistency. The detail page collapses "no venue" and "a venue you
// cannot read" into one em dash because it is a DISPLAY and the collision
// costs the reader nothing. The edit form cannot collapse them, because one of
// the two is a value it has to hand back unchanged.
//
// The save is then refused rather than applied: `liveInOrg` answers "gone" for
// a row the caller cannot read, and `refusedEndState` turns that into
// REFUSED_MESSAGE (lib/crm/actions.ts). An explanation, instead of a silent
// rewrite. It does NOT let the user keep editing other fields while that venue
// is set -- which is the honest consequence of not being able to see it, and
// is the same trade a deleted end already makes.

/**
 * Why an option is in the list.
 *
 * A THREE-VALUE UNION RATHER THAN THE `unavailable: boolean` IT REPLACED,
 * because the boolean had two meanings and now needs three, and the third
 * renders differently: a deleted venue keeps its NAME with a "(deleted)"
 * suffix, an unreadable one has no name to render at all.
 */
export type PickerAvailability = "live" | "deleted" | "unreadable";

export interface PickerRoom {
  id: string;
  /** Empty for `unreadable` -- there is no name to show and none is fetched. */
  name: string;
  state: PickerAvailability;
}

export interface PickerVenue {
  id: string;
  /** Empty for `unreadable`. */
  name: string;
  state: PickerAvailability;
  rooms: PickerRoom[];
}

/** A venue or room row as the caller's own client returned it. */
export interface PickerPlaceRow {
  id: string;
  name: string;
}

export interface PickerRoomRow extends PickerPlaceRow {
  venueId: string;
}

/** What `lookupPlace` found for a stored id, or null when it found nothing. */
export interface StoredPlace {
  name: string;
  deleted: boolean;
}

export interface PickerInputs {
  /** Live venues the caller can read, already ordered and capped. */
  live: readonly PickerPlaceRow[];
  /** Live rooms of those venues, already ordered and capped. */
  rooms: readonly PickerRoomRow[];
  /** The event's stored venue id, or null on the create form. */
  includeVenueId: string | null;
  includeRoomId: string | null;
  /**
   * The stored venue, or null when the caller cannot read it. Only looked up
   * when `includeVenueId` is set and absent from `live`.
   */
  storedVenue: StoredPlace | null;
  /** The stored room, or null when the caller cannot read it. */
  storedRoom: (StoredPlace & { venueId: string }) | null;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, "en-GB", {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Turn the four query results into the option list the form renders.
 *
 * THE INVARIANT, and it is the one the unit test states first: **if
 * `includeVenueId` is non-null it is the id of exactly one option in the
 * result, whatever else is true** -- and the same for `includeRoomId`, under
 * the venue the action will check it against. Anything less silently rewrites
 * the record on the next save.
 */
export function assemblePicker(inputs: PickerInputs): PickerVenue[] {
  const venues: PickerVenue[] = inputs.live.map((row) => ({
    id: row.id,
    name: row.name,
    state: "live" as const,
    rooms: [],
  }));

  const { includeVenueId, includeRoomId } = inputs;

  // THE STORED VENUE, ALWAYS, WHEN THE RECORD HAS ONE. Three ways it can be
  // missing from `live` and all three end here with an option carrying the id:
  // soft-deleted, past the cap, or unreadable. The first two keep their name;
  // the third has none, and its ABSENCE from this list was the I-1 defect.
  if (includeVenueId !== null && !venues.some((v) => v.id === includeVenueId)) {
    venues.push({
      id: includeVenueId,
      name: inputs.storedVenue?.name ?? "",
      state:
        inputs.storedVenue === null
          ? "unreadable"
          : inputs.storedVenue.deleted
            ? "deleted"
            : "live",
      rooms: [],
    });
  }

  const byId = new Map(venues.map((venue) => [venue.id, venue]));
  for (const row of inputs.rooms) {
    byId.get(row.venueId)?.rooms.push({
      id: row.id,
      name: row.name,
      state: "live",
    });
  }

  // THE STORED ROOM, ALWAYS, ON THE SAME ARGUMENT. Its parent is the venue it
  // names when that is readable, and otherwise the stored venue -- which is in
  // `byId` by construction, because the block above put it there. The
  // `venue_room_id`/`venue_id` pair is held by the composite
  // events_venue_room_fkey, so those two are the same venue in every row the
  // database will accept.
  const known = new Set(venues.flatMap((venue) => venue.rooms.map((r) => r.id)));
  if (includeRoomId !== null && !known.has(includeRoomId)) {
    const parent =
      (inputs.storedRoom ? byId.get(inputs.storedRoom.venueId) : undefined) ??
      (includeVenueId !== null ? byId.get(includeVenueId) : undefined);
    if (parent) {
      parent.rooms.push({
        id: includeRoomId,
        name: inputs.storedRoom?.name ?? "",
        state:
          inputs.storedRoom === null
            ? "unreadable"
            : inputs.storedRoom.deleted
              ? "deleted"
              : "live",
      });
      parent.rooms.sort(byName);
    }
  }

  // The appended venue was pushed past the sort the query did. Re-sorting
  // keeps the picker alphabetical rather than stranding a deleted venue at the
  // bottom where nobody looks for it -- but an UNREADABLE one has no name, so
  // it goes last rather than sorting to the top on an empty string.
  return venues.sort((a, b) => {
    const nameless =
      Number(a.state === "unreadable") - Number(b.state === "unreadable");
    return nameless !== 0 ? nameless : byName(a, b);
  });
}
