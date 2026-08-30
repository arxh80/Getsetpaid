import { defineListSpec } from "@/lib/list/spec";
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

export interface EventRow {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  status: EventStatus;
  eventType: EventType;
  venueId: string | null;
  updatedAt: string;
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
