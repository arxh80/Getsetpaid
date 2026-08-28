import "server-only";

// The list query. One function, one shape, every CRM entity.
//
// ===========================================================================
// THE CLAUSES THAT ARE NOT NEGOTIABLE, AND WHAT EACH ONE COSTS TO OMIT
// ===========================================================================
// Measured on a committed, VACUUM ANALYZEd fixture: 25,000 contacts in one
// organisation (24,509 live, 491 soft-deleted), 5,000 in a second tenant, as
// a real `authenticated` role with `request.jwt.claims` set the way PostgREST
// sets it. Not inside a transaction -- Task 1's lesson.
//
//  1. `.eq("organisation_id", ...)` -- THE TENANT FILTER, ALWAYS EXPLICIT.
//     CLAUDE.md § Tenancy model. Worth being precise about why, because the
//     measurement does NOT say what the brief expected: for a single-org user
//     the plan is the same node with and without it (10.925 ms vs 11.995 ms),
//     because the RLS set-form predicate has already narrowed to the caller's
//     organisations. The clause is a CORRECTNESS control, not a performance
//     one -- and multi-org membership ships at MVP (CLAUDE.md § Tenancy
//     model), so for an admin in two workspaces the query without it returns
//     BOTH tenants' contacts on one workspace's page. RLS allows that; it is
//     supposed to. Only the query can say which workspace is being viewed.
//
//  2. `.is("deleted_at", null)` -- RLS DOES NOT DO THIS. Task 2 § 4.1 decided
//     the policies deliberately do not hide soft-deleted rows, and
//     FOLLOW-UPS.md carries it to every task in Phases 2-7. It is not only a
//     correctness clause: the supporting indexes are PARTIAL (`where
//     deleted_at is null`), so dropping it makes them unusable and the plan
//     falls back to a Seq Scan plus a top-N sort of the whole tenant --
//     11.995 ms / 884 buffers against 1.015 ms / 314. Wrong rows AND twelve
//     times the work.
//
//  3. The keyset predicate, in TWO PARTS. See `applyCursor`.
//
//  4. `.limit(pageSize + 1)`. The spare row is how "is there another page" is
//     answered without a second query and without a count.
// ===========================================================================

import { createClient } from "@/lib/supabase/server";
import type { Cursor, CursorDirection } from "./cursor";
import type { ListParams } from "./params";
import { containsPattern, quoteLogicValue, topLevelValue } from "./postgrest";
import type { ListSpec, SortDirection } from "./spec";

