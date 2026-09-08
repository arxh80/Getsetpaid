import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import {
  displayStatus,
  isLive,
  listOrganisationImpersonationRequests,
} from "@/lib/admin/impersonation-list";
import { IMPERSONATION_TIME_BOX_MINUTES } from "@/lib/admin/impersonation-session";
import { formatDateTime } from "@/lib/format/date";
import {
  AcceptImpersonationForm,
  DeclineImpersonationForm,
  RevokeImpersonationForm,
} from "@/components/admin/impersonation-actions";
import { ImpersonationStatusChip } from "@/components/admin/impersonation-status-chip";
import { Alert } from "@/components/ui/alert";

// PHASE 7 TASK 2: the CUSTOMER's half of break-glass impersonation -- the
// consent screen, inside their own workspace.
//
// ===========================================================================
// WHY THIS IS AN ORG ROUTE AND NOT A SECOND SUPERUSER SCREEN
// ===========================================================================
// CLAUDE.md § Superuser dashboard: "the org's admin must accept the request".
// A consent an operator can grant on the operator's own dashboard is not
// consent, so the accept control lives where only the customer can reach it,
// behind their own manage_organisation permission, on their own domain of the
// application. The superuser cannot see this page for a workspace they are
// impersonating either -- manage_organisation is not in the read-only
// envelope private.impersonated_organisations() grants (Q96), so the sidebar
// item does not render and this page 404s for them, which is the correct and
// slightly delicious outcome: support access cannot be used to extend itself.
//
// ===========================================================================
// THERE IS NO NOTIFICATION. THIS PAGE IS THE WHOLE DISCOVERY SURFACE.
// ===========================================================================
// Q45, the same answer `reminder_at` and connection requests got: there is no
// notification subsystem at MVP. An impersonation request is discovered by
// visiting this page (linked from the sidebar's Admin group for
// manage_organisation holders) and by nothing else -- not email, not a toast.
// The email fold-in later in Phase 7 is where that changes; until then a
// support engineer's practical move is to tell the customer they have sent
// one, which is stated in the page copy rather than left to be discovered.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/support-access">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org || !(await hasPermission(org.id, "manage_organisation"))) {
    return { title: "Not found · GetSetPaid" };
  }
  return { title: `Support access · ${org.name} · GetSetPaid` };
}

export default async function SupportAccessPage({
  params,
}: PageProps<"/[orgSlug]/support-access">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  // A RECORD-LEVEL REFUSAL, SO THE STREAMED NOT-FOUND CONTRACT APPLIES
  // (DESIGN.md § Error pages): a member without manage_organisation gets the
  // identical document a stranger gets, never a 403 and never a "you don't
  // have permission" that confirms the page exists. The database refuses
  // independently -- impersonation_sessions_select_target_admin returns no
  // rows without the permission -- so this is the render decision, not the
  // enforcement.
  if (!(await hasPermission(org.id, "manage_organisation"))) notFound();

  const rows = await listOrganisationImpersonationRequests(org.id);
  const now = new Date();
  const pending = rows.filter((row) => row.status === "requested");
  const live = rows.filter((row) => isLive(row, now));
  const history = rows.filter(
    (row) => row.status !== "requested" && !isLive(row, now),
  );

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Support access
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          GetSetPaid support cannot see anything in this workspace unless you
          let them. When they need to, they ask here, with a reason. If you
          accept, they get a read-only view for{" "}
          <span className="tabular-nums">{IMPERSONATION_TIME_BOX_MINUTES}</span>{" "}
          minutes — they can look, and change nothing — and every page they
          open is written to the audit record. You can end it at any moment.
        </p>
        <p className="max-w-prose text-sm text-ink-muted">
          Nothing notifies you when a request arrives; this page is where they
          appear.
        </p>
      </div>

      {org.isSuspended ? (
        <Alert tone="info">
          This workspace is suspended, so it is read-only — which includes
          answering support-access requests. Contact GetSetPaid support to have
          it reinstated first.
        </Alert>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">Waiting for you</h2>
        {pending.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            No open requests. Nobody at GetSetPaid can see this workspace.
          </p>
        ) : (
          <ul className="flex flex-col border-t border-rule">
            {pending.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 border-b border-rule py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-base font-semibold text-ink">
                    GetSetPaid support
                  </span>
                  <ImpersonationStatusChip status={displayStatus(row, now)} />
                  <span className="text-sm text-ink-muted tabular-nums">
                    Asked {formatDateTime(row.requestedAt)}
                  </span>
                </div>
                <p className="max-w-prose text-base text-ink">{row.reason}</p>
                <div className="flex flex-wrap items-start gap-3">
                  <AcceptImpersonationForm
                    orgSlug={org.slug}
                    sessionId={row.id}
                    subject={`request of ${formatDateTime(row.requestedAt)}`}
                  />
                  <DeclineImpersonationForm
                    orgSlug={org.slug}
                    sessionId={row.id}
                    subject={`request of ${formatDateTime(row.requestedAt)}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Open right now</h2>
        {live.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            No support session is running.
          </p>
        ) : (
          <ul className="flex flex-col border-t border-rule">
            {live.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 border-b border-rule py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-base font-semibold text-ink">
                    GetSetPaid support
                  </span>
                  <ImpersonationStatusChip status={displayStatus(row, now)} />
                  {row.expiresAt ? (
                    <span className="text-sm text-ink-muted tabular-nums">
                      Ends {formatDateTime(row.expiresAt)}
                    </span>
                  ) : null}
                </div>
                <p className="max-w-prose text-base text-ink">{row.reason}</p>
                <div>
                  <RevokeImpersonationForm
                    orgSlug={org.slug}
                    sessionId={row.id}
                    subject={`session started ${row.startedAt ? formatDateTime(row.startedAt) : ""}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">History</h2>
        {history.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            Nothing yet. Every request, refusal and session shows here
            permanently once it is answered.
          </p>
        ) : (
          <ul className="flex flex-col border-t border-rule">
            {history.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 border-b border-rule py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <ImpersonationStatusChip status={displayStatus(row, now)} />
                  <span className="text-sm text-ink-muted tabular-nums">
                    Asked {formatDateTime(row.requestedAt)}
                    {row.endedAt ? `, ended ${formatDateTime(row.endedAt)}` : null}
                    {row.declinedAt
                      ? `, declined ${formatDateTime(row.declinedAt)}`
                      : null}
                  </span>
                </div>
                <p className="max-w-prose text-base text-ink">{row.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
