import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getOwnDataSubjectRequests, OWN_REQUEST_LIMIT } from "@/lib/dsr/requests";
import {
  DSR_RESPONSE_DAYS,
  DSR_RIGHT_COPY,
  DSR_SCOPE_COPY,
  DSR_STATUS_LABELS,
  NO_ACCOUNT_ROUTE,
  describeDeadline,
  dsrUrgency,
  isDsrRight,
  isDsrScope,
  isDsrStatus,
  isDsrTerminal,
} from "@/lib/dsr/contract";
import { supportContact } from "@/lib/legal/contact";
import { formatDateTime } from "@/lib/format/date";
import { Alert } from "@/components/ui/alert";
import { StatusChip } from "@/components/ui/ruled-row";
import { DataRequestForm } from "@/components/account/data-request-form";
import { DataRequestWithdrawForm } from "@/components/account/data-request-withdraw-form";

export const metadata: Metadata = { title: "Your data protection requests · GetSetPaid" };

// PHASE 8 TASK 3 -- the requester's half: make a request, and track it.
//
// ACCOUNT-LEVEL, beside /account/privacy and for the same reason: these rights
// are the person's own, not their employer's, so the page sits outside
// [orgSlug] and reads nothing tenant-scoped.
//
// WHAT IT NEVER SHOWS: the operator's working notes. They are not omitted
// here -- they are in a different table with no policy that would let this
// session read them at all (Q103). There is nothing to leave out, which is
// the point of the split.
export default async function AccountDataRequestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const state = await getOwnDataSubjectRequests(user.id);
  const supportEmail = supportContact().address;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Your data protection requests
        </h1>
        <p className="max-w-prose text-lg text-ink-muted">
          Ask us to give you a copy of your data, correct it, delete it, limit how it is used,
          stop a use you object to, or hand it to you in a portable file. We respond within{" "}
          {DSR_RESPONSE_DAYS} days.
        </p>
        <p className="max-w-prose text-base text-ink-muted">
          The{" "}
          <Link
            href="/legal/data-subject-rights"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Your Data Protection Rights
          </Link>{" "}
          page explains each right in full, including when we can refuse one and how to
          complain to the Information Commissioner’s Office.
        </p>
      </div>

      <Alert tone="info" live={false}>
        {NO_ACCOUNT_ROUTE}
        {supportEmail ? (
          <>
            {" "}
            <a
              href={`mailto:${supportEmail}`}
              className="underline underline-offset-4 hover:text-ink"
            >
              {supportEmail}
            </a>
            .
          </>
        ) : (
          <>
            {" "}
            (No contact address has been configured on this deployment — see the{" "}
            <Link
              href="/legal/contact"
              prefetch={false}
              className="underline underline-offset-4 hover:text-ink"
            >
              Contact
            </Link>{" "}
            page.)
          </>
        )}
      </Alert>

      <section aria-labelledby="new-request-heading" className="flex flex-col gap-5">
        <h2 id="new-request-heading" className="text-xl font-bold text-ink">
          Make a request
        </h2>
        <DataRequestForm />
      </section>

      <section aria-labelledby="your-requests-heading" className="flex flex-col gap-5">
        <h2 id="your-requests-heading" className="text-xl font-bold text-ink">
          Your requests
        </h2>
        {state.requests.length === 0 ? (
          <p className="max-w-prose text-base text-ink-muted" data-testid="no-requests">
            You have not made a request. When you do, it appears here with its deadline and
            what happened to it.
          </p>
        ) : (
          <>
            <ul className="flex flex-col border-t border-rule">
              {state.requests.map((request) => {
                const urgency = dsrUrgency(request.status, request.dueBy);
                const closed = isDsrTerminal(request.status);
                return (
                  <li
                    key={request.id}
                    className="flex flex-col gap-3 border-b border-rule py-5"
                    data-testid="own-request"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-base font-semibold text-ink">
                        {isDsrRight(request.rightType)
                          ? DSR_RIGHT_COPY[request.rightType].label
                          : request.rightType}
                      </h3>
                      <StatusChip
                        tone={
                          request.status === "fulfilled"
                            ? "active"
                            : closed
                              ? "revoked"
                              : "pending"
                        }
                      >
                        {isDsrStatus(request.status)
                          ? DSR_STATUS_LABELS[request.status]
                          : request.status}
                      </StatusChip>
                    </div>

                    <p className="text-sm text-ink-muted">
                      About:{" "}
                      {isDsrScope(request.subjectScope)
                        ? DSR_SCOPE_COPY[request.subjectScope].label
                        : request.subjectScope}{" "}
                      · Sent{" "}
                      <time dateTime={request.requestedAt} className="tabular-nums">
                        {formatDateTime(request.requestedAt)}
                      </time>{" "}
                      (UK time)
                    </p>

                    <p className="text-sm text-ink-muted" data-testid="own-request-deadline">
                      {closed ? (
                        <>
                          Closed{" "}
                          {request.closedAt ? (
                            <time dateTime={request.closedAt} className="tabular-nums">
                              {formatDateTime(request.closedAt)}
                            </time>
                          ) : null}
                        </>
                      ) : (
                        <>
                          Due by{" "}
                          <time dateTime={request.dueBy} className="tabular-nums">
                            {formatDateTime(request.dueBy)}
                          </time>{" "}
                          — {describeDeadline(request.status, request.dueBy)}
                          {urgency === "overdue"
                            ? ". We are past our own deadline; we are sorry, and it is still being worked on."
                            : ""}
                        </>
                      )}
                    </p>

                    {/* WHAT THEY WROTE, rendered as inert text. Never HTML. */}
                    <p className="max-w-prose text-base whitespace-pre-wrap text-ink">
                      {request.detail}
                    </p>

                    {request.routedAt ? (
                      <p className="max-w-prose text-sm text-ink-muted">
                        We passed this to the business that holds the records, because it — not
                        GetSetPaid — decides what it keeps and why. It is the one that must
                        answer you.
                      </p>
                    ) : null}

                    {request.rejectionReason ? (
                      <div className="flex max-w-prose flex-col gap-1 border-l-2 border-rule pl-4">
                        <p className="text-sm text-ink-muted">Why this was refused</p>
                        <p
                          className="text-base whitespace-pre-wrap text-ink"
                          data-testid="own-request-rejection"
                        >
                          {request.rejectionReason}
                        </p>
                      </div>
                    ) : null}

                    {/* Rendered for every request, open or closed: a
                        successful withdrawal CLOSES the request, and an
                        outcome rendered by a component the revalidated page
                        no longer holds is an outcome nobody reads (Task 1's
                        I1). The component hides its own button instead. */}
                    <DataRequestWithdrawForm requestId={request.id} open={!closed} />
                  </li>
                );
              })}
            </ul>
            {state.truncated ? (
              <p className="text-sm text-ink-muted">
                Showing your most recent {OWN_REQUEST_LIMIT} requests. Older ones are kept and
                are included if you ask us for a copy of your data.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
