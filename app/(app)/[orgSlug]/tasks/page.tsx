import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import {
  TASK_LIST,
  TASK_SELECT,
  mapTaskRow,
  type TaskFilterKey,
  type TaskRow,
  type TaskSortKey,
} from "@/lib/crm/tasks-list";
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
import { formatDateTime } from "@/lib/format/date";

// Tasks. `manage_tasks` (20260902010000) -- owner, admin, manager, booker,
// venue_manager, standard_user hold it; finance, marketing, read_only do not.
// The same shape as the events list, with the tasks spec.
//
// THE `due` FILTER'S OVERDUE BOUND IS THE SERVER'S CLOCK, computed per request
// (like events' `when`), never read off the query string. "Overdue" also means
// NOT already finished -- a done task past its date is not overdue.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/tasks">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Tasks · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function TasksPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/tasks">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(TASK_LIST, raw);
  const basePath = `/${org.slug}/tasks`;
  const narrowed = isNarrowed(TASK_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_tasks");

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
          <h1 className="tracking-display text-3xl font-extrabold text-ink">Tasks</h1>
          <NewRecordAction access={access} href={`${basePath}/new`} label="New task" id="new-task" />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted tasks
          </Link>
        </p>
      </div>

      <ListToolbar spec={TASK_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={5} />}
      >
        <TaskResults
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

async function TaskResults({
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
  listParams: ListParams<TaskSortKey, TaskFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();
  // ONE `now` for the whole request, off the server's clock -- see the events
  // list for why this is hoisted rather than called inside the closure.
  const now = new Date().toISOString();

  const page = await fetchListPage<TaskRow, TaskSortKey, TaskFilterKey>({
    spec: TASK_LIST,
    params: listParams,
    organisationId,
    table: "tasks",
    select: TASK_SELECT,
    mapRow: mapTaskRow,
    applyFilters: (query: ListQuery, filters) => {
      let q = query;
      if (filters.status !== "any") q = q.eq("status", filters.status);
      if (filters.priority !== "any") q = q.eq("priority", filters.priority);
      // The due filter -- `due_at` as a filter, never a sort. "Overdue" is
      // past-due AND not finished.
      if (filters.due === "overdue") {
        q = q
          .filter("due_at", "lt", now)
          .filter("status", "not.in", "(done,cancelled)");
      }
      if (filters.due === "has_due") q = q.filter("due_at", "not.is", null);
      if (filters.due === "none") q = q.is("due_at", null);
      if (filters.owner === "mine" && user) q = q.eq("owner_user_id", user.id);
      return q;
    },
  });

  return (
    <EntityList
      spec={TASK_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={taskColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing tasks assigned to you. Others in this workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No tasks assigned to you" : "No tasks yet"}
          </h2>
          {recordScoped ? (
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              Ask an Owner or Admin to assign some to you.
            </p>
          ) : (
            <>
              <p className="mt-2 max-w-prose text-base text-ink-muted">
                A task is something that needs doing — chase a contract, confirm
                a rider, call the venue. Create one and link it to the record it
                is about.
              </p>
              <div className="mt-4">
                <NewRecordAction access={access} href={`${basePath}/new`} label="Add the first task" id="empty-new-task" />
              </div>
            </>
          )}
        </div>
      }
    />
  );
}

function taskColumns(orgSlug: string): readonly ListColumn<TaskRow, TaskSortKey>[] {
  return [
    {
      key: "title",
      header: "Title",
      sortKey: "title",
      render: (row) => (
        <Link
          href={`/${orgSlug}/tasks/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.title}
        </Link>
      ),
    },
    { key: "status", header: "Status", render: (row) => <TaskStatusChip status={row.status} /> },
    { key: "priority", header: "Priority", render: (row) => <PriorityChip priority={row.priority} /> },
    {
      key: "due",
      header: "Due",
      // NOT sortable -- `due_at` is nullable (rule 9); it is a filter, not a
      // sort. tabular figures on the date column regardless (DESIGN.md).
      numeric: true,
      render: (row) =>
        row.dueAt === null ? (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No due date</span>
          </span>
        ) : (
          <time dateTime={row.dueAt}>{formatDateTime(row.dueAt)}</time>
        ),
    },
    {
      key: "created",
      header: "Added",
      sortKey: "created",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.createdAt} className="text-ink-muted">
          {formatDateTime(row.createdAt)}
        </time>
      ),
    },
  ];
}
