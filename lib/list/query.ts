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
//     Task 4 made the SIDE of the line an option (`scope`) so the restore view
//     can exist, and did NOT make the clause itself optional -- there is no
//     value of `scope` that omits it, and the "deleted" side has its own
//     partial indexes for the same reason this side does.
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

import { consumeRateLimit } from "@/lib/security/rate-limit";
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
  /**
   * Membership in a BOUNDED, CALLER-BUILT set of values.
   *
   * Added by Phase 3 Task 7 for `loadEventsForArtist`, whose relation is
   * `event_lineup` rather than `events` -- see that function for why a
   * two-step read is the shape and for the cap that keeps this list short.
   *
   * THE LIST MUST BE BOUNDED BY THE CALLER. `.in()` puts every value in the
   * GET query string, so an unbounded set is a request that grows with the
   * tenant and eventually exceeds what PostgREST will accept. Every caller in
   * this repository caps at `MAX_PAGE_SIZE` (50 uuids, roughly 2KB) or states
   * its own ceiling -- the same budget `loadVenueNames` records.
   */
  in(column: string, values: readonly unknown[]): ListQuery;
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
       * Why this is page one when the URL asked for somewhere else, or null.
       *
       * A BOOLEAN WAS WRONG IN BOTH DIRECTIONS, and the flag is widened rather
       * than the string reworded:
       *
       *   past-end      the cursor named a row at or after the end of the
       *                 list. The link pointed PAST the data.
       *   before-start  the cursor named a row at or before the start, on a
       *                 `before` request. The link pointed BEFORE the data --
       *                 and the one string the component used to render said
       *                 the opposite, in as many words.
       *   stale-sort    the cursor was made under a different sort and was
       *                 discarded by `parseListParams`. Same class of event --
       *                 your link is stale and this is not what you asked for
       *                 -- and it previously produced page one with NO notice
       *                 at all, which is the quietest of the three failures.
       *
       * The component picks the sentence. Nothing here writes copy.
       */
      readonly recovered: RecoveryReason;
    }
  | { readonly outcome: "unavailable" }
  /**
   * REFUSED BY THE RATE LIMITER (SECURITY.md § 5), before any query ran.
   *
   * A THIRD OUTCOME, NOT A DRESSED-UP "unavailable", because the two demand
   * opposite copy: "unavailable" says refresh and try again -- exactly the
   * wrong advice for a caller who is being asked to SLOW DOWN -- and the
   * brief's own contract is that a refused request is 429-shaped, never a
   * silent empty result. `retryAfterSeconds` is the window's remainder, from
   * the database's clock, for the "try again in …" sentence.
   */
  | { readonly outcome: "rate_limited"; readonly retryAfterSeconds: number };

/** @see ListPage.recovered */
export type RecoveryReason = "past-end" | "before-start" | "stale-sort" | null;

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
  /**
   * Which side of the soft-delete line this list is.
   *
   * ADDED BY TASK 4, AND IT IS A NARROWING OF CLAUSE 2 ABOVE RATHER THAN AN
   * ESCAPE FROM IT. `deleted_at` is still always constrained -- there is no
   * value of this option that omits the clause -- because a list with no
   * soft-delete predicate cannot use either partial index and would show
   * deleted records among live ones.
   *
   * "deleted" exists because CLAUDE.md requires soft delete, and a soft delete
   * nobody can undo is a hard delete with extra steps. Restore needs a way to
   * REACH a deleted record; this is it, on its own route, with its own
   * indexes (20260828230000) and its own single sort. It is deliberately NOT a
   * query-string filter on the live list: the count line there would stop
   * being a true statement about live records, and the clause this file calls
   * non-negotiable would become negotiable by URL.
   */
  readonly scope?: "live" | "deleted";
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
/**
 * The tables that genuinely have no `deleted_at`, and are therefore the only
 * ones this file will read without a soft-delete predicate.
 *
 * ===========================================================================
 * NOT AN OPTION, AND DELIBERATELY NOT ONE
 * ===========================================================================
 * `scope`'s own note says there is no value of it that omits the clause,
 * because a list with no soft-delete predicate cannot use either partial index
 * and would show deleted records among live ones. That rule is about tables
 * that HAVE a soft delete. `public.merges` does not and must not: it is
 * append-only by design -- no UPDATE grant, no DELETE grant, no updated_at,
 * and merged_at is the creation timestamp (20260827232512). Asking PostgREST
 * to filter a column that does not exist is a 400, and this page would render
 * "unavailable" forever.
 *
 * Written as a SET KEYED ON THE TABLE rather than a caller-supplied flag, so
 * the escape cannot be pointed at `contacts` by a copied spec. Adding a table
 * here is a decision somebody has to write down in this file, next to the
 * reason.
 *
 * BOUND TO THE DATABASE by tests/integration/list/soft-delete-tables-match-db,
 * which fails if a table listed here grows a `deleted_at`, or if a table this
 * repository lists reads without one.
 *
 * ADDED BY TASK 7: `public.activity_events`. It is a VIEW, so it has no
 * columns of its own to soft-delete with -- each branch decides for itself
 * what a deleted row means, and they do not agree, which is why one column
 * could not express it:
 *
 *   * the five entity branches DO NOT filter their subject's `deleted_at`,
 *     deliberately. The detail route serves a soft-deleted record -- that is
 *     how restore is reached -- and a timeline that vanished on that page
 *     would take the record's own deletion entry with it.
 *   * `record_deleted` exists BECAUSE the subject is deleted. Filtering it
 *     would remove the one entry that is only ever true of a deleted record.
 *   * `link_removed` is the same shape on the two join tables that have a
 *     `deleted_at`.
 *
 * FOUND IN A BROWSER, WITH EVERY GATE GREEN. Omitting this entry does not fail
 * to compile, lint, or any of the 813 unit and integration tests, 843 psql
 * assertions or 174 HTTP checks that were green at the moment it was found --
 * none of them calls `fetchListPage` against this view. It renders
 * "We couldn't load this contact's activity just now" on every detail page in
 * the product, with `column activity_events.deleted_at does not exist` in the
 * server log. tests/integration/list/soft-delete-tables-match-db.test.ts now
 * asserts the OTHER direction too -- every relation a `fetchListPage` call
 * names is either soft-deletable or listed here -- so the next omission is red
 * before it is a browser finding.
 */
