import { defineListSpec } from "@/lib/list/spec";
import {
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import type { ScanStatus } from "@/lib/crm/task-status";

// The three RELATED-PANEL surfaces: the tasks, notes and documents linked to
// one CRM record, read from that record's detail page.
//
// ===========================================================================
// WHY DERIVED SPECS RATHER THAN REUSING TASK_LIST / NOTE_LIST
// ===========================================================================
// The exact argument ARTIST_EVENTS_LIST / VENUE_EVENTS_LIST make one phase
// along (lib/crm/events-list.ts's Task 7 section):
//
//   * a detail page carries THREE of these surfaces at once, so each needs its
//     own query-string namespace (`paramPrefix`) or they read each other's
//     `after` -- two lists reading one cursor is a PostgREST 400 rendered as
//     "we couldn't load" on a page where nothing is wrong (rule 10);
//   * the full lists' toolbars, filters and multiple sorts would be inert on a
//     detail-page panel with no `ListToolbar`, so each derived surface has ONE
//     sort (`created`, the parent's own default index) and no filters.
//
// THREE DISTINCT PREFIXES -- `rel_tasks_`, `rel_notes_`, `rel_docs_` -- and the
// related panel passes the WHOLE raw query string to all three as `preserve`,
// so paging any one leaves the other two where they were.
//
// ===========================================================================
// EACH DROPS ITS OWN `<prefix>q`, LIKE venueEventsParams
// ===========================================================================
// Every spec must declare a real `searchColumn` (a fake one is a PostgREST
// 400), and none of these panels renders a search control -- so a hand-edited
// `?rel_tasks_q=zzz` would narrow the panel silently. The three params wrappers
// below drop that key, exactly as `venueEventsParams` does, and
// tests/unit/list/one-cursor-only.test.ts registers all three.
//
// DOCUMENTS ARE READ-ONLY IN THIS TASK (upload is Task 6). The surface is a
// real (currently always empty) list so rule 10's "three lists page
// independently" holds and the docs panel renders its own "no documents"
// empty state; the DocumentRow / DOCUMENT_SELECT here are the minimum the
// reverse read needs and Task 6's full DOCUMENT_LIST supersedes them.

// ---------------------------------------------------------------------------
// Tasks linked to a record
// ---------------------------------------------------------------------------

export const RELATED_TASKS_LIST = defineListSpec({
  entity: "related-tasks",
  noun: { one: "task", many: "tasks" },
  searchColumn: "title",
  searchLabel: "Search linked tasks by title",
  sort: {
    created: {
      column: "created_at",
      label: "Added",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "tasks_org_created_at_id_live_idx",
    },
  },
  defaultSort: "created",
  filters: {},
  paramPrefix: "rel_tasks_",
});

export type RelatedTasksSortKey = keyof (typeof RELATED_TASKS_LIST)["sort"];
export type RelatedTasksFilterKey = keyof (typeof RELATED_TASKS_LIST)["filters"];

const RELATED_TASKS_SEARCH_PARAM = "rel_tasks_q";

export function relatedTasksParams(
  raw: RawSearchParams,
): ListParams<RelatedTasksSortKey, RelatedTasksFilterKey> {
  return parseListParams(RELATED_TASKS_LIST, {
    ...raw,
    [RELATED_TASKS_SEARCH_PARAM]: undefined,
  });
}

// ---------------------------------------------------------------------------
// Notes linked to a record
// ---------------------------------------------------------------------------

export const RELATED_NOTES_LIST = defineListSpec({
  entity: "related-notes",
  noun: { one: "note", many: "notes" },
  searchColumn: "body",
  searchLabel: "Search linked notes by text",
  sort: {
    created: {
      column: "created_at",
      label: "Added",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "notes_org_created_at_id_live_idx",
    },
  },
  defaultSort: "created",
  filters: {},
  paramPrefix: "rel_notes_",
});

export type RelatedNotesSortKey = keyof (typeof RELATED_NOTES_LIST)["sort"];
export type RelatedNotesFilterKey = keyof (typeof RELATED_NOTES_LIST)["filters"];

const RELATED_NOTES_SEARCH_PARAM = "rel_notes_q";

export function relatedNotesParams(
  raw: RawSearchParams,
): ListParams<RelatedNotesSortKey, RelatedNotesFilterKey> {
  return parseListParams(RELATED_NOTES_LIST, {
    ...raw,
    [RELATED_NOTES_SEARCH_PARAM]: undefined,
  });
}

// ---------------------------------------------------------------------------
// Documents linked to a record (READ-ONLY until Task 6)
// ---------------------------------------------------------------------------

/** The minimum a read-only related-panel document row needs. */
export const DOCUMENT_SELECT =
  "id, filename, mime_type, size_bytes, scan_status, owner_user_id, created_at";

export interface DocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  createdAt: string;
}

export function mapDocumentRow(row: Record<string, unknown>): DocumentRow {
  return {
    id: String(row.id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    scanStatus: row.scan_status as ScanStatus,
    createdAt: String(row.created_at),
  };
}

export const RELATED_DOCS_LIST = defineListSpec({
  entity: "related-documents",
  noun: { one: "document", many: "documents" },
  searchColumn: "filename",
  searchLabel: "Search linked documents by name",
  sort: {
    created: {
      column: "created_at",
      label: "Added",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      // Documents have no list-index migration in Task 3 (Task 6 owns the
      // documents list surface). This reverse read is bounded to a page's worth
      // of parent ids first and then pages `documents` by `id in (...)`, so the
      // ordering is over the PK-membership set rather than a tenant scan -- the
      // same shape as loadEventsForArtist's step two, which names
      // events_org_starts_at_id_live_idx for the sort even though the equality
      // is the `in`. There being no document rows at all in this task, the
      // index this points at is Task 6's to create; named here so the sort is
      // not allowed to exist without one being owed. See task-3-report.md.
      backedBy: "documents_org_created_at_id_live_idx",
    },
  },
  defaultSort: "created",
  filters: {},
  paramPrefix: "rel_docs_",
});

export type RelatedDocsSortKey = keyof (typeof RELATED_DOCS_LIST)["sort"];
export type RelatedDocsFilterKey = keyof (typeof RELATED_DOCS_LIST)["filters"];

const RELATED_DOCS_SEARCH_PARAM = "rel_docs_q";

export function relatedDocsParams(
  raw: RawSearchParams,
): ListParams<RelatedDocsSortKey, RelatedDocsFilterKey> {
  return parseListParams(RELATED_DOCS_LIST, {
    ...raw,
    [RELATED_DOCS_SEARCH_PARAM]: undefined,
  });
}
