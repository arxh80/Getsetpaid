import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  fetchIncidentAlertPage,
  loadPlatformHealthSnapshot,
  parseIncidentAlertParams,
  type PlatformHealthSnapshot,
} from "@/lib/admin/health";
import type { RawSearchParams } from "@/lib/list/params";
import { IncidentAlertList } from "@/components/admin/incident-alert-list";
import { formatDateTime } from "@/lib/format/date";
import { humanFileSize } from "@/lib/format/bytes";

// PHASE 7 TASK 5: the platform health view + the incident-alert list.
//
// CLAUDE.md § Superuser dashboard: "basic counts only at MVP (active orgs,
// signups, seat/storage usage, error counts), queried on-demand/daily from
// Postgres directly -- no separate metrics/observability pipeline" and
// "basic trigger-based ... alerts ... not a full alerting platform".
//
// AGGREGATES ONLY, AND THE MASK IS THE RPC, NOT THIS PAGE. Every number here
// comes from public.platform_health_snapshot() (20260909020000), whose
// projection is counts, sums and organisation names -- the same disclosure
// /super/organisations already makes -- so nothing this page could render is
// a tenant record. Viewing it is itself audited (platform_health.viewed),
// inside the RPC, before anything is read.
//
// generateMetadata(), NOT a static export -- the same enumeration-oracle fix
// every /super/* page carries: a static title would carry "Superuser" into
// the streamed refusal a non-superuser receives.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Platform health · Superuser · GetSetPaid" };
}

/** A number, or the honest admission that we could not read one. "0" and
 *  "not available" are different claims on a health surface. */
function Count({ value }: { value: number | null }) {
  return value === null ? (
    <span className="text-ink-muted">—</span>
  ) : (
    <span className="tabular-nums">{value}</span>
  );
}

function StatRow({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-2">
      <dt className="text-base text-ink-muted">
        {label}
        {note ? <span className="block text-sm">{note}</span> : null}
      </dt>
      <dd className="text-base font-semibold text-ink">
        <Count value={value} />
      </dd>
    </div>
  );
}

