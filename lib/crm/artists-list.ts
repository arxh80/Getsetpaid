import { defineListSpec } from "@/lib/list/spec";

// The Artists list specification, plus the artist fee-history panel's.
//
// THE COPYABILITY TEST, ROUND TWO. Task 4's report claimed the list shape
// copies "with no change to lib/list/ or components/list/". This file, and its
// agency and venue siblings, are what tests that claim -- they are
// lib/crm/contacts-list.ts with the nouns, the columns and the index names
// changed, and nothing in lib/list/spec.ts, lib/list/params.ts,
// lib/list/query.ts or components/list/ moved to accommodate any of them.
//
// The two required fields did their job again. `backedBy` had nowhere honest
// to point until 20260829000000 created the indexes, and `notNull` ruled out
// the two sorts an artists list invites and cannot have.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * `owner_user_id` for the same two reasons as contacts: the "Mine" filter and
 * the RLS record-scope term both key on it, and it is in the covering index's
 * INCLUDE list so selecting it is free. It is NOT rendered.
 *
 * ===========================================================================
 * `genres` IS SELECTED WHERE `contacts.tags` IS NOT, AND THAT IS A DECISION
 * ===========================================================================
 * lib/crm/contacts-list.ts leaves `tags` and `socials` out and gives one
 * reason for both: "a list that does not select them cannot be the surface
 * that renders a `javascript:` URL". That reason is exactly right for
 * `socials` and `website`, which are the columns a page turns into an
 * `href` -- and both are absent here for it.
 *
 * It does not apply to `genres`. A genre is never rendered as a link; it is
 * rendered as a text chip, the same way `companies.type` is, and the same way
 * `tags` is on the contact DETAIL page (which does select it). What makes a
 * column dangerous is the anchor, not the fact that a user typed it -- this
 * list already renders `name`, `country` and `city`, which are free text too.
 *
 * And it earns its place: "which of our artists play techno" is the question
 * an artists list exists to answer, and answering it from the detail page one
 * record at a time is not answering it. The cap is in lib/crm/validate.ts
 * (25 genres, 40 characters each), so a pasted paragraph cannot become a row
 * of chips wider than the table.
 */
export const ARTIST_SELECT =
  "id, name, genres, country, city, owner_user_id, updated_at";

export interface ArtistRow {
  id: string;
  name: string;
  genres: string[];
  country: string | null;
  city: string | null;
  updatedAt: string;
}

