import "server-only";

// Task 4 / Gap B (Q73/Q82): this organisation's own network_links rows.
//
// Two jobs, and they are kept in one file because both read the same table
// the same way -- this organisation's OWN links, never a cross-tenant read,
// and the profile's owner is never told either exists (network_links' own
// header, 20260904000000/20260904003000):
//
//   1. `NETWORK_LINKS_LIST` / `loadNetworkLinksList` -- a paginated "your
//      linked records" surface, consumed by its OWN route,
//      app/(app)/[orgSlug]/network/links/page.tsx -- NOT the directory route.
//      A second list on the directory page (which already carries a
//      ListToolbar with no `preserve` option) would have reintroduced
//      Constraint 10's exact failure, so this list gets a route of its own
//      rather than a `link_`/`net_` paramPrefix pairing on a shared one. Fix
//      round 1, F2: three comments in this file used to describe the
//      pre-deviation "second list on the directory" design; all three are
//      corrected below to name the real, only caller.
//   2. `loadNetworkLinkForEntity` -- the single-row lookup
//      components/network/linked-identity.tsx needs on each of the four
//      private record detail pages (companies/[id], artists/[id],
//      venues/[id], agencies/[id]), the same role
//      lib/network/entities.ts's `loadNetworkProfileForEntity` plays for a
//      record's OWN published profile.
//
// NEITHER FUNCTION EVER EMBEDS `network_profiles`. A link row's
// `network_profile_id` names a profile owned by ANOTHER tenant (that is the
// entire point of a link -- 20260904000000's header), so resolving it to
// display fields is `loadNetworkProfileForViewer`'s job (lib/network/
// discovery.ts, Task 3), which reads only the two masking views. See
// components/network/linked-identity.tsx for the composition.

import { createClient } from "@/lib/supabase/server";
import type { CurrentOrg } from "@/lib/auth";
import type { ListPage } from "@/lib/list/query";
import { fetchListPage } from "@/lib/list/query";
import { parseListParams, type RawSearchParams } from "@/lib/list/params";
import { defineListSpec } from "@/lib/list/spec";
import {
  NETWORK_ENTITY_KINDS,
  NETWORK_ENTITY_KIND_LABELS,
  isNetworkEntityKind,
  type NetworkEntityKind,
} from "@/lib/network/fields";

const NETWORK_LINK_SELECT =
  "id, network_profile_id, private_entity_type, private_entity_id, created_at";

export interface NetworkLinkRow {
  id: string;
  networkProfileId: string;
  privateEntityType: NetworkEntityKind;
  privateEntityId: string;
  createdAt: string;
}

function mapNetworkLinkRow(row: Record<string, unknown>): NetworkLinkRow {
  return {
    id: String(row.id),
    networkProfileId: String(row.network_profile_id),
    privateEntityType: row.private_entity_type as NetworkEntityKind,
    privateEntityId: String(row.private_entity_id),
    createdAt: String(row.created_at),
  };
}

type LinkSortKey = "linked";
type LinkFilterKey = "kind";

export const NETWORK_LINKS_LIST = defineListSpec<LinkSortKey, LinkFilterKey>({
  entity: "network-links",
  noun: { one: "linked record", many: "linked records" },

  // No text column worth an ILIKE scan (the private record's own NAME is not
  // this table's -- resolving it would mean joining a private table, which no
  // list in this product does casually). `private_entity_type` is a short
  // closed vocabulary, same shape as the requests lists' `status` search.
  searchColumn: "private_entity_type",
  searchLabel: "Search by record type",

  sort: {
    linked: {
      column: "created_at",
      label: "Linked",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL by declaration (20260904000000).
      notNull: true,
      backedBy: "network_links_org_created_at_id_live_idx",
    },
  },
  defaultSort: "linked",

  filters: {
    kind: {
      label: "Record type",
      choices: [
        { value: "any", label: "Any type" },
        ...NETWORK_ENTITY_KINDS.map((kind) => ({
          value: kind,
          label: NETWORK_ENTITY_KIND_LABELS[kind],
        })),
      ],
    },
  },

  // ITS OWN ROUTE (app/(app)/[orgSlug]/network/links/page.tsx), not a second
  // list sharing NETWORK_DIRECTORY_LIST's route -- see this file's header.
  // `paramPrefix` is still set even though nothing on this route needs to be
  // told apart from a sibling list, for the same reason every other spec in
  // this codebase sets one: retrofitting a prefix later would silently
  // invalidate every bookmarked URL.
  paramPrefix: "link_",
});

export type NetworkLinkSortKey = keyof (typeof NETWORK_LINKS_LIST)["sort"];
export type NetworkLinkFilterKey = keyof (typeof NETWORK_LINKS_LIST)["filters"];

/**
 * This organisation's own links, paginated -- consumed by its own route,
 * app/(app)/[orgSlug]/network/links/page.tsx ("Linked records"), the only
 * caller (`grep -rn NETWORK_LINKS_LIST` confirms it).
 */
export async function loadNetworkLinksList(
  org: Pick<CurrentOrg, "id">,
  raw: RawSearchParams,
): Promise<ListPage<NetworkLinkRow>> {
  const params = parseListParams(NETWORK_LINKS_LIST, raw);
  return fetchListPage<NetworkLinkRow, LinkSortKey, LinkFilterKey>({
    spec: NETWORK_LINKS_LIST,
    params,
    organisationId: org.id,
    table: "network_links",
    select: NETWORK_LINK_SELECT,
    mapRow: mapNetworkLinkRow,
    applyFilters: (query, filters) =>
      isNetworkEntityKind(filters.kind)
        ? query.eq("private_entity_type", filters.kind)
        : query,
  });
}

/**
 * The single link (if any) this organisation has filed against one of its own
 * private records -- `linked-identity.tsx`'s lookup on each of the four
 * detail pages.
 *
 * At most one row is rendered even though the schema does not forbid several
 * (`network_links_unique` is keyed on (organisation, entity, PROFILE), so the
 * same record could in principle be linked to more than one profile). The
 * most recently created link is the one shown, matching the "Network
 * identity" row's own single-profile shape (`loadNetworkProfileForEntity`) --
 * a record has one story to tell about what it is, and if more than one link
 * is ever filed the hub's full list (`loadNetworkLinksList`) is where every
 * one of them is visible.
 */
export async function loadNetworkLinkForEntity(
  organisationId: string,
  entityType: NetworkEntityKind,
  entityId: string,
): Promise<NetworkLinkRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("network_links")
    .select(NETWORK_LINK_SELECT)
    .eq("organisation_id", organisationId)
    .eq("private_entity_type", entityType)
    .eq("private_entity_id", entityId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      `[network] link lookup failed for ${entityType} ${entityId}:`,
      error.message,
    );
    return null;
  }
  if (!data) return null;
  return mapNetworkLinkRow(data);
}
