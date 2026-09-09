import Link from "next/link";
import type { Cursor } from "@/lib/list/cursor";
import type { RawSearchParams } from "@/lib/list/params";
import {
  INCIDENT_ALERT_FILTER_PARAMS,
  INCIDENT_ALERT_TYPE_LABELS,
  buildIncidentAlertNextHref,
  buildIncidentAlertSelfHref,
  incidentAlertIsFiltered,
  isIncidentAlertType,
  type IncidentAlertPage,
  type IncidentAlertParams,
  type IncidentAlertRow,
} from "@/lib/admin/health";
import { formatDateTime } from "@/lib/format/date";
import { Button } from "@/components/ui/button";
import { ResolveAlertForm } from "@/components/admin/incident-alert-actions";

// The incident-alert list: a filter strip, the rows, and a forward pager.
//
// ===========================================================================
// WHY THIS IS PAGINATED AT ALL (fix round 1, minor M5)
// ===========================================================================
// It shipped as a flat 50-row read, ordered open-first then newest-first, with
// no cursor and no filter, and a comment arguing that "a platform with 50+
// open alerts has a bigger problem than pagination". Review finding I1 is that
// bigger problem: any authenticated account could file roughly two alerts a
// minute, so the ceiling turned a flood into REAL ALERTS BEING UNREACHABLE
// FROM THE UI. CLAUDE.md § Non-negotiable rules does not carve out an
// exception for small lists: "Paginate everything. No unbounded list
// endpoint."
//
// ORDERED NEWEST-FIRST RATHER THAN OPEN-FIRST, and the status filter is what
// replaces the implicit sort — see lib/admin/health.ts's fetchIncidentAlertPage
// for why a two-key order over a nullable column cannot be expressed by a
// (value, id) cursor, and why a pager that cannot express its own order skips
// rows between pages.
//
// A PLAIN NATIVE `<form method="get">`, the audit-log filter strip's idiom and
// for its reasons: no auto-submitting client toolbar for a page with an
// audience of one, and it works with JavaScript off. The cursor is absent from
// the form on purpose — a new filter starts at page one, because a cursor made
// under the old filtered set need not exist in the new one.

const SELECT_CLASS =
  "h-11 w-full min-w-0 border border-rule bg-surface px-3 text-base text-ink " +
  "transition-colors duration-[var(--dur-fast)] ease-brand " +
  "hover:border-ink focus:border-accent";

const LABEL_CLASS = "text-base font-semibold text-ink";

