import "server-only";

// The reads behind /super/health: the live platform-health snapshot and the
// incident-alert list.
//
// A SEPARATE MODULE FROM lib/admin/health-actions.ts because that file is
// `"use server"` -- the same split every admin surface here uses
// (lifecycle/lifecycle-list, overrides/overrides-list): a read helper in a
// "use server" module would be published as a callable endpoint for no
// reason.
//
// THE SNAPSHOT IS ONE RPC, NOT A FAN OF POLICY-GATED SELECTS, and the
// difference is the boundary: the numbers aggregate over TENANT tables
// (documents, memberships, subscriptions) that deliberately carry no
// superuser SELECT policy -- adding one would open exactly the direct
// tenant-data read CLAUDE.md § Superuser dashboard forbids. So the
// aggregation happens inside public.platform_health_snapshot()
// (20260909020000), a guarded SECURITY DEFINER function whose projection IS
// the mask: counts, sums and organisation names only, never a record. It is
// also SELF-AUDITING (platform_health.viewed), which is the second reason
// the page must not assemble the numbers from raw reads: a hand-rolled
// aggregate would be a superuser access that did not audit itself.
//
// PARSED DEFENSIVELY: the RPC returns jsonb, and this module owns turning it
// into a typed shape. A missing or non-numeric field renders as null ("not
// available"), never as 0 -- on a health surface, "0 quarantined uploads" and
// "could not read the quarantine count" are different claims, the same
// three-way honesty ListPage keeps.

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

export interface PlatformHealthSnapshot {
  readonly generatedAt: string | null;
  readonly organisations: {
    readonly active: number | null;
    readonly suspended: number | null;
    readonly deleted: number | null;
    readonly total: number | null;
    readonly created7d: number | null;
    readonly created30d: number | null;
  };
  readonly users: {
    readonly total: number | null;
    readonly created7d: number | null;
    readonly created30d: number | null;
  };
  readonly membershipsActive: number | null;
  readonly subscriptions: {
    readonly declaredSeats: number | null;
    readonly pastPeriodEnd: number | null;
    readonly byPlan: readonly { plan: string; count: number }[];
  };
  readonly storage: {
    readonly totalBytes: number | null;
    readonly documents: number | null;
  };
  readonly storageTopOrganisations: readonly {
    readonly name: string;
    readonly slug: string;
    readonly bytes: number;
    readonly documents: number;
  }[];
  readonly abuse: {
    readonly rateLimitTrips24h: number | null;
    readonly repeatedLoginFailures24h: number | null;
    readonly quarantinedUploads24h: number | null;
    readonly quarantinedDocumentsTotal: number | null;
    readonly openAlerts: number | null;
  };
}

export type PlatformHealthOutcome =
  | { readonly outcome: "loaded"; readonly snapshot: PlatformHealthSnapshot }
  | { readonly outcome: "unavailable" };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The live snapshot. Guarded (42501 for anyone but the superuser at aal2)
 * and self-audited inside the RPC; the page above still calls isSuperuser()
 * and notFound()s, because a page rendering an error to a stranger has told
 * them the route exists.
 */
export async function loadPlatformHealthSnapshot(): Promise<PlatformHealthOutcome> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_health_snapshot");

  if (error || typeof data !== "object" || data === null) {
    // LOUD IN THE LOG, HONEST ON THE PAGE: unlike the overrides list, a
    // failed snapshot has no other surface carrying the same numbers, so the
    // page renders a real error state rather than silently showing nothing.
    console.error(
      "[admin] platform_health_snapshot() failed:",
      error?.message ?? "no data returned",
    );
    return { outcome: "unavailable" };
  }

  const root = obj(data);
  const orgs = obj(root.organisations);
  const users = obj(root.users);
  const subs = obj(root.subscriptions);
  const storage = obj(root.storage);
  const abuse = obj(root.abuse);

  const byPlanRaw = obj(subs.by_plan);
  const byPlan = Object.entries(byPlanRaw)
    .map(([plan, count]) => ({ plan, count: num(count) ?? 0 }))
    .sort((a, b) => a.plan.localeCompare(b.plan));

  const topRaw = Array.isArray(root.storage_top_organisations)
    ? root.storage_top_organisations
    : [];
  const storageTopOrganisations = topRaw.flatMap((entry) => {
    const row = obj(entry);
    if (typeof row.name !== "string" || typeof row.slug !== "string") return [];
    return [
      {
        name: row.name,
        slug: row.slug,
        bytes: num(row.bytes) ?? 0,
        documents: num(row.documents) ?? 0,
      },
    ];
  });

  return {
    outcome: "loaded",
    snapshot: {
      generatedAt: typeof root.generated_at === "string" ? root.generated_at : null,
      organisations: {
        active: num(orgs.active),
        suspended: num(orgs.suspended),
        deleted: num(orgs.deleted),
        total: num(orgs.total),
        created7d: num(orgs.created_7d),
        created30d: num(orgs.created_30d),
      },
      users: {
        total: num(users.total),
        created7d: num(users.created_7d),
        created30d: num(users.created_30d),
      },
      membershipsActive: num(root.memberships_active),
      subscriptions: {
        declaredSeats: num(subs.declared_seats),
        pastPeriodEnd: num(subs.past_period_end),
        byPlan,
      },
      storage: {
        totalBytes: num(storage.total_bytes),
        documents: num(storage.documents),
      },
      storageTopOrganisations,
      abuse: {
        rateLimitTrips24h: num(abuse.rate_limit_trips_24h),
        repeatedLoginFailures24h: num(abuse.repeated_login_failures_24h),
        quarantinedUploads24h: num(abuse.quarantined_uploads_24h),
        quarantinedDocumentsTotal: num(abuse.quarantined_documents_total),
        openAlerts: num(abuse.open_alerts),
      },
    },
  };
}

