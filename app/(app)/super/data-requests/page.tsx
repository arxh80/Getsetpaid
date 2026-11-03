import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import { StepUpGate } from "@/components/auth/step-up-gate";
import {
  fetchDsrNotes,
  fetchDsrQueuePage,
  parseDsrQueueParams,
} from "@/lib/dsr/queue";
import { DSR_ALERT_LEAD_DAYS, DSR_RESPONSE_DAYS, SUPER_DATA_REQUESTS_PATH } from "@/lib/dsr/contract";
import type { RawSearchParams } from "@/lib/list/params";
import { DsrQueue } from "@/components/admin/dsr-queue";

// PHASE 8 TASK 3: the operator's data subject request queue.
//
// WHY /super/data-requests AND NOT /super/requests. The brief permits a better
// name and this is one: the product already has two other kinds of "request"
// on operator surfaces — impersonation requests at /super/impersonation and
// network connection requests inside a workspace — so /super/requests would be
// ambiguous on the very index page that lists them all. It also mirrors
// /account/data-requests, so the two halves of one thing read alike.
//
// generateMetadata(), NOT a static export — the enumeration-oracle fix every
// /super/* page carries: a static title would carry "Superuser" into the
// streamed refusal a non-superuser receives.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Data requests · Superuser · GetSetPaid" };
}

export default async function SuperDataRequestsPage({
  searchParams,
}: PageProps<"/super/data-requests">) {
  // STREAMED, NOT LITERAL — see app/(app)/super/layout.tsx's header.
  if (!(await isSuperuser())) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const params = parseDsrQueueParams(raw);
  const page = await fetchDsrQueuePage(params);
  const notesByRequest =
    page.outcome === "loaded" ? await fetchDsrNotes(page.rows.map((row) => row.id)) : new Map();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Data requests</h1>
        <p className="max-w-prose text-base text-ink-muted">
          What people have asked us to do with their own data, nearest deadline first. The{" "}
          {DSR_RESPONSE_DAYS}-day limit is the ICO’s statutory maximum, not a target: an alert
          is raised {DSR_ALERT_LEAD_DAYS} days out and again the moment one passes, and both
          reach the incident email without anyone opening this page.
        </p>
        <p className="max-w-prose text-base text-ink-muted">
          This page shows the request and who made it. It shows no workspace’s records — the
          standing rule for every operator surface. A request about a business’s own records is
          passed to that business, because it is the controller and we are only its processor.
        </p>
      </div>

      {/* REFUSING A REQUEST IS THE ONE HIGH-RISK ACTION HERE, and
          lib/dsr/admin-actions.ts re-checks step-up server-side whatever this
          renders. The prompt lives at the top of the page, once, rather than
          inside each row's form: StepUpGate is a server component and the
          row controls are client ones, and a prompt per row would be the same
          prompt N times. Progressing, routing and noting are ordinary
          casework and are NOT gated — a prompt on every one of them is a
          prompt people learn to click through. */}
      <section aria-labelledby="step-up-heading" className="flex flex-col gap-3">
        <h2 id="step-up-heading" className="text-lg font-bold text-ink">
          Refusing a request
        </h2>
        <StepUpGate next={SUPER_DATA_REQUESTS_PATH}>
          <p className="max-w-prose text-base text-ink-muted">
            You have re-authenticated recently, so refusing a request is available. Every other
            action on this page needs no confirmation.
          </p>
        </StepUpGate>
      </section>

      <DsrQueue
        page={page}
        params={params}
        raw={raw}
        basePath={SUPER_DATA_REQUESTS_PATH}
        notesByRequest={notesByRequest}
      />
    </div>
  );
}
