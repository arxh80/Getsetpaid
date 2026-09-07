import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import { MeetingStatusChip } from "@/components/crm/task-status-chip";
import {
  MEETING_LIST,
  MEETING_SELECT,
  mapMeetingRow,
  type MeetingFilterKey,
  type MeetingRow,
  type MeetingSortKey,
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

// Meetings. `manage_meetings` (20260902010000). The events-list shape with the
// meetings spec; the `when` bound is the server's clock, per request.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/meetings">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Meetings · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function MeetingsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/meetings">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(MEETING_LIST, raw);
  const basePath = `/${org.slug}/meetings`;
  const narrowed = isNarrowed(MEETING_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_meetings");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}`} className="break-words text-primary underline underline-offset-4 hover:text-ink">
            {org.name}
          </Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">Meetings</h1>
          <NewRecordAction access={access} href={`${basePath}/new`} label="New meeting" id="new-meeting" />
        </div>
        <p className="text-sm text-ink-muted">
          <Link href={`${basePath}/deleted`} className="text-primary underline underline-offset-4 hover:text-ink">
            Deleted meetings
          </Link>
        </p>
      </div>

      <ListToolbar spec={MEETING_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <MeetingResults
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

async function MeetingResults({
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
  listParams: ListParams<MeetingSortKey, MeetingFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();
  const now = new Date().toISOString();

  const page = await fetchListPage<MeetingRow, MeetingSortKey, MeetingFilterKey>({
    spec: MEETING_LIST,
    params: listParams,
    organisationId,
    table: "meetings",
    select: MEETING_SELECT,
    mapRow: mapMeetingRow,
    applyFilters: (query: ListQuery, filters) => {
      let q = query;
      if (filters.when === "upcoming") q = q.filter("starts_at", "gte", now);
      if (filters.when === "past") q = q.filter("starts_at", "lt", now);
      if (filters.status !== "any") q = q.eq("status", filters.status);
      if (filters.owner === "mine" && user) q = q.eq("owner_user_id", user.id);
      return q;
    },
  });

  return (
    <EntityList
      spec={MEETING_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={meetingColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing meetings assigned to you. Others in this workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No meetings assigned to you" : "No meetings yet"}
          </h2>
          {recordScoped ? (
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              Ask an Owner or Admin to assign some to you.
            </p>
          ) : (
            <>
              <p className="mt-2 max-w-prose text-base text-ink-muted">
                A meeting is a call or a get-together with a date and a time.
                Create one and link it to the records it is about.
              </p>
              <div className="mt-4">
                <NewRecordAction access={access} href={`${basePath}/new`} label="Add the first meeting" id="empty-new-meeting" />
              </div>
            </>
          )}
        </div>
      }
    />
  );
}

function meetingColumns(orgSlug: string): readonly ListColumn<MeetingRow, MeetingSortKey>[] {
  return [
    {
      key: "title",
      header: "Title",
      sortKey: "title",
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
      sortKey: "starts",
      numeric: true,
      render: (row) => <time dateTime={row.startsAt}>{formatDateTime(row.startsAt)}</time>,
    },
    { key: "status", header: "Status", render: (row) => <MeetingStatusChip status={row.status} /> },
    {
      key: "updated",
      header: "Updated",
      sortKey: "updated",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.updatedAt} className="text-ink-muted">
          {formatDateTime(row.updatedAt)}
        </time>
      ),
    },
  ];
}
