import "server-only";

// Task 4: the two connection-request lists -- Received and Sent -- both on
// app/(app)/[orgSlug]/network/requests/page.tsx.
//
// ===========================================================================
// ONE TABLE, TWO SPECS, BECAUSE Q83 MAKES "THIS ORGANISATION'S SIDE" A CHOICE
// OF COLUMN RATHER THAN A SINGLE `organisation_id` EQUALITY
// ===========================================================================
// public.network_connection_requests carries TWO organisation columns
// (from_organisation_id, to_organisation_id) and no bare `organisation_id` at
// all (20260904000000's own header: "the one table two organisations both own
// a side of"). lib/list/query.ts's `applyScope` therefore cannot scope this
// table the ordinary way -- it is now in RELATIONS_WITHOUT_ORGANISATION_ID for
// exactly that reason -- so EACH loader below supplies the correct column
// itself, through `applyFilters`, which `applyScope` still runs on every one
// of the four queries a page issues (the page query, the count, and both
// keyset probes). The tenant clause is not weaker here; it is spelled
// differently because the table has two tenants, not none.
//
// TWO SPECS, NOT ONE PARAMETRISED SPEC, because Constraint 10 requires a
// DISTINCT paramPrefix per list sharing a route, and a ListSpec bakes its
// prefix in at definition time (lib/list/spec.ts). `buildRequestListSpec`
// below is the shared shape; NETWORK_REQUESTS_RECEIVED_LIST and
// NETWORK_REQUESTS_SENT_LIST are its two instances, `req_in_` and `req_out_`.
//
// ===========================================================================
// THE COUNTERPARTY'S NAME COMES FROM A VIEW, NEVER FROM AN EMBED
// ===========================================================================
// A row here carries the COUNTERPARTY'S PROFILE ID
// (from_network_profile_id for Received, to_network_profile_id for Sent) --
// that column is plain data the SELECT policy already permits either side to
// read (20260904003000). Resolving it to a DISPLAY NAME must not be done with
// a PostgREST embed (`...(display_name)`) into public.network_profiles: that
// relation's own directory SELECT policy permits any active member to read a
// PUBLISHED row's EVERY column, unmasked -- an embed through it would render
// the requester's identity honestly but would also make organisation_id,
// entity_id and every hidden/connections-only field one join away from this
// list. `loadNetworkProfileSummaries` (lib/network/discovery.ts) is the
// sanctioned batch resolver over the two masking views, and requestsResults.tsx
// is the one caller that reaches for it here.
//
// CLAUDE.md: "The requester renders to the recipient as its published network
// profile -- never a tenant name or user name." This module never selects
// from_organisation_id or to_organisation_id for DISPLAY -- it selects them
// only because the RECEIVED/SENT split needs to know which end is which, and
// neither is ever rendered as a label. See requests-results.tsx.

import { createClient } from "@/lib/supabase/server";
import type { CurrentOrg } from "@/lib/auth";
import type { ListPage } from "@/lib/list/query";
import { fetchListPage } from "@/lib/list/query";
import { parseListParams, type RawSearchParams } from "@/lib/list/params";
import { defineListSpec, type ListSpec } from "@/lib/list/spec";
import type { ConnectionStatus } from "@/lib/network/fields";
import {
  loadNetworkProfileSummaries,
  type NetworkProfileForViewer,
} from "@/lib/network/discovery";

/**
 * PostgREST select list. A literal, never assembled from a request.
 *
 * Both organisation columns are selected -- the loaders need them to compute
 * `counterpartyProfileId`, and the SELECT policy already lets either side of
 * a request read both -- but see this file's header: neither is ever rendered
 * as a tenant name.
 */
const NETWORK_REQUEST_SELECT =
  "id, status, requested_at, responded_at, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id";

export interface NetworkRequestRow {
  id: string;
  status: ConnectionStatus;
  requestedAt: string;
  respondedAt: string | null;
  fromOrganisationId: string;
  fromNetworkProfileId: string;
  toOrganisationId: string;
  toNetworkProfileId: string;
}

function mapNetworkRequestRow(
  row: Record<string, unknown>,
): NetworkRequestRow {
  return {
    id: String(row.id),
    status: row.status as ConnectionStatus,
    requestedAt: String(row.requested_at),
    respondedAt: (row.responded_at as string | null) ?? null,
    fromOrganisationId: String(row.from_organisation_id),
    fromNetworkProfileId: String(row.from_network_profile_id),
    toOrganisationId: String(row.to_organisation_id),
    toNetworkProfileId: String(row.to_network_profile_id),
  };
}

/** A request row plus the resolved counterparty profile, as the page renders
 *  it. `counterparty` is `null` when the profile is no longer reachable
 *  through either masking view -- unpublished or soft-deleted since the
 *  request was made, which the INSERT policy's exists clauses permit to
 *  happen later (nothing re-validates a standing request). */
export interface ConnectionRequestRow extends NetworkRequestRow {
  readonly counterpartyProfileId: string;
  readonly counterparty: NetworkProfileForViewer | null;
}

/** Shared by both directions: Received and Sent are the same shape over the
 *  same table, scoped by a different column (see this file's header). */
export type NetworkRequestSortKey = "requested";
/** No filter keys -- see NETWORK_REQUESTS_RECEIVED_LIST's `filters: {}` note:
 *  no ListToolbar ever renders on this route, so no filter control could ever
 *  set one. */
export type NetworkRequestFilterKey = never;

