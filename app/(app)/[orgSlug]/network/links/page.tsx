import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getNetworkReadAccess } from "@/lib/network/access";
import { loadEntityName } from "@/lib/network/entities";
import {
  loadNetworkProfileSummaries,
  type NetworkProfileForViewer,
} from "@/lib/network/discovery";
import {
  NETWORK_LINKS_LIST,
  loadNetworkLinksList,
  type NetworkLinkRow,
  type NetworkLinkSortKey,
} from "@/lib/network/links-list";
import {
  NETWORK_ENTITY_KIND_LABELS,
  NETWORK_ENTITY_URL_SEGMENT,
} from "@/lib/network/fields";
import {
  isNarrowed,
  parseListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { formatDate } from "@/lib/format/date";
import { Alert } from "@/components/ui/alert";

// Task 4 / Gap B (Q73/Q82): "your linked records" -- every private record
// this organisation has explicitly linked to a network identity, in one
// place. `link-picker.tsx` and `linked-identity.tsx` (the write surface) live
// on each of the four private record detail pages; THIS page is the read
// surface Constraint 19 requires for `lib/network/links-list.ts`'s
// `NETWORK_LINKS_LIST` and `loadNetworkLinksList` to have a real caller.
//
// ITS OWN ROUTE, DELIBERATELY, RATHER THAN A SECOND LIST ON THE DIRECTORY
// PAGE. app/(app)/[orgSlug]/network/page.tsx already carries one list
// (NETWORK_DIRECTORY_LIST) with its own `ListToolbar`, and `ListToolbar`'s
// search/filter submit calls `buildListHref` WITHOUT a `preserve` option
// (unlike `EntityList`'s sort headers and `ListPager`) -- so putting a second
// `ListToolbar`-backed list on that same route would silently drop each
// list's cursor whenever the OTHER one's toolbar submitted, the very
// Constraint 10 failure `lib/network/requests-list.ts`'s two specs are
// written to avoid by carrying NO ListToolbar at all. A page of its own sidesteps
// the whole question: exactly one list, exactly one ListToolbar, no risk.
export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network/links">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Linked records · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NetworkLinksPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/network/links">) {
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
        Linked records
      </h1>
      <p className="max-w-prose text-base text-ink-muted">
        Your own private records, explicitly linked to network identities
        other workspaces have published. Manage a link from the record’s own
        page — this is the read-only overview.
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
  const listParams = parseListParams(NETWORK_LINKS_LIST, raw);
  const basePath = `/${org.slug}/network/links`;
  const narrowed = isNarrowed(NETWORK_LINKS_LIST, listParams);

  return (
    <div className="flex flex-col gap-8">
      {heading}

      <ListToolbar
        spec={NETWORK_LINKS_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={3} />}
      >
        <LinksResults orgSlug={org.slug} organisationId={org.id} raw={raw} basePath={basePath} />
      </Suspense>
    </div>
  );
}

async function LinksResults({
  orgSlug,
  organisationId,
  raw,
  basePath,
}: {
  orgSlug: string;
  organisationId: string;
  raw: RawSearchParams;
  basePath: string;
}) {
  const listParams = parseListParams(NETWORK_LINKS_LIST, raw);
  const narrowed = isNarrowed(NETWORK_LINKS_LIST, listParams);
  const page = await loadNetworkLinksList({ id: organisationId }, raw);

  if (page.outcome !== "loaded") {
    return (
      <EntityList
        spec={NETWORK_LINKS_LIST}
        params={listParams}
        basePath={basePath}
        page={page}
        columns={linkColumns(orgSlug, new Map(), new Map())}
        rowKey={(row) => row.id}
        narrowed={narrowed}
        emptyState={null}
      />
    );
  }

  // TWO BATCH LOOKUPS, NOT ONE PER ROW WHERE IT CAN BE AVOIDED. The
  // counterparty profile's display name IS batched
  // (`loadNetworkProfileSummaries`, one query against each masking view
  // regardless of page size). The PRIVATE record's own name is NOT --
  // `private_entity_type` spans four different tables with no single relation
  // to `.in()` against, so this is bounded (page size, capped by
  // MAX_PAGE_SIZE) sequential reads rather than a second batch query. Noted
  // as a follow-up rather than solved here: a future version could group rows
  // by kind and issue four `.in()` queries instead of up to fifty single-row
  // ones.
  const [profileSummaries, entityNames] = await Promise.all([
    loadNetworkProfileSummaries(page.rows.map((r) => r.networkProfileId)),
    Promise.all(
      page.rows.map(
        async (r) =>
          [r.id, await loadEntityName(organisationId, r.privateEntityType, r.privateEntityId)] as const,
      ),
    ).then((entries) => new Map(entries)),
  ]);

  return (
    <EntityList
      spec={NETWORK_LINKS_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={linkColumns(orgSlug, profileSummaries, entityNames)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-lg font-bold text-ink">No linked records yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Open a company, artist, venue or agency record and use “Link to a
            network profile” if it is the same entity as one already
            published on the network.
          </p>
        </div>
      }
    />
  );
}

function linkColumns(
  orgSlug: string,
  profileSummaries: ReadonlyMap<string, NetworkProfileForViewer>,
  entityNames: ReadonlyMap<string, string | null>,
): readonly ListColumn<NetworkLinkRow, NetworkLinkSortKey>[] {
  return [
    {
      key: "record",
      header: "Your record",
      render: (row) => {
        const name = entityNames.get(row.id) ?? null;
        return (
          <div className="flex flex-col gap-1">
            {name === null ? (
              <span className="text-ink-muted">A record outside your access</span>
            ) : (
              <Link
                href={`/${orgSlug}/${NETWORK_ENTITY_URL_SEGMENT[row.privateEntityType]}/${row.privateEntityId}`}
                className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
              >
                {name}
              </Link>
            )}
            <span className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
              {NETWORK_ENTITY_KIND_LABELS[row.privateEntityType]}
            </span>
          </div>
        );
      },
    },
    {
      key: "profile",
      header: "Linked to",
      render: (row) => {
        const summary = profileSummaries.get(row.networkProfileId);
        return summary === undefined ? (
          <span className="text-ink-muted">No longer available</span>
        ) : (
          <Link
            href={`/${orgSlug}/network/${row.networkProfileId}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            {summary.row.displayName}
          </Link>
        );
      },
    },
    {
      key: "linked",
      header: "Linked",
      sortKey: "linked",
      numeric: true,
      render: (row) => (
        <time dateTime={row.createdAt} className="text-ink-muted">
          {formatDate(row.createdAt)}
        </time>
      ),
    },
  ];
}
