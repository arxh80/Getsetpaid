import { defineListSpec } from "@/lib/list/spec";

// The Agencies list specification.
//
// THE THINNEST OF THE FIVE, AND THAT IS THE SCHEMA'S DOING RATHER THAN A
// SHORTCUT. `public.agencies` is NAME ONLY: 20260827232510 says the PRD gives
// agencies no fields beyond identity and invents none, and "anything an agency
// needs later (address, contacts, socials) arrives as an additive migration
// when a screen actually needs it". So there is one renderable column plus
// `updated_at`, no filters worth having beyond Owner, and no protocol-bearing
// column at all -- no `website`, no `socials`.
//
// What an agency page is FOR is the other side of artist_representations: who
// this agency represents. That is a panel on the detail page, not a column
// here, because it is a join and joins do not fit in a table cell.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` for the same two reasons as every other list: the "Mine"
 * filter and the RLS record-scope term both key on it, and it is in the
 * covering index's INCLUDE list so selecting it is free. It is NOT rendered --
 * showing which colleague owns a record is a members-directory question.
 */
export const AGENCY_SELECT = "id, name, owner_user_id, updated_at";

export interface AgencyRow {
  id: string;
  name: string;
  updatedAt: string;
}

export const AGENCY_LIST = defineListSpec({
  entity: "agencies",
  noun: { one: "agency", many: "agencies" },

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
      backedBy: "agencies_org_name_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "agencies_org_updated_at_id_live_idx",
    },
    // There is nothing else on this table to sort by. `created_at` exists and
    // has no index, so `backedBy` would have nowhere honest to point.
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

export type AgencySortKey = keyof (typeof AGENCY_LIST)["sort"];
export type AgencyFilterKey = keyof (typeof AGENCY_LIST)["filters"];

/**
 * The restore view's spec. See lib/crm/artists-list.ts's copy of this note for
 * the full argument: a different column, a different index, and a `notNull`
 * that is true of the rows this list reads rather than of the column.
 *
 * THE RESTORE QUEUE MATTERS MORE HERE THAN ANYWHERE ELSE IN THE PHASE.
 * 20260827232510 added `deleted_at` to this table beyond the plan's field list
 * for one concrete reason: `artist_representations` references `agencies`
 * ON DELETE CASCADE, so hard-deleting an agency that has folded would destroy
 * the representation history of every artist it ever handled. Soft delete is
 * what stops that, and a soft delete nobody can undo is a hard delete with
 * extra steps.
 */
export const AGENCY_DELETED_LIST = defineListSpec({
  entity: "agencies-deleted",
  noun: { one: "deleted agency", many: "deleted agencies" },
  searchColumn: "name",
  searchLabel: "Search deleted agencies by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "agencies_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const AGENCY_DELETED_SELECT = "id, name, owner_user_id, deleted_at";

export interface DeletedAgencyRow {
  id: string;
  name: string;
  deletedAt: string;
}

export type AgencyDeletedSortKey = keyof (typeof AGENCY_DELETED_LIST)["sort"];
export type AgencyDeletedFilterKey = keyof (typeof AGENCY_DELETED_LIST)["filters"];