interface ListResponse {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

/**
 * The subset of the PostgREST builder this module uses.
 *
 * Declared structurally rather than importing `PostgrestFilterBuilder`, whose
 * seven type parameters describe generated database types this project does
 * not generate -- naming it would mean threading six unused parameters through
 * every signature here, or `any`. It also narrows what an entity's
 * `applyFilters` hook can reach for, which is a small but real benefit: the
 * hook is handed a filter builder, not the whole client.
 */
export interface ListQuery extends PromiseLike<ListResponse> {
  eq(column: string, value: unknown): ListQuery;
  is(column: string, value: null): ListQuery;
  ilike(column: string, pattern: string): ListQuery;
  filter(column: string, operator: string, value: unknown): ListQuery;
  or(filters: string): ListQuery;
  order(column: string, options: { ascending: boolean }): ListQuery;
  limit(count: number): ListQuery;
}

/**
 * A loaded page, or a stated failure.
 *
 * THE THREE-WAY SHAPE IS THE POINT, and it is the same one
 * `app/(app)/[orgSlug]/members/page.tsx` adopted after review finding M-2:
 * a failed query and an empty table are different answers and must not
 * collapse into one value. "0 contacts" is a claim about the customer's data;
 * "we could not load this" is a claim about the request. Rendering the first
 * when the second is true reads as data loss.
 */
export type ListPage<TRow> =
  | {
      readonly outcome: "loaded";
      readonly rows: readonly TRow[];
      readonly hasNext: boolean;
      readonly hasPrevious: boolean;
      /** Total matching the filters, ignoring the cursor. Null if uncounted. */
      readonly total: number | null;
      /** Boundary cursors for this page, for the pager's two links. */
      readonly firstCursor: Cursor | null;
      readonly lastCursor: Cursor | null;
    }
  | { readonly outcome: "unavailable" };

export interface FetchListPageOptions<
  TRow,
  TSort extends string,
  TFilter extends string,
> {
  readonly spec: ListSpec<TSort, TFilter>;
  readonly params: ListParams<TSort, TFilter>;
  /** Already resolved and authorised by the caller -- see lib/auth. */
  readonly organisationId: string;
  /** Table name. A literal from the caller, never from a request. */
  readonly table: string;
  /** PostgREST select list. A literal from the caller. */
  readonly select: string;
  /** Maps a raw row once, so pages never handle PostgREST shapes. */
  readonly mapRow: (raw: Record<string, unknown>) => TRow;
  /** Reads the sort column off a raw row, to build the boundary cursors. */
  readonly sortValue: (
    raw: Record<string, unknown>,
    sort: TSort,
  ) => string;
  /** Entity-specific filters. Server-side only; never crosses to a client. */
  readonly applyFilters?: (
    query: ListQuery,
    filters: Readonly<Record<TFilter, string>>,
  ) => ListQuery;
}

function flip(direction: SortDirection): SortDirection {
  return direction === "asc" ? "desc" : "asc";
}

/**
 * The keyset predicate: a redundant range bound AND an exact tie-break.
 *
 * Both halves are required, and the redundant-looking one is the one that
 * decides the cost.
 *
 *   `(col, id) > (v, i)` is what is meant. Postgres understands row-value
 *   comparison and turns it into an index range condition -- but PostgREST
 *   has no syntax for it, so the only reachable form is the disjunction
 *   `col > v OR (col = v AND id > i)`.
 *
 *   A disjunction is not a range. Measured, paging from the middle of a
 *   25,000-row tenant, the OR alone is applied as a FILTER over a full index
 *   scan of the tenant: 3.345 ms forward with 10,475 index entries discarded,
 *   4.876 ms backward with 14,034 discarded. Cost proportional to how deep
 *   the page is -- which is offset pagination's failure mode, reappearing
 *   inside the thing chosen to avoid it.
 *
 *   Adding `col >= v`, which the disjunction already implies and which
 *   therefore changes no row, gives the planner a range it can push into the
 *   index:
 *
 *     Index Cond: (organisation_id = ... AND name >= 'Kit Kaur 12345')
 *     Rows Removed by Filter: 0
 *     Execution Time: 0.433 ms      forward, from the middle
 *     Execution Time: 0.487 ms      backward, from the middle
 *
 *   The row-value form PostgREST cannot express measures 0.408 ms on the same
 *   page, so this is within 6% of the ideal and 8-10x better than the
 *   disjunction alone.
 *
 * The two halves sit in DIFFERENT PostgREST grammars and are encoded
 * differently -- top-level values are literal, logic-tree values must be
 * quoted. lib/list/postgrest.ts carries the measurements; swapping them
 * returns the wrong page with a 200 and no error anywhere.
 */
function applyCursor(
  query: ListQuery,
  column: string,
  reading: SortDirection,
  cursor: Cursor,
): ListQuery {
  const strict = reading === "asc" ? "gt" : "lt";
  const inclusive = reading === "asc" ? "gte" : "lte";
  const quoted = quoteLogicValue(cursor.value);

  return query
    .filter(column, inclusive, topLevelValue(cursor.value))
    .or(
      `${column}.${strict}.${quoted},and(${column}.eq.${quoted},id.${strict}.${cursor.id})`,
    );
}

/** Everything that narrows the set, shared by the page query and the count. */
function applyScope<TRow, TSort extends string, TFilter extends string>(
  query: ListQuery,
  options: FetchListPageOptions<TRow, TSort, TFilter>,
): ListQuery {
  const { spec, params, organisationId, applyFilters } = options;

  let q = query.eq("organisation_id", organisationId).is("deleted_at", null);

  if (params.q !== "") {
    // A top-level filter, so the value is literal -- no quoting, by
    // measurement. `containsPattern` handles the LIKE and PostgREST
    // metacharacters.
    q = q.ilike(spec.searchColumn, containsPattern(params.q));
  }

  return applyFilters ? applyFilters(q, params.filters) : q;
}

export async function fetchListPage<
  TRow,
  TSort extends string,
  TFilter extends string,
>(options: FetchListPageOptions<TRow, TSort, TFilter>): Promise<ListPage<TRow>> {
  const { spec, params, table, select, mapRow, sortValue } = options;
  const sortOption = spec.sort[params.sort];
  const supabase = await createClient();

  // Paging BACKWARDS is the forwards query with the ordering reversed, then
  // the rows reversed again in memory. There is no other way to take "the 25
  // rows immediately before this one" from a limit-based API, and every other
  // way (an offset, a second count) reintroduces what keyset exists to avoid.
  const reading: SortDirection =
    params.cursorDirection === "before" ? flip(params.dir) : params.dir;
  const ascending = reading === "asc";

  let page = applyScope(
    supabase.from(table).select(select) as unknown as ListQuery,
    options,
  );
  if (params.cursor) {
    page = applyCursor(page, sortOption.column, reading, params.cursor);
  }
  page = page
    .order(sortOption.column, { ascending })
    // `id` is the tie-break and it is not optional. No sort column here is
    // unique -- a contacts list has several "Sam Patel"s -- and a keyset over
    // a non-total order both skips and repeats rows at every page boundary a
    // tie straddles. The primary key makes the order total.
    .order("id", { ascending })
    .limit(params.pageSize + 1);

  // The count deliberately does NOT carry the cursor: it answers "how many
  // match", not "how many are left". It is a separate round trip because
  // PostgREST's `count=exact` counts the rows the request selects, cursor
  // included, which would make the total shrink as the user pages -- a number
  // that changes when nothing changed.
  //
  // Cost, measured: 7.703 ms over 24,509 live rows, a Seq Scan, and it cannot
  // be anything else -- a count needs every row, and the RLS predicate's
  // owner_user_id term keeps it off an index-only path. So it is O(tenant)
  // where the page query is O(page), and at a few hundred thousand records it
  // would dominate the request. It runs in PARALLEL with the page and fails
  // independently: a page renders without a total rather than not at all.
  const countQuery = applyScope(
    supabase
      .from(table)
      .select("id", { count: "exact", head: true }) as unknown as ListQuery,
    options,
  );

  const [pageResult, countResult] = await Promise.all([page, countQuery]);

  if (pageResult.error || !pageResult.data) {
    // The message only, never the rows: a log line must not become a second
    // copy of tenant data. Same rule as the members page.
    console.error(
      `[list] ${spec.entity} page query failed for organisation ${options.organisationId}; rendering "unavailable" rather than an empty list:`,
      pageResult.error?.message ?? "no data returned",
    );
    return { outcome: "unavailable" };
  }

  const raw = pageResult.data as Record<string, unknown>[];
  const more = raw.length > params.pageSize;
  const window = more ? raw.slice(0, params.pageSize) : raw;
  const ordered =
    params.cursorDirection === "before" ? [...window].reverse() : window;

  const edge = (row: Record<string, unknown> | undefined): Cursor | null =>
    row ? { value: sortValue(row, params.sort), id: String(row.id) } : null;

  if (countResult.error) {
    console.error(
      `[list] ${spec.entity} count failed for organisation ${options.organisationId}; rendering the page without a total:`,
      countResult.error.message,
    );
  }

  return {
    outcome: "loaded",
    rows: ordered.map(mapRow),
    // Paging forward, the spare row says there is more ahead and having
    // arrived from somewhere says there is something behind. Paging backward,
    // both are true in mirror image. With no cursor this is page one, so
    // there is nothing behind by definition.
    hasNext: params.cursorDirection === "before" ? true : more,
    hasPrevious:
      params.cursorDirection === "before"
        ? more
        : params.cursorDirection === "after",
    total: countResult.error ? null : countResult.count,
    firstCursor: edge(ordered[0]),
    lastCursor: edge(ordered[ordered.length - 1]),
  };
}

export type { Cursor, CursorDirection };