// THE FLAT 50-ROW CEILING IS GONE (fix round 1, M5). It used to live here as
// INCIDENT_ALERT_LIST_LIMIT, with the comment "a platform with 50+ open alerts
// has a bigger problem than pagination". Finding I1 is that bigger problem:
// one account could file roughly two alerts a minute, and the ceiling turned
// that into real alerts being unreachable from the UI entirely. The page size
// now comes from lib/list/params.ts's own ceiling, through
// INCIDENT_ALERT_SPEC, and the list is a keyset pager with two filters.

export type IncidentAlertType =
  | "rate_limit_tripped"
  | "repeated_login_failures"
  | "upload_quarantined";

export const INCIDENT_ALERT_TYPE_LABELS: Record<IncidentAlertType, string> = {
  rate_limit_tripped: "Rate limit tripped",
  repeated_login_failures: "Repeated failed sign-ins",
  upload_quarantined: "Upload quarantined",
};

export function isIncidentAlertType(value: string): value is IncidentAlertType {
  return value in INCIDENT_ALERT_TYPE_LABELS;
}

/** The three scopes `public.rate_limit_policies.subject_scope` permits. An
 *  `upload_quarantined` alert has none (its `details` carry a document id),
 *  and anything unrecognised is dropped rather than rendered: `details` is
 *  written only by this schema's own definer functions, but a platform
 *  surface should not be the place that assumption is first tested. */
const SUBJECT_SCOPES = new Set(["user", "organisation", "account"]);

function subjectScopeOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const scope = (details as Record<string, unknown>).subject_scope;
  return typeof scope === "string" && SUBJECT_SCOPES.has(scope) ? scope : null;
}

