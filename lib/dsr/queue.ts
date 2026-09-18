import "server-only";

// The read behind /super/data-requests: a keyset-paged, filterable queue of
// data subject requests through the superuser's own RLS
// (`data_subject_requests_select_platform`, 20260924000000).
//
// THE FEEDBACK LIST'S SHAPE (lib/feedback/list.ts), for its reasons: a real
// ListSpec so the cursor and the page-size ceiling come from lib/list and
// nowhere else, the filters parsed HERE against closed allowlists and applied
// directly (this list has no organisation to scope to and is superuser-only),
// forward-only paging, both sort directions honoured.
//
// OLDEST DUE FIRST IS THE DEFAULT, and that is the whole point of the page:
// the thing that must not be missed is the one nearest its statutory deadline,
// so the queue opens on it rather than on the newest arrival. `dir=desc`
// ("Furthest from its deadline") exists because a keyset pager whose URL
// advertises a direction it does not honour is a URL that lies — the M5
// finding on the feedback list.
//
// METADATA AND THE REQUESTER'S OWN WORDS. Nothing here reads a tenant table:
// the one join is `organisations` for the NAME of a workspace a request was
// routed to, through the superuser's existing cross-tenant read of
// organisation rows (`organisations_select_platform_lifecycle`, Phase 7 Task
// 3). CLAUDE.md § Superuser dashboard's "never shows record content" holds.

