import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { StatusChip } from "@/components/crm/status-chip";
import type { EventStatus } from "@/lib/crm/event-status";
import {
  EVENT_DELETED_LIST,
  EVENT_DELETED_SELECT,
  type DeletedEventRow,
  type EventDeletedFilterKey,
  type EventDeletedSortKey,
} from "@/lib/crm/events-list";
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
import { formatDate, formatDateTime } from "@/lib/format/date";

// The restore queue for events. See the agencies equivalent for why this is a
// route rather than a filter on the live list -- in short, the live list's
// count line has to stay a true statement about live records, and
// lib/list/query.ts's non-negotiable `deleted_at` clause must not become
// negotiable by URL.
//
// NO VENUE COLUMN, unlike the live list. A restore queue answers one question
// -- "which of these do I want back" -- and the name, the date and the status
// answer it. Fetching venue names here would be a second round trip per page
// for a column nobody restores by.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/events/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted events · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedEventsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/events/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(EVENT_DELETED_LIST, raw);
  const basePath = `/${org.slug}/events/deleted`;
  const narrowed = isNarrowed(EVENT_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/events`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Events
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted events
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — its
          lineup survived the delete and comes back with it. Until then it can’t
          be changed.
        </p>
      </div>

      <ListToolbar
        spec={EVENT_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
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
  listParams: ListParams<EventDeletedSortKey, EventDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedEventRow,
    EventDeletedSortKey,
    EventDeletedFilterKey
  >({
    spec: EVENT_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "events",
    select: EVENT_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      startsAt: String(row.starts_at),
      status: row.status as EventStatus,
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={EVENT_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted events assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted events stay here so they can be restored. Deleting an event
            does not delete its venue or its artists.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedEventRow, EventDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/events/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "starts",
      header: "Date",
      numeric: true,
      // `formatDate`, not `formatDateTime`: on a restore queue the day is what
      // identifies the event ("the Bristol one in March") and the door time is
      // noise beside the deletion timestamp in the next column but one.
      render: (row) => (
        <time dateTime={row.startsAt} className="text-ink-muted">
          {formatDate(row.startsAt)}
        </time>
      ),
    },
    {
      key: "status",
      header: "Status",
      secondary: true,
      // The status a deleted event was in when it was deleted. It is the thing
      // that decides whether restoring it is urgent: a deleted `on_sale` event
      // has tickets out in the world.
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "deleted",
      header: "Deleted",
      sortKey: "deleted",
      numeric: true,
      // The full instant here, because "which of the four I deleted this
      // afternoon" is a real question and a day alone cannot answer it.
      render: (row) => (
        <time dateTime={row.deletedAt} className="text-ink-muted">
          {formatDateTime(row.deletedAt)}
        </time>
      ),
    },
  ];
}
