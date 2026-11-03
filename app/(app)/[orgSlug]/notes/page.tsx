import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  NOTE_LIST,
  NOTE_SELECT,
  mapNoteRow,
  type NoteFilterKey,
  type NoteRow,
  type NoteSortKey,
  notePreview,
} from "@/lib/crm/notes-list";
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

// Notes. `manage_notes` (20260902010000).
//
// WHAT IS LISTED IS WHAT THE DATABASE LETS THE READER SEE. `notes_select_by_visibility`
// hides a private note from everyone but its author, so a `standard_user` sees
// every company note plus their own private ones and nothing else -- the
// visibility filter below narrows within that, it does not widen it.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/notes">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Notes · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NotesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/notes">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(NOTE_LIST, raw);
  const basePath = `/${org.slug}/notes`;
  const narrowed = isNarrowed(NOTE_LIST, listParams);
  const access = await getCrmWriteAccess(org, "manage_notes");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={`/${org.slug}`} className="break-words text-primary underline underline-offset-4 hover:text-ink">
            {org.name}
          </Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">Notes</h1>
          <NewRecordAction access={access} href={`${basePath}/new`} label="New note" id="new-note" />
        </div>
        <p className="text-sm text-ink-muted">
          <Link href={`${basePath}/deleted`} className="text-primary underline underline-offset-4 hover:text-ink">
            Deleted notes
          </Link>
        </p>
      </div>

      <ListToolbar spec={NOTE_LIST} params={listParams} basePath={basePath} narrowed={narrowed} />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={3} />}
      >
        <NoteResults
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          access={access}
        />
      </Suspense>
    </div>
  );
}

async function NoteResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  access,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<NoteSortKey, NoteFilterKey>;
  basePath: string;
  narrowed: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<NoteRow, NoteSortKey, NoteFilterKey>({
    spec: NOTE_LIST,
    params: listParams,
    organisationId,
    table: "notes",
    select: NOTE_SELECT,
    mapRow: mapNoteRow,
    applyFilters: (query: ListQuery, filters) => {
      let q = query;
      if (filters.visibility !== "any") q = q.eq("visibility", filters.visibility);
      if (filters.owner === "mine" && user) q = q.eq("owner_user_id", user.id);
      return q;
    },
  });

  return (
    <EntityList
      spec={NOTE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={noteColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">No notes yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            A note is free-form text you want kept with a record — a call
            summary, a reminder, a heads-up. Mark it Private to keep it to
            yourself, or Company to share it with the workspace.
          </p>
          <div className="mt-4">
            <NewRecordAction access={access} href={`${basePath}/new`} label="Add the first note" id="empty-new-note" />
          </div>
        </div>
      }
    />
  );
}

function noteColumns(orgSlug: string): readonly ListColumn<NoteRow, NoteSortKey>[] {
  return [
    {
      key: "body",
      header: "Note",
      render: (row) => (
        <Link
          href={`/${orgSlug}/notes/${row.id}`}
          className="break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {notePreview(row.body)}
        </Link>
      ),
    },
    {
      key: "visibility",
      header: "Visibility",
      render: (row) => <span className="text-ink-muted capitalize">{row.visibility}</span>,
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

/** A one-line preview so the cell stays a cell. React escapes it on render. */
