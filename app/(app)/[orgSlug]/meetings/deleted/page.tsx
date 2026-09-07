import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { MeetingStatusChip } from "@/components/crm/task-status-chip";
import {
  MEETING_DELETED_LIST,
  MEETING_DELETED_SELECT,
  mapDeletedMeetingRow,
  type DeletedMeetingRow,
  type MeetingDeletedFilterKey,
  type MeetingDeletedSortKey,
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
import { formatDate, formatDateTime } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/meetings/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Deleted meetings · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function DeletedMeetingsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/meetings/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(MEETING_DELETED_LIST, raw);
  const basePath = `/${org.slug}/meetings/deleted`;
  const narrowed = isNarrowed(MEETING_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}/meetings`} className="text-primary underline underline-offset-4 hover:text-ink">
            Meetings
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Deleted meetings</h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a meeting to restore it — its
          links come back with it. Until then it can’t be changed.
        </p>
      </div>

      <ListToolbar spec={MEETING_DELETED_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

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
  listParams: ListParams<MeetingDeletedSortKey, MeetingDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<DeletedMeetingRow, MeetingDeletedSortKey, MeetingDeletedFilterKey>({
    spec: MEETING_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "meetings",
    select: MEETING_DELETED_SELECT,
    scope: "deleted",
    mapRow: mapDeletedMeetingRow,
  });

  return (
    <EntityList
      spec={MEETING_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted meetings assigned to you. Others may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted meetings stay here so they can be restored.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(orgSlug: string): readonly ListColumn<DeletedMeetingRow, MeetingDeletedSortKey>[] {
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
    { key: "status", header: "Status", secondary: true, render: (row) => <MeetingStatusChip status={row.status} /> },
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
