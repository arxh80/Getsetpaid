import "server-only";

// The list query. One function, one shape, every CRM entity.
//
// ===========================================================================
// THE CLAUSES THAT ARE NOT NEGOTIABLE, AND WHAT EACH ONE COSTS TO OMIT
// ===========================================================================
// Measured on a committed, VACUUM ANALYZEd fixture -- 19,882 live contacts in
// one organisation, 119 soft-deleted, 5,000 in a second tenant with an
// overlapping name range -- as a real `authenticated` role with
// `request.jwt.claims` set the way PostgREST sets it. Not inside a transaction
// (Task 1's lesson), and re-taken in fix round 1 WITH this task's own indexes
// in place, because the first round's numbers were taken before them and one
// of the conclusions below did not survive that.
//
//  1. `.eq("organisation_id", ...)` -- THE TENANT FILTER, ALWAYS EXPLICIT.
//     Required twice over, and fix round 1 corrects this comment: the first
//     version said the clause "is a CORRECTNESS control, not a performance
//     one", on a measurement taken when no index existed for either plan to
//     use. With `contacts_org_name_id_live_idx` in place -- the state this
//     file actually ships in -- `organisation_id` is that index's LEADING
//     COLUMN, so the clause is what makes the index reachable at all:
//
//       with it      Index Scan using contacts_org_name_id_live_idx
//                    1.790 ms   shared hit=317
//       without it   Seq Scan + top-N heapsort of 19,882 rows
//                    13.141 ms  shared hit=498
//
//     CORRECTNESS: multi-org membership ships at MVP (CLAUDE.md § Tenancy
//     model), so for an admin in two workspaces the query without it returns
//     BOTH tenants' rows on one workspace's page. RLS allows that; it is
//     supposed to. Only the query can say which workspace is being viewed.
//     PERFORMANCE: 7x on the shipped schema, and the comment mattered --
//     "the plan is the same with and without it" is exactly what a Task 4
//     author would read while deciding whether their single-org page needs
//     the clause, and dropping it silently reinstates the Seq Scan this
//     task's migration exists to remove. Nothing would fail; the rows are
//     identical.
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
//
// ===========================================================================
// SEARCH IS O(TENANT) AND NO INDEX CAN CHANGE THAT UNDER RLS
// ===========================================================================
// The first round of this task claimed the composite btree served search at
// 1.079 ms. That number is real and it is unrepresentative: it was taken on a
// term matching ~4% of the tenant, dense enough that walking the ordered index
// and stopping at 26 wins. A user types a surname. Measured on this fixture,
// as `authenticated`, a term matching ONE row of 19,882:
//
//   page   Index Scan on contacts_organisation_id_idx, 20,000 rows filtered
//                                                         39.002 ms
//   count  the same shape                                 35.926 ms
//
// So a realistic search costs two scans of the tenant, ~75 ms of database time
// at 20k rows, growing linearly. The list's headline property -- O(page)
// paging -- does not extend to the search path.
//
// THE MECHANISM, TESTED RATHER THAN ASSERTED, because the first round declined
// to name one and the reviewer's correction named a different one:
//
//   select p.proname, p.proleakproof from pg_operator o
//     join pg_proc p on p.oid = o.oprcode
//    where o.oprname in ('~~*','%','>=') and o.oprleft = 'text'::regtype;
//     texticlike     f      -- ILIKE
//     similarity_op  f      -- the pg_trgm `%` operator
//     text_ge        t      -- `>=`
//
// Postgres will not promote a NON-LEAKPROOF qual to an index qual on a relation
// that carries RLS SECURITY QUALS FOR THE CURRENT CALLER, so on this table
// ILIKE and `%` can never become an Index Cond for an `authenticated` session.
//
// "on a table with RLS enabled" would be the wrong condition, and this
// paragraph's own `postgres` control below is the counter-example: `contacts`
// has relrowsecurity = t, and `postgres` uses the trigram index anyway -- and
// still does after `force row level security` (0.045 ms on, 0.044 ms off,
// identical plans), because it is BYPASSRLS. A role RLS does not apply to has
// no security quals to order against, which is why the SECURITY DEFINER fix
// below works at all. The distinction is load-bearing, not pedantry.
//
// The pair below varies leakproofness AND which index can serve the operator,
// so it is suggestive rather than decisive. The decisive experiment holds role,
// RLS, index, statement and session fixed and flips only pg_proc.proleakproof:
// texticlike goes 27.379 ms Seq Scan -> 0.855 ms Bitmap Index Scan,
// Index Cond: (name ~~* '%Wilhelmina%'); similarity_op 31.345 ms -> 0.566 ms.
//
//   name >= 'Wilhelmina'     Index Cond: (organisation_id = ... AND name >= ...)
//                            1.425 ms, Heap Fetches: 0
//   name like 'Wilhelmina%'  Index Cond: (organisation_id = ...) only,
//                            20,000 rows removed by Filter, 6.853 ms
//
// That is why `contacts_name_trgm_idx` is never chosen (0 scans, ever), why a
// composite `gin (organisation_id, name gin_trgm_ops)` was built and measured
// and ALSO never chosen (24.313 ms, unchanged), and why the same statement as
// `postgres` -- no policy, no barrier -- uses the trigram index in 0.114 ms.
// It is a property of RLS plus the operator, not of this schema, so no index
// this project can add will fix it from the PostgREST path.
//
// The ceiling is recorded in FOLLOW-UPS.md with these numbers. A real search
// design (a SECURITY DEFINER search function, which CAN use the trigram index
// -- measured at 0.36 ms against 48-51 ms without it) is scoped there and is
// deliberately NOT built here.
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
      /**
       * True when the request carried a cursor that pointed past the data and
       * this is the first page instead. The component says so, rather than
       * silently showing different rows than the URL asked for.
       */
      readonly recovered: boolean;
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
  // NO `sortValue` OPTION. It used to be here, and every entity supplied a
  // ternary mapping its sort keys back to column names -- a map the spec
  // already holds. Review finding M-6: the else branch of that ternary is a
  // catch-all, so a third sort added to a spec without a matching branch
  // produces cursors carrying the WRONG COLUMN'S VALUE. That is exactly the
  // failure I-2 reproduced, reached by an ordinary omission in a copied file
  // rather than by a forged URL, and Task 4 would have had five chances to
  // make it. The boundary value is now derived from
  // `spec.sort[params.sort].column` below, so the only thing a caller still
  // has to get right is including that column in `select` -- which is checked
  // at runtime and logged loudly.
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
  { includeCursorRow = false }: { includeCursorRow?: boolean } = {},
): ListQuery {
  const strict = reading === "asc" ? "gt" : "lt";
  const bound = reading === "asc" ? "gte" : "lte";
  // `includeCursorRow` widens the tie-break from strictly-after to
  // at-or-after. Only the "is there anything ahead of this backward page"
  // probe uses it; a page always wants strictly-after, or it repeats a row.
  const idOp = includeCursorRow ? bound : strict;
  const quoted = quoteLogicValue(cursor.value);

  return query
    .filter(column, bound, topLevelValue(cursor.value))
    .or(
      `${column}.${strict}.${quoted},and(${column}.eq.${quoted},id.${idOp}.${cursor.id})`,
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
  const { spec, params, table, select, mapRow } = options;
  const sortOption = spec.sort[params.sort];
  const supabase = await createClient();

  // Paging BACKWARDS is the forwards query with the ordering reversed, then
  // the rows reversed again in memory. There is no other way to take "the 25
  // rows immediately before this one" from a limit-based API, and every other
  // way (an offset, a second count) reintroduces what keyset exists to avoid.
  const buildPage = (
    cursor: Cursor | null,
    direction: CursorDirection | null,
  ): ListQuery => {
    const reading: SortDirection =
      direction === "before" ? flip(params.dir) : params.dir;
    const ascending = reading === "asc";
    let q = applyScope(
      supabase.from(table).select(select) as unknown as ListQuery,
      options,
    );
    if (cursor) q = applyCursor(q, sortOption.column, reading, cursor);
    return (
      q
        .order(sortOption.column, { ascending })
        // `id` is the tie-break and it is not optional. No sort column here is
        // unique -- a contacts list has several "Sam Patel"s -- and a keyset
        // over a non-total order both skips and repeats rows at every page
        // boundary a tie straddles. The primary key makes the order total.
        .order("id", { ascending })
        .limit(params.pageSize + 1)
    );
  };

  // The count deliberately does NOT carry the cursor: it answers "how many
  // match", not "how many are left". It is a separate round trip because
  // PostgREST's `count=exact` counts the rows the request selects, cursor
  // included, which would make the total shrink as the user pages -- a number
  // that changes when nothing changed.
  //
  // Cost, measured: it is the one part of this page that is O(tenant). A count
  // needs every row, so it is a scan whatever indexes exist -- 7.7 ms over
  // 24,509 rows unfiltered, and 20.5-35.9 ms when a search narrows it, because
  // the search predicate is then a per-row filter too (see the header's search
  // note). It runs in PARALLEL with the page and fails independently: a page
  // renders without a total rather than not at all.
  const countQuery = applyScope(
    supabase
      .from(table)
      .select("id", { count: "exact", head: true }) as unknown as ListQuery,
    options,
  );

  // "IS THERE A PAGE AFTER THIS ONE" WHEN PAGING BACKWARDS.
  //
  // This used to be the literal `true`, with a comment calling it a fact. It
  // was an assumption about how the page was reached, and review reproduced
  // what that costs: land on a `before` page that happens to be the end of the
  // list -- a bookmark, or a link that was correct before rows were removed --
  // and the app offers a Next that leads somewhere empty.
  //
  // The real answer is one indexed `limit 1`: does any row still exist at or
  // after the cursor we came back from, reading forwards? It runs in PARALLEL,
  // because that cursor is known before the page query returns, and only on
  // backward pages.
  const nextProbeQuery =
    params.cursorDirection === "before" && params.cursor
      ? applyCursor(
          applyScope(
            supabase.from(table).select("id") as unknown as ListQuery,
            options,
          ),
          sortOption.column,
          params.dir,
          params.cursor,
          { includeCursorRow: true },
        ).limit(1)
      : null;

  const [pageResult, countResult, nextResult] = await Promise.all([
    buildPage(params.cursor, params.cursorDirection),
    countQuery,
    nextProbeQuery ?? Promise.resolve(null),
  ]);

  if (pageResult.error || !pageResult.data) {
    // The message only, never the rows: a log line must not become a second
    // copy of tenant data. Same rule as the members page.
    console.error(
      `[list] ${spec.entity} page query failed for organisation ${options.organisationId}; rendering "unavailable" rather than an empty list:`,
      pageResult.error?.message ?? "no data returned",
    );
    return { outcome: "unavailable" };
  }

  let raw = pageResult.data as Record<string, unknown>[];
  let direction = params.cursorDirection;
  let recovered = false;

  // A CURSOR THAT LANDS PAST THE DATA RECOVERS TO PAGE ONE INSTEAD OF DEAD-ENDING.
  //
  // Review finding I-1, reproduced three ways: a cursor past the end of the
  // table, a `before` cursor of the very first row, and a Next link the app
  // itself offered -- each rendering "No contacts yet" in a workspace holding
  // 20,220 contacts, with no table and no pager, so the only way out was the
  // breadcrumb. Telling a customer their workspace is empty is the same class
  // of lie as the Read Only empty state, reached through the cursor instead of
  // through the role.
  //
  // Fixed HERE rather than in the component, so that no entity page can get it
  // wrong: Task 4 copies EntityList five times and would have copied a branch
  // that cannot tell "no records" from "bad cursor". It also makes
  // lib/list/cursor.ts's stated invariant -- "a cursor that does not decode
  // must produce the FIRST page" -- true of the SEMANTIC failure as well as
  // the syntactic one, which is what that header always promised in spirit.
  //
  // One extra round trip, in a case that is already degenerate.
  if (raw.length === 0 && params.cursor !== null) {
    const retry = await buildPage(null, null);
    if (retry.error || !retry.data) {
      console.error(
        `[list] ${spec.entity} recovery query failed for organisation ${options.organisationId} after an empty cursored page:`,
        retry.error?.message ?? "no data returned",
      );
      return { outcome: "unavailable" };
    }
    raw = retry.data as Record<string, unknown>[];
    direction = null;
    recovered = true;
  }

  const more = raw.length > params.pageSize;
  const window = more ? raw.slice(0, params.pageSize) : raw;
  const ordered = direction === "before" ? [...window].reverse() : window;

  // The boundary value comes from the SPEC's column, not from a per-entity
  // callback -- see the note where `sortValue` used to be. The one thing a
  // caller can still get wrong is leaving the sort column out of `select`, so
  // that is checked rather than assumed: silently, it would produce cursors
  // whose value is the string "undefined" and a list that pages in circles.
  if (ordered.length > 0 && ordered[0]![sortOption.column] === undefined) {
    console.error(
      `[list] ${spec.entity}: sort column "${sortOption.column}" is not in the select list, so cursors cannot be built. Add it to the entity's select.`,
    );
  }

  const edge = (row: Record<string, unknown> | undefined): Cursor | null =>
    row
      ? {
          value: String(row[sortOption.column] ?? ""),
          id: String(row.id),
          // The cursor records WHICH sort it was made under, so a stale link
          // under a different sort degrades to page one instead of to a 400.
          sort: params.sort,
        }
      : null;

  if (countResult.error) {
    console.error(
      `[list] ${spec.entity} count failed for organisation ${options.organisationId}; rendering the page without a total:`,
      countResult.error.message,
    );
  }

  let hasNext: boolean;
  if (direction !== "before") {
    hasNext = more;
  } else if (nextResult && !nextResult.error && Array.isArray(nextResult.data)) {
    hasNext = nextResult.data.length > 0;
  } else {
    // The probe failed. Stay optimistic, because the recovery above means an
    // offered Next can no longer strand anyone -- but say so, rather than let
    // a failed query look like an answer.
    console.error(
      `[list] ${spec.entity} next-page probe failed for organisation ${options.organisationId}; assuming a next page exists:`,
      nextResult?.error?.message ?? "no data returned",
    );
    hasNext = true;
  }

  return {
    outcome: "loaded",
    rows: ordered.map(mapRow),
    hasNext,
    // Paging forward, having arrived from somewhere means there is something
    // behind. Paging backward, the spare row is what says so. With no cursor
    // this is page one, so there is nothing behind by definition.
    hasPrevious: direction === "before" ? more : direction === "after",
    total: countResult.error ? null : countResult.count,
    firstCursor: edge(ordered[0]),
    lastCursor: edge(ordered[ordered.length - 1]),
    recovered,
  };
}

export type { Cursor, CursorDirection };