function FilterStrip({
  params,
  basePath,
}: {
  params: IncidentAlertParams;
  basePath: string;
}) {
  const { filters } = params;
  const narrowed = incidentAlertIsFiltered(filters);

  return (
    <form
      action={basePath}
      method="get"
      className="flex flex-wrap items-end gap-x-4 gap-y-4 border-y border-rule py-4"
    >
      <div className="flex min-w-0 basis-64 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="incident-alert-type">
          Alert type
        </label>
        <select
          id="incident-alert-type"
          name={INCIDENT_ALERT_FILTER_PARAMS.alertType}
          defaultValue={filters.alertType ?? ""}
          className={SELECT_CLASS}
        >
          <option value="">Any type</option>
          {Object.entries(INCIDENT_ALERT_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 basis-48 flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="incident-alert-status">
          Status
        </label>
        <select
          id="incident-alert-status"
          name={INCIDENT_ALERT_FILTER_PARAMS.status}
          defaultValue={filters.status}
          className={SELECT_CLASS}
        >
          <option value="any">Open and resolved</option>
          <option value="open">Open only</option>
          <option value="resolved">Resolved only</option>
        </select>
      </div>

      <Button type="submit" variant="secondary">
        Filter
      </Button>

      {narrowed ? (
        <Link
          href={basePath}
          className="flex h-11 items-center text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Clear filters
        </Link>
      ) : null}
    </form>
  );
}

/**
 * WHO OR WHAT AN ALERT IS ABOUT — and, when that is not a workspace, saying so.
 *
 * FIX ROUND 1, REVIEW FINDING I1. This row used to render the organisation
 * name when there was one and NOTHING when there wasn't, which had two
 * problems at once. The forgeable half is fixed in the database
 * (`20260909050000`: a user-scoped category cannot carry a caller-supplied
 * organisation at all, so an alert can no longer name a workspace the caller
 * merely chose). The honest half is here: a `search` or `network_discovery`
 * crossing genuinely has no workspace, and an operator whose next move off an
 * alert is suspend/close or an impersonation request must read that as a fact
 * rather than as a blank. Identifiers only, the discipline the summary keeps.
 */
function AlertAttribution({ alert }: { alert: IncidentAlertRow }) {
  if (alert.organisationName !== null) {
    return (
      <span className="font-normal text-ink-muted">
        {" "}
        · {alert.organisationName}
      </span>
    );
  }
  return (
    <span className="font-normal text-ink-muted">
      {" "}
      · Not attributed to a workspace
      {alert.subjectScope !== null ? ` (${alert.subjectScope}-scoped)` : null}
    </span>
  );
}

function Rows({ alerts }: { alerts: readonly IncidentAlertRow[] }) {
  return (
    <ul className="flex flex-col border-t border-rule">
      {alerts.map((alert) => (
        <li
          key={alert.id}
          className="flex flex-col gap-2 border-b border-rule py-4 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="flex max-w-prose flex-col gap-1">
            <p className="text-base font-semibold text-ink">
              {isIncidentAlertType(alert.alertType)
                ? INCIDENT_ALERT_TYPE_LABELS[alert.alertType]
                : // An unmirrored type renders RAW rather than hidden -- a
                  // live alert must stay findable and resolvable here (the
                  // overrides list's M4 rule).
                  alert.alertType}
              <AlertAttribution alert={alert} />
            </p>
            <p className="text-base text-ink">{alert.summary}</p>
            <p className="text-sm text-ink-muted">
              Raised {formatDateTime(alert.createdAt)}
              {alert.resolvedAt !== null
                ? ` · resolved ${formatDateTime(alert.resolvedAt)}`
                : null}
            </p>
          </div>
          {alert.resolvedAt === null ? (
            <ResolveAlertForm alertId={alert.id} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The disabled "Next" points at the CURRENT view, never at a bare base path.
 * `aria-disabled` keeps the element focusable and activatable by design, so a
 * keyboard user pressing Enter on it must land back on the page they were
 * already reading rather than on an unfiltered page one.
 */
function NextLink({
  basePath,
  params,
  raw,
  enabled,
  cursor,
}: {
  basePath: string;
  params: IncidentAlertParams;
  raw: RawSearchParams;
  enabled: boolean;
  cursor: Cursor | null;
}) {
  const href =
    enabled && cursor
      ? buildIncidentAlertNextHref(basePath, params, raw, cursor)
      : buildIncidentAlertSelfHref(basePath, params, raw);
  return (
    <Link
      href={href}
      aria-disabled={enabled ? undefined : true}
      prefetch={enabled ? undefined : false}
      className={
        "inline-flex h-11 items-center border px-4 text-base font-semibold " +
        "whitespace-nowrap transition-colors duration-[var(--dur-fast)] ease-brand " +
        (enabled
          ? "border-rule bg-surface text-ink hover:border-ink hover:bg-shell"
          : "cursor-not-allowed border-rule bg-surface text-ink-muted")
      }
    >
      Next
    </Link>
  );
}

export function IncidentAlertList({
  page,
  params,
  raw,
  basePath,
}: {
  page: IncidentAlertPage;
  params: IncidentAlertParams;
  raw: RawSearchParams;
  basePath: string;
}) {
  const narrowed = incidentAlertIsFiltered(params.filters);

  if (page.outcome === "unavailable") {
    return (
      <>
        <FilterStrip params={params} basePath={basePath} />
        <p
          role="status"
          className="max-w-prose border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t
          load the incident alerts just now. Refresh the page to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <FilterStrip params={params} basePath={basePath} />

      {page.rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          {narrowed
            ? "No incident alerts match the filters you’ve set."
            : "No incident alerts. They appear here when a rate limit trips, an account accumulates failed sign-ins, or the malware scanner quarantines an upload — and email delivery for new alerts arrives with the notification work later in this phase."}
        </p>
      ) : (
        <>
          <Rows alerts={page.rows} />
          <nav
            aria-label="Pagination for incident alerts"
            className="flex flex-wrap items-center justify-between gap-3 pt-2"
          >
            <p className="text-sm text-ink-muted">
              Showing <span className="tabular-nums">{page.rows.length}</span>{" "}
              {page.rows.length === 1 ? "alert" : "alerts"}
            </p>
            <NextLink
              basePath={basePath}
              params={params}
              raw={raw}
              enabled={page.hasNext && page.lastCursor !== null}
              cursor={page.lastCursor}
            />
          </nav>
        </>
      )}
    </>
  );
}