export interface IncidentAlertRow {
  readonly id: string;
  /** Usually one of IncidentAlertType -- deliberately `string`, the
   *  overrides-list M4 rule: an unmirrored type must still be listed and
   *  resolvable, rendered raw, never filtered into invisibility. */
  readonly alertType: string;
  readonly organisationName: string | null;
  /**
   * `details.subject_scope` -- "user", "organisation" or "account" -- when the
   * writer recorded one.
   *
   * FIX ROUND 1, REVIEW FINDING I1. `organisationName` used to be the ONLY
   * attribution this page rendered, which made a null one read as "no
   * information" rather than as the fact it is. A user-scoped crossing
   * (`search`, `network_discovery`) now carries no organisation at all by
   * construction -- `public.consume_rate_limit()` refuses to attribute one
   * (`20260909050000`) -- so the operator needs to be told WHAT the alert is
   * about instead of being left to infer a workspace. Identifiers only: the
   * scope is a three-value enum from the limiter, never user-entered content.
   */
  readonly subjectScope: string | null;
  readonly summary: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** Which alerts the operator is looking at. `any` is the default because a
 *  resolved alert is still evidence and the e2e/UI both rest on a row staying
 *  listed after it is resolved. */
export type IncidentAlertStatusFilter = "any" | "open" | "resolved";

export interface IncidentAlertFilters {
  readonly alertType: IncidentAlertType | null;
  readonly status: IncidentAlertStatusFilter;
}

export interface IncidentAlertParams {
  readonly filters: IncidentAlertFilters;
  /** The lib/list/ half: pageSize and cursor. Kept whole rather than picked
   *  apart, because buildListHref (the "Next" link) needs the same shape back. */
  readonly list: ListParams<IncidentAlertSort, never>;
}

export type IncidentAlertSort = "created_at";

/**
 * The minimal `ListSpec` this surface needs -- the audit-log viewer's shape,
 * for the audit-log viewer's reason.
 *
 * `tests/unit/list/one-cursor-only.test.ts` enforces as a source census that
 * `encodeCursor`/`decodeCursor` are called from nowhere but `lib/list` itself,
 * and allows exactly one indirection: a wrapper whose own module calls
 * `parseListParams`. So this file declares a real spec and goes through
 * `parseListParams`/`buildListHref` for the cursor and the page-size ceiling,
 * rather than growing a second cursor format one refactor away from
 * disagreeing with the first. The two real filters below are not
 * `FilterChoice`-shaped in a way the spec could carry through
 * `applyFilters` (this list is not read by `fetchListPage` at all -- it has no
 * `organisation_id` to scope to and is superuser-only), so they are parsed
 * here and applied directly.
 */
export const INCIDENT_ALERT_SPEC: ListSpec<IncidentAlertSort, never> =
  defineListSpec({
    entity: "incident_alerts",
    noun: { one: "alert", many: "alerts" },
    searchColumn: "summary",
    searchLabel: "Search alerts",
    sort: {
      created_at: {
        column: "created_at",
        label: "Raised",
        defaultDirection: "desc",
        directionLabels: { asc: "Oldest first", desc: "Newest first" },
        notNull: true,
        backedBy: "incident_alerts_created_at_id_desc_idx",
      },
    },
    defaultSort: "created_at",
    filters: {},
  });

/** Query-string keys for the two real filters. Distinct from lib/list's own
 *  reserved set (q/sort/dir/size/after/before), so buildListHref's `preserve`
 *  carries them through a "Next" click untouched. */
export const INCIDENT_ALERT_FILTER_PARAMS = {
  alertType: "type",
  status: "status",
} as const;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? (value[0] ?? null) : null;
  return typeof value === "string" ? value : null;
}

/**
 * Parse one request's query string. Never throws; a stale or hostile value
 * degrades to "no filter", the same rule `parseListParams` and `decodeCursor`
 * already follow.
 */
export function parseIncidentAlertParams(
  raw: RawSearchParams,
): IncidentAlertParams {
  const list = parseListParams(INCIDENT_ALERT_SPEC, raw);

  const typeRaw = firstParam(raw[INCIDENT_ALERT_FILTER_PARAMS.alertType]);
  const statusRaw = firstParam(raw[INCIDENT_ALERT_FILTER_PARAMS.status]);

  return {
    filters: {
      alertType:
        typeRaw !== null && isIncidentAlertType(typeRaw) ? typeRaw : null,
      status:
        statusRaw === "open" || statusRaw === "resolved" ? statusRaw : "any",
    },
    list,
  };
}

/** True when either filter is set -- drives the "no matches" vs "nothing yet"
 *  copy the same way `isNarrowed()` does for entity lists. */
export function incidentAlertIsFiltered(filters: IncidentAlertFilters): boolean {
  return filters.alertType !== null || filters.status !== "any";
}

export type IncidentAlertPage =
  | {
      readonly outcome: "loaded";
      readonly rows: readonly IncidentAlertRow[];
      readonly hasNext: boolean;
      readonly lastCursor: Cursor | null;
    }
  | { readonly outcome: "unavailable" };

/**
 * One page of alerts, newest first, through the caller's own RLS
 * (incident_alerts_select_platform, 20260909020000).
 *
 * ===========================================================================
 * FIX ROUND 1, MINOR M5: THIS WAS A FLAT `limit 50` WITH NO CURSOR
 * ===========================================================================
 * That met CLAUDE.md's page-size ceiling and not its "Paginate everything. No
 * unbounded list endpoint" rule, and finding I1 is what made the difference
 * matter rather than being a nicety: alerts a single account could file at
 * roughly two a minute would push every real one off the operator's only
 * triage surface, unreachable from the UI at all. So: a keyset pager and two
 * filters.
 *
 * ORDERED NEWEST-FIRST, NOT OPEN-FIRST, and that is the trade the pager
 * demands. "Open first, then newest" is a two-key order over a nullable
 * column, which a `(value, id)` cursor cannot express -- and a pager that
 * cannot express its own order is how a row gets skipped between pages. The
 * capability is not lost: `status=open` is one click, and it is a better
 * answer than an implicit sort, because it also bounds the count.
 *
 * FORWARD-ONLY, the audit log's reasoning: an exact count over a
 * platform-wide table on every page load is the unbounded aggregate the
 * cursor exists to avoid, and "Next" plus a bounded page size is what
 * "paginate everything" actually asks for.
 */
