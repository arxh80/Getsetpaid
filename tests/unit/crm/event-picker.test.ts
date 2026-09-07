import { describe, expect, it } from "vitest";
import { assemblePicker, type PickerInputs } from "@/lib/crm/event-picker";

// THE TEST FIX ROUND 1's IMPORTANT 1 EXISTS FOR.
//
// ===========================================================================
// THE DEFECT, AND WHY NOTHING COULD SEE IT
// ===========================================================================
// A `<select>` that does not contain the value the record holds silently
// submits a DIFFERENT one: the browser selects the first `<option>`, which is
// `value=""`, `field()` maps `""` to null, and the UPDATE writes
// `venue_id = null`. A user who edited only the event's name loses its venue
// with nothing said.
//
// The first version of the picker appended the stored venue when it was
// soft-deleted or past the cap, and NOT when the caller could not read it --
// with a comment calling that "the correct answer". `venues_select_view_crm`
// is record-scoped, so a user downgraded from a full-scope role keeps
// ownership of events pointing at venues they can no longer read; an import or
// a `psql` write produces the same state. The picker cannot create it; the
// database can hold it.
//
// It was invisible to every gate: the assembly lived inside
// `loadVenuesForPicker` between four PostgREST calls, and `tests/unit` is pure
// functions only (vitest.config.ts's own rule) so a query module cannot be
// imported here at all. Extracting `assemblePicker` is what made the property
// assertable, and the first `describe` below is that property stated directly.

const EMPTY: PickerInputs = {
  live: [],
  rooms: [],
  includeVenueId: null,
  includeRoomId: null,
  storedVenue: null,
  storedRoom: null,
};

const VENUE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const VENUE_B = "aaaaaaaa-0000-0000-0000-000000000002";
const ROOM_A1 = "bbbbbbbb-0000-0000-0000-000000000001";
const ROOM_B1 = "bbbbbbbb-0000-0000-0000-000000000002";

/** Every option value the venue `<select>` would render. */
function venueIds(venues: ReturnType<typeof assemblePicker>): string[] {
  return venues.map((venue) => venue.id);
}

/** Every option value the room `<select>` would render, across all groups. */
function roomIds(venues: ReturnType<typeof assemblePicker>): string[] {
  return venues.flatMap((venue) => venue.rooms.map((room) => room.id));
}

describe("I-1: a stored id is ALWAYS an option, whatever else is true", () => {
  // THE INVARIANT, over every combination of the two things that can be true
  // of a stored end: whether the live list carries it, and whether the caller
  // can read it at all. Any `false` here is a silent `venue_id = null` on the
  // next save of an unrelated field.
  const CASES: { label: string; inputs: PickerInputs }[] = [
    {
      label: "live and readable",
      inputs: {
        ...EMPTY,
        live: [{ id: VENUE_A, name: "Live Venue" }],
        includeVenueId: VENUE_A,
      },
    },
    {
      label: "soft-deleted, so absent from the live list",
      inputs: {
        ...EMPTY,
        includeVenueId: VENUE_A,
        storedVenue: { name: "Closed Down", deleted: true },
      },
    },
    {
      label: "past the LINK_PANEL_LIMIT cap, so absent but readable",
      inputs: {
        ...EMPTY,
        live: [{ id: VENUE_B, name: "Some Other Venue" }],
        includeVenueId: VENUE_A,
        storedVenue: { name: "Venue 101", deleted: false },
      },
    },
    {
      label: "UNREADABLE -- the case the first version dropped",
      inputs: {
        ...EMPTY,
        live: [{ id: VENUE_B, name: "Some Other Venue" }],
        includeVenueId: VENUE_A,
        storedVenue: null,
      },
    },
  ];

  for (const { label, inputs } of CASES) {
    it(`the stored venue is an option when it is ${label}`, () => {
      expect(
        venueIds(assemblePicker(inputs)),
        "an option missing from the list is a silent venue_id = null on the next save",
      ).toContain(VENUE_A);
    });

    it(`...and appears exactly once when it is ${label}`, () => {
      // A duplicate would be a second option with the same value, which the
      // browser renders twice and which reads as a bug in the picker.
      expect(
        venueIds(assemblePicker(inputs)).filter((id) => id === VENUE_A),
      ).toHaveLength(1);
    });
  }

  it("the stored ROOM is an option when the caller cannot read it either", () => {
    // The room path failed the same way, one level down: with no readable room
    // row there was no `parent` and nothing was appended. The stored venue is
    // in `byId` by construction, so it is the group the option goes under --
    // which is also the venue the action checks the room against.
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_B, name: "Some Other Venue" }],
      includeVenueId: VENUE_A,
      includeRoomId: ROOM_A1,
      storedVenue: null,
      storedRoom: null,
    });
    expect(roomIds(venues)).toContain(ROOM_A1);
    const parent = venues.find((venue) => venue.id === VENUE_A);
    expect(parent?.rooms.map((room) => room.id)).toEqual([ROOM_A1]);
  });

  it("a stored room that IS readable goes under the venue it names", () => {
    const venues = assemblePicker({
      ...EMPTY,
      live: [
        { id: VENUE_A, name: "Venue A" },
        { id: VENUE_B, name: "Venue B" },
      ],
      includeVenueId: VENUE_B,
      includeRoomId: ROOM_B1,
      storedRoom: { name: "Closed Room", venueId: VENUE_B, deleted: true },
    });
    const parent = venues.find((venue) => venue.id === VENUE_B);
    expect(parent?.rooms).toEqual([
      { id: ROOM_B1, name: "Closed Room", state: "deleted" },
    ]);
  });

  it("nothing is appended on the CREATE form, where no id is stored", () => {
    // The paired negative: without it every assertion above would pass against
    // an implementation that appended an option unconditionally.
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_A, name: "Venue A" }],
      rooms: [{ id: ROOM_A1, name: "Main Room", venueId: VENUE_A }],
    });
    expect(venueIds(venues)).toEqual([VENUE_A]);
    expect(roomIds(venues)).toEqual([ROOM_A1]);
  });
});