const TABLES_WITHOUT_SOFT_DELETE = new Set([
  "merges",
  "activity_events",
  // ADDED BY PHASE 6 TASK 4. `public.network_connection_requests` is a real
  // TABLE, not a view, and genuinely has no `deleted_at` at all: 20260904000000's
  // own header states it -- "a request is never deleted, it moves to a terminal
  // status (Q79), which is a richer record than a tombstone".
  // lib/network/requests-list.ts's two list specs (Received, Sent) both read
  // this table and neither ever passes `scope: "deleted"` -- there is no
  // deleted view of a request to restore, only a terminal `status` to read.
  "network_connection_requests",
  // ADDED BY PHASE 6 TASK 1 (fix round 1, review finding I3).
  // `public.network_directory` is a masking VIEW over network_profiles and
  // projects eleven columns, none of them `deleted_at` -- the view's own
  // `where p.deleted_at is null` is what removes soft-deleted profiles, once,
  // for every reader. Filtering a column it does not project is a PostgREST
  // 400, which is the `activity_events` finding above repeating one phase
  // later. `scope: "deleted"` over it is meaningless and throws below: a
  // soft-deleted network profile is not restorable from the DIRECTORY, it is
  // restorable from its owner's own list over the base table.
  "network_directory",
]);

/**
 * The relations a list reads that carry NO `organisation_id` at all.
 *
 * ===========================================================================
 * THIS IS THE TENANT CLAUSE, SO THE ESCAPE IS NARROWER THAN THE ONE ABOVE
 * ===========================================================================
 * `applyScope` puts `.eq("organisation_id", organisationId)` on every query
 * this application's list surface makes, and that is the single most important
 * line in this file: it is the application half of the tenant boundary, with
 * RLS as the half that actually enforces it.
 *
 * ADDED BY PHASE 6 TASK 1 (fix round 1, review finding I3) FOR EXACTLY ONE
 * RELATION, and the reason it is safe is the reason it is needed:
 * `public.network_directory` is THE ONE LIST IN THE PRODUCT THAT IS NOT
 * ORGANISATION-SCOPED. Discovery spans every tenant by design (CLAUDE.md
 * § The private/network split), and the view deliberately does not project
 * `organisation_id` -- a discovery result identifies a PROFILE, never a
 * tenant, so Task 3's UI has no tenant id to leak. Filtering a column it does
 * not project is a PostgREST 400.
 *
 * ===========================================================================
 * WHAT STOPS THIS BECOMING A TENANT-BOUNDARY ESCAPE HATCH
 * ===========================================================================
 * Three things, and the second is the one that makes it structural rather than
 * a promise:
 *
 *   1. IT IS A SET KEYED ON THE RELATION, NOT A FLAG A SPEC CAN PASS -- the
 *      same shape as TABLES_WITHOUT_SOFT_DELETE, and for the same reason: a
 *      copied file cannot point it at `contacts`.
 *   2. A TENANT TABLE CANNOT LEGALLY BE ADDED TO IT. Every tenant-owned
 *      relation in this schema carries a NOT NULL `organisation_id`
 *      (schema_invariants D10), so
 *      tests/integration/list/soft-delete-tables-match-db.test.ts asserts that
 *      every relation named here genuinely HAS NO SUCH COLUMN. Adding
 *      `contacts` is red on the next run, before it is a breakout.
 *   3. THE DATABASE IS UNAFFECTED. Dropping the client-side predicate does
 *      not widen what the caller may read by one row: `network_directory`'s
 *      own WHERE clause is its row gate (a definer view since Phase 10 Task
 *      19, F1) -- published, live, and only to an active member of some
 *      organisation (`private.network_profile_reaches_caller`).
 */
