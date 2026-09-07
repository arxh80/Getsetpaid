import { defineListSpec } from "@/lib/list/spec";
import {
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import {
  EVENT_STATUSES,
  STATUS_LABELS,
  type EventStatus,
  type EventType,
} from "@/lib/crm/event-status";

// The Events list specification.
//
// ===========================================================================
// THE ONE THAT HAS THREE SORTS AND THREE FILTERS, AND THE REASON IS THE DATE
// ===========================================================================
// The five Phase 2 lists each sort by a name and a timestamp. This one sorts
// by WHEN THE EVENT IS, which is the question every other question about an
// event hangs off, and it is the default. `venues-list.ts` is the file to read
// beside this one for what `notNull` is for; this file's own interesting
// absence is `ends_at`, below.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` for the "Mine" filter and the RLS record-scope term; it is
 * in the covering indexes' INCLUDE list and it is not rendered.
 *
 * `ticket_link`, `notes` and `location` are deliberately absent:
 *
 *   `ticket_link` is the column a page turns into an `href`, and it belongs on
 *   the detail page behind `safeHref()` (lib/crm/urls.ts). 20260901000000's
 *   `events_ticket_link_is_http` CHECK is described in that migration as
 *   "DEFENCE IN DEPTH, NOT THE CONTROL" precisely because it does not run on
 *   render -- so a list cell that linked it would be leaning on the guard that
 *   file says not to lean on.
 *
 *   `notes` is unbounded free text -- a paragraph, not a table cell. Selecting
 *   it would put a kilobyte per row on the wire for something no column shows,
 *   which is the same trade `venues-list.ts` makes over `technical_info`.
 *
 *   `location` FITS -- it is the short "TBC, south London" string, and on the
 *   venues list its equivalent IS a column. It is absent here because this
 *   list already carries a Venue column, and two place columns side by side
 *   (one a record, one free text, usually only one of them filled in) is a
 *   table that has to be explained. The detail page shows both.
 *
 * `venue_id` and NOT a venue name: see `loadVenueNames` in lib/crm/queries.ts
 * for why this is a second query rather than a PostgREST embed.
 */
export const EVENT_SELECT =
  "id, name, starts_at, ends_at, status, event_type, venue_id, owner_user_id, updated_at";

/**
 * One mapped row of the live list.
 *
 * A FAITHFUL PROJECTION OF `EVENT_SELECT`, INCLUDING THE TWO FIELDS NO COLUMN
 * RENDERS. `endsAt` and `eventType` have no consumer until Task 4's detail page
 * (and `TYPE_LABELS` has none either, for the same reason). They are kept
 * because `EVENT_SELECT` is the brief's literal and carries both columns
 * regardless: dropping them from this interface would not take a byte off the
 * wire, and it would leave the row type and the select list as two shapes a
 * reader has to diff. Flagged in fix round 1 (review Minor 4) and kept
 * deliberately rather than silently.
 */
export interface EventRow {
  id: string;
  name: string;
  startsAt: string;
  /** Nullable, and the reason it is not a sort. See the sort block below. */
  endsAt: string | null;
  status: EventStatus;
  /** Rendered by Task 4's detail page, through `TYPE_LABELS`. */
  eventType: EventType;
  venueId: string | null;
  updatedAt: string;
}

/**
 * One raw `events` row, as `EventRow`.
 *
 * EXTRACTED FROM THE EVENTS LIST PAGE BY PHASE 3 TASK 7, which added two more
 * readers of the same select list (`loadEventsForVenue` and
 * `loadEventsForArtist`, lib/crm/queries.ts). Three copies of one mapper over
 * one literal is three chances for a column to be added to `EVENT_SELECT` and
 * read back in only two of them -- and `tests/unit/crm/events-list.test.ts`
 * § EVENT_SELECT guards the literal, not its readers. It lives beside the row
 * type for the reason `mapLineupRow` lives beside `LineupRow`.
 */
export function mapEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: String(row.id),
    name: String(row.name),
    startsAt: String(row.starts_at),
    endsAt: (row.ends_at as string | null) ?? null,
    status: row.status as EventStatus,
    eventType: row.event_type as EventType,
    venueId: (row.venue_id as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

export const EVENT_LIST = defineListSpec({
  entity: "events",
  noun: { one: "event", many: "events" },

  searchColumn: "name",
  searchLabel: "Search by name",

  sort: {
    starts: {
      column: "starts_at",
      label: "Date",
      // LATEST FIRST, not earliest. An events list opened cold should show the
      // most recent thing that happened or is about to, not a club night from
      // 2019 -- the same argument every `updated_at` sort in this codebase
      // makes, applied to the column that is actually about time.
      defaultDirection: "desc",
      // NOT "A-Z"/"Z-A". lib/list/spec.ts's `directionLabels` exists because
      // the first browser pass produced "sorted by updated (Z-A)" for a date
      // column, and a reader then has to work out which end is newest.
      directionLabels: { asc: "earliest first", desc: "latest first" },
      // NOT NULL by declaration. 20260901000000's column comment states the
      // reason in the migration itself: it "is the events list's default sort
      // column, and a nullable sort column makes keyset ordering non-total. An
      // undated event is a draft with a placeholder date instead."
      notNull: true,
      backedBy: "events_org_starts_at_id_live_idx",
    },
    name: {
      column: "name",
      label: "Name",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      // NOT NULL, with a non-blank CHECK on top of it.
      notNull: true,
      backedBy: "events_org_name_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "events_org_updated_at_id_live_idx",
    },
    // NOT `ends_at`, AND IT IS THE TEMPTING ONE HERE the way `capacity` is on
    // venues. "When does it finish" is a real question and the column is
    // NULLABLE on purpose (20260901000000: "an event with no announced finish
    // is ordinary"). Keyset pagination compares `(ends_at, id)` against the
    // last row of the previous page, every comparison against NULL is NULL,
    // and `order by` puts the NULLs in one contiguous block -- so every event
    // whose finish time nobody has announced would drop out of the middle of
    // the list, silently, with a 200 and the right-looking number of rows.
    // See lib/list/spec.ts's `notNull`.
    //
    // NOT `status`: it is NOT NULL and it has no index of the required shape,
    // so `backedBy` would have nowhere honest to point -- and a text sort over
    // eight values is eight big alphabetical blocks, which is what the status
    // FILTER below is for instead.
    //
    // NOT `venue_id`: sorting by a uuid is meaningless, and sorting by venue
    // NAME needs a join a keyset page cannot carry -- the cursor holds one
    // column's value from THIS table.
    //
    // NOT `created_at`: no index, same reason as venues.
  },
  defaultSort: "starts",

  filters: {
    // THE DEFAULT IS `all`, AND THAT IS THE DELIBERATE PART.
    //
    // "Upcoming" is the obvious default and it is the wrong one. `isNarrowed`
    // (lib/list/params.ts) reports a narrowing only when a filter is away from
    // its FIRST choice, so an `upcoming` default would render the UN-narrowed
    // empty state -- "No events yet", with an "Add the first event" button --
    // over a workspace full of past events. That is not hypothetical: Phase 2
    // Task 3 shipped exactly that failure and a browser found it, "No contacts
    // yet" on a 71-contact workspace. lib/list/spec.ts's `FilterDefinition`
    // states it as a rule: "The first choice is the default and MUST be the
    // one that filters nothing."
    when: {
      label: "When",
      choices: [
        { value: "all", label: "All dates" },
        { value: "upcoming", label: "Upcoming" },
        { value: "past", label: "Past" },
      ],
    },
    // ONE CHOICE PER STATUS, GENERATED FROM `EVENT_STATUSES` rather than typed
    // out. Eight hand-written entries is eight chances for the filter to drift
    // from the CHECK constraint, and tests/unit/crm/events-list.test.ts asserts
    // this list equals EVENT_STATUSES exactly, in order -- so the generation is
    // load-bearing and checked, not a convenience.
    //
    // The order is EVENT_STATUSES' order, which is the migration's order, which
    // runs roughly draft -> live -> finished. A filter read in lifecycle order
    // reads as a lifecycle.
    status: {
      label: "Status",
      choices: [
        { value: "any", label: "Any status" },
        ...EVENT_STATUSES.map((status) => ({
          value: status,
          label: STATUS_LABELS[status],
        })),
      ],
    },
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type EventSortKey = keyof (typeof EVENT_LIST)["sort"];
export type EventFilterKey = keyof (typeof EVENT_LIST)["filters"];

/**
 * The restore view's spec. See lib/crm/artists-list.ts's copy of this note.
 *
 * Restoring an event matters beyond the event: `event_lineup` hangs off it,
 * and Phase 3 Task 2's policies leave a lineup row unreachable while its
 * parent event is soft-deleted. A deleted event is a deleted bill, not just a
 * deleted date.
 */
export const EVENT_DELETED_LIST = defineListSpec({
  entity: "events-deleted",
  noun: { one: "deleted event", many: "deleted events" },
  searchColumn: "name",
  searchLabel: "Search deleted events by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      // TRUE OF THE ROWS THIS LIST READS, not of the column. `deleted_at` IS
      // nullable; `events_org_deleted_at_id_idx` is partial on
      // `deleted_at is not null` and lib/list/query.ts's `scope: "deleted"`
      // writes that predicate on every query, so no row this sort can reach
      // has a NULL in it. Same trade as the other five restore views.
      notNull: true,
      backedBy: "events_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const EVENT_DELETED_SELECT =
  "id, name, starts_at, status, owner_user_id, deleted_at";

export interface DeletedEventRow {
  id: string;
  name: string;
  startsAt: string;
  status: EventStatus;
  deletedAt: string;
}

export type EventDeletedSortKey = keyof (typeof EVENT_DELETED_LIST)["sort"];
export type EventDeletedFilterKey = keyof (typeof EVENT_DELETED_LIST)["filters"];

// ===========================================================================
// TASK 7: THE TWO DERIVED SURFACES -- "EVENTS HERE" AND "EVENT HISTORY"
// ===========================================================================
// PRD § 6.4 asks a venue for its event history and § 6.3 asks an artist for
// theirs. Both are the SAME TABLE as EVENT_LIST above, read from a different
// record's page, and both are therefore derived specs rather than a second
// query shape: one sort (`starts`, the same column and the same index), no
// filters, no toolbar.
//
// WHY NOT REUSE `EVENT_LIST` ITSELF, which is the obvious move:
//
//   1. IT HAS NO `paramPrefix`, and it must not grow one -- `/events` is the
//      list page, its query string is `?sort=&dir=&after=` and namespacing it
//      would break every link anybody has bookmarked. A detail page carrying
//      two or three list surfaces needs its own namespace per surface
//      (lib/list/spec.ts's `paramPrefix`), so the derived surfaces are
//      separate spec objects.
//   2. ITS THREE FILTERS WOULD BE INERT. `when`, `status` and `owner` are
//      rendered by `ListToolbar`, and there is no toolbar on a detail page --
//      so on this surface they would be reachable only by hand-editing a URL,
//      with nothing on screen saying the panel was narrowed.
//   3. ITS `name` AND `updated` SORTS WOULD BE INERT TOO. A sortable column
//      header is a link; three of them on a five-row panel inside a record
//      page is noise. One sort, and the count line says which it is.
//
// THE PREFIXES ARE THE LOAD-BEARING FIELD, and the failure they close is the
// one lib/crm/activity.ts's header documents in full: two lists reading one
// `after` hand each other's cursor, and the symptom is either a PostgREST 400
// rendered as "we couldn't load" on a page where nothing is wrong, or -- worse
// -- a silent return to page one. The ARTIST page is now the most exposed
// route in the product: three lib/list/ surfaces on it (the fee history, this
// one, and the timeline). tests/unit/crm/events-list.test.ts § the prefix set
// asserts the WHOLE set with its cardinality, which is the denominator.
//
// NEITHER SURFACE SORTS BY `name` OR `updated`, so neither needs those two
// indexes; both name `events_org_starts_at_id_live_idx`, which is the index
// `fetchListPage`'s ORDER BY and keyset range actually use. See the note on
// each spec's `backedBy` for what the EQUALITY column costs, which is the
// honest part.

/**
 * The events at one venue. PRD § 6.4's "event history" for a venue.
 *
 * `applyFilters` pins `venue_id` -- see `loadEventsForVenue` in
 * lib/crm/queries.ts. That is an ordinary second equality column, exactly like
 * `ARTIST_FEE_LIST`'s `artist_id`, and it is why this surface is a filter on
 * `events` while the artist's is not.
 */
export const VENUE_EVENTS_LIST = defineListSpec({
  entity: "venue-events",
  noun: { one: "event", many: "events" },
  // A REAL COLUMN, AND NO SEARCH CONTROL -- the same trade LINEUP_LIST and
  // ACTIVITY_LIST make. `spec.searchColumn` reaches PostgREST the moment
  // `params.q !== ""`, so a placeholder here is a 400 waiting for whoever
  // removes the guard; `venueEventsParams()` below is the guard.
  searchColumn: "name",
  searchLabel: "Search events by name",
  sort: {
    starts: {
      column: "starts_at",
      label: "Date",
      // LATEST FIRST, as on the events list. A venue page opened cold should
      // show the most recent night at this room, not one from 2019.
      defaultDirection: "desc",
      directionLabels: { asc: "earliest first", desc: "latest first" },
      // NOT NULL by declaration (20260901000000). Same reason as EVENT_LIST's.
      notNull: true,
      // THE SORT AND THE KEYSET RANGE ARE COVERED; THE EQUALITY IS NOT, and
      // saying so is the point of this field being required. The index is
      // (organisation_id, starts_at, id) WHERE deleted_at is null, so the
      // ORDER BY and the `(starts_at, id) >= cursor` range are index
      // conditions and `venue_id = $1` is a filter applied over that range.
      // Cost is therefore O(events in the tenant between the cursor and the
      // page's worth of this venue's) rather than O(page) -- fine for a venue
      // holding a normal share of a workspace's events, and NOT fine for a
      // workspace where one venue holds 1% of the nights. The real fix is an
      // index of the shape (organisation_id, venue_id, starts_at, id) WHERE
      // deleted_at is null; it is a migration, this task ships none, and it is
      // in FOLLOW-UPS.md rather than asserted here as though it existed.
      // `events_venue_id_org_idx` (20260901000000) exists and leads on
      // venue_id, so it cannot serve the ordering -- naming it here would be
      // the dishonest choice.
      backedBy: "events_org_starts_at_id_live_idx",
    },
  },
  defaultSort: "starts",
  filters: {},
  paramPrefix: "venueevents_",
});

export type VenueEventsSortKey = keyof (typeof VENUE_EVENTS_LIST)["sort"];
export type VenueEventsFilterKey = keyof (typeof VENUE_EVENTS_LIST)["filters"];

/**
 * The events an artist is on. PRD § 6.3's "booking/event history".
 *
 * NOT A FILTER ON `events`. The relation is `event_lineup`, and
 * `fetchListPage` reads ONE relation -- see `loadEventsForArtist` in
 * lib/crm/queries.ts for the two-step read this forces and for the cap it
 * carries.
 */
export const ARTIST_EVENTS_LIST = defineListSpec({
  entity: "artist-events",
  noun: { one: "event", many: "events" },
  searchColumn: "name",
  searchLabel: "Search events by name",
  sort: {
    starts: {
      column: "starts_at",
      label: "Date",
      defaultDirection: "desc",
      directionLabels: { asc: "earliest first", desc: "latest first" },
      notNull: true,
      // SAME INDEX, AND HERE THE EQUALITY IS AN `id IN (...)` OF AT MOST 50
      // uuids RATHER THAN A COLUMN -- which is a primary-key membership test,
      // so the planner has the option of the primary key instead. Either way
      // the ordering and the keyset range come from this index and the
      // candidate set is bounded to one page's worth before the query is
      // built. See `loadEventsForArtist`.
      backedBy: "events_org_starts_at_id_live_idx",
    },
  },
  defaultSort: "starts",
  filters: {},
  paramPrefix: "artistevents_",
});

export type ArtistEventsSortKey = keyof (typeof ARTIST_EVENTS_LIST)["sort"];
export type ArtistEventsFilterKey = keyof (typeof ARTIST_EVENTS_LIST)["filters"];

/**
 * The two query-string keys these surfaces refuse to honour.
 *
 * Each is its spec's `paramPrefix` + the search key, written out rather than
 * built from the spec so that renaming a prefix without renaming this is a
 * mismatch a reader can see instead of a guard that silently stops guarding.
 * `tests/unit/crm/events-list.test.ts` asserts both against their specs.
 */
export const VENUE_EVENTS_SEARCH_PARAM = "venueevents_q";
export const ARTIST_EVENTS_SEARCH_PARAM = "artistevents_q";

/**
 * Each surface's parameters, out of the detail page's whole query string.
 *
 * THE WHOLE OBJECT IS SAFE TO PASS, because the spec's `paramPrefix` means
 * `parseListParams` only ever reads keys beginning with it. The timeline's
 * `activity_after`, the fee history's bare `after` and anything a later phase
 * adds to these routes are invisible to them.
 *
 * ===========================================================================
 * EXCEPT THE `q` KEY, WHICH IS DROPPED -- `lineupParams()`'s REASON EXACTLY
 * ===========================================================================
 * Each spec declares a `searchColumn` because it must (a spec naming a column
 * that does not exist is a PostgREST 400), and neither surface renders a
 * search control -- there is no `ListToolbar` on a detail page. So
 * `?venueevents_q=zzz` in a hand-edited or pasted URL would narrow the panel
 * through `ilike(name, ...)` with nothing on screen offering to clear it.
 *
 * `EntityList` would at least render its NARROWED empty state here rather than
 * the lie the lineup panel would have told ("No lineup yet" on a full bill),
 * so this is the milder version of that defect. It is still refused, for two
 * reasons: the narrowed state's "Clear search and filters" link is `basePath`
 * bare, which on a three-list page would also return the other two surfaces to
 * page one; and a surface with no search control should not be searchable by
 * URL at all. Refusing is one line; honouring it is a control this panel is
 * not getting.
 */
export function venueEventsParams(
  raw: RawSearchParams,
): ListParams<VenueEventsSortKey, VenueEventsFilterKey> {
  return parseListParams(VENUE_EVENTS_LIST, {
    ...raw,
    [VENUE_EVENTS_SEARCH_PARAM]: undefined,
  });
}

export function artistEventsParams(
  raw: RawSearchParams,
): ListParams<ArtistEventsSortKey, ArtistEventsFilterKey> {
  return parseListParams(ARTIST_EVENTS_LIST, {
    ...raw,
    [ARTIST_EVENTS_SEARCH_PARAM]: undefined,
  });
}
