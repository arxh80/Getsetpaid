import "server-only";

// `loadNetworkProfileForViewer` is `cache`-wrapped: the directory profile page
// asks for it in generateMetadata and again in the body. Per-request, keyed on
// the profile id -- see lib/crm/queries.ts's header.
import { cache } from "react";

// Task 3: the read path over PUBLISHED network profiles -- the directory page
// and the profile-as-seen-by-the-caller page. Two functions, and the second is
// the one Constraint 19 is about.
//
// ===========================================================================
// EVERY QUERY IN THIS FILE NAMES A VIEW. NONE NAMES public.network_profiles.
// ===========================================================================
// `lib/network/entities.ts` reads `network_profiles` directly, and that is
// correct there: every one of its queries is pinned to
// `.eq("organisation_id", organisationId)` for the CALLER'S OWN organisation.
// This file is the opposite case -- a profile that may belong to ANY
// organisation -- and for that case the base table is the wrong source
// regardless of how the query is filtered: since Phase 10 Task 19 (F1,
// 20261103000000) it returns no foreign row at all, and before that it
// returned every column unmasked. The masking is the VIEW's job, not a WHERE
// clause this file could add. tests/unit/network/discovery-source-shape.test.ts is
// the source-only guard that a future edit does not reintroduce
// `.from("network_profiles")` here.
import { createClient } from "@/lib/supabase/server";
import type { ListPage } from "@/lib/list/query";
import { fetchListPage } from "@/lib/list/query";
import { parseListParams, type RawSearchParams } from "@/lib/list/params";
import {
  NETWORK_DIRECTORY_LIST,
  NETWORK_DIRECTORY_SELECT,
  mapNetworkDirectoryRow,
  type NetworkDirectoryFilterKey,
  type NetworkDirectoryRow,
  type NetworkDirectorySortKey,
} from "@/lib/network/discovery-list";

/**
 * One page of the network directory.
 *
 * A THIN WRAPPER, not a reimplementation. `NETWORK_DIRECTORY_LIST` (Task 1) and
 * `fetchListPage` (Foundation) already carry the whole contract -- the search
 * column, the sort, the kind filter, the keyset paging and, load-bearingly,
 * the server-side page-size CEILING (`lib/list/params.ts`'s `MAX_PAGE_SIZE`,
 * applied inside `parseListParams` before this function ever sees a page
 * size). This function exists so the page and its Suspense boundary have one
 * name to call, and so the `organisationId` placeholder -- required by
 * `fetchListPage`'s type and IGNORED for this one exempted relation
 * (`RELATIONS_WITHOUT_ORGANISATION_ID` in lib/list/query.ts) -- is explained
 * once, here, rather than at every call site.
 *
 * `[P6]` THE PAGE CEILING PROTECTS THE WHOLE PLATFORM, NOT ONE TENANT. This is
 * the one list in the product where that is true (CLAUDE.md § Non-negotiable
 * rules): an unbounded directory page would scan every published profile of
 * every customer. Nothing here can raise it -- there is no parameter that
 * reaches past what `parseListParams` already clamps, and no LIST path into
 * `network_directory` skips it.
 *
 * THE SENTENCE ABOVE USED TO END "there is no second code path into
 * `network_directory` that skips it", AND THAT WAS TOO STRONG (fix round 1,
 * minor M4). Two functions in this very file --
 * `loadNetworkProfileForViewer` and `loadNetworkProfileSummaries` -- select
 * from `network_directory` (and `network_connected_profiles`) directly rather
 * than through `fetchListPage`, so they pass neither the page ceiling nor,
 * since Phase 7 Task 5, the `network_discovery` meter that now lives at the
 * same chokepoint. That is deliberate and stays deliberate: both are
 * `id`-equality lookups, one row or a bounded `.in()` over ids the caller
 * already holds, so neither is the O(published profiles platform-wide) scan
 * either control exists to bound. Metering them would spend a browse budget
 * on opening a single profile -- charging for the cheap thing to protect the
 * expensive one. The claim that holds without qualification is the narrower
 * one now written above: no LIST of the directory avoids the ceiling or the
 * meter.
 */
