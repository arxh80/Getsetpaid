import Link from "next/link";
import {
  MEETING_DELETED_LIST,
  MEETING_DELETED_SELECT,
  mapDeletedMeetingRow,
  type DeletedMeetingRow,
  type MeetingDeletedSortKey,
} from "@/lib/crm/tasks-list";
import type { ListColumn } from "@/lib/list/spec";
import { MeetingStatusChip } from "@/components/crm/task-status-chip";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate, formatDateTime } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "meetings",
  backLabel: "Meetings",
  title: "Deleted meetings",
  blurb: (
    <>
      Nothing here has been destroyed. Open a meeting to restore it — its links
      come back with it. Until then it can’t be changed.
    </>
  ),
  spec: MEETING_DELETED_LIST,
  table: "meetings",
  select: MEETING_DELETED_SELECT,
  mapRow: mapDeletedMeetingRow,
  columns: columnsFor,
  skeletonColumns: 3,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted meetings assigned to you. Others may see more.
      </p>
    ) : undefined,
  emptyState: () => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted meetings stay here so they can be restored.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedMeetingRow, MeetingDeletedSortKey>[] {
  return [
    {
      key: "title",
      header: "Title",
      render: (row) => (
        <Link
          href={`/${orgSlug}/meetings/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.title}
        </Link>
      ),
    },
    {
      key: "starts",
      header: "When",
      numeric: true,
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
      render: (row) => <MeetingStatusChip status={row.status} />,
    },
    {
      key: "deleted",
      header: "Deleted",
      sortKey: "deleted",
      numeric: true,
      render: (row) => (
        <time dateTime={row.deletedAt} className="text-ink-muted">
          {formatDateTime(row.deletedAt)}
        </time>
      ),
    },
  ];
}
