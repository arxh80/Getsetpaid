import { defineListSpec } from "@/lib/list/spec";

// The Venues list specification.
//
// The clearest of the five for what `notNull` is actually for. A venues list
// wants to be sorted by CAPACITY -- "show me the 800-capacity rooms" is the
// question a promoter asks -- and `venues.capacity` is nullable by design
// (20260827232510: "capacity is frequently unknown when a venue is first
// entered, and 0 would be a lie that then renders as a real number"). So it is
// a column here and not a sort, and the reason is written down at the sort
// block rather than being an absence somebody later reads as an oversight.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` for the "Mine" filter and the RLS record-scope term; it is
 * in the covering index's INCLUDE list, so selecting it is free, and it is not
 * rendered.
 *
 * `website`, `socials` and `technical_info` are deliberately absent.
 * The first two are the columns a page turns into an `href` and belong on the
 * detail page behind `safeHref()` (lib/crm/urls.ts); the third is unbounded
 * free text -- PA specs, rigging notes, load-in instructions -- which is a
 * paragraph, not a table cell, and selecting it would put a kilobyte per row
 * on the wire for something no column can show.
 *
 * `address` is absent for the same table-cell reason; `location` is the short
 * searchable place ("Bristol", "South London") the PRD lists separately, and
 * it is the one that fits.
 */
export const VENUE_SELECT =
  "id, name, location, capacity, owner_user_id, updated_at";

export interface VenueRow {
  id: string;
  name: string;
  location: string | null;
  capacity: number | null;
  updatedAt: string;
}

export const VENUE_LIST = defineListSpec({
  entity: "venues",
  noun: { one: "venue", many: "venues" },

  searchColumn: "name",
  searchLabel: "Search by name",

  sort: {
    name: {
      column: "name",
      label: "Name",
      defaultDirection: "asc",
      directionLabels: { asc: "A–Z", desc: "Z–A" },
      // NOT NULL, with `check (btrim(name) <> '')` on top of it.
      notNull: true,
      backedBy: "venues_org_name_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "venues_org_updated_at_id_live_idx",
    },
    // NOT `capacity`, AND THIS IS THE TEMPTING ONE ON THIS TABLE.
    // "Sort by capacity" is a real question a promoter asks, and the column is
    // NULLABLE on purpose -- an unknown capacity is a real state and 0 would
    // be a lie. Keyset pagination compares `(capacity, id)` against the last
    // row of the previous page, every comparison against NULL is NULL, and
    // `order by` puts the NULLs in one contiguous block -- so every venue
    // whose capacity nobody has filled in yet would drop out of the middle of
    // the list, silently, with a 200 and the right-looking number of rows.
    // See lib/list/spec.ts's `notNull`. When this sort is worth building it
    // needs a decision about where unknown capacities go, not just an index.
    //
    // NOT `location` either: nullable, same failure. NOT `created_at`: no
    // index, so `backedBy` would have nowhere honest to point.
  },
  defaultSort: "name",

  filters: {
    owner: {
      label: "Owner",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type VenueSortKey = keyof (typeof VENUE_LIST)["sort"];
export type VenueFilterKey = keyof (typeof VENUE_LIST)["filters"];

/**
 * The restore view's spec. See lib/crm/artists-list.ts's copy of this note.
 *
 * Restoring a venue matters beyond the venue: `venue_rooms` cascades from it,
 * and as of 20260829001000 a soft-deleted venue's rooms cannot be added,
 * renamed, closed or reopened until the venue itself comes back.
 */
export const VENUE_DELETED_LIST = defineListSpec({
  entity: "venues-deleted",
  noun: { one: "deleted venue", many: "deleted venues" },
  searchColumn: "name",
  searchLabel: "Search deleted venues by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "venues_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const VENUE_DELETED_SELECT =
  "id, name, location, owner_user_id, deleted_at";

export interface DeletedVenueRow {
  id: string;
  name: string;
  location: string | null;
  deletedAt: string;
}

export type VenueDeletedSortKey = keyof (typeof VENUE_DELETED_LIST)["sort"];
export type VenueDeletedFilterKey = keyof (typeof VENUE_DELETED_LIST)["filters"];
