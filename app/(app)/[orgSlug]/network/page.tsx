import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess } from "@/lib/network/access";
import { NETWORK_DIRECTORY_LIST } from "@/lib/network/discovery-list";
import { isNarrowed, parseListParams, type RawSearchParams } from "@/lib/list/params";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { DirectoryResults } from "@/components/network/directory-results";
import { Alert } from "@/components/ui/alert";

// Task 3: the network directory -- THE FRONT PAGE OF THE NETWORK AREA.
//
// ===========================================================================
// FREE-TIER HONESTY: THIS PAGE HAS NO TIER GATE AT ALL
// ===========================================================================
// CLAUDE.md § Subscription tiers: Free is "view-only network browsing" -- not
// "no network browsing". `getNetworkReadAccess` (view_network) is the ONLY
// gate here, and it carries no tier term (lib/network/access.ts's own header:
// "READS ARE NOT ENTITLEMENT-GATED... a tier term here would invert the
// product's own pricing"). So a Free-tier member reaches this page, sees the
// full directory and every published field the same as a Pro member does; the
// tier only ever disables the REQUEST control on the profile page
// (app/(app)/[orgSlug]/network/[profileId]/page.tsx), never this one.
//
// ===========================================================================
// THIS IS THE IA DECISION THE BRIEF ASKED FOR
// ===========================================================================
// Task 2 shipped `network/profiles` (this workspace's OWN published
// identities) as the only network route, and the workspace hub linked to it
// first. This route is now the network area's front door -- browsing what
// EVERYONE has published -- with "Your network profiles" demoted to a second
// link underneath it on the hub (app/(app)/[orgSlug]/page.tsx). Publishing is
// still something you do to your own records; discovering is the point of an
// industry network, and a hub that led with "manage your own listing" before
// "see who else is here" had the two backwards.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Network · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NetworkDirectoryPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/network">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const canRead = await getNetworkReadAccess(org);

  const heading = (
    <div className="flex flex-col gap-3">
      <h1 className="tracking-display text-3xl font-extrabold text-ink">
        Network
      </h1>
      <p className="max-w-prose text-base text-ink-muted">
        Every company, artist, venue and agency the GetSetPaid network has
        published — search by name, or filter by type. Fields a publisher kept
        to accepted connections only appear once you have one.
      </p>
    </div>
  );

  // THE READ GATE. Not a 404: the area exists for every workspace, and a
  // suspended workspace's Owner asking "why can't I see this" deserves the
  // real reason -- the same discipline app/(app)/[orgSlug]/network/profiles
  // uses for the identical question.
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
  const listParams = parseListParams(NETWORK_DIRECTORY_LIST, raw);
  const basePath = `/${org.slug}/network`;
  const narrowed = isNarrowed(NETWORK_DIRECTORY_LIST, listParams);

  return (
    <div className="flex flex-col gap-8">
      {heading}

      <ListToolbar
        spec={NETWORK_DIRECTORY_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={2} />}
      >
        <DirectoryResults orgSlug={org.slug} raw={raw} basePath={basePath} />
      </Suspense>
    </div>
  );
}
