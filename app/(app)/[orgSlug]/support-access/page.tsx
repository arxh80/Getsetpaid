import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import {
  displayStatus,
  isLive,
  listOrganisationImpersonationRequests,
  roleWouldAdministerOrganisation,
} from "@/lib/admin/impersonation-list";
import { IMPERSONATION_TIME_BOX_MINUTES } from "@/lib/admin/impersonation-contract";
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
// Q45. `reminder_at` and connection requests are emailed since Phase 8 Task 9b
// job 3 (20261016000000); an impersonation request is not. It is discovered by
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
  if (!org) return { title: "Not found · GetSetPaid" };
  // Mirrors the body's two-reason gate exactly (fix round 1, Important 2).
  // If it did not, a suspended workspace's administrator would read the
  // paused notice under a tab titled "Not found" — and the <title> is the
  // enumeration oracle app/(app)/super/audit-log/page.tsx documents at
  // length, so the two must agree in BOTH directions, not just the refusing
  // one. hasPermission and getCurrentOrg are cache()-wrapped, so agreeing
  // costs no extra round trip.
  const canAdminister = await hasPermission(org.id, "manage_organisation");
  if (
    !canAdminister &&
    !(org.isSuspended && (await roleWouldAdministerOrganisation(org.id)))
  ) {
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
  //
  // ===========================================================================
  // ...WITH ONE EXCEPTION, WHICH IS FIX ROUND 1, IMPORTANT 2
  // ===========================================================================
  // `manage_organisation` has `survives_suspension = false`, so a SUSPENDED
  // workspace's own Owner/Admin fails this check exactly like a stranger --
  // and the Q98 alert further down, written specifically to explain that,
  // could never render. The consequence reached the customer as an
  // unexplained 404 on a page they had been told exists, which is worse than
  // the consequence itself.
  //
  // So there are now TWO reasons to render, not one, and they render
  // DIFFERENT PAGES: the ordinary administrator gets the working surface; a
  // suspended workspace's administrator gets the paused notice and nothing
  // else -- no lists, no controls, no request data (RLS returns them none
  // anyway, which is the point: this branch adds a sentence, not a read).
  //
  // REFUSAL PARITY IS INTACT. The second condition requires `org.isSuspended`
  // AND that the caller's own role grants manage_organisation in the
  // catalogue, so an ordinary member -- suspended workspace or not -- still
  // gets the identical not-found document. Q98 itself is NOT resolved here:
  // accepting is still impossible while suspended, because
  // public.accept_impersonation_request() asks has_permission() and gets
  // false. This makes the refusal legible; it does not soften it.
  const canAdminister = await hasPermission(org.id, "manage_organisation");
  const pausedBySuspension =
    !canAdminister &&
    org.isSuspended &&
    (await roleWouldAdministerOrganisation(org.id));

  if (!canAdminister && !pausedBySuspension) notFound();

  if (pausedBySuspension) {
    // ===========================================================================
    // THE SENTENCE THAT USED TO SIT HERE WAS FALSE IN ONE STATE, AND IT WAS THE
    // STATE THAT MATTERED (pre-merge review finding I1)
    // ===========================================================================
    // It read: "Nobody at GetSetPaid can see this workspace in the meantime."
    // `view_crm` is the one READ key with survives_suspension = true, so a
    // support session that was ALREADY RUNNING when the workspace was suspended
    // keeps reading it (rls_phase7_impersonation.sql § IS6/§ IS7, deliberately).
    // The operator's access survived; the customer's control of it did not, and
    // this page then told them the opposite.
    //
    // 20260921002000 fixes the control half -- `end_support_access` survives
    // suspension, so both the session row and the End control are reachable
    // here. This branch fixes the sentence half: it no longer makes a claim
    // about what support can see. It states only what is actually true of a
    // suspended workspace (nothing new can be accepted) and then SHOWS the
    // running sessions, or their absence, from the database.
    //
    // THE aal2 SPLIT IS WHY THE NEGATIVE CLAIM IS GATED. `hasPermission` carries
    // the aal2 term; `roleWouldAdministerOrganisation` deliberately does not, so
    // an aal1 Owner reaches this explanation and RLS correctly returns them no
    // rows. Telling *them* "no session is running" would be the same untrue
    // sentence in a smaller costume, so they get the second-factor line instead.
    const canEndSupportAccess = await hasPermission(org.id, "end_support_access");
    const now = new Date();
    const liveSessions = canEndSupportAccess
      ? (await listOrganisationImpersonationRequests(org.id)).filter((row) =>
          isLive(row, now),
        )
      : [];

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">
            Support access
          </h1>
          <p className="max-w-prose text-base text-ink-muted">
            GetSetPaid support cannot see anything in this workspace unless you
            let them.
          </p>
        </div>
        <Alert tone="info">
          New support-access requests are <strong>paused</strong> while this
          workspace is suspended. Answering one is a change to the workspace,
          and a suspended workspace is read-only — so nothing can be accepted
          or declined here until it is reinstated. <strong>Access you have
          already granted is not paused</strong>: any session still running is
          listed below and you can end it at any moment. Contact GetSetPaid
          support to have the workspace reinstated.
        </Alert>

        {!canEndSupportAccess ? (
          <p className="max-w-prose text-base text-ink-muted">
            Sign in with your second factor to see whether a support session is
            running and to end it.
          </p>
        ) : liveSessions.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            No support session is running. Nobody at GetSetPaid can see this
            workspace.
          </p>
        ) : (
          <section className="flex flex-col gap-4">
            <h2 className="text-xl font-bold text-ink">Access you have granted</h2>
            <ul className="flex flex-col border-t border-rule">
              {liveSessions.map((row) => (
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
          </section>
        )}
      </div>
    );
  }

  const rows = await listOrganisationImpersonationRequests(org.id);
  const now = new Date();

  // THREE GROUPS, AND THE MIDDLE ONE HOLDS TWO DIFFERENT THINGS ON PURPOSE.
  //
  // FOUND IN THE BROWSER WALK, NOT IN REVIEW. The first cut had `granted`
  // hold only genuinely-live sessions, which put an ACCEPTED-BUT-NOT-STARTED
  // row under the heading "History" -- a request the customer had just said
  // yes to, filed under a word meaning "over". Acceptance and start are
  // deliberately separate (the whole reason `started_at` exists), so there is
  // a real window in which support MAY enter and has not, and the customer's
  // own page has to name it rather than losing it between two headings.
  const pending = rows.filter((row) => row.status === "requested");
  const granted = rows.filter((row) => row.status === "accepted" || isLive(row, now));
  const history = rows.filter(
    (row) =>
      row.status !== "requested" && row.status !== "accepted" && !isLive(row, now),
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

      {/* NO SUSPENDED-WORKSPACE ALERT HERE ANY MORE. It used to sit at this
          point and was unreachable dead code (fix round 1, Important 2): the
          permission gate above fires first for a suspended workspace's own
          administrator, because manage_organisation does not survive
          suspension. Its sentence now lives in the `pausedBySuspension`
          branch above, which is the only state that can actually reach it. */}

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">Waiting for you</h2>
        {pending.length === 0 ? (
          // NO VISIBILITY CLAIM HERE (pre-merge finding I1's second half). It
          // used to add "Nobody at GetSetPaid can see this workspace", which is
          // a statement about SESSIONS made in the section about REQUESTS --
          // false whenever a session is running with no new request pending.
          // The claim belongs to the section that can actually check it, which
          // is "Access you have granted" below.
          <p className="max-w-prose text-base text-ink-muted">
            No open requests.
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
        <h2 className="text-xl font-bold text-ink">Access you have granted</h2>
        {granted.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted">
            Nobody at GetSetPaid can open this workspace.
          </p>
        ) : (
          <ul className="flex flex-col border-t border-rule">
            {granted.map((row) => {
              const running = isLive(row, now);
              return (
                <li key={row.id} className="flex flex-col gap-3 border-b border-rule py-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-base font-semibold text-ink">
                      GetSetPaid support
                    </span>
                    <ImpersonationStatusChip status={displayStatus(row, now)} />
                    {running && row.expiresAt ? (
                      <span className="text-sm text-ink-muted tabular-nums">
                        Ends {formatDateTime(row.expiresAt)}
                      </span>
                    ) : null}
                  </div>
                  <p className="max-w-prose text-base text-ink">{row.reason}</p>
                  {running ? (
                    <div>
                      <RevokeImpersonationForm
                        orgSlug={org.slug}
                        sessionId={row.id}
                        subject={`session started ${row.startedAt ? formatDateTime(row.startedAt) : ""}`}
                      />
                    </div>
                  ) : (
                    // ACCEPTED, NOT STARTED. There is no control here, and
                    // the sentence says so rather than leaving a gap the
                    // reader has to interpret: public.end_impersonation_
                    // session() acts on a RUNNING session, so consent given
                    // cannot currently be taken back in the window before
                    // support opens it. Queued as DECISIONS-QUEUE Q100 with
                    // "no withdraw-after-accept at MVP" as the shipped
                    // default -- the window is minutes in practice, and the
                    // session is still time-boxed and audited the moment it
                    // starts.
                    <p className="max-w-prose text-sm text-ink-muted">
                      Support hasn’t opened this yet. When they do it runs for{" "}
                      <span className="tabular-nums">
                        {IMPERSONATION_TIME_BOX_MINUTES}
                      </span>{" "}
                      minutes and an “End access now” control appears here.
                    </p>
                  )}
                </li>
              );
            })}
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
