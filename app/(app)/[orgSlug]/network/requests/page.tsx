import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess } from "@/lib/network/access";
import type { RawSearchParams } from "@/lib/list/params";
import {
  ReceivedRequestsResults,
  SentRequestsResults,
} from "@/components/network/requests-results";
import { Alert } from "@/components/ui/alert";

// Task 4: the requests inbox/outbox. Two lists on one route (Received, Sent),
// Constraint 10 -- see lib/network/requests-list.ts's header for the distinct
// paramPrefixes (`req_in_`, `req_out_`) and why this route carries no
// ListToolbar.
//
// ===========================================================================
// THIS PAGE, PLUS THE HUB COUNT, IS THE WHOLE DISCOVERY SURFACE
// ===========================================================================
// CLAUDE.md's `reminder_at` precedent and Q45: there is no notification
// subsystem at MVP. A request is discovered by visiting this page and by the
// pending-received count on app/(app)/[orgSlug]/page.tsx's Network card --
// nothing else tells either side a request exists, was accepted, or was
// declined. Stated here, in FOLLOW-UPS.md, and in the task report, because
// "we sent them a request and nothing happened" reads as a bug otherwise.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network/requests">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Connection requests · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NetworkRequestsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/network/requests">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const heading = (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        <Link
          href={`/${org.slug}/network`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          Network
        </Link>
      </p>
      <h1 className="tracking-display text-3xl font-extrabold text-ink">
        Connection requests
      </h1>
      <p className="max-w-prose text-base text-ink-muted">
        Requests to connect, in both directions. There is no notification for
        any of this — check back here, or watch the count on your workspace
        home.
      </p>
    </div>
  );

  const canRead = await getNetworkReadAccess(org);
  if (!canRead) {
    return (
      <div className="flex flex-col gap-8">
        {heading}
        <Alert tone="info">
          This workspace is suspended, so the network area is read-only in a
          way that includes not browsing it right now. Contact GetSetPaid
          support to have it reinstated.
        </Alert>
      </div>
    );
  }

  const raw = (await searchParams) as RawSearchParams;
  const basePath = `/${org.slug}/network/requests`;

  // NO PER-SECTION Suspense/streaming, matching the multi-panel detail pages
  // (companies/[id], events/[id]) rather than the single-list directory pages
  // -- both `ReceivedRequestsResults` and `SentRequestsResults` are plain
  // async Server Components awaited as part of this page's own render, so a
  // page-size change to either list re-renders this whole route rather than
  // a per-panel boundary. Simpler, and correct: the two-list Constraint 10
  // risk on this route is ListToolbar's missing `preserve` (see
  // lib/network/requests-list.ts's header), not streaming.
  return (
    <div className="flex flex-col gap-10">
      {heading}

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-ink">Received</h2>
        <ReceivedRequestsResults
          orgSlug={org.slug}
          organisationId={org.id}
          raw={raw}
          basePath={basePath}
        />
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-8">
        <h2 className="text-xl font-bold text-ink">Sent</h2>
        <SentRequestsResults
          orgSlug={org.slug}
          organisationId={org.id}
          raw={raw}
          basePath={basePath}
        />
      </section>
    </div>
  );
}
