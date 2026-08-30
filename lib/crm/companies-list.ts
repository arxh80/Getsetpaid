import { defineListSpec } from "@/lib/list/spec";

// The Companies list specification.
//
// THIS FILE IS THE COPYABILITY TEST FOR TASK 3'S SHAPE, and it passed: it is
// lib/crm/contacts-list.ts with the nouns, the columns and one filter's
// contents changed, and nothing in lib/list/spec.ts, lib/list/params.ts or
// components/list/ had to move to accommodate it. The two things that DID
// have to exist first are both named by the spec itself and both were
// missing, which is the point of them being required fields:
//
//   `backedBy`  companies had no list indexes at all. 20260828230000 adds the
//               pair, in the shape FOLLOW-UPS.md states, before this file
//               could name them.
//   `notNull`   ruled `type` out as a sort (it is an array, and ordering a
//               list by a text[] is not a thing a user means) and would have
//               ruled out anything nullable.
//
// The one change to lib/list/ that Task 4 did make -- `scope` on
// fetchListPage -- was not needed for THIS file. It was needed for the
// restore view below, which did not exist in Task 3 at all.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` for the same two reasons as contacts: the "Mine" filter and
 * the RLS record-scope term both key on it, and it is in the covering index's
 * INCLUDE list so selecting it is free.
 *
 * `type` IS selected here, where contacts deliberately omits `socials`. The
 * difference is that `companies.type` is constrained at the database to an
 * element-level allowlist (`companies_type_allowed`), so its contents are a
 * closed vocabulary rather than user text -- there is no protocol to validate
 * and no string that can reach the DOM that this schema did not already
 * approve. It is rendered as chips.
 */
export const COMPANY_SELECT =
  "id, name, type, owner_user_id, updated_at";

export interface CompanyRow {
  id: string;
  name: string;
  type: string[];
  updatedAt: string;
}

/**
 * The closed vocabulary from `companies_type_allowed`.
 *
 * Written here as the labels the UI shows, keyed by the values the CHECK
 * constraint admits. A value the constraint would reject cannot be selected in
 * the form, and a value the form does not offer is still refused by the
 * database -- 20260827232510's `type <@ array[...]` is the enforcement and
 * this is the vocabulary.
 *
 * THE EMPTY ARRAY IS VALID AND MEANS "UNTYPED". The constraint admits it
 * (`'{}' <@ anything` is true) and the schema comment calls it "a legitimate
 * half-entered record", so the form does not require a type and the list says
 * "Untyped" rather than showing a blank cell.
 */
export const COMPANY_TYPES = [
  { value: "promoter", label: "Promoter" },
  { value: "venue", label: "Venue" },
  { value: "agency", label: "Agency" },
  { value: "artist_dj_business", label: "Artist / DJ business" },
  { value: "supplier", label: "Supplier" },
  { value: "other", label: "Other" },
] as const;

const TYPE_LABELS = new Map<string, string>(
  COMPANY_TYPES.map((t) => [t.value, t.label]),
);

/** A stored type value's label, or the raw value if the vocabulary grew. */
export function companyTypeLabel(value: string): string {
  return TYPE_LABELS.get(value) ?? value;
}

export const COMPANY_LIST = defineListSpec({
  entity: "companies",
  noun: { one: "company", many: "companies" },

  // `name` for the same reason contacts search `name`: it is the identity of
  // the record and the only NOT NULL free-text column on the table. Search is
  // a sequential scan of the tenant either way (lib/list/query.ts, "SEARCH IS
  // O(TENANT)"), so the column has to be worth that, and this one is.
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
      backedBy: "companies_org_name_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL and trigger-maintained since 20260828121500, so a client
      // cannot PATCH itself to the top of a colleague's list.
      notNull: true,
      backedBy: "companies_org_updated_at_id_live_idx",
    },
    // NOT `type`: it is a text[], it is nullable in the sense that '{}' sorts
    // as its own value, and "sorted by type" is not a request anyone makes of
    // a multi-valued column. NOT `created_at`: no index, so `backedBy` would
    // have nowhere honest to point.
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

export type CompanySortKey = keyof (typeof COMPANY_LIST)["sort"];
export type CompanyFilterKey = keyof (typeof COMPANY_LIST)["filters"];

/**
 * The restore view's spec. Its own spec, not a mode of the one above.
 *
 * ONE SORT, and it is a different column with a different index. The live
 * list's two indexes are partial on `deleted_at is null`, so neither can serve
 * a query for deleted rows -- naming them here would make `backedBy` a lie of
 * exactly the kind that field exists to prevent.
 *
 * `notNull: true` on `deleted_at` is true OF THE ROWS THIS LIST READS and not
 * of the column, because `scope: "deleted"` constrains it to `not null` and
 * `companies_org_deleted_at_id_idx` is partial on the same predicate. It is
 * the one place in this codebase where that field leans on a predicate rather
 * than on the column definition, and keyset pagination over a genuinely
 * nullable column drops a silent band of rows -- so it is said out loud here
 * rather than left to be rediscovered.
 *
 * NO FILTERS. "Mine" on a restore queue is a question nobody asks, and every
 * filter is a control someone has to maintain forever.
 */
export const COMPANY_DELETED_LIST = defineListSpec({
  entity: "companies-deleted",
  noun: { one: "deleted company", many: "deleted companies" },
  searchColumn: "name",
  searchLabel: "Search deleted companies by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "companies_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const COMPANY_DELETED_SELECT = "id, name, type, owner_user_id, deleted_at";

export interface DeletedCompanyRow {
  id: string;
  name: string;
  type: string[];
  deletedAt: string;
}

export type CompanyDeletedSortKey = keyof (typeof COMPANY_DELETED_LIST)["sort"];
export type CompanyDeletedFilterKey = keyof (typeof COMPANY_DELETED_LIST)["filters"];