// ADDED BY PHASE 6 TASK 4, FOR A DIFFERENT REASON THAN network_directory'S.
// `public.network_connection_requests` is BI-TENANT (Q83): it carries TWO
// organisation columns, `from_organisation_id` and `to_organisation_id`, and
// genuinely has no column named `organisation_id` at all -- so it passes the
// same strict test network_directory does (neither column list contains that
// exact name), for the opposite reason: network_directory has NO tenant at
// all, this table has TWO. lib/network/requests-list.ts's two loaders
// (Received, Sent) each supply the correct column -- `to_organisation_id` or
// `from_organisation_id` -- through `applyFilters`, which `applyScope` still
// calls for every one of the four queries a page issues (the page query, the
// count, and both keyset probes), so the tenant clause is not weaker here,
// only spelled differently.
const RELATIONS_WITHOUT_ORGANISATION_ID = new Set([
  "network_directory",
  "network_connection_requests",
]);

function applyScope<TRow, TSort extends string, TFilter extends string>(
  query: ListQuery,
  options: FetchListPageOptions<TRow, TSort, TFilter>,
): ListQuery {
  const { spec, params, organisationId, applyFilters } = options;

  // THE TENANT CLAUSE. Applied to everything except the one cross-tenant
  // relation named above; see that set's comment for why the exemption cannot
  // be pointed at a tenant table.
  let q = RELATIONS_WITHOUT_ORGANISATION_ID.has(options.table)
    ? query
    : query.eq("organisation_id", organisationId);
  // Always one of the two, never neither -- unless the table HAS no
  // soft-delete column at all. See TABLES_WITHOUT_SOFT_DELETE.
  if (!TABLES_WITHOUT_SOFT_DELETE.has(options.table)) {
    q =
      options.scope === "deleted"
        ? q.filter("deleted_at", "not.is", null)
        : q.is("deleted_at", null);
  } else if (options.scope === "deleted") {
    // Unreachable from any spec in this repository and cheap to make loud: a
    // "deleted" view of a table with no deleted_at would silently render the
    // whole table as if every row were deleted.
    throw new Error(
      `[list] ${options.table} has no soft-delete column, so scope: "deleted" is meaningless.`,
    );
  }

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

  // =========================================================================
  // THE RATE-LIMIT GATE (SECURITY.md § 5) -- THIS is the one chokepoint all
  // twenty searchColumn paths flow through (FOLLOW-UPS § "Opened by Task 8"),
  // which is why the meter lives here and not in twenty page files.
  //
  //   network_directory  -> 'network_discovery', 30/min/user, EVERY read of
  //     the directory list (browse and search alike) -- the NAMED endpoint
  //     (FOLLOW-UPS:3408-3419), deliberately its own budget and never folded
  //     into 'search': its unit cost is O(platform-wide published rows), not
  //     O(tenant), so a budget sized for index-backed tenant lists would be
  //     many times too generous. Keyed on the TABLE, not on a spec flag, for
  //     the same reason TABLES_WITHOUT_SOFT_DELETE is -- a copied spec cannot
  //     accidentally opt out.
  //   any other list WITH a search term -> 'search', 60/min/user. A plain
  //     browse/page of a tenant list is O(page) by this file's own
  //     measurements and stays unmetered; the search term is what makes the
  //     request O(tenant) (the header's leakproofness note), so the term is
  //     what is metered.
  //
  // consumeRateLimit() is cache()-wrapped, so one user request that fans out
  // into several metered reads (the command palette's per-entity fan-out)
  // costs ONE unit per category. A refusal returns before any query is
  // built: the refused request must not cost the database the very work the
  // limit exists to bound.
  //
  // WHAT THIS DOES NOT METER, stated so nobody reads more into it. Two things,
  // and only the first is a residual:
  //
  //   1. `GET /rest/v1/network_directory` issued directly with the anon key +
  //      a session JWT never enters this function. That residual is measured,
  //      named in SECURITY.md § 5/§ 10 and queued (Q107) -- PostgREST runs
  //      GETs in read-only transactions, so no DB-side hook on that path can
  //      write a counter (20260909020000's header carries the probe).
  //   2. lib/network/discovery.ts's `loadNetworkProfileForViewer` and
  //      `loadNetworkProfileSummaries` read `network_directory` and
  //      `network_connected_profiles` WITHOUT going through this function, and
  //      are deliberately unmetered (fix round 1, minor M4). Both are
  //      `id`-equality lookups -- one row, or a bounded `.in()` over ids the
  //      caller already holds -- so neither carries the O(platform-wide
  //      published rows) cost this budget exists to bound, and charging a
  //      browse unit for opening one profile would meter the cheap path to
  //      protect the expensive one. What holds without qualification is that
  //      no LIST of the directory reaches the database without passing here.
  // =========================================================================
  const meteredCategory =
    table === "network_directory"
      ? ("network_discovery" as const)
      : params.q !== ""
        ? ("search" as const)
        : null;
  if (meteredCategory !== null) {
    const verdict = await consumeRateLimit(meteredCategory);
    if (!verdict.allowed) {
      return {
        outcome: "rate_limited",
        retryAfterSeconds: verdict.retryAfterSeconds,
      };
    }
  }

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

  // "IS THERE A PAGE BEFORE THIS ONE" WHEN PAGING FORWARDS -- the mirror of
  // the probe above, and it exists because the asymmetry was the defect.
  //
  // `hasPrevious` used to be `direction === "after"`: on a forward page that
  // is the literal `true`, dressed as a derivation. It is the same statement
  // that `hasNext` used to make in the other direction, and the re-reviewer
  // reproduced what it costs -- a cursor whose value sorts before every row
  // renders 25 rows starting at the true first row, with PREVIOUS ENABLED, on
  // what is literally page one.
  //
  // Symmetric answer, symmetric cost: one indexed `limit 1` asking whether any
  // row still exists at or before the cursor we came forward from, reading
  // backwards. `includeCursorRow` is what makes the cursor's OWN row count --
  // it is the last row of the previous page, so if it is still there, there is
  // still a page behind. A fabricated cursor that names nothing finds nothing.
  //
  // Runs in PARALLEL and only on forward pages, so it never coexists with the
  // backward probe above; between them a page issues at most three round trips
  // plus the degenerate recovery.
  const prevProbeQuery =
    params.cursorDirection === "after" && params.cursor
      ? applyCursor(
          applyScope(
            supabase.from(table).select("id") as unknown as ListQuery,
            options,
          ),
          sortOption.column,
          flip(params.dir),
          params.cursor,
          { includeCursorRow: true },
        ).limit(1)
      : null;

  const [pageResult, countResult, nextResult, prevResult] = await Promise.all([
    buildPage(params.cursor, params.cursorDirection),
    countQuery,
    nextProbeQuery ?? Promise.resolve(null),
    prevProbeQuery ?? Promise.resolve(null),
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
  // The third recovery cause is decided BEFORE the query, by the parser: a
  // cursor made under another sort never reaches this function at all, so the
  // page is already page one and there is nothing to re-run. It is reported
  // here anyway because the component needs one flag, not two.
  let recovered: RecoveryReason = params.cursorDiscarded ? "stale-sort" : null;

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
    // WHICH END WE FELL OFF IS DECIDED BY `cursorDirection` ALONE, and not by
    // comparing it against `params.dir` as the brief suggested. `applyCursor`
    // already folds `dir` in -- it reads `flip(dir)` for a `before` page -- so
    // by the time a cursored page comes back empty, "nothing after the cursor"
    // and "nothing before it" are exactly the two request directions. Bringing
    // `dir` back in would invert the message on every descending list.
    recovered = direction === "before" ? "before-start" : "past-end";
    direction = null;
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

  // The mirror of the block above, deliberately written the same shape so the
  // asymmetry that produced N-1 cannot come back by drift. Paging backward the
  // spare row answers it directly; with no cursor -- including a page that
  // RECOVERED to page one, which sets `direction` to null -- this is page one
  // and there is nothing behind by definition; paging forward it is measured.
  let hasPrevious: boolean;
  if (direction === "before") {
    hasPrevious = more;
  } else if (direction === null) {
    hasPrevious = false;
  } else if (prevResult && !prevResult.error && Array.isArray(prevResult.data)) {
    hasPrevious = prevResult.data.length > 0;
  } else {
    // Optimistic on a failed probe, same as `hasNext`, and for the same
    // reason: an offered Previous can no longer strand anyone now that an
    // empty cursored page recovers. Logged rather than silent, so a failing
    // query does not look like an answer.
    console.error(
      `[list] ${spec.entity} previous-page probe failed for organisation ${options.organisationId}; assuming a previous page exists:`,
      prevResult?.error?.message ?? "no data returned",
    );
    hasPrevious = true;
  }

  return {
    outcome: "loaded",
    rows: ordered.map(mapRow),
    hasNext,
    hasPrevious,
    total: countResult.error ? null : countResult.count,
    firstCursor: edge(ordered[0]),
    lastCursor: edge(ordered[ordered.length - 1]),
    recovered,
  };
}

export type { Cursor, CursorDirection };
