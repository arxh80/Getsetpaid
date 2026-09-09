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

/** The ceiling on the alert list. Not a page size -- the working list an
 *  operator triages; the full history ages out by resolution, and a platform
 *  with 50+ open alerts has a bigger problem than pagination. */
export const INCIDENT_ALERT_LIST_LIMIT = 50;

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

export interface IncidentAlertRow {
  readonly id: string;
  /** Usually one of IncidentAlertType -- deliberately `string`, the
   *  overrides-list M4 rule: an unmirrored type must still be listed and
   *  resolvable, rendered raw, never filtered into invisibility. */
  readonly alertType: string;
  readonly organisationName: string | null;
  readonly summary: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/**
 * Open alerts first (newest first), then the most recently raised resolved
 * ones, up to the ceiling. Reads through the caller's own RLS
 * (incident_alerts_select_platform, 20260909020000).
 */
export async function listIncidentAlerts(): Promise<
  readonly IncidentAlertRow[]
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("incident_alerts")
    .select("id, alert_type, organisation_id, summary, created_at, resolved_at")
    .order("resolved_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(INCIDENT_ALERT_LIST_LIMIT);

  if (error) {
    console.error("[admin] incident alert list failed:", error.message);
    return [];
  }

  const rows = data ?? [];
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

  return rows.map((row) => ({
    id: row.id as string,
    alertType: row.alert_type as string,
    organisationName:
      row.organisation_id === null
        ? null
        : (names.get(row.organisation_id as string) ?? "(unknown workspace)"),
    summary: row.summary as string,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  }));
}
