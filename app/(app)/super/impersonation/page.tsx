import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import {
  displayStatus,
  isLive,
  listMyImpersonationSessions,
} from "@/lib/admin/impersonation-list";
import { IMPERSONATION_TIME_BOX_MINUTES } from "@/lib/admin/impersonation-session";
import { formatDateTime } from "@/lib/format/date";
import { StepUpGate } from "@/components/auth/step-up-gate";
import { ImpersonationRequestForm } from "@/components/admin/impersonation-request-form";
import {
  EndImpersonationForm,
  StartImpersonationForm,
} from "@/components/admin/impersonation-actions";
import { ImpersonationStatusChip } from "@/components/admin/impersonation-status-chip";

// PHASE 7 TASK 2: the superuser's half of break-glass impersonation.
//
// CLAUDE.md § Superuser dashboard: "Break-glass only: the superuser requests
// impersonation, the org's admin must accept the request, and the session is
// time-boxed and fully audited... No silent or unilateral impersonation." This
// page is the request and the start; the accept lives in the customer's own
// workspace (app/(app)/[orgSlug]/support-access/page.tsx), which is the whole
// point -- there is no control anywhere on this page that grants access
// without a customer having said yes first.
//
// generateMetadata(), NOT a static `export const metadata` -- the same fix
// app/(app)/super/audit-log/page.tsx carries and for the identical reason: a
// static export is evaluated regardless of what the page body decides, so the
// tab title would carry "Superuser" into the STREAMED refusal a non-superuser
// receives even though the body correctly does not. That is an enumeration
// oracle, measured directly by tests/e2e/impersonation.spec.ts's
// expectStreamedRefusal. isSuperuser() is cache()-wrapped, so calling it here
// AND in the body costs one RPC per request.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Impersonation · Superuser · GetSetPaid" };
}

export default async function ImpersonationPage() {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for why
  // the gate lives in each page rather than in the layout. This runs below
  // this route's own loading.tsx boundary, so a refusal streams HTTP 200 plus
  // the identical app/(app)/not-found.tsx document.
  if (!(await isSuperuser())) notFound();

  const sessions = await listMyImpersonationSessions();
  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Impersonation
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Break-glass support access to one workspace, read-only, for{" "}
          <span className="tabular-nums">{IMPERSONATION_TIME_BOX_MINUTES}</span>{" "}
          minutes. An Owner or Admin of that workspace has to accept before
          anything is visible, and every page you open is written to the audit
          log against the session.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">Request access</h2>
        {/* STEP-UP (CLAUDE.md § Session security: required before "any
            high-risk admin/superuser function (including impersonation)").
            The gate decides what to RENDER; lib/admin/impersonation.ts's
            actions re-check it server-side, because hiding a form is not
            enforcement. */}
        <StepUpGate next="/super/impersonation">
          <ImpersonationRequestForm />
        </StepUpGate>
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Your sessions</h2>
        {sessions.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            No impersonation sessions yet. Request one above — it will appear
            here waiting for the workspace to accept.
          </p>
        ) : (
          <ul className="flex flex-col border-t border-rule">
            {sessions.map((session) => {
              const shown = displayStatus(session, now);
              const live = isLive(session, now);
              return (
                <li
                  key={session.id}
                  className="flex flex-col gap-3 border-b border-rule py-4"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-base font-semibold text-ink">
                      {session.organisationName || session.organisationSlug}
                    </span>
                    <ImpersonationStatusChip status={shown} />
                    <span className="text-sm text-ink-muted tabular-nums">
                      Requested {formatDateTime(session.requestedAt)}
                    </span>
                  </div>

                  {/* The reason, echoed back. It is what the customer read
                      before deciding, so it is what this row is about. */}
                  <p className="max-w-prose text-base text-ink">{session.reason}</p>

                  {live && session.expiresAt ? (
                    <p className="text-sm text-ink-muted">
                      Ends at{" "}
                      <span className="tabular-nums">
                        {formatDateTime(session.expiresAt)}
                      </span>
                      .
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3">
                    {session.status === "accepted" ? (
                      <StartImpersonationForm
                        sessionId={session.id}
                        subject={session.organisationName || session.organisationSlug}
                      />
                    ) : null}
                    {live ? (
                      <>
                        {/* A plain link into the tenant. It grants nothing on
                            its own -- the grant is the live session row, read
                            by private.impersonated_organisations() on every
                            permission check -- so this is a shortcut, not a
                            door. With no live session the same URL 404s. */}
                        <Link
                          href={`/${session.organisationSlug}`}
                          className="text-base font-semibold text-primary underline underline-offset-4 hover:text-ink"
                        >
                          Open workspace
                        </Link>
                        <EndImpersonationForm
                          sessionId={session.id}
                          subject={
                            session.organisationName || session.organisationSlug
                          }
                        />
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
