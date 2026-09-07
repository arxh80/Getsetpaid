import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import {
  TASK_DELETED_LIST,
  TASK_DELETED_SELECT,
  mapDeletedTaskRow,
  type DeletedTaskRow,
  type TaskDeletedFilterKey,
  type TaskDeletedSortKey,
} from "@/lib/crm/tasks-list";
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
import { formatDateTime } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/tasks/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Deleted tasks · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function DeletedTasksPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/tasks/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(TASK_DELETED_LIST, raw);
  const basePath = `/${org.slug}/tasks/deleted`;
  const narrowed = isNarrowed(TASK_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}/tasks`} className="text-primary underline underline-offset-4 hover:text-ink">
            Tasks
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Deleted tasks</h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a task to restore it — its links
          come back with it. Until then it can’t be changed.
        </p>
      </div>

      <ListToolbar spec={TASK_DELETED_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

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
  listParams: ListParams<TaskDeletedSortKey, TaskDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<DeletedTaskRow, TaskDeletedSortKey, TaskDeletedFilterKey>({
    spec: TASK_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "tasks",
    select: TASK_DELETED_SELECT,
    scope: "deleted",
    mapRow: mapDeletedTaskRow,
  });

  return (
    <EntityList
      spec={TASK_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted tasks assigned to you. Others may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted tasks stay here so they can be restored.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(orgSlug: string): readonly ListColumn<DeletedTaskRow, TaskDeletedSortKey>[] {
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
    { key: "status", header: "Status", secondary: true, render: (row) => <TaskStatusChip status={row.status} /> },
    { key: "priority", header: "Priority", secondary: true, render: (row) => <PriorityChip priority={row.priority} /> },
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
