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
// THIS PAGE, PLUS THE HUB COUNT, IS THE WHOLE IN-APP SURFACE
// ===========================================================================
// Since Phase 8 Task 9b job 3 (founder 2026-09-30, Q157(3)/Q174/Q45;
// 20261016000000, lib/email/network-notifications.ts) a request is also
// EMAILED: received to this workspace's Owners and Admins, accepted and
// declined to whoever sent it -- each linking here and naming the other side's
// published profile at most. In the app there is still no toast: this page
// and the pending-received count on app/(app)/[orgSlug]/page.tsx's Network
// card are where a request is seen.
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
        Requests to connect, in both directions. A new request is emailed to
        your workspace’s owners and admins, and the answer to one you sent is
        emailed to you; this page is where you act on them.
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
