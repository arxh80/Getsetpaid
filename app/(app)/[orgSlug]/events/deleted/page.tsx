import Link from "next/link";
import {
  EVENT_DELETED_LIST,
  EVENT_DELETED_SELECT,
  type DeletedEventRow,
  type EventDeletedSortKey,
} from "@/lib/crm/events-list";
import type { EventStatus } from "@/lib/crm/event-status";
import type { ListColumn } from "@/lib/list/spec";
import { StatusChip } from "@/components/crm/status-chip";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate, formatDateTime } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "events",
  backLabel: "Events",
  title: "Deleted events",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — its lineup
      survived the delete and comes back with it. Until then it can’t be changed.
    </>
  ),
  spec: EVENT_DELETED_LIST,
  table: "events",
  select: EVENT_DELETED_SELECT,
  mapRow: (row): DeletedEventRow => ({
    id: String(row.id),
    name: String(row.name),
    startsAt: String(row.starts_at),
    status: row.status as EventStatus,
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 4,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted events assigned to you. Others in this workspace
        may see more.
      </p>
    ) : undefined,
  emptyState: () => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted events stay here so they can be restored. Deleting an event does
        not delete its venue or its artists.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

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
