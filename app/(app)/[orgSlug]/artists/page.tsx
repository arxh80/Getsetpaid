import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  ARTIST_LIST,
  ARTIST_SELECT,
  type ArtistFilterKey,
  type ArtistRow,
  type ArtistSortKey,
} from "@/lib/crm/artists-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";

// Artists. `manage_artists` -- a Booker holds this key and not `manage_venues`.
//
// `genres` IS RENDERED HERE where the contacts list leaves `tags` out. The
// difference is not the column's provenance -- both are free text a user typed
// -- it is what the page does with it: a genre is a text chip, never an
// `href`, and "which of our artists play techno" is the question this list
// exists to answer. `website` and `socials` stay off the list for the reason
// contacts states, because those are the columns that become anchors.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/artists">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Artists · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function ArtistsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/artists">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(ARTIST_LIST, raw);
  const basePath = `/${org.slug}/artists`;
  const narrowed = isNarrowed(ARTIST_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_artists");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {org.name}
          </Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">
            Artists
          </h1>
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="New artist"
            id="new-artist"
          />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted artists
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={ARTIST_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <ArtistResults
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
          access={access}
        />
      </Suspense>
    </div>
  );
}

async function ArtistResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
  access,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<ArtistSortKey, ArtistFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<ArtistRow, ArtistSortKey, ArtistFilterKey>({
    spec: ARTIST_LIST,
    params: listParams,
    organisationId,
    table: "artists",
    select: ARTIST_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      genres: (row.genres as string[] | null) ?? [],
      country: (row.country as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      updatedAt: String(row.updated_at),
    }),
    applyFilters: (query: ListQuery, filters) =>
      filters.owner === "mine" && user
        ? query.eq("owner_user_id", user.id)
        : query,
  });

  return (
    <EntityList
      spec={ARTIST_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={artistColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing artists assigned to you. Others in this workspace may
            see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No artists assigned to you" : "No artists yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            An artist or DJ you book. Their representation, their fee history
            and eventually their events all hang off one record.
          </p>
          {recordScoped ? (
            <p className="mt-3 max-w-prose text-base text-ink-muted">
              Ask an Owner or Admin to assign some to you.
            </p>
          ) : (
            <div className="mt-4">
              <NewRecordAction
                access={access}
                href={`${basePath}/new`}
                label="Add the first artist"
                id="empty-new-artist"
              />
            </div>
          )}
        </div>
      }
    />
  );
}

function artistColumns(
  orgSlug: string,
): readonly ListColumn<ArtistRow, ArtistSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      key: "genres",
      header: "Genres",
      // NOT SORTABLE. `genres` is a text[]; ordering by it would compare
      // arrays element-wise, which is not what "sort by genre" means to
      // anybody, and there is no index for it. lib/list/spec.ts makes that a
      // compile error rather than a judgement call.
      render: (row) =>
        row.genres.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.genres.map((genre) => (
              // A TEXT CHIP AND NEVER AN href. React escapes the value; there
              // is no protocol to validate because nothing here is a link.
              <span
                key={genre}
                className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {genre}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-muted">No genres</span>
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