import { createClient } from "@/lib/supabase/server";
import type { Cursor } from "@/lib/list/cursor";
import { containsPattern, quoteLogicValue } from "@/lib/list/postgrest";
import {
  buildListHref,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { defineListSpec, type ListSpec, type SortDirection } from "@/lib/list/spec";
import {
  isDsrRight,
  isDsrStatus,
  type DsrRight,
  type DsrScope,
  type DsrStatus,
} from "./contract";

export type DsrSort = "due_by";

export const DSR_SPEC: ListSpec<DsrSort, never> = defineListSpec({
  entity: "data_subject_request",
  noun: { one: "request", many: "requests" },
  searchColumn: "detail",
  searchLabel: "Search what the requester wrote",
  sort: {
    due_by: {
      column: "due_by",
      label: "Deadline",
      defaultDirection: "asc",
      directionLabels: { asc: "Nearest deadline first", desc: "Furthest deadline first" },
      notNull: true,
      backedBy: "data_subject_requests_due_by_idx",
    },
  },
  defaultSort: "due_by",
  filters: {},
});

/** Query-string keys for the filters, distinct from lib/list's reserved set
 *  (q/sort/dir/size/after/before) so `preserve` carries them through a "Next"
 *  click untouched. */
export const DSR_FILTER_PARAMS = {
  status: "status",
  right: "right",
  open: "open",
} as const;

export interface DsrFilters {
  readonly status: DsrStatus | null;
  readonly right: DsrRight | null;
  /** "Only requests with a deadline left to miss" — the default view. */
  readonly openOnly: boolean;
}

export interface DsrQueueParams {
  readonly filters: DsrFilters;
  readonly list: ListParams<DsrSort, never>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return typeof value === "string" ? value : null;
}

/**
 * THE DEFAULT IS THE OPEN QUEUE. A page that opened on every request ever made
 * would bury the three that are due; `?open=all` turns the filter off, and
 * naming an explicit status turns it off too (asking for "Refused" and being
 * shown nothing because refused requests are closed is a filter that fights
 * itself).
 */
export function parseDsrQueueParams(raw: RawSearchParams): DsrQueueParams {
  const list = parseListParams(DSR_SPEC, raw);
  const statusRaw = firstParam(raw[DSR_FILTER_PARAMS.status]);
  const rightRaw = firstParam(raw[DSR_FILTER_PARAMS.right]);
  const status = statusRaw !== null && isDsrStatus(statusRaw) ? statusRaw : null;
  const openRaw = firstParam(raw[DSR_FILTER_PARAMS.open]);
  return {
    filters: {
      status,
      right: rightRaw !== null && isDsrRight(rightRaw) ? rightRaw : null,
      openOnly: status === null && openRaw !== "all",
    },
    list,
  };
}

export function dsrQueueIsFiltered(params: DsrQueueParams): boolean {
  return (
    params.filters.status !== null ||
    params.filters.right !== null ||
    params.list.q !== ""
  );
}

export interface DsrQueueRow {
  readonly id: string;
  readonly userEmail: string;
  readonly rightType: DsrRight | string;
  readonly subjectScope: DsrScope | string;
  readonly detail: string;
  readonly status: DsrStatus | string;
  readonly requestedAt: string;
  readonly dueBy: string;
  readonly rejectionReason: string | null;
  readonly routedAt: string | null;
  readonly routedToOrganisationName: string | null;
  readonly routedToOrganisationId: string | null;
  readonly fulfilmentKind: string | null;
  readonly noteCount: number;
}

export type DsrQueuePage =
  | {
      readonly outcome: "loaded";
      readonly rows: readonly DsrQueueRow[];
      readonly hasNext: boolean;
      readonly lastCursor: Cursor | null;
    }
  | { readonly outcome: "unavailable" };

/** The keyset predicate for one reading direction — lib/list/query.ts's
 *  two-part shape, kept pure so the operators can be proved to flip WITH the
 *  direction rather than read out of the query. */
export function keysetClause(
  direction: SortDirection,
  cursor: Cursor,
): { readonly bound: "gte" | "lte"; readonly or: string } {
  const strict = direction === "asc" ? "gt" : "lt";
  const bound = direction === "asc" ? "gte" : "lte";
  const quoted = quoteLogicValue(cursor.value);
  return {
    bound,
    or: `due_by.${strict}.${quoted},and(due_by.eq.${quoted},id.${strict}.${cursor.id})`,
  };
}

const OPEN_STATUSES = ["open", "in_progress", "routed"] as const;

export async function fetchDsrQueuePage(params: DsrQueueParams): Promise<DsrQueuePage> {
  const { filters } = params;
  const { pageSize, cursor, dir } = params.list;
  const supabase = await createClient();

  let query = supabase
    .from("data_subject_requests")
    .select(
      "id, user_email, right_type, subject_scope, detail, status, requested_at, due_by, rejection_reason, routed_at, routed_to_organisation_id, fulfilment_kind",
    );

  // ALLOWLISTED FILTERS: every value passed a closed allowlist above; nothing
  // a request supplies reaches the query as a column or an operator.
  if (filters.status !== null) query = query.eq("status", filters.status);
  else if (filters.openOnly) query = query.in("status", [...OPEN_STATUSES]);
  if (filters.right !== null) query = query.eq("right_type", filters.right);
  if (params.list.q !== "") {
    query = query.ilike(DSR_SPEC.searchColumn, containsPattern(params.list.q));
  }

  if (cursor) {
    const clause = keysetClause(dir, cursor);
    query = query.filter("due_by", clause.bound, cursor.value).or(clause.or);
  }

  const ascending = dir === "asc";
  const { data, error } = await query
    .order("due_by", { ascending })
    .order("id", { ascending })
    .limit(pageSize + 1);

  if (error) {
    console.error("[dsr] queue read failed:", error.message);
    return { outcome: "unavailable" };
  }

  const raw = data ?? [];
  const more = raw.length > pageSize;
  const rows = more ? raw.slice(0, pageSize) : raw;

  // The workspace NAME for a routed request — the superuser's existing
  // cross-tenant read of organisation rows. A name is not record content.
  const orgIds = [
    ...new Set(
      rows
        .map((row) => row.routed_to_organisation_id as string | null)
        .filter((id): id is string => id !== null),
    ),
  ];
  let names = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgRows, error: nameError } = await supabase
      .from("organisations")
      .select("id, name")
      .in("id", orgIds);
    if (nameError) console.error("[dsr] workspace name lookup failed:", nameError.message);
    else names = new Map((orgRows ?? []).map((r) => [r.id as string, r.name as string]));
  }

  // How many working notes each request carries. The BODIES are not read here
  // — the queue shows a count and the detail view shows the notes — but the
  // count tells the operator at a glance which ones have been worked.
  const noteCounts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: noteRows, error: noteError } = await supabase
      .from("data_subject_request_notes")
      .select("request_id")
      .in(
        "request_id",
        rows.map((r) => r.id as string),
      );
    if (noteError) console.error("[dsr] note count read failed:", noteError.message);
    else {
      for (const note of noteRows ?? []) {
        const key = note.request_id as string;
        noteCounts.set(key, (noteCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const mapped: DsrQueueRow[] = rows.map((row) => ({
    id: row.id as string,
    userEmail: row.user_email as string,
    rightType: row.right_type as string,
    subjectScope: row.subject_scope as string,
    detail: row.detail as string,
    status: row.status as string,
    requestedAt: row.requested_at as string,
    dueBy: row.due_by as string,
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    routedAt: (row.routed_at as string | null) ?? null,
    routedToOrganisationId: (row.routed_to_organisation_id as string | null) ?? null,
    routedToOrganisationName:
      row.routed_to_organisation_id === null
        ? null
        : (names.get(row.routed_to_organisation_id as string) ?? "(unknown workspace)"),
    fulfilmentKind: (row.fulfilment_kind as string | null) ?? null,
    noteCount: noteCounts.get(row.id as string) ?? 0,
  }));

  const lastRow = mapped[mapped.length - 1];
  const lastCursor: Cursor | null = lastRow
    ? { value: lastRow.dueBy, id: lastRow.id, sort: "due_by" }
    : null;

  return { outcome: "loaded", rows: mapped, hasNext: more, lastCursor };
}

export interface DsrNote {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
}

/** The operator's notes on the requests currently on screen. Bounded, like
 *  every other read: the newest few per request are what a queue needs. */
export async function fetchDsrNotes(
  requestIds: readonly string[],
): Promise<Map<string, DsrNote[]>> {
  const byRequest = new Map<string, DsrNote[]>();
  if (requestIds.length === 0) return byRequest;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("data_subject_request_notes")
    .select("id, request_id, body, created_at")
    .in("request_id", [...requestIds])
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[dsr] notes read failed:", error.message);
    return byRequest;
  }
  for (const row of data ?? []) {
    const key = row.request_id as string;
    const list = byRequest.get(key) ?? [];
    list.push({
      id: row.id as string,
      body: row.body as string,
      createdAt: row.created_at as string,
    });
    byRequest.set(key, list);
  }
  return byRequest;
}

export function buildDsrNextHref(
  basePath: string,
  params: DsrQueueParams,
  raw: RawSearchParams,
  cursor: Cursor,
): string {
  return buildListHref(DSR_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: { direction: "after", cursor },
  });
}

export function buildDsrSelfHref(
  basePath: string,
  params: DsrQueueParams,
  raw: RawSearchParams,
): string {
  return buildListHref(DSR_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: params.list.cursor ? { direction: "after", cursor: params.list.cursor } : null,
  });
}
