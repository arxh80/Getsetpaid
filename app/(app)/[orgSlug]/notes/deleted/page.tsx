import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  NOTE_DELETED_LIST,
  NOTE_DELETED_SELECT,
  mapDeletedNoteRow,
  type DeletedNoteRow,
  type NoteDeletedFilterKey,
  type NoteDeletedSortKey,
} from "@/lib/crm/notes-list";
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
}: PageProps<"/[orgSlug]/notes/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Deleted notes · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function DeletedNotesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/notes/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(NOTE_DELETED_LIST, raw);
  const basePath = `/${org.slug}/notes/deleted`;
  const narrowed = isNarrowed(NOTE_DELETED_LIST, listParams);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}/notes`} className="text-primary underline underline-offset-4 hover:text-ink">
            Notes
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Deleted notes</h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a note to restore it — its links
          come back with it. You can only restore notes you wrote.
        </p>
      </div>

      <ListToolbar spec={NOTE_DELETED_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

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
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<NoteDeletedSortKey, NoteDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
}) {
  const page = await fetchListPage<DeletedNoteRow, NoteDeletedSortKey, NoteDeletedFilterKey>({
    spec: NOTE_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "notes",
    select: NOTE_DELETED_SELECT,
    scope: "deleted",
    mapRow: mapDeletedNoteRow,
  });

  return (
    <EntityList
      spec={NOTE_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted notes stay here so they can be restored.
          </p>
        </div>
      }
    />
  );
}

function columnsFor(orgSlug: string): readonly ListColumn<DeletedNoteRow, NoteDeletedSortKey>[] {
  return [
    {
      key: "body",
      header: "Note",
      render: (row) => (
        <Link
          href={`/${orgSlug}/notes/${row.id}`}
          className="break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {preview(row.body)}
        </Link>
      ),
    },
    {
      key: "visibility",
      header: "Visibility",
      secondary: true,
      render: (row) => <span className="text-ink-muted capitalize">{row.visibility}</span>,
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

function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}…` : oneLine;
}