export async function loadNetworkDirectory(
  raw: RawSearchParams,
): Promise<ListPage<NetworkDirectoryRow>> {
  const params = parseListParams(NETWORK_DIRECTORY_LIST, raw);
  return fetchListPage<
    NetworkDirectoryRow,
    NetworkDirectorySortKey,
    NetworkDirectoryFilterKey
  >({
    spec: NETWORK_DIRECTORY_LIST,
    params,
    // REQUIRED BY THE TYPE, IGNORED BY THE QUERY. See this function's own doc
    // comment and lib/list/query.ts's RELATIONS_WITHOUT_ORGANISATION_ID: the
    // directory is the one list in the product that is not organisation-scoped,
    // and network_directory does not project a column this value could filter
    // on even if `applyScope` tried.
    organisationId: "",
    table: "network_directory",
    select: NETWORK_DIRECTORY_SELECT,
    mapRow: mapNetworkDirectoryRow,
    applyFilters: (query, filters) =>
      filters.kind !== "any" ? query.eq("entity_kind", filters.kind) : query,
  });
}

/** Which view resolved a profile for `loadNetworkProfileForViewer`. */
export type NetworkProfileSource = "connected" | "directory";

/** One published profile, as ONE caller is entitled to see it. */
export interface NetworkProfileForViewer {
  readonly row: NetworkDirectoryRow;
  /**
   * `"connected"` -- resolved through `public.network_connected_profiles`, so
   * every field the publisher marked `connections` is ALSO visible, alongside
   * the `network`-level ones. This is what an accepted request unlocks (N4)
   * and nothing else: no tenant table becomes reachable, only these two views
   * gain one more caller.
   *
   * `"directory"` -- resolved through `public.network_directory`. Only
   * `network`-level fields are visible. This is the answer for every caller
   * with no accepted connection to this profile's organisation, INCLUDING the
   * profile's own organisation viewing it through this function (an
   * organisation has no accepted connection with itself) -- which is why the
   * page checks ownership separately (`lib/network/entities.ts`'s
   * `loadNetworkProfileById`) rather than reading anything here as "am I the
   * owner".
   */
  readonly source: NetworkProfileSource;
}

/**
 * Load one PUBLISHED profile, exactly as the CURRENT SESSION'S organisation
 * may see it.
 *
 * **THE ONE FUNCTION THIS TASK IS ABOUT (the brief's own words).** It tries
 * `network_connected_profiles` first and falls back to `network_directory`,
 * and it reads `public.network_profiles` NEVER -- not for this profile, not
 * for any profile, regardless of who owns it. Constraint 19's network case,
 * verbatim: shipping the two masking views while this function read the base
 * table would pass every structural assertion ABOUT the views and leak the
 * `connections` and `hidden` fields anyway, because the base table's SELECT
 * policy is deliberately column-blind.
 *
 * Returns `null` for anything the two views do not carry: a draft, a
 * soft-deleted profile, or an id that never existed. ALL THREE COLLAPSE TO THE
 * SAME ANSWER ON PURPOSE -- the enumeration-oracle argument DESIGN.md makes for
 * every other record in this product, applied to a profile: a caller probing
 * ids must not learn "that one exists but is a draft" from a different
 * response shape than "that one has never existed". The PAGE distinguishes a
 * true 404 from "this is your own draft" by asking
 * `lib/network/entities.ts`'s `loadNetworkProfileById` SEPARATELY, scoped to
 * the caller's own organisation_id -- a question this function is not asked
 * and could not safely answer for a foreign id.
 *
 * TWO ROUND TRIPS, NOT ONE, AND SEQUENTIAL RATHER THAN PARALLEL. A `.or()`
 * across two different views is not an expression PostgREST can make (they are
 * different relations), and running both in parallel would mean discarding
 * the connected view's row on every uncommitted caller for no saved latency --
 * this is a single profile lookup by primary key against two views each
 * carrying its own index-backed `id` equality, not a list scan, so the second
 * round trip this function sometimes skips is cheap to keep sequential and
 * easy to reason about.
 */