export const ARTIST_LIST = defineListSpec({
  entity: "artists",
  noun: { one: "artist", many: "artists" },

  // `name` for the same reason contacts and companies search `name`: it is the
  // identity of the record and the only NOT NULL free-text column on the
  // table. Search is a sequential scan of the tenant either way
  // (lib/list/query.ts, "SEARCH IS O(TENANT)"), so the column has to be worth
  // that, and this one is.
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
      backedBy: "artists_org_name_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      // Not "Z–A". A date column read as an alphabet is a line the reader has
      // to decode rather than read -- see SortOption.directionLabels.
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL and trigger-maintained since 20260828121500, so a client
      // cannot PATCH itself to the top of a colleague's list.
      notNull: true,
      backedBy: "artists_org_updated_at_id_live_idx",
    },
    // NOT `country` and NOT `city`. Both are the obvious third sort for an
    // artist roster and both are NULLABLE, which silently breaks keyset
    // pagination -- every comparison against NULL is NULL, so a contiguous
    // band of rows drops out of the middle of the list and nothing errors.
    // See lib/list/spec.ts's `notNull`. NOT `genres` either: it is a text[],
    // and "sorted by genre" is not a request anyone makes of a multi-valued
    // column. NOT `created_at`: no index, so `backedBy` would have nowhere
    // honest to point.
  },
  defaultSort: "name",

  filters: {
    owner: {
      label: "Owner",
      choices: [
        // The first choice must be the one that filters nothing, or the count
        // line above the table stops being a true statement about the
        // workspace's records.
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type ArtistSortKey = keyof (typeof ARTIST_LIST)["sort"];
export type ArtistFilterKey = keyof (typeof ARTIST_LIST)["filters"];

/**
 * The restore view's spec. Its own spec, not a mode of the one above.
 *
 * ONE SORT, and it is a different column with a different index -- the live
 * list's two indexes are partial on `deleted_at is null`, so neither can serve
 * a query for deleted rows, and naming them here would make `backedBy` a lie
 * of exactly the kind that field exists to prevent.
 *
 * `notNull: true` on `deleted_at` is true OF THE ROWS THIS LIST READS and not
 * of the column, because `scope: "deleted"` constrains it to `not null` and
 * `artists_org_deleted_at_id_idx` is partial on the same predicate. Keyset
 * pagination over a genuinely nullable column drops a silent band of rows, so
 * it is said out loud rather than left to be rediscovered.
 *
 * NO FILTERS. "Mine" on a restore queue is a question nobody asks, and every
 * filter is a control someone has to maintain forever.
 */
export const ARTIST_DELETED_LIST = defineListSpec({
  entity: "artists-deleted",
  noun: { one: "deleted artist", many: "deleted artists" },
  searchColumn: "name",
  searchLabel: "Search deleted artists by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "artists_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const ARTIST_DELETED_SELECT =
  "id, name, country, city, owner_user_id, deleted_at";

export interface DeletedArtistRow {
  id: string;
  name: string;
  country: string | null;
  city: string | null;
  deletedAt: string;
}

export type ArtistDeletedSortKey = keyof (typeof ARTIST_DELETED_LIST)["sort"];
export type ArtistDeletedFilterKey = keyof (typeof ARTIST_DELETED_LIST)["filters"];

// ---------------------------------------------------------------------------
// The fee-history panel
// ---------------------------------------------------------------------------

/**
 * Fee history on an artist detail page: a paginated list, not a panel with a
 * cap.
 *
 * ===========================================================================
 * WHY IT GOES THROUGH lib/list/ AND THE JOIN PANELS DO NOT
 * ===========================================================================
 * `LINK_PANEL_LIMIT` (lib/crm/queries.ts) satisfies CLAUDE.md's
 * "paginate everything" with a cap rather than with a design, and
 * FOLLOW-UPS.md records that as a deliberate stopgap. A cap is defensible for
 * a join panel because a contact linked to more than 100 companies is not a
 * real record.
 *
 * Fee history is different in kind: it GROWS, for ever, by one row per booking
 * -- PRD 6.3 wants it "by booking/date/currency rather than a single mutable
 * number", and 7-year financial retention (CLAUDE.md § Non-negotiable rules)
 * means a busy artist accumulates hundreds of rows the product must not stop
 * showing. So the honest surface is keyset pagination, and keyset pagination
 * on this table needs its own index -- which is why
 * `artist_fee_history_org_artist_occurred_on_id_live_idx` exists.
 *
 * ===========================================================================
 * READ ONLY IN THIS TASK
 * ===========================================================================
 * There is no create or edit form for a fee, deliberately. Finance is Phase 5
 * and MVP finance is budget and actuals at EVENT level (CLAUDE.md § Scope
 * discipline); a free-standing "add a fee" form here would be building ahead
 * into Phase 5's data model, and `artist_fee_history.event_id` is currently
 * held NULL by `artist_fee_history_event_id_unwritable_until_phase_3` --
 * verified in the catalogue, not assumed -- so a fee entered here could not be
 * attached to the booking it came from anyway. Queued as a decision in the
 * task report rather than guessed at.
 *
 * ===========================================================================
 * ONE PAGINATED LIST PER PAGE, AND THIS IS THE ARTIST PAGE'S
 * ===========================================================================
 * lib/list/params.ts owns the query-string keys `q`, `sort`, `dir`, `size`,
 * `after` and `before` unconditionally -- they are not namespaced per list. So
 * an artist detail page may carry exactly one lib/list/ surface, and this is
 * it. A second one on the same route would share its cursor with this one and
 * page both lists at once. Recorded here because the next person to add a
 * paginated panel to a detail page will not otherwise find out until the
 * browser.
 */
export const ARTIST_FEE_LIST = defineListSpec({
  entity: "artist-fees",
  noun: { one: "fee", many: "fees" },
  // `note` is the only free-text column on the row. It is nullable, which is
  // fine for SEARCH (an ILIKE against NULL is NULL, so a null note simply does
  // not match) and would NOT be fine for a sort -- see the `sort` block.
  searchColumn: "note",
  searchLabel: "Search fee notes",
  sort: {
    occurred: {
      column: "occurred_on",
      label: "Date",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      // NOT NULL in the table definition itself, unlike the `deleted_at` sorts
      // above whose `notNull` leans on a partial index predicate.
      notNull: true,
      backedBy: "artist_fee_history_org_artist_occurred_on_id_live_idx",
    },
    // NOT `amount_minor`. It is NOT NULL and it would be the obvious second
    // sort -- and there is no index of the required shape for it, so
    // `backedBy` would have nowhere honest to point. Adding the sort and
    // deferring the index is the one move that makes that field pointless.
  },
  defaultSort: "occurred",
  filters: {},
});

export const ARTIST_FEE_SELECT =
  "id, occurred_on, currency, amount_minor, note";

export interface ArtistFeeRow {
  id: string;
  occurredOn: string;
  currency: string;
  /** Minor units, as stored. Formatted at the edge, never summed here. */
  amountMinor: number;
  note: string | null;
}

export type ArtistFeeSortKey = keyof (typeof ARTIST_FEE_LIST)["sort"];
export type ArtistFeeFilterKey = keyof (typeof ARTIST_FEE_LIST)["filters"];

/**
 * A stored fee as money.
 *
 * MINOR UNITS IN, A STRING OUT, AND NO ARITHMETIC IN BETWEEN beyond the single
 * division `Intl` needs. CLAUDE.md § Non-functional targets: "GBP only at MVP;
 * `financial_entries` and related tables store a currency column and use minor
 * units so multi-currency UI can be added later without a schema migration."
 * So the currency comes off the ROW, not from a constant -- the schema is
 * already multi-currency and hardcoding "£" here is the thing that would need
 * finding again later.
 *
 * The `try` is not defensive padding. `artist_fee_history.currency` is checked
 * for SHAPE only (`~ '^[A-Z]{3}$'`, deliberately not an ISO 4217 allowlist --
 * an allowlist is a lookup table this phase has not built), so 'ZZZ' is a
 * legal stored value and `Intl.NumberFormat` throws a RangeError on it. A
 * thrown formatter on a detail page is a 500 for a row that is merely odd.
 */
export function formatFee(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    // Honest fallback: the number, with the code the row actually carries.
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
