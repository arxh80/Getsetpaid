import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  getNetworkReadAccess,
  getNetworkPublishAccess,
  manageableNetworkEntityKinds,
} from "@/lib/network/access";
import { loadPublishableEntities } from "@/lib/network/entities";
import {
  NETWORK_ENTITY_KINDS,
  NETWORK_ENTITY_KIND_LABELS,
  publishSummary,
  type NetworkEntityKind,
} from "@/lib/network/fields";
import {
  NETWORK_OWN_PROFILE_LIST,
  NETWORK_OWN_PROFILE_SELECT,
  mapNetworkOwnProfileRow,
  type NetworkOwnProfileFilterKey,
  type NetworkOwnProfileRow,
  type NetworkOwnProfileSortKey,
} from "@/lib/network/profiles-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { ProfileStatusChip } from "@/components/network/profile-status-chip";
import { CreateProfileForm } from "@/components/network/create-profile-form";
import { Alert } from "@/components/ui/alert";
import { formatDate } from "@/lib/format/date";

// This organisation's own network profiles -- drafts and published alike --
// keyset-paginated, plus the "Publish a record" entry point.
//
// ===========================================================================
// THE READ GATE FOR THE WHOLE AREA
// ===========================================================================
// `getNetworkReadAccess(org)` (view_network). Every role holds it EXCEPT a
// suspended workspace, so the refusal branch is real but rare -- rendered as
// an honest sentence rather than a 404, the same discipline the custom-fields
// settings page uses for the same shape of question ("can this caller see
// this AREA at all", separate from "can they write in it").
//
// ===========================================================================
// THE WRITE GATE IS TWO LAYERS, AND M4 IS WHY
// ===========================================================================
// `getNetworkPublishAccess(org)` decides whether the "Publish a record"
// section renders as a live picker or as a read-only explanation at all
// (Free tier, suspended, no manage_network_profile). `manageableNetworkEntity
// Kinds(org)` decides WHICH KINDS within that picker -- the M4 closure: a
// marketing user passes the first gate and is offered `company`/`agency`
// only, never `artist`/`venue`, because entity_is_manageable's per-kind
// dispatch would refuse those two regardless of what this page rendered.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/network/profiles">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Network profiles · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function NetworkProfilesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/network/profiles">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const canRead = await getNetworkReadAccess(org);

  const heading = (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        <Link
          href={`/${org.slug}`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          {org.name}
        </Link>
      </p>
      <h1 className="tracking-display text-3xl font-extrabold text-ink">
        Network profiles
      </h1>
      <p className="max-w-prose text-base text-ink-muted">
        Your workspace’s own published identities on the GetSetPaid network.
        Drafts here are visible only to you, until you publish them.
      </p>
    </div>
  );

  // THE READ GATE. Not a 404: the area exists, and a suspended workspace's
  // Owner asking "why can't I see this" deserves the real reason, the same
  // discipline the custom-fields settings page's `canRead` branch uses.
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
  const listParams = parseListParams(NETWORK_OWN_PROFILE_LIST, raw);
  const basePath = `/${org.slug}/network/profiles`;
  const narrowed = isNarrowed(NETWORK_OWN_PROFILE_LIST, listParams);

  const [access, manageableKinds] = await Promise.all([
    getNetworkPublishAccess(org),
    manageableNetworkEntityKinds(org),
  ]);

  // Only queried for kinds this caller could actually publish (M4) -- there
  // is no reason to ask "which companies are unpublished" for a caller who
  // will never be offered the company picker.
  const kinds = NETWORK_ENTITY_KINDS.filter((k) => manageableKinds.has(k));
  const optionsEntries = await Promise.all(
    kinds.map(async (kind) => [kind, await loadPublishableEntities(org.id, kind)] as const),
  );
  const optionsByKind: Partial<Record<NetworkEntityKind, readonly { id: string; name: string }[]>> =
    Object.fromEntries(optionsEntries);

  return (
    <div className="flex flex-col gap-8">
      {heading}

      <CreateProfileForm
        orgSlug={org.slug}
        kinds={kinds}
        optionsByKind={optionsByKind}
        disabled={!access.canWrite}
        disabledExplanation={access.canWrite ? null : access.explanation}
      />

      <ListToolbar
        spec={NETWORK_OWN_PROFILE_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={5} />}
      >
        <NetworkProfileResults
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
        />
      </Suspense>
    </div>
  );
}

async function NetworkProfileResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<NetworkOwnProfileSortKey, NetworkOwnProfileFilterKey>;
  basePath: string;
  narrowed: boolean;
}) {
  const page = await fetchListPage<
    NetworkOwnProfileRow,
    NetworkOwnProfileSortKey,
    NetworkOwnProfileFilterKey
  >({
    spec: NETWORK_OWN_PROFILE_LIST,
    params: listParams,
    organisationId,
    table: "network_profiles",
    select: NETWORK_OWN_PROFILE_SELECT,
    mapRow: mapNetworkOwnProfileRow,
    applyFilters: (query, filters) =>
      filters.status !== "any" ? query.eq("status", filters.status) : query,
  });

  return (
    <EntityList
      spec={NETWORK_OWN_PROFILE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={profileColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-lg font-bold text-ink">No network profiles yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Use “Publish a record” above to create a draft for a company,
            artist, venue or agency this workspace manages.
          </p>
        </div>
      }
    />
  );
}

function profileColumns(
  orgSlug: string,
): readonly ListColumn<NetworkOwnProfileRow, NetworkOwnProfileSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/network/profiles/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.displayName}
        </Link>
      ),
    },
    {
      key: "kind",
      header: "Type",
      render: (row) => (
        <span className="text-base text-ink-muted">
          {NETWORK_ENTITY_KIND_LABELS[row.entityKind]}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <ProfileStatusChip status={row.status} />,
    },
    {
      key: "publishing",
      header: "Publishing",
      render: (row) => {
        const summary = publishSummary(row.fieldVisibility);
        return (
          <span className="text-sm text-ink-muted tabular-nums">
            {summary.network} network · {summary.connections} connections ·{" "}
            {summary.hidden} hidden
          </span>
        );
      },
    },
    {
      key: "updated",
      header: "Updated",
      sortKey: "updated",
      numeric: true,
      render: (row) => (
        <time dateTime={row.updatedAt} className="text-ink-muted">
          {formatDate(row.updatedAt)}
        </time>
      ),
    },
  ];
}