describe("what each state means to the form", () => {
  it("a readable, live, uncapped venue is plain `live` and is not duplicated", () => {
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_A, name: "Venue A" }],
      includeVenueId: VENUE_A,
    });
    expect(venues).toEqual([
      { id: VENUE_A, name: "Venue A", state: "live", rooms: [] },
    ]);
  });

  it("a soft-deleted stored venue keeps its NAME and is marked `deleted`", () => {
    // The name is what the user recorded; hiding it leaves them a control they
    // cannot interpret. The form suffixes "(deleted)".
    const venues = assemblePicker({
      ...EMPTY,
      includeVenueId: VENUE_A,
      storedVenue: { name: "Closed Down", deleted: true },
    });
    expect(venues).toEqual([
      { id: VENUE_A, name: "Closed Down", state: "deleted", rooms: [] },
    ]);
  });

  it("an unreadable stored venue carries the id and NO NAME", () => {
    // NO ATTRIBUTE CROSSES THE BOUNDARY. The id is already handed to this
    // caller by `events_select_view_crm` on the event's own row -- the same
    // accepted identifier disclosure Q3a records for representations -- and
    // the name, which is an attribute, is neither fetched nor rendered.
    const venues = assemblePicker({
      ...EMPTY,
      includeVenueId: VENUE_A,
      storedVenue: null,
    });
    expect(venues).toEqual([
      { id: VENUE_A, name: "", state: "unreadable", rooms: [] },
    ]);
  });

  it("a stored venue that is readable and live is NOT marked, only appended", () => {
    // The past-the-cap case. It is an ordinary venue that the first hundred
    // did not reach, and marking it would tell the user something untrue.
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_B, name: "B" }],
      includeVenueId: VENUE_A,
      storedVenue: { name: "Venue 101", deleted: false },
    });
    expect(venues.find((venue) => venue.id === VENUE_A)?.state).toBe("live");
  });
});

describe("ordering", () => {
  it("is alphabetical, and the appended entry is not stranded at the bottom", () => {
    const venues = assemblePicker({
      ...EMPTY,
      live: [
        { id: VENUE_B, name: "Zed Bar" },
        { id: "cccccccc-0000-0000-0000-000000000003", name: "Middle Room" },
      ],
      includeVenueId: VENUE_A,
      storedVenue: { name: "Aardvark Club", deleted: true },
    });
    expect(venues.map((venue) => venue.name)).toEqual([
      "Aardvark Club",
      "Middle Room",
      "Zed Bar",
    ]);
  });

  it("puts the NAMELESS entry last rather than first on an empty string", () => {
    // `localeCompare("")` sorts an unreadable venue to the top, where it would
    // be the first thing in the list and read as the default.
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_B, name: "Zed Bar" }],
      includeVenueId: VENUE_A,
      storedVenue: null,
    });
    expect(venues.map((venue) => venue.id)).toEqual([VENUE_B, VENUE_A]);
  });

  it("sorts a venue's rooms by name once the stored one is appended", () => {
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_A, name: "Venue A" }],
      rooms: [{ id: ROOM_A1, name: "Zed Room", venueId: VENUE_A }],
      includeVenueId: VENUE_A,
      includeRoomId: ROOM_B1,
      storedRoom: { name: "Attic", venueId: VENUE_A, deleted: true },
    });
    expect(venues[0].rooms.map((room) => room.name)).toEqual(["Attic", "Zed Room"]);
  });
});

describe("rooms are grouped under the venue they belong to", () => {
  it("drops a room whose venue is not in the list at all", () => {
    // Not a leak and not a loss: the room query is scoped to the venue ids
    // this function assembled, so this only happens if a caller hands it rows
    // it did not ask for. Rendering an orphan would mean an `<option>` outside
    // every `<optgroup>`, which the server would then refuse anyway.
    const venues = assemblePicker({
      ...EMPTY,
      live: [{ id: VENUE_A, name: "Venue A" }],
      rooms: [{ id: ROOM_B1, name: "Orphan", venueId: VENUE_B }],
    });
    expect(roomIds(venues)).toEqual([]);
  });

  it("keeps two venues' rooms in their own groups", () => {
    const venues = assemblePicker({
      ...EMPTY,
      live: [
        { id: VENUE_A, name: "Venue A" },
        { id: VENUE_B, name: "Venue B" },
      ],
      rooms: [
        { id: ROOM_A1, name: "Main Room A", venueId: VENUE_A },
        { id: ROOM_B1, name: "Main Room B", venueId: VENUE_B },
      ],
    });
    expect(venues.map((venue) => venue.rooms.map((room) => room.id))).toEqual([
      [ROOM_A1],
      [ROOM_B1],
    ]);
  });
});