function buildRequestListSpec(
  entity: string,
  paramPrefix: string,
): ListSpec<NetworkRequestSortKey, NetworkRequestFilterKey> {
  return defineListSpec({
    entity,
    noun: { one: "request", many: "requests" },

    // NO ListToolbar ON THIS ROUTE, DELIBERATELY -- both this and its sibling
    // spec share app/(app)/[orgSlug]/network/requests/page.tsx, and
    // ListToolbar's own search/filter submit calls `buildListHref` WITHOUT a
    // `preserve` option (unlike EntityList's sort headers and ListPager, which
    // both take one). Rendering it here would silently drop the OTHER list's
    // cursor on every search -- the exact Constraint 10 failure this spec's
    // header exists to avoid -- so this route uses only the sortable
    // "Requested" column header and the pager, same as
    // lib/crm/related-list.ts's three panel specs (`rel_tasks_`, `rel_notes_`,
    // `rel_docs_`) and lib/crm/activity.ts's timeline, which make the
    // identical choice for the identical reason. `searchColumn` is still a
    // real column (required by `defineListSpec`) even though no control ever
    // reads it.
    searchColumn: "status",
    searchLabel: "Search by status",

    sort: {
      requested: {
        column: "requested_at",
        label: "Requested",
        defaultDirection: "desc",
        directionLabels: { asc: "oldest first", desc: "newest first" },
        // NOT NULL by declaration (20260904000000).
        notNull: true,
        backedBy:
          paramPrefix === "req_in_"
            ? "network_connection_requests_to_org_requested_at_id_idx"
            : "network_connection_requests_from_org_requested_at_id_idx",
      },
    },
    defaultSort: "requested",

    // Empty, for the same reason the searchColumn note gives: no ListToolbar
    // on this route, so no filter control could ever set one.
    filters: {},

    // Constraint 10: two lists on one route, distinct prefixes.
    paramPrefix,
  });
}

export const NETWORK_REQUESTS_RECEIVED_LIST = buildRequestListSpec(
  "network-requests-received",
  "req_in_",
);
export const NETWORK_REQUESTS_SENT_LIST = buildRequestListSpec(
  "network-requests-sent",
  "req_out_",
);

/**
 * Attach each row's resolved counterparty profile, in exactly two extra round
 * trips regardless of page size (loadNetworkProfileSummaries batches by id).
 */
async function withCounterparties(
  page: ListPage<NetworkRequestRow>,
  counterpartyIdOf: (row: NetworkRequestRow) => string,
): Promise<ListPage<ConnectionRequestRow>> {
  if (page.outcome !== "loaded") return page;
  const ids = page.rows.map(counterpartyIdOf);
  const summaries = await loadNetworkProfileSummaries(ids);
  return {
    ...page,
    rows: page.rows.map((row) => {
      const counterpartyProfileId = counterpartyIdOf(row);
      return {
        ...row,
        counterpartyProfileId,
        counterparty: summaries.get(counterpartyProfileId) ?? null,
      };
    }),
  };
}

/**
 * Requests RECEIVED by `org` -- from_organisation_id is the sender, whoever
 * they are; `org` is always the recipient.
 */
export async function loadReceivedConnectionRequests(
  org: Pick<CurrentOrg, "id">,
  raw: RawSearchParams,
): Promise<ListPage<ConnectionRequestRow>> {
  const params = parseListParams(NETWORK_REQUESTS_RECEIVED_LIST, raw);
  const page = await fetchListPage<
    NetworkRequestRow,
    NetworkRequestSortKey,
    NetworkRequestFilterKey
  >({
    spec: NETWORK_REQUESTS_RECEIVED_LIST,
    params,
    organisationId: org.id,
    table: "network_connection_requests",
    select: NETWORK_REQUEST_SELECT,
    mapRow: mapNetworkRequestRow,
    // No `filters` term -- NETWORK_REQUESTS_RECEIVED_LIST declares `filters:
    // {}` (see that spec's own comment on why). This closure's only job is
    // the tenant clause this table cannot express the ordinary way (Q83).
    applyFilters: (query) => query.eq("to_organisation_id", org.id),
  });
  return withCounterparties(page, (row) => row.fromNetworkProfileId);
}

/**
 * Requests SENT by `org` -- to_organisation_id is the recipient, whoever they
 * are; `org` is always the sender.
 */
export async function loadSentConnectionRequests(
  org: Pick<CurrentOrg, "id">,
  raw: RawSearchParams,
): Promise<ListPage<ConnectionRequestRow>> {
  const params = parseListParams(NETWORK_REQUESTS_SENT_LIST, raw);
  const page = await fetchListPage<
    NetworkRequestRow,
    NetworkRequestSortKey,
    NetworkRequestFilterKey
  >({
    spec: NETWORK_REQUESTS_SENT_LIST,
    params,
    organisationId: org.id,
    table: "network_connection_requests",
    select: NETWORK_REQUEST_SELECT,
    mapRow: mapNetworkRequestRow,
    applyFilters: (query) => query.eq("from_organisation_id", org.id),
  });
  return withCounterparties(page, (row) => row.toNetworkProfileId);
}

/**
 * The workspace hub card's pending-received count (Task 4 deliverable,
 * `app/(app)/[orgSlug]/page.tsx`).
 *
 * A PLAIN COUNT, not a list page: the hub renders one number, not a table, so
 * there is no pager, no sort and no filter to thread through
 * `fetchListPage` for. `head: true` asks PostgREST for the count alone, no
 * rows. Same RLS as the two lists above -- a caller with no view_network
 * simply gets 0 rows to count, which the hub never calls this for anyway
 * (gated on the same `canViewNetwork` the rest of the card already is).
 */
export async function countPendingReceivedRequests(
  organisationId: string,
): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("network_connection_requests")
    .select("id", { count: "exact", head: true })
    .eq("to_organisation_id", organisationId)
    .eq("status", "pending");
  if (error) {
    console.error(
      `[network] pending-received count failed for organisation ${organisationId}:`,
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}
