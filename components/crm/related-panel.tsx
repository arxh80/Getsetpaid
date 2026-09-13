import Link from "next/link";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
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
import { ScanStatusChip } from "@/components/crm/scan-status-chip";
import { DocumentDownloadLink } from "@/components/crm/document-row";
import { DocumentDetachControl } from "@/components/crm/document-detach";
import { DocumentUpload } from "@/components/crm/document-upload";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { humanFileSize } from "@/lib/format/bytes";
import { formatDateTime } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

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
// TASKS AND NOTES ARE READ-ONLY HERE; DOCUMENTS ARE WRITABLE (Task 6). The
// panel shows what points at the record. For a task or a note, the LINK is
// created from that record's own page (components/crm/entity-link-picker.tsx),
// so this surface only lists them. A DOCUMENT has no detail page, so its attach
// point is here: this panel carries an upload control that creates the document
// AND the document_links row in one action (uploadDocumentAction with the
// entity's hidden type/id), and lists what is attached with the scan chip and a
// download link that resolves only for a `clean` file.
//
// AN ASYNC SERVER COMPONENT that does its own reads, so a detail page mounts it
// with `<RelatedPanel ... />` and nothing else. Each loader is the two-step
// reverse read in lib/crm/queries.ts. It also resolves manage_documents write
// access itself (getCurrentOrg is cached, so this is not a second round trip),
// so the six detail pages need no new prop.

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
  const org = await getCurrentOrg(orgSlug);
  const [tasks, notes, documents, docAccess] = await Promise.all([
    loadTasksForEntity(organisationId, entityType, entityId, raw),
    loadNotesForEntity(organisationId, entityType, entityId, raw),
    loadDocumentsForEntity(organisationId, entityType, entityId, raw),
    org
      ? getCrmWriteAccess(org, "manage_documents")
      : Promise.resolve({ canWrite: false as const, reason: "permission" as const, explanation: "" }),
  ]);
  const docWriteNoteId = "related-documents-write-note";

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
        {/* WRITABLE (Task 6): upload attaches to this record in one action. A
            writer gets the control; anyone else gets the explanation, never a
            silent absence. The server refuses a forbidden upload regardless. */}
        {docAccess.canWrite ? (
          <DocumentUpload
            orgSlug={orgSlug}
            entity={{ type: entityType, id: entityId }}
            compact
          />
        ) : (
          <WriteBlockedNote access={docAccess} id={docWriteNoteId} />
        )}
        <EntityList
          spec={RELATED_DOCS_LIST}
          params={documents.params}
          basePath={basePath}
          page={documents.page}
          columns={documentColumns(
            orgSlug,
            documents.linkIds,
            !docAccess.canWrite,
            docWriteNoteId,
          )}
          rowKey={(row) => row.id}
          narrowed={isNarrowed(RELATED_DOCS_LIST, documents.params)}
          preserve={raw}
          emptyState={
            <p className="max-w-prose text-base text-ink-muted">
              No documents attached to this record yet.
              {docAccess.canWrite ? " Attach one above." : ""}
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
          <Absent label="No due date" />
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

function documentColumns(
  orgSlug: string,
  linkIds: ReadonlyMap<string, string>,
  blocked: boolean,
  writeNoteId: string,
): readonly ListColumn<DocumentRow, RelatedDocsSortKey>[] {
  return [
    {
      key: "filename",
      header: "File",
      // The download link resolves ONLY for a `clean` file; the rest render
      // inert with a reason, and the Route Handler refuses them anyway (rule 12).
      render: (row) => (
        <DocumentDownloadLink
          orgSlug={orgSlug}
          documentId={row.id}
          filename={row.filename}
          scanStatus={row.scanStatus}
        />
      ),
    },
    {
      key: "scan",
      header: "Scan",
      render: (row) => <ScanStatusChip status={row.scanStatus} />,
    },
    {
      key: "size",
      header: "Size",
      numeric: true,
      secondary: true,
      // DESIGN.md § Numerals: tabular figures on every file size.
      render: (row) => (
        <span className="tabular-nums text-ink-muted">
          {humanFileSize(row.sizeBytes)}
        </span>
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
    {
      key: "actions",
      header: "Attached",
      // DETACH — un-attach this document from THIS record, leaving the document
      // and its other attachments alone (removeLinkAction on the one link row).
      // A missing link id (a race where the document is on the page but its link
      // just went) renders nothing rather than a broken control.
      render: (row) => {
        const linkId = linkIds.get(row.id);
        if (!linkId) return null;
        return (
          <DocumentDetachControl
            orgSlug={orgSlug}
            documentId={row.id}
            linkId={linkId}
            filename={row.filename}
            blocked={blocked}
            describedBy={writeNoteId}
          />
        );
      },
    },
  ];
}

/** A one-line preview of a note body, so the cell stays a cell. */
function preview(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}
