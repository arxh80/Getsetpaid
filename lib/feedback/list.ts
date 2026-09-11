import "server-only";

// The read behind /super/feedback: a keyset-paged, filterable list of
// feedback rows through the superuser's own RLS (feedback_select_platform,
// 20260911000000 -- aal2 superuser, inside the 2-year retention window).
//
// THE INCIDENT-ALERT LIST'S SHAPE (lib/admin/health.ts), for its reasons: a
// real ListSpec so the cursor and page-size ceiling come from lib/list and
// nowhere else (tests/unit/list/one-cursor-only.test.ts allows exactly this
// indirection), the filters parsed HERE against closed allowlists and applied
// directly (this list is not read by fetchListPage: it has no organisation to
// scope to and is superuser-only), forward-only paging, newest first.
//
// FILTERABLE BY ORG, CATEGORY AND DATE (CLAUDE.md § In-app feedback) plus
// status and a message search. The organisation filter takes a SLUG typed
// into a text box rather than a select of every workspace on the platform --
// that select would be an unbounded list, which is the thing "paginate
// everything" forbids. The slug resolves to an id through
// organisations_select_platform_lifecycle, the superuser's existing
// cross-tenant read of organisation ROWS (Task 3); a slug that resolves to
// nothing yields an empty page rather than an unfiltered one.
//
// DATES ARE UTC CALENDAR DAYS. `from` is inclusive from 00:00Z, `to` is
// inclusive through 23:59:59Z of that day. The UI renders instants in UK local
// time (DESIGN/CLAUDE: UTC in the database, UK in the UI), so a row stamped
// 00:30 BST on the 2nd is a 1st-of-the-month row to this filter. Stated
// rather than hidden; a timezone-aware day filter is a follow-up for a
// surface with one reader.

