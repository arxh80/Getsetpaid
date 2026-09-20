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
      "id, user_email, right_type, subject_scope, detail, status, requested_at, due_by, rejection_reason, routed_at, routed_to_organisation_id, routed_to_organisation_name, fulfilment_kind",
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

  // THE WORKSPACE NAME IS ON THE ROW (fix round 1, I4/I7). The transition
  // trigger snapshots it at routing time, so the requester -- who holds no
  // read of public.organisations for a workspace they do not belong to -- can
  // be told WHICH business was asked, and so the evidence survives that
  // workspace being purged. This read no longer joins organisations at all.

  // How many working notes each request carries, COUNTED IN THE DATABASE
  // (review finding M9). The read this replaces selected every note row for
  // the page and counted them here, bounded only by PostgREST's max_rows
  // (1000), which truncates silently: past that the "(n)" in a row header
  // under-counted with no sign at all.
  const noteCounts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: countRows, error: noteError } = await supabase.rpc(
      "data_subject_request_note_counts",
      { p_request_ids: rows.map((r) => r.id as string) },
    );
    if (noteError) console.error("[dsr] note count read failed:", noteError.message);
    else {
      for (const entry of (countRows ?? []) as { request_id: string; note_count: number }[]) {
        noteCounts.set(entry.request_id, Number(entry.note_count));
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
    routedToOrganisationName: (row.routed_to_organisation_name as string | null) ?? null,
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

/** How many of a request's notes the queue shows under its header. */
export const DSR_NOTES_PER_REQUEST = 5;

/**
 * The operator's notes on the requests currently on screen: the newest
 * DSR_NOTES_PER_REQUEST **per request**, by a window function in the database
 * (review finding M9).
 *
 * The read this replaces took the newest 200 notes across the WHOLE page, so
 * one heavily annotated request could starve every other row on it: a header
 * saying "(3)" above a list saying "No notes yet."
 */
export async function fetchDsrNotes(
  requestIds: readonly string[],
): Promise<Map<string, DsrNote[]>> {
  const byRequest = new Map<string, DsrNote[]>();
  if (requestIds.length === 0) return byRequest;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("data_subject_request_recent_notes", {
    p_request_ids: [...requestIds],
    p_per_request: DSR_NOTES_PER_REQUEST,
  });
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