function SnapshotSections({ snapshot }: { snapshot: PlatformHealthSnapshot }) {
  return (
    <>
      <section className="flex flex-col gap-3 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Workspaces and people</h2>
        <dl className="flex max-w-prose flex-col">
          <StatRow label="Active workspaces" value={snapshot.organisations.active} />
          <StatRow label="Suspended workspaces" value={snapshot.organisations.suspended} />
          <StatRow label="Closed workspaces" value={snapshot.organisations.deleted} />
          <StatRow
            label="Workspace signups, last 7 days"
            value={snapshot.organisations.created7d}
          />
          <StatRow
            label="Workspace signups, last 30 days"
            value={snapshot.organisations.created30d}
          />
          <StatRow label="User accounts" value={snapshot.users.total} />
          <StatRow label="New users, last 30 days" value={snapshot.users.created30d} />
          <StatRow label="Active memberships" value={snapshot.membershipsActive} />
        </dl>
      </section>

      <section className="flex flex-col gap-3 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Seats and subscriptions</h2>
        {/* THE TASK A M2 CAVEAT, IN AS MANY WORDS. Presenting the backfilled
            defaults as billed truth would be this page's own version of an
            unimplemented control listed as live. */}
        <p className="max-w-prose text-sm text-ink-muted">
          Declared seats, not billed truth: workspaces that existed before the
          subscription backfill carry a default of one seat and a placeholder
          period end, and nothing reconciles these against a payment processor
          yet.
        </p>
        <dl className="flex max-w-prose flex-col">
          <StatRow label="Declared seats" value={snapshot.subscriptions.declaredSeats} />
          {snapshot.subscriptions.byPlan.map((entry) => (
            <StatRow
              key={entry.plan}
              label={`Workspaces on ${entry.plan}`}
              value={entry.count}
            />
          ))}
          <StatRow
            label="Subscriptions past their period end"
            value={snapshot.subscriptions.pastPeriodEnd}
          />
        </dl>
      </section>

      <section className="flex flex-col gap-3 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Storage</h2>
        <dl className="flex max-w-prose flex-col">
          <div className="flex items-baseline justify-between gap-4 border-b border-rule py-2">
            <dt className="text-base text-ink-muted">Live documents, total size</dt>
            <dd className="text-base font-semibold text-ink tabular-nums">
              {snapshot.storage.totalBytes === null
                ? "—"
                : humanFileSize(snapshot.storage.totalBytes)}
            </dd>
          </div>
          <StatRow label="Live documents" value={snapshot.storage.documents} />
        </dl>
        {snapshot.storageTopOrganisations.length > 0 ? (
          <table className="max-w-prose border-collapse text-base">
            <caption className="pb-2 text-left text-sm text-ink-muted">
              Largest workspaces by stored bytes (top{" "}
              <span className="tabular-nums">
                {snapshot.storageTopOrganisations.length}
              </span>
              )
            </caption>
            <thead>
              <tr className="border-b-2 border-rule text-left">
                <th scope="col" className="py-2 pr-4 font-semibold text-ink">
                  Workspace
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-semibold text-ink">
                  Documents
                </th>
                <th scope="col" className="py-2 text-right font-semibold text-ink">
                  Stored
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.storageTopOrganisations.map((org) => (
                <tr key={org.slug} className="border-b border-rule">
                  <td className="py-2 pr-4 text-ink">{org.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-ink">
                    {org.documents}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink">
                    {humanFileSize(org.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Abuse and errors</h2>
        <dl className="flex max-w-prose flex-col">
          <StatRow
            label="Rate-limit trips, last 24 hours"
            value={snapshot.abuse.rateLimitTrips24h}
          />
          <StatRow
            label="Accounts with repeated failed sign-ins, last 24 hours"
            value={snapshot.abuse.repeatedLoginFailures24h}
          />
          <StatRow
            label="Uploads quarantined, last 24 hours"
            value={snapshot.abuse.quarantinedUploads24h}
          />
          <StatRow
            label="Quarantined documents held"
            value={snapshot.abuse.quarantinedDocumentsTotal}
          />
          <StatRow label="Open incident alerts" value={snapshot.abuse.openAlerts} />
          {/* THE DEFERRAL, MADE VISIBLE (fix round 2, review finding N4). The
              account-holder lockout notification (Q114) is delivered by a run
              bounded at 30 accounts and 120 seconds a tick, and NOTHING reads
              pg_net's response -- so a wrong bearer, a stopped clock or a
              permanently squeezed budget all look exactly like a healthy tick.
              These two lines are the only operator-facing witness that the
              queue exists: the count is how many accounts are waiting, and the
              AGE beside it is what separates a normal one-tick backlog from a
              queue that is not draining at all. */}
          <StatRow
            label="Accounts waiting for a lockout notification"
            note={
              snapshot.abuse.lockoutNotificationsOldestAt
                ? `Oldest waiting since ${formatDateTime(snapshot.abuse.lockoutNotificationsOldestAt)} — if this stops moving, the delivery clock is not draining the queue`
                : "Delivered on the 10-minute clock, 30 accounts a tick"
            }
            value={snapshot.abuse.lockoutNotificationsPending}
          />
        </dl>
      </section>
    </>
  );
}

export default async function PlatformHealthPage({
  searchParams,
}: PageProps<"/super/health">) {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for why
  // the gate lives in each page rather than in the layout.
  if (!(await isSuperuser())) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const alertParams = parseIncidentAlertParams(raw);

  const [health, alerts] = await Promise.all([
    loadPlatformHealthSnapshot(),
    fetchIncidentAlertPage(alertParams),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Platform health
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Live counts, queried on demand — active workspaces, signups, seats,
          storage and abuse signals. Aggregates only, never a tenant’s
          records, and every view of this page is itself audited.
        </p>
      </div>

      {health.outcome === "unavailable" ? (
        <p
          role="status"
          className="max-w-prose border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t
          load the health snapshot just now. Refresh the page to try again —
          the alert list below is read separately.
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-muted">
            Snapshot taken{" "}
            {health.snapshot.generatedAt !== null
              ? formatDateTime(health.snapshot.generatedAt)
              : "just now"}
            . Deeper real-time monitoring stays in the hosting and Supabase
            dashboards — this page is deliberately basic counts.
          </p>
          <SnapshotSections snapshot={health.snapshot} />
        </>
      )}

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Incident alerts</h2>
        <p className="max-w-prose text-sm text-ink-muted">
          Trigger-based rows — a tripped rate limit, repeated failed sign-ins
          on one account, a quarantined upload. Newest first, a page at a time;
          filter by type or narrow to the open ones. Resolving is bookkeeping,
          and it is audited: the row keeps who resolved it and when, and the
          audit log keeps that even after a reopen.
        </p>
        <IncidentAlertList
          page={alerts}
          params={alertParams}
          raw={raw}
          basePath="/super/health"
        />
      </section>
    </div>
  );
}
