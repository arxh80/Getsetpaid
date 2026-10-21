import Link from "next/link";
import {
  TASK_DELETED_LIST,
  TASK_DELETED_SELECT,
  mapDeletedTaskRow,
  type DeletedTaskRow,
  type TaskDeletedSortKey,
} from "@/lib/crm/tasks-list";
import type { ListColumn } from "@/lib/list/spec";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDateTime } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "tasks",
  backLabel: "Tasks",
  title: "Deleted tasks",
  blurb: (
    <>
      Nothing here has been destroyed. Open a task to restore it — its links come
      back with it. Until then it can’t be changed.
    </>
  ),
  spec: TASK_DELETED_LIST,
  table: "tasks",
  select: TASK_DELETED_SELECT,
  mapRow: mapDeletedTaskRow,
  columns: columnsFor,
  skeletonColumns: 4,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted tasks assigned to you. Others may see more.
      </p>
    ) : undefined,
  emptyState: () => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted tasks stay here so they can be restored.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedTaskRow, TaskDeletedSortKey>[] {
  return [
    {
      key: "title",
      header: "Title",
      render: (row) => (
        <Link
          href={`/${orgSlug}/tasks/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.title}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      secondary: true,
      render: (row) => <TaskStatusChip status={row.status} />,
    },
    {
      key: "priority",
      header: "Priority",
      secondary: true,
      render: (row) => <PriorityChip priority={row.priority} />,
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
