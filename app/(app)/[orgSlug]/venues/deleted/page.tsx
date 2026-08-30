import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  VENUE_DELETED_LIST,
  VENUE_DELETED_SELECT,
  type DeletedVenueRow,
  type VenueDeletedFilterKey,
  type VenueDeletedSortKey,
} from "@/lib/crm/venues-list";
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
import { formatDate } from "@/lib/format/date";

// The restore queue for venues. See the agencies equivalent for why this is a
// route rather than a filter on the live list.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/venues/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted venues · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedVenuesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/venues/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(VENUE_DELETED_LIST, raw);
  const basePath = `/${org.slug}/venues/deleted`;
  const narrowed = isNarrowed(VENUE_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/venues`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Venues
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted venues
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — its
          rooms survived the delete and come back with it. Until then they can’t
          be changed.
        </p>
      </div>

      <ListToolbar
        spec={VENUE_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={3} />}
      >
        <Results
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
        />
      </Suspense>
    </div>
  );
}

async function Results({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<VenueDeletedSortKey, VenueDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedVenueRow,
    VenueDeletedSortKey,
    VenueDeletedFilterKey
  >({
    spec: VENUE_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "venues",
    select: VENUE_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      location: (row.location as string | null) ?? null,
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={VENUE_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted venues assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "None of your venues have been deleted"
              : "Nothing has been deleted"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted venues collect here so they can be put back. Nothing is ever
            destroyed by the Delete button.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedVenueRow, VenueDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/venues/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "location",
      header: "Location",
      secondary: true,
      render: (row) =>
        row.location ? (
          <span className="break-words">{row.location}</span>
        ) : (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not recorded</span>
          </span>
        ),
    },
    {
      key: "deleted",
      header: "Deleted",
      sortKey: "deleted",
      numeric: true,
      render: (row) => (
        <time dateTime={row.deletedAt} className="text-ink-muted">
          {formatDate(row.deletedAt)}
        </time>
      ),
    },
  ];
}
