import Link from "next/link";
import {
  loadDocumentsForEntity,
  loadNotesForEntity,
  loadTasksForEntity,
} from "@/lib/crm/queries";
import {
  RELATED_DOCS_LIST,
  RELATED_NOTES_LIST,
  RELATED_TASKS_LIST,
  type DocumentRow,
  type RelatedDocsSortKey,
  type RelatedNotesSortKey,
  type RelatedTasksSortKey,
} from "@/lib/crm/related-list";
import type { NoteRow } from "@/lib/crm/notes-list";
import type { TaskRow } from "@/lib/crm/tasks-list";
import type { LinkEntityType } from "@/lib/crm/links";
import { isNarrowed, type RawSearchParams } from "@/lib/list/params";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import { formatDateTime } from "@/lib/format/date";

// The reusable RELATED panel: the tasks, notes and documents linked TO one CRM
// record, mounted on every entity detail page.
//
// ===========================================================================
// THREE lib/list/ SURFACES ON ONE PAGE -- RULE 10
// ===========================================================================
// Each of the three specs carries its own `paramPrefix` (`rel_tasks_`,
// `rel_notes_`, `rel_docs_` -- lib/crm/related-list.ts), and every EntityList
// below is passed `preserve={raw}`, so paging any one leaves the other two
// where they were. Without both halves the three lists read each other's
// `after` and page one silently returns the other two to page one (the artist
// detail page's header states the same for its three surfaces).
//
// READ-ONLY. This panel shows what points at the record; the LINK is created
// from the task/meeting/note's own page (components/crm/entity-link-picker.tsx).
// The documents column is read-only until Task 6 (upload), so it renders a
// "no documents" empty state over an always-empty list -- a real surface so the
// three page independently, not a special case.
//
// AN ASYNC SERVER COMPONENT that does its own reads, so a detail page mounts it
// with `<RelatedPanel ... />` and nothing else. Each loader is the two-step
// reverse read in lib/crm/queries.ts.

export async function RelatedPanel({
  orgSlug,
  organisationId,
  entityType,
  entityId,
  basePath,
  raw,
}: {
  orgSlug: string;
  organisationId: string;
  entityType: LinkEntityType;
  entityId: string;
  /** The record's own detail path -- the base for the three lists' pager links. */
  basePath: string;
  /** The whole query string, passed to all three as `preserve` (rule 10). */
  raw: RawSearchParams;
}) {
  const [tasks, notes, documents] = await Promise.all([
    loadTasksForEntity(organisationId, entityType, entityId, raw),
    loadNotesForEntity(organisationId, entityType, entityId, raw),
    loadDocumentsForEntity(organisationId, entityType, entityId, raw),
  ]);

  return (
    <section className="flex flex-col gap-6 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Tasks, notes &amp; documents</h2>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink">Tasks</h3>
        <EntityList
          spec={RELATED_TASKS_LIST}
          params={tasks.params}
          basePath={basePath}
          page={tasks.page}
          columns={taskColumns(orgSlug)}
          rowKey={(row) => row.id}
          narrowed={isNarrowed(RELATED_TASKS_LIST, tasks.params)}
          preserve={raw}
          emptyState={
            <p className="max-w-prose text-base text-ink-muted">
              No tasks linked to this record. Link one from a task’s own page.
            </p>
          }
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink">Notes</h3>
        <EntityList
          spec={RELATED_NOTES_LIST}
          params={notes.params}
          basePath={basePath}
          page={notes.page}
          columns={noteColumns(orgSlug)}
          rowKey={(row) => row.id}
          narrowed={isNarrowed(RELATED_NOTES_LIST, notes.params)}
          preserve={raw}
          emptyState={
            <p className="max-w-prose text-base text-ink-muted">
              No notes linked to this record. Link one from a note’s own page.
            </p>
          }
        />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink">Documents</h3>
        <EntityList
          spec={RELATED_DOCS_LIST}
          params={documents.params}
          basePath={basePath}
          page={documents.page}
          columns={documentColumns()}
          rowKey={(row) => row.id}
          narrowed={isNarrowed(RELATED_DOCS_LIST, documents.params)}
          preserve={raw}
          emptyState={
            <p className="max-w-prose text-base text-ink-muted">
              No documents. Uploading and attaching files arrives in a later
              release.
            </p>
          }
        />
      </div>
    </section>
  );
}

function taskColumns(
  orgSlug: string,
): readonly ListColumn<TaskRow, RelatedTasksSortKey>[] {
  return [
    {
      key: "title",
      header: "Task",
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
      render: (row) => <TaskStatusChip status={row.status} />,
    },
    {
      key: "priority",
      header: "Priority",
      secondary: true,
      render: (row) => <PriorityChip priority={row.priority} />,
    },
    {
      key: "due",
      header: "Due",
      numeric: true,
      secondary: true,
      render: (row) =>
        row.dueAt === null ? (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No due date</span>
          </span>
        ) : (
          <time dateTime={row.dueAt} className="tabular-nums">
            {formatDateTime(row.dueAt)}
          </time>
        ),
    },
  ];
}

function noteColumns(
  orgSlug: string,
): readonly ListColumn<NoteRow, RelatedNotesSortKey>[] {
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
      render: (row) => (
        <span className="text-ink-muted capitalize">{row.visibility}</span>
      ),
    },
    {
      key: "created",
      header: "Added",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.createdAt} className="tabular-nums text-ink-muted">
          {formatDateTime(row.createdAt)}
        </time>
      ),
    },
  ];
}

function documentColumns(): readonly ListColumn<DocumentRow, RelatedDocsSortKey>[] {
  // Read-only until Task 6; the list is empty in this task, so these render for
  // nobody yet. Kept so the surface is a real list (rule 10) and Task 6 fills
  // in the download/scan controls.
  return [
    { key: "filename", header: "File", render: (row) => <span className="break-words">{row.filename}</span> },
    {
      key: "size",
      header: "Size",
      numeric: true,
      secondary: true,
      // A minimal inline size render -- lib/format/bytes.ts (humanFileSize)
      // arrives with the document upload path in Task 6; this column renders
      // for nobody until then (the list is empty in Task 3).
      render: (row) => (
        <span className="tabular-nums">{Math.ceil(row.sizeBytes / 1024)} KB</span>
      ),
    },
    {
      key: "added",
      header: "Added",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.createdAt} className="tabular-nums text-ink-muted">
          {formatDateTime(row.createdAt)}
        </time>
      ),
    },
  ];
}

/** A one-line preview of a note body, so the cell stays a cell. */
function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}