export async function fetchIncidentAlertPage(
  params: IncidentAlertParams,
): Promise<IncidentAlertPage> {
  const { filters } = params;
  const { pageSize, cursor } = params.list;
  const supabase = await createClient();

  let query = supabase
    .from("incident_alerts")
    .select(
      "id, alert_type, organisation_id, details, summary, created_at, resolved_at",
    );

  // THE ALLOWLISTED FILTERS: two columns, two fixed operators, and both values
  // already passed the allowlist in parseIncidentAlertParams -- nothing a
  // request supplies reaches the query as a column name or an operator.
  if (filters.alertType !== null) {
    query = query.eq("alert_type", filters.alertType);
  }
  if (filters.status === "open") query = query.is("resolved_at", null);
  if (filters.status === "resolved") {
    query = query.not("resolved_at", "is", null);
  }

  // THE KEYSET PREDICATE. The same two-part shape lib/list/query.ts documents
  // at length: a redundant range bound the planner can push into
  // incident_alerts_created_at_id_desc_idx, plus the OR'd exact tie-break that
  // is the only way PostgREST's grammar can express a row-value comparison.
  if (cursor) {
    const quoted = quoteLogicValue(cursor.value);
    query = query
      .lte("created_at", cursor.value)
      .or(
        `created_at.lt.${quoted},and(created_at.eq.${quoted},id.lt.${cursor.id})`,
      );
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // The spare row answers "is there a next page" without a second,
    // unbounded count query.
    .limit(pageSize + 1);

  if (error) {
    console.error("[admin] incident alert list failed:", error.message);
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
    const { data: orgRows, error: orgError } = await supabase
      .from("organisations")
      .select("id, name")
      .in("id", orgIds);
    if (orgError) {
      console.error(
        "[admin] organisation name lookup for alerts failed:",
        orgError.message,
      );
    } else {
      names = new Map(
        (orgRows ?? []).map((row) => [row.id as string, row.name as string]),
      );
    }
  }

  const mapped: IncidentAlertRow[] = rows.map((row) => ({
    id: row.id as string,
    alertType: row.alert_type as string,
    organisationName:
      row.organisation_id === null
        ? null
        : (names.get(row.organisation_id as string) ?? "(unknown workspace)"),
    subjectScope: subjectScopeOf(row.details),
    summary: row.summary as string,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  }));

  const lastRow = mapped[mapped.length - 1];
  // `sort: "created_at"` -- INCIDENT_ALERT_SPEC's one sort key, and the only
  // value parseListParams will accept back: a cursor made under any other
  // sort is discarded.
  const lastCursor: Cursor | null = lastRow
    ? { value: lastRow.createdAt, id: lastRow.id, sort: "created_at" }
    : null;

  return { outcome: "loaded", rows: mapped, hasNext: more, lastCursor };
}

/**
 * The "Next" page's href. Delegates to lib/list/params.ts's buildListHref --
 * the one sanctioned `encodeCursor` call site -- carrying the request's own
 * searchParams through `preserve` so the two filters survive the click.
 */
export function buildIncidentAlertNextHref(
  basePath: string,
  params: IncidentAlertParams,
  raw: RawSearchParams,
  cursor: Cursor,
): string {
  return buildListHref(INCIDENT_ALERT_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: { direction: "after", cursor },
  });
}

/**
 * The href for the CURRENT view. A disabled "Next" keeps `aria-disabled`
 * rather than leaving the tab order, so it stays activatable by keyboard --
 * and activating it must be a no-op on the page the reader is already on,
 * never a jump to an unfiltered page one. Same shape, same reason, as
 * `buildAuditLogSelfHref`.
 */
export function buildIncidentAlertSelfHref(
  basePath: string,
  params: IncidentAlertParams,
  raw: RawSearchParams,
): string {
  return buildListHref(INCIDENT_ALERT_SPEC, basePath, params.list, {
    preserve: raw,
    cursor: params.list.cursor
      ? { direction: "after", cursor: params.list.cursor }
      : null,
  });
}
