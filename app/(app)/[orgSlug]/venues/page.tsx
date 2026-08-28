import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  VENUE_LIST,
  VENUE_SELECT,
  type VenueFilterKey,
  type VenueRow,
  type VenueSortKey,
} from "@/lib/crm/venues-list";
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

// Venues. `manage_venues` -- a Venue Manager holds this key and not
// `manage_artists`; a Booker is the mirror image.
//
// The same file as the contacts and companies lists with the spec, the nouns
// and the columns changed. `capacity` is a COLUMN and not a SORT, which is the
// one thing about this list that is not a copy: see lib/crm/venues-list.ts.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/venues">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Venues · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function VenuesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/venues">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(VENUE_LIST, raw);
  const basePath = `/${org.slug}/venues`;
  const narrowed = isNarrowed(VENUE_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_venues");

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
            Venues
          </h1>
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="New venue"
            id="new-venue"
          />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted venues
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={VENUE_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <VenueResults
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

async function VenueResults({
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
  listParams: ListParams<VenueSortKey, VenueFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<VenueRow, VenueSortKey, VenueFilterKey>({
    spec: VENUE_LIST,
    params: listParams,
    organisationId,
    table: "venues",
    select: VENUE_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      location: (row.location as string | null) ?? null,
      // NOT `?? 0`. Unknown capacity is a real state and zero is a lie.
      capacity: (row.capacity as number | null) ?? null,
      updatedAt: String(row.updated_at),
    }),
    applyFilters: (query: ListQuery, filters) =>
      filters.owner === "mine" && user
        ? query.eq("owner_user_id", user.id)
        : query,
  });

  return (
    <EntityList
      spec={VENUE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={venueColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing venues assigned to you. Others in this workspace may
            see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No venues assigned to you" : "No venues yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            A venue is a place you put events on. Add its rooms once it exists —
            a main room and a basement are two rooms of one venue, not two
            venues.
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
                label="Add the first venue"
                id="empty-new-venue"
              />
            </div>
          )}
        </div>
      }
    />
  );
}

function venueColumns(
  orgSlug: string,
): readonly ListColumn<VenueRow, VenueSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      render: (row) =>
        row.location ? (
          <span className="break-words">{row.location}</span>
        ) : (
          <Absent />
        ),
    },
    {
      key: "capacity",
      header: "Capacity",
      // NOT SORTABLE, and lib/list/spec.ts makes that a compile error rather
      // than a judgement call: `sortKey` is constrained to the spec's own sort
      // keys and `capacity` is deliberately not one, because it is nullable and
      // keyset pagination over a nullable column drops a contiguous band of
      // rows out of the middle of the list. See lib/crm/venues-list.ts.
      //
      // DESIGN.md § Numerals: tabular figures on every table cell containing a
      // number. `numeric` is what applies them.
      numeric: true,
      secondary: true,
      render: (row) =>
        row.capacity === null ? (
          // "Unknown", not a blank and not 0. The column is nullable precisely
          // so that "we have not found out yet" is expressible, and rendering
          // it as an em dash would put it in the same visual class as a field
          // nobody filled in.
          <span className="text-ink-muted">Unknown</span>
        ) : (
          <span>{row.capacity.toLocaleString("en-GB")}</span>
        ),
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

/** A blank cell is indistinguishable from a rendering fault, and silent to a
 *  screen reader. */
function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