import { createClient } from "@/lib/supabase/server";
import type { Cursor } from "@/lib/list/cursor";
import { containsPattern, quoteLogicValue } from "@/lib/list/postgrest";
import {
  buildListHref,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { defineListSpec, type ListSpec } from "@/lib/list/spec";
import {
  isFeedbackCategory,
  isFeedbackStatus,
  parseIsoDate,
  type FeedbackCategory,
  type FeedbackStatus,
} from "@/lib/feedback/contract";

export type FeedbackSort = "created_at";

export const FEEDBACK_SPEC: ListSpec<FeedbackSort, never> = defineListSpec({
  entity: "feedback",
  noun: { one: "submission", many: "submissions" },
  searchColumn: "message",
  searchLabel: "Search feedback",
  sort: {
    created_at: {
      column: "created_at",
      label: "Submitted",
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
      notNull: true,
      backedBy: "feedback_created_at_id_desc_idx",
    },
  },
  defaultSort: "created_at",
  filters: {},
});

/** Query-string keys for the filters. Distinct from lib/list's reserved set
 *  (q/sort/dir/size/after/before) so buildListHref's `preserve` carries them
 *  through a "Next" click untouched. */
export const FEEDBACK_FILTER_PARAMS = {
  org: "org",
  category: "category",
  status: "status",
  from: "from",
  to: "to",
} as const;

export interface FeedbackFilters {
  readonly orgSlug: string | null;
  readonly category: FeedbackCategory | null;
  readonly status: FeedbackStatus | null;
  readonly from: string | null;
  readonly to: string | null;
}

export interface FeedbackParams {
  readonly filters: FeedbackFilters;
  readonly list: ListParams<FeedbackSort, never>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return typeof value === "string" ? value : null;
}

/** The slug grammar create_organisation() accepts; anything else is "no
 *  filter" rather than a query against a value nobody could have. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function parseFeedbackParams(raw: RawSearchParams): FeedbackParams {
  const list = parseListParams(FEEDBACK_SPEC, raw);
  const orgRaw = firstParam(raw[FEEDBACK_FILTER_PARAMS.org])?.trim().toLowerCase() ?? null;
  const categoryRaw = firstParam(raw[FEEDBACK_FILTER_PARAMS.category]);
  const statusRaw = firstParam(raw[FEEDBACK_FILTER_PARAMS.status]);
  return {
    filters: {
      orgSlug: orgRaw !== null && orgRaw !== "" && SLUG_RE.test(orgRaw) ? orgRaw : null,
      category: categoryRaw !== null && isFeedbackCategory(categoryRaw) ? categoryRaw : null,
      status: statusRaw !== null && isFeedbackStatus(statusRaw) ? statusRaw : null,
      from: parseIsoDate(firstParam(raw[FEEDBACK_FILTER_PARAMS.from])),
      to: parseIsoDate(firstParam(raw[FEEDBACK_FILTER_PARAMS.to])),
    },
    list,
  };
}

export function feedbackIsFiltered(params: FeedbackParams): boolean {
  const f = params.filters;
  return (
    f.orgSlug !== null ||
    f.category !== null ||
    f.status !== null ||
    f.from !== null ||
    f.to !== null ||
    params.list.q !== ""
  );
}

export interface FeedbackRow {
  readonly id: string;
  readonly category: FeedbackCategory | string;
  readonly status: FeedbackStatus | string;
  readonly message: string;
  readonly route: string;
  readonly userEmail: string | null;
  readonly organisationName: string | null;
  readonly organisationRole: string | null;
  readonly userAgent: string | null;
  readonly screenshot: "none" | "clean" | "quarantined" | "error";
  readonly notifiedAt: string | null;
  readonly createdAt: string;
}

export type FeedbackPage =
  | {
      readonly outcome: "loaded";
      readonly rows: readonly FeedbackRow[];
      readonly hasNext: boolean;
      readonly lastCursor: Cursor | null;
    }
  | { readonly outcome: "unavailable" };

function screenshotOf(key: unknown, status: unknown): FeedbackRow["screenshot"] {
  if (typeof key !== "string") return "none";
  return status === "clean" || status === "quarantined" || status === "error"
    ? status
    : "error";
}

export async function fetchFeedbackPage(params: FeedbackParams): Promise<FeedbackPage> {
  const { filters } = params;
  const { pageSize, cursor } = params.list;
  const supabase = await createClient();

  // THE ORGANISATION FILTER resolves a slug to an id first. Nothing found is
  // an EMPTY page, deliberately: a filter the reader set must narrow, never
  // silently widen back to everything.
  let orgId: string | null = null;
  if (filters.orgSlug !== null) {
    const { data: orgRow, error: orgError } = await supabase
      .from("organisations")
      .select("id")
      .eq("slug", filters.orgSlug)
      .maybeSingle();
    if (orgError) {
      console.error("[feedback] organisation slug lookup failed:", orgError.message);
      return { outcome: "unavailable" };
    }
    if (!orgRow) return { outcome: "loaded", rows: [], hasNext: false, lastCursor: null };
    orgId = orgRow.id as string;
  }

  let query = supabase
    .from("feedback")
    .select(
      "id, category, status, message, route, user_email, organisation_id, organisation_role, user_agent, screenshot_key, screenshot_scan_status, notified_at, created_at",
    );

  // ALLOWLISTED FILTERS: every value passed a closed allowlist in
  // parseFeedbackParams; nothing a request supplies reaches the query as a
  // column or an operator.
  if (orgId !== null) query = query.eq("organisation_id", orgId);
  if (filters.category !== null) query = query.eq("category", filters.category);
  if (filters.status !== null) query = query.eq("status", filters.status);
  if (filters.from !== null) query = query.gte("created_at", `${filters.from}T00:00:00Z`);
  if (filters.to !== null) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);
  if (params.list.q !== "") {
    query = query.ilike(FEEDBACK_SPEC.searchColumn, containsPattern(params.list.q));
  }

  // THE KEYSET PREDICATE, lib/list/query.ts's two-part shape.
  if (cursor) {
    const quoted = quoteLogicValue(cursor.value);
    query = query
      .lte("created_at", cursor.value)
      .or(`created_at.lt.${quoted},and(created_at.eq.${quoted},id.lt.${cursor.id})`);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (error) {
    console.error("[feedback] list failed:", error.message);
    return { outcome: "unavailable" };
  }

  const raw = data ?? [];
  const more = raw.length > pageSize;
  const rows = more ? raw.slice(0, pageSize) : raw;

  const orgIds = [
    ...new Set(
      rows
        .map((row) => row.organisation_id as string | null)
        .filter((id): id is string => id !== null),
    ),
  ];
  let names = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgRows, error: nameError } = await supabase
      .from("organisations")
      .select("id, name")
      .in("id", orgIds);
    if (nameError) {
      console.error("[feedback] organisation name lookup failed:", nameError.message);
    } else {
      names = new Map((orgRows ?? []).map((row) => [row.id as string, row.name as string]));
    }
  }

  const mapped: FeedbackRow[] = rows.map((row) => ({
    id: row.id as string,
    category: row.category as string,
    status: row.status as string,
    message: row.message as string,
    route: row.route as string,
    userEmail: (row.user_email as string | null) ?? null,
    organisationName:
      row.organisation_id === null
        ? null
        : (names.get(row.organisation_id as string) ?? "(unknown workspace)"),
    organisationRole: (row.organisation_role as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    screenshot: screenshotOf(row.screenshot_key, row.screenshot_scan_status),
    notifiedAt: (row.notified_at as string | null) ?? null,
    createdAt: row.created_at as string,
  }));

  const lastRow = mapped[mapped.length - 1];
  const lastCursor: Cursor | null = lastRow
    ? { value: lastRow.createdAt, id: lastRow.id, sort: "created_at" }
    : null;

  return { outcome: "loaded", rows: mapped, hasNext: more, lastCursor };
}

export function buildFeedbackNextHref(
  basePath: string,
  params: FeedbackParams,
  raw: RawSearchParams,
  cursor: Cursor,
): string {
  return buildListHref(FEEDBACK_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: { direction: "after", cursor },
  });
}

export function buildFeedbackSelfHref(
  basePath: string,
  params: FeedbackParams,
  raw: RawSearchParams,
): string {
  return buildListHref(FEEDBACK_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: params.list.cursor ? { direction: "after", cursor: params.list.cursor } : null,
  });
}
