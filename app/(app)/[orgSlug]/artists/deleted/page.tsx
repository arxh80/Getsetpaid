import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  ARTIST_DELETED_LIST,
  ARTIST_DELETED_SELECT,
  type ArtistDeletedFilterKey,
  type ArtistDeletedSortKey,
  type DeletedArtistRow,
} from "@/lib/crm/artists-list";
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

// The restore queue for artists. A route rather than a filter on the live
// list -- see the agencies equivalent for the argument.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/artists/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted artists · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedArtistsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/artists/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(ARTIST_DELETED_LIST, raw);
  const basePath = `/${org.slug}/artists/deleted`;
  const narrowed = isNarrowed(ARTIST_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/artists`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Artists
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted artists
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — its
          representation and its fee history survived the delete and come back
          with it.
        </p>
      </div>

      <ListToolbar
        spec={ARTIST_DELETED_LIST}
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
  listParams: ListParams<ArtistDeletedSortKey, ArtistDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedArtistRow,
    ArtistDeletedSortKey,
    ArtistDeletedFilterKey
  >({
    spec: ARTIST_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "artists",
    select: ARTIST_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      country: (row.country as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={ARTIST_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted artists assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "None of your artists have been deleted"
              : "Nothing has been deleted"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted artists collect here so they can be put back. Nothing is
            ever destroyed by the Delete button.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedArtistRow, ArtistDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/artists/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "based",
      header: "Based",
      secondary: true,
      render: (row) => {
        const parts = [row.city, row.country].filter(Boolean);
        return parts.length > 0 ? (
          <span className="break-words">{parts.join(", ")}</span>
        ) : (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not recorded</span>
          </span>
        );
      },
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
