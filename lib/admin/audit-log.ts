import "server-only";

// The audit log viewer's query layer: parsing, the self-audit write, and the
// page fetch.
//
// ===========================================================================
// WHY THIS IS NOT lib/list/query.ts's fetchListPage(), AND IS NOT MEANT TO BE
// ===========================================================================
// lib/list/query.ts's whole design rests on ONE tenant filter
// (`.eq("organisation_id", organisationId)`) applied to every query it
// builds, with a single, structurally-tested exemption set
// (RELATIONS_WITHOUT_ORGANISATION_ID) reserved for relations that have NO
// organisation_id COLUMN AT ALL -- network_directory and
// network_connection_requests, both verified against pg_depend/information_
// schema by tests/integration/list/soft-delete-tables-match-db.test.ts. That
// test's whole point is to make the exemption un-copyable onto a real tenant
// table: public.audit_events DOES carry an organisation_id column (nullable,
// ON DELETE SET NULL), so adding it to that set would fail the very
// assertion the set exists to be checked against, and would be lying about
// why the exemption is safe everywhere else it is used. The audit log's
// organisation_id is a FILTER a superuser may or may not apply, not a scope
// every query is pinned to -- the opposite relationship fetchListPage
// enforces by construction. So this file is a deliberate, narrower sibling
// for the ROW QUERY: no tenant clause, and no bidirectional pager (see
// below).
//
// ===========================================================================
// BUT THE CURSOR ITSELF STILL GOES THROUGH lib/list -- NOT REBUILT HERE
// ===========================================================================
// tests/unit/list/one-cursor-only.test.ts enforces, as a source census, that
// `decodeCursor`/`encodeCursor` (lib/list/cursor.ts) are called from NOWHERE
// but `lib/list` itself -- "a second cursor format one refactor away from
// disagreeing with the first". That rule does not carve out an exception for
// "a deliberately different list shape"; it exists BECAUSE lists have
// deliberately different shapes and a bespoke re-implementation of the
// cursor mechanics is exactly how a second, weaker one starts.
//
// So this file defines a real, minimal `ListSpec` (AUDIT_LOG_SPEC, below)
// and calls `parseListParams`/`buildListHref` -- the SANCTIONED indirection
// the census file's own comment allows ("one indirection is allowed... a
// wrapper WHOSE OWN MODULE calls parseListParams") -- for the parts of this
// surface that a cursor actually touches: the cursor itself and the page
// size ceiling. The five real filters (organisation, actor, action, date
// range) are NOT expressible as `ListSpec` filters at all -- `FilterChoice`
// is a closed enum for a `<select>`, and every one of these is free text or
// a date -- so they are parsed by THIS file, entirely independently of the
// cursor, and applied directly as PostgREST `.eq()`/`.gte()`/`.lte()` calls
// in fetchAuditLogPage. AUDIT_LOG_SPEC therefore declares `filters: {}`; its
// only real job is to own one sort key (created_at) so parseListParams can
// validate and encode/decode a cursor against it.
//
// FORWARD-ONLY, AND WHY THAT IS NOT A REGRESSION FROM fetchListPage'S
// BIDIRECTIONAL PAGER. Bidirectional keyset paging costs two extra probe
// queries per page (lib/list/query.ts's hasNext/hasPrevious probes) plus an
// exact count, and every one of those is affordable there because the count
// and the probes are bounded by ONE TENANT. audit_events has none of that
// bound -- it is the one table in the schema every organisation writes into,
// forever, until Phase 8's retention purge exists -- so an exact count here
// is an unbounded full-table aggregate on every page load, for a page whose
// audience is one hardcoded account. "Next" plus a bounded page size is the
// honest surface for that shape: CLAUDE.md's "paginate everything" is
// satisfied by the cursor and the size ceiling, not by also answering "how
// many, total" at the cost of a sequential scan every time the page is
// viewed. So this file only ever asks parseListParams/buildListHref for a
// forward (`after`) cursor; it never builds a `before` one.
import { createClient } from "@/lib/supabase/server";
import type { Cursor } from "@/lib/list/cursor";
import { quoteLogicValue } from "@/lib/list/postgrest";
import {
  buildListHref,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { defineListSpec, type ListSpec } from "@/lib/list/spec";
import { londonWallClockToInstant } from "@/lib/format/date";

export type AuditLogSort = "created_at";

/**
 * The only ListSpec this file needs: one sort (there is no other useful
 * order for an audit trail), no filters (the five real filters below are not
 * `<select>`-shaped, so they bypass ListSpec entirely), no search control
 * (searchColumn is required by the type but nothing here ever renders a
 * search box or sets `q`, so it is never consulted).
 */
export const AUDIT_LOG_SPEC: ListSpec<AuditLogSort, never> = defineListSpec({
  entity: "audit_events",
  noun: { one: "event", many: "events" },
  searchColumn: "action",
  searchLabel: "Search action",
  sort: {
    created_at: {
      column: "created_at",
      label: "When",
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
      notNull: true,
      backedBy: "audit_events_created_at_id_desc_idx",
    },
  },
  defaultSort: "created_at",
  filters: {},
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `action` values are dot-namespaced identifiers ("organisation.created"),
 *  never free prose -- this is a generous ceiling against a pathological
 *  query string, not a realistic length. */
const MAX_ACTION_LENGTH = 100;

/**
 * THE FILTER ALLOWLIST (CLAUDE.md § Non-negotiable rules: "search/filter/sort
 * inputs map to allowlisted columns and operators"). Every value below is
 * either a validated UUID, a length-capped literal, or a validated instant --
 * nothing a request supplies reaches a query as a column name or an operator.
 * Bad input never errors; it is dropped to `null` ("no filter"), the same
 * "a stale or hostile input degrades to the unfiltered view" rule
 * lib/list/params.ts's parseListParams and lib/list/cursor.ts's decodeCursor
 * both already follow.
 */
export interface AuditLogFilters {
  readonly organisationId: string | null;
  readonly actorUserId: string | null;
  readonly action: string | null;
  /** ISO instant, inclusive lower bound on created_at. */
  readonly dateFrom: string | null;
  /** ISO instant, inclusive upper bound on created_at. */
  readonly dateTo: string | null;
}

export interface AuditLogParams {
  readonly filters: AuditLogFilters;
  /** The lib/list/ half: pageSize, cursor, and the (unused) q/sort/dir --
   *  kept whole, rather than picked apart, because buildListHref (the
   *  "Next" link) needs the same shape back. */
  readonly list: ListParams<AuditLogSort, never>;
}

/** One row, exactly as public.audit_events carries it -- no join, no
 *  resolved display name. See this file's header on why. */
export interface AuditLogRow {
  readonly id: string;
  readonly organisationId: string | null;
  readonly actorUserId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly correlationId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

export type AuditLogPage =
  | {
      readonly outcome: "loaded";
      readonly rows: readonly AuditLogRow[];
      readonly hasNext: boolean;
      readonly lastCursor: Cursor | null;
    }
  | { readonly outcome: "unavailable" };

/** Query-string keys the FIVE REAL FILTERS use. Distinct from lib/list's own
 *  reserved set (q/sort/dir/size/after/before -- see RESERVED_PARAMS in
 *  lib/list/spec.ts), so buildListHref's `preserve` carries them through a
 *  "Next" click untouched without this file ever encoding a cursor itself. */
export const AUDIT_LOG_FILTER_PARAMS = {
  organisationId: "org",
  actorUserId: "actor",
  action: "action",
  dateFrom: "from",
  dateTo: "to",
} as const;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return typeof value === "string" ? value : null;
}

function parseUuidFilter(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function parseActionFilter(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().slice(0, MAX_ACTION_LENGTH);
  return trimmed === "" ? null : trimmed;
}

/** `<input type="datetime-local">`'s value, read as UK LOCAL TIME (CLAUDE.md
 *  § Non-negotiable rules: "UTC in the database, UK local time in the UI
 *  with explicit timezone handling") and converted to the UTC instant the
 *  database compares against. Reuses lib/format/date.ts's own converter
 *  rather than a second implementation of the DST-straddling rules it
 *  documents at length. */
function parseWallClockFilter(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  return londonWallClockToInstant(raw);
}

/** Parse one request's query string: the cursor/page-size half through
 *  lib/list/params.ts's parseListParams (which is the one place
 *  `decodeCursor` is called at all), the five real filters through the
 *  allowlist above. Never throws; every rejection degrades to "no filter" or
 *  "page one". */
export function parseAuditLogParams(raw: RawSearchParams): AuditLogParams {
  const list = parseListParams(AUDIT_LOG_SPEC, raw);

  const filters: AuditLogFilters = {
    organisationId: parseUuidFilter(
      first(raw[AUDIT_LOG_FILTER_PARAMS.organisationId]),
    ),
    actorUserId: parseUuidFilter(
      first(raw[AUDIT_LOG_FILTER_PARAMS.actorUserId]),
    ),
    action: parseActionFilter(first(raw[AUDIT_LOG_FILTER_PARAMS.action])),
    dateFrom: parseWallClockFilter(
      first(raw[AUDIT_LOG_FILTER_PARAMS.dateFrom]),
    ),
    dateTo: parseWallClockFilter(first(raw[AUDIT_LOG_FILTER_PARAMS.dateTo])),
  };

  return { filters, list };
}

/** True when any filter is set -- drives the "no matches" vs. "nothing yet"
 *  copy the same way lib/list/params.ts's isNarrowed() does. */
export function auditLogIsFiltered(filters: AuditLogFilters): boolean {
  return (
    filters.organisationId !== null ||
    filters.actorUserId !== null ||
    filters.action !== null ||
    filters.dateFrom !== null ||
    filters.dateTo !== null
  );
}

/** The JSON this file's self-audit RPC records as `after` -- filter CRITERIA
 *  only, never a result row, never a count. Snake-cased to match the
 *  database's own column names, since this blob is read by a human off
 *  audit_events.after, not consumed by any query. */
export function auditLogFiltersForSelfAudit(
  filters: AuditLogFilters,
): Record<string, string | null> {
  return {
    organisation_id: filters.organisationId,
    actor_user_id: filters.actorUserId,
    action: filters.action,
    date_from: filters.dateFrom,
    date_to: filters.dateTo,
  };
}

/**
 * Record "a superuser viewed the audit log with these filters" via
 * public.audit_superuser_audit_log_view() (20260908010000). Returns whether
 * the write landed; it does NOT throw, so the caller decides what "the
 * self-audit failed" means for the page (see app/(app)/super/audit-log/
 * page.tsx: refused entirely, rather than shown unaudited).
 */
export async function recordAuditLogView(
  filters: AuditLogFilters,
): Promise<{ readonly ok: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("audit_superuser_audit_log_view", {
    p_filters: auditLogFiltersForSelfAudit(filters),
  });
  if (error) {
    console.error(
      "[admin] audit_superuser_audit_log_view() failed; refusing to show audit log results unaudited:",
      error.message,
    );
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Fetch one page of public.audit_events for the filters/cursor given.
 *
 * Reads through the EXISTING RLS policy
 * ("audit_events_select_platform_superuser", 20260826154304) -- this
 * function adds no new read surface. A caller who is not the platform
 * superuser at aal2 gets zero rows back, not an error (the policy filters,
 * it does not deny), which is exactly what tests/integration/rls/rls.test.ts
 * section D already measures for an org Owner and an org Admin.
 */
export async function fetchAuditLogPage(
  params: AuditLogParams,
): Promise<AuditLogPage> {
  const { filters } = params;
  const { pageSize, cursor } = params.list;
  const supabase = await createClient();

  let query = supabase
    .from("audit_events")
    .select(
      "id, organisation_id, actor_user_id, action, target_type, target_id, correlation_id, before, after, created_at",
    );

  // THE ALLOWLISTED FILTERS. Five columns, five fixed operators (eq/eq/eq/
  // gte/lte) -- nothing here is derived from a request string except the
  // VALUES, and every value already passed the allowlist above.
  if (filters.organisationId) {
    query = query.eq("organisation_id", filters.organisationId);
  }
  if (filters.actorUserId) {
    query = query.eq("actor_user_id", filters.actorUserId);
  }
  if (filters.action) {
    query = query.eq("action", filters.action);
  }
  if (filters.dateFrom) {
    query = query.gte("created_at", filters.dateFrom);
  }
  if (filters.dateTo) {
    query = query.lte("created_at", filters.dateTo);
  }

  // THE KEYSET PREDICATE. Same two-part shape lib/list/query.ts's
  // applyCursor documents at length -- a redundant range bound so the
  // planner can push this into audit_events_created_at_id_desc_idx
  // (20260908010000) as an Index Cond, plus the OR'd exact tie-break
  // PostgREST's grammar is the only way to express row-value comparison
  // through. Always the "after this cursor, reading desc" direction: this
  // file has no "Previous", and parseAuditLogParams/AUDIT_LOG_SPEC's one
  // fixed sort means `cursor` (when present) is always a created_at value.
  if (cursor) {
    const quoted = quoteLogicValue(cursor.value);
    query = query
      .lte("created_at", cursor.value)
      .or(`created_at.lt.${quoted},and(created_at.eq.${quoted},id.lt.${cursor.id})`);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // The spare row is how "is there a next page" is answered without a
    // second, unbounded count query -- see this file's header.
    .limit(pageSize + 1);

  if (error || !data) {
    console.error(
      "[admin] audit log page query failed; rendering \"unavailable\" rather than an empty list:",
      error?.message ?? "no data returned",
    );
    return { outcome: "unavailable" };
  }

  const raw = data as Record<string, unknown>[];
  const more = raw.length > pageSize;
  const window = more ? raw.slice(0, pageSize) : raw;

  const rows: AuditLogRow[] = window.map((row) => ({
    id: String(row.id),
    organisationId: (row.organisation_id as string | null) ?? null,
    actorUserId: String(row.actor_user_id),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: (row.target_id as string | null) ?? null,
    correlationId: String(row.correlation_id),
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: String(row.created_at),
  }));

  const lastRow = rows[rows.length - 1];
  // `sort: "created_at"` -- AUDIT_LOG_SPEC's one sort key, and the only value
  // buildListHref's later encode (in the table component) will accept back:
  // parseListParams discards a cursor made under any other sort.
  const lastCursor: Cursor | null = lastRow
    ? { value: lastRow.createdAt, id: lastRow.id, sort: "created_at" }
    : null;

  return { outcome: "loaded", rows, hasNext: more, lastCursor };
}

/**
 * Build the "Next" page's href. Delegates to lib/list/params.ts's
 * buildListHref (the sanctioned `encodeCursor` call site) rather than
 * encoding a cursor here -- see this file's header. `raw` is the request's
 * OWN searchParams, carried through via `preserve` so the five real filters
 * (which AUDIT_LOG_SPEC does not know about) survive the click unchanged;
 * buildListHref's own "FOREIGN KEYS FIRST" ordering means the cursor/size it
 * DOES know about still wins if the two ever collided, which they cannot
 * (AUDIT_LOG_FILTER_PARAMS' five keys share nothing with lib/list's
 * reserved q/sort/dir/size/after/before).
 */
export function buildAuditLogNextHref(
  basePath: string,
  params: AuditLogParams,
  raw: RawSearchParams,
  cursor: Cursor,
): string {
  return buildListHref(AUDIT_LOG_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: { direction: "after", cursor },
  });
}

/**
 * Build the href for the CURRENT view -- the page being rendered right now,
 * filters and cursor (if any) unchanged.
 *
 * FIX ROUND 1, IMPORTANT 1. The disabled "Next" link at the end of the log
 * used to fall back to the bare `basePath` (page one, every filter dropped)
 * -- exactly the lie components/list/list-pager.tsx's own `selfHref` exists
 * to prevent ("the href points at the current view so activating it is a
 * no-op rather than a lie"), and this component's own header already cited
 * that file's shape without actually reproducing it. `aria-disabled` keeps
 * the element focusable and activatable BY DESIGN (list-pager.tsx's header:
 * that is the whole point of `aria-disabled` over removing the element from
 * the tab order), so a keyboard user who tabs to "Next" at the end of a
 * filtered page and presses Enter must land back on the SAME page they were
 * already looking at -- never on an unfiltered page one.
 */
export function buildAuditLogSelfHref(
  basePath: string,
  params: AuditLogParams,
  raw: RawSearchParams,
): string {
  return buildListHref(AUDIT_LOG_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: params.list.cursor
      ? { direction: "after", cursor: params.list.cursor }
      : null,
  });
}