export const loadNetworkProfileForViewer = cache(async (
  profileId: string,
): Promise<NetworkProfileForViewer | null> => {
  const supabase = await createClient();

  const connected = await supabase
    .from("network_connected_profiles")
    .select(NETWORK_DIRECTORY_SELECT)
    .eq("id", profileId)
    .maybeSingle();
  if (connected.error) {
    console.error(
      `[network] connected-profile lookup failed for ${profileId}:`,
      connected.error.message,
    );
    // Fail closed to the NARROWER view rather than surface the error: falling
    // through to the directory lookup is strictly safer than returning early,
    // because the directory can only ever show LESS than the connected view
    // would have.
  } else if (connected.data) {
    return { row: mapNetworkDirectoryRow(connected.data), source: "connected" };
  }

  const directory = await supabase
    .from("network_directory")
    .select(NETWORK_DIRECTORY_SELECT)
    .eq("id", profileId)
    .maybeSingle();
  if (directory.error) {
    console.error(
      `[network] directory lookup failed for ${profileId}:`,
      directory.error.message,
    );
    return null;
  }
  if (!directory.data) return null;
  return { row: mapNetworkDirectoryRow(directory.data), source: "directory" };
});

/**
 * Task 4: batch-resolve several profile ids in exactly two round trips,
 * regardless of how many ids are asked for -- the requests inbox/outbox's
 * counterparty column (lib/network/requests-list.ts), and any future caller
 * that needs to render a small, BOUNDED set of foreign profiles by id.
 *
 * SAME TWO VIEWS AS `loadNetworkProfileForViewer`, NEVER `network_profiles`.
 * This is the batched form of that function's own rule (Constraint 19's
 * network case): reads `network_connected_profiles` first, falls back to
 * `network_directory` for whatever is left, and never selects from the base
 * table for a foreign organisation.
 *
 * `ids` MUST BE BOUNDED BY THE CALLER -- `.in()` puts every value in the GET
 * query string (lib/list/query.ts's `ListQuery.in` doc comment states the same
 * rule). Every caller in this file reaches it from one page of an already
 * page-size-capped list, so the bound is inherited rather than re-declared
 * here.
 *
 * A profile id absent from the returned map is one neither view carries any
 * more -- unpublished or soft-deleted since whatever pointed at it was
 * created (a standing connection request is never re-validated against the
 * profile it named). The caller renders that as "no longer available" rather
 * than as an error.
 */
export async function loadNetworkProfileSummaries(
  profileIds: readonly string[],
): Promise<ReadonlyMap<string, NetworkProfileForViewer>> {
  const ids = [...new Set(profileIds)];
  const map = new Map<string, NetworkProfileForViewer>();
  if (ids.length === 0) return map;

  const supabase = await createClient();

  const connected = await supabase
    .from("network_connected_profiles")
    .select(NETWORK_DIRECTORY_SELECT)
    .in("id", ids);
  if (connected.error) {
    console.error(
      "[network] batched connected-profile lookup failed:",
      connected.error.message,
    );
    // Fail closed to the narrower view, same reasoning as the single-id
    // function above: falling through to the directory lookup can only ever
    // show LESS than the connected view would have.
  } else {
    for (const row of connected.data ?? []) {
      map.set(String(row.id), { row: mapNetworkDirectoryRow(row), source: "connected" });
    }
  }

  const remaining = ids.filter((id) => !map.has(id));
  if (remaining.length === 0) return map;

  const directory = await supabase
    .from("network_directory")
    .select(NETWORK_DIRECTORY_SELECT)
    .in("id", remaining);
  if (directory.error) {
    console.error(
      "[network] batched directory lookup failed:",
      directory.error.message,
    );
    return map;
  }
  for (const row of directory.data ?? []) {
    map.set(String(row.id), { row: mapNetworkDirectoryRow(row), source: "directory" });
  }
  return map;
}
