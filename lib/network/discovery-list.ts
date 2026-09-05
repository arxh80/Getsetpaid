import { defineListSpec } from "@/lib/list/spec";
import {
  NETWORK_ENTITY_KINDS,
  NETWORK_ENTITY_KIND_LABELS,
  type NetworkEntityKind,
} from "@/lib/network/fields";

// The network directory's list specification. Consumed by Task 3.
//
// ===========================================================================
// THE ONE LIST IN THE PRODUCT THAT IS NOT ORGANISATION-SCOPED
// ===========================================================================
// Every other list in this codebase asks "what does THIS TENANT have"; this one
// asks "what has EVERYONE published". That single fact drives three things that
// otherwise read as mistakes, and each is stated where it lands:
//
//   1. THE SOURCE IS A VIEW, NOT A TABLE. `entity` and every query built from
//      this spec read public.network_directory -- the masking view -- and NEVER
//      public.network_profiles. That is Constraint 19's network case verbatim:
//      shipping the view while the discovery page read the base table would
//      pass every structural assertion ABOUT the view and leak anyway, because
//      the base table's directory SELECT policy deliberately does not constrain
//      which COLUMNS are legible (20260904003000).
//   2. THE COVERING INDEX LEADS WITH THE PUBLISHED-STATE PREDICATE, not with
//      organisation_id -- the Constraint 9 deviation, restated on `backedBy`
//      below and in the index's own comment in 20260904000000.
//   3. THE PAGE CEILING PROTECTS THE PLATFORM, NOT A TENANT. CLAUDE.md
//      § Non-negotiable rules ("Paginate everything") is carried by
//      lib/list/query.ts's server-side ceiling for every spec; here it is the
//      one list whose unbounded form would scan every published profile of
//      every customer, so it is not optional and it is not settable from the
//      client. Nothing in this file can raise it.

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * ELEVEN COLUMNS -- THE WHOLE VIEW, AND THAT IS THE POINT. There is no column
 * of public.network_directory a discovery result should not carry, because the
 * view was built to project exactly what is safe to show: id, entity_kind and
 * display_name (always visible, Q71), the seven publishable fields already
 * masked to their `network` level, and published_at. Selecting `*` would be
 * equivalent TODAY and is deliberately not written, so that a column added to
 * the view later is an explicit decision here rather than something the
 * directory page starts rendering on its own.
 *
 * `organisation_id` and `entity_id` are ABSENT because the view does not
 * project them -- asking PostgREST for either is a 400, which the HTTP suite
 * asserts. Task 3's UI therefore has no tenant id to leak, whatever it renders.
 */
export const NETWORK_DIRECTORY_SELECT =
  "id, entity_kind, display_name, headline, bio, city, region, country, website_url, contact_email, published_at";

/**
 * One mapped row of the directory.
 *
 * A FAITHFUL PROJECTION OF `NETWORK_DIRECTORY_SELECT`. Every field but the
 * first three is `string | null`, and the NULL is not an absence of data -- it
 * is a field the publisher did not publish at this level. Task 3 renders those
 * as omitted rows, never as "—" against a label, because a blank beside
 * "Contact email" reads as "they have none" rather than "they have not shared
 * one".
 */
export interface NetworkDirectoryRow {
  id: string;
  entityKind: NetworkEntityKind;
  displayName: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  publishedAt: string | null;
}

/**
 * One raw `network_directory` row, as `NetworkDirectoryRow`.
 *
 * Lives beside the row type for the reason `mapFinancialEntryRow` does: the
 * directory page and any later reader (a connected-profile detail panel, which
 * reads the sibling view with the same eleven columns) share one mapper over
 * one literal, so a column added to the select is read back everywhere or the
 * type stops compiling.
 */
export function mapNetworkDirectoryRow(
  row: Record<string, unknown>,
): NetworkDirectoryRow {
  return {
    id: String(row.id),
    entityKind: row.entity_kind as NetworkEntityKind,
    displayName: String(row.display_name),
    headline: (row.headline as string | null) ?? null,
    bio: (row.bio as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    websiteUrl: (row.website_url as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    publishedAt: (row.published_at as string | null) ?? null,
  };
}

export const NETWORK_DIRECTORY_LIST = defineListSpec({
  entity: "network-directory",
  noun: { one: "profile", many: "profiles" },

  // `display_name` is the one column a person searches a directory by. Search
  // is O(published) rather than O(tenant) here -- the only list in the product
  // where that denominator is the whole platform -- and lib/list/spec.ts
  // records why ILIKE cannot be an Index Cond under RLS. The page ceiling is
  // what keeps that bounded; see the header.
  searchColumn: "display_name",
  searchLabel: "Search the network by name",

  sort: {
    name: {
      column: "display_name",
      label: "Name",
      // A-Z. A directory opened cold is a thing you SCAN, not a feed you read
      // newest-first -- which is why this is the one list in the codebase whose
      // default sort is ascending and alphabetical rather than a date desc.
      defaultDirection: "asc",
      directionLabels: { asc: "A to Z", desc: "Z to A" },
      // NOT NULL by declaration. `network_profiles.display_name` is NOT NULL
      // (20260904000000) -- a profile with no name is not a discoverable
      // identity, so there is nothing to publish -- and the view projects it
      // unconditionally. A nullable sort column silently drops a contiguous
      // band of rows out of the middle of a keyset page with a 200 and the
      // right-looking count (Constraint 9).
      notNull: true,
      // COVERED, AND THE INDEX LEADS WITH `status`, NOT `organisation_id`.
      // THE DOCUMENTED CONSTRAINT 9 DEVIATION: the index is
      // (status, display_name, id) INCLUDE (entity_kind, city, country) WHERE
      // deleted_at is null. Discovery is NOT organisation-scoped -- it is the
      // one list in the product that spans every tenant -- so a tenant-led
      // index would never be used by a query whose WHERE clause never names an
      // organisation. Stated here AND in the index's own comment in
      // 20260904000000, or a reviewer reads it as an omission (the
      // financial_entries `include (event_id)` precedent).
      backedBy: "network_profiles_directory_idx",
    },
  },
  defaultSort: "name",

  filters: {
    // ONE CHOICE PER KIND, GENERATED FROM `NETWORK_ENTITY_KINDS` rather than
    // typed out, so the filter cannot drift from the CHECK constraint. The
    // FIRST choice ("Any") is the default and filters nothing (lib/list/spec.ts
    // FilterDefinition rule -- otherwise the un-narrowed empty state renders
    // over a filtered list).
    kind: {
      label: "Type",
      choices: [
        { value: "any", label: "Any type" },
        ...NETWORK_ENTITY_KINDS.map((kind) => ({
          value: kind,
          label: NETWORK_ENTITY_KIND_LABELS[kind],
        })),
      ],
    },
  },

  // NAMESPACED FROM THE START, unlike the finance list which was bare until it
  // landed beside other lists. Task 3's discovery page carries the directory
  // AND the caller's own connection-request list, and Constraint 10 is that two
  // paginated lists on one page drop each other's state unless the page says
  // otherwise -- without a distinct prefix both would read the same `after`.
  // Chosen before the second list exists, because retrofitting a prefix
  // silently invalidates every bookmarked URL.
  paramPrefix: "net_",
});

export type NetworkDirectorySortKey =
  keyof (typeof NETWORK_DIRECTORY_LIST)["sort"];
export type NetworkDirectoryFilterKey =
  keyof (typeof NETWORK_DIRECTORY_LIST)["filters"];
