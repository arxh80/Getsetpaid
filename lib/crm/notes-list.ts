import { defineListSpec } from "@/lib/list/spec";
import {
  NOTE_VISIBILITIES,
  NOTE_VISIBILITY_LABELS,
  type NoteVisibility,
} from "@/lib/crm/task-status";

// The Notes list specification.
//
// Notes have NO name/title column -- a note is a body -- so this list searches
// on `body` and cannot offer a name sort. `created_at` is the default and
// `updated_at` the alternate; both are NOT NULL by declaration.
//
// VISIBILITY IS NOT RE-ENFORCED HERE. `notes_select_by_visibility`
// (20260902011000) already hides a private note from everyone but its author in
// the DATABASE, so the `visibility` FILTER below is a convenience over the rows
// the caller can already see, never a control -- exactly as the record-scope
// "Mine" filter is over rows RLS already scoped. The filter narrows `company`
// vs `private` among the notes the reader is allowed to read.

/**
 * PostgREST select list. A literal. `body` is selected because the list renders
 * a one-line preview of it; `owner_user_id` for the "Mine" filter and the RLS
 * scope term.
 */
export const NOTE_SELECT =
  "id, body, visibility, owner_user_id, created_at, updated_at";

export interface NoteRow {
  id: string;
  body: string;
  visibility: NoteVisibility;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export function mapNoteRow(row: Record<string, unknown>): NoteRow {
  return {
    id: String(row.id),
    body: String(row.body),
    visibility: row.visibility as NoteVisibility,
    ownerUserId: String(row.owner_user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const NOTE_LIST = defineListSpec({
  entity: "notes",
  noun: { one: "note", many: "notes" },
  // A REAL COLUMN. `body` is unbounded free text, so search is a sequential
  // scan of the tenant (lib/list/spec.ts's searchColumn note) -- worth it for
  // a notes list, where finding the note you half-remember is the point.
  searchColumn: "body",
  searchLabel: "Search notes by text",
  sort: {
    created: {
      column: "created_at",
      label: "Added",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "notes_org_created_at_id_live_idx",
    },
    updated: {
      column: "updated_at",
      label: "Updated",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      notNull: true,
      backedBy: "notes_org_updated_at_id_live_idx",
    },
    // NO `title`/`name` sort -- the column does not exist. NO `visibility` sort:
    // two values, a text sort over it is two blocks, and the FILTER below is
    // how it is read.
  },
  defaultSort: "created",
  filters: {
    visibility: {
      label: "Visibility",
      choices: [
        { value: "any", label: "Any visibility" },
        ...NOTE_VISIBILITIES.map((v) => ({
          value: v,
          label: NOTE_VISIBILITY_LABELS[v],
        })),
      ],
    },
    owner: {
      label: "Author",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Mine" },
      ],
    },
  },
});

export type NoteSortKey = keyof (typeof NOTE_LIST)["sort"];
export type NoteFilterKey = keyof (typeof NOTE_LIST)["filters"];

export const NOTE_DELETED_LIST = defineListSpec({
  entity: "notes-deleted",
  noun: { one: "deleted note", many: "deleted notes" },
  searchColumn: "body",
  searchLabel: "Search deleted notes by text",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "notes_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const NOTE_DELETED_SELECT =
  "id, body, visibility, owner_user_id, deleted_at";

export interface DeletedNoteRow {
  id: string;
  body: string;
  visibility: NoteVisibility;
  deletedAt: string;
}

export function mapDeletedNoteRow(row: Record<string, unknown>): DeletedNoteRow {
  return {
    id: String(row.id),
    body: String(row.body),
    visibility: row.visibility as NoteVisibility,
    deletedAt: String(row.deleted_at),
  };
}

export type NoteDeletedSortKey = keyof (typeof NOTE_DELETED_LIST)["sort"];
export type NoteDeletedFilterKey = keyof (typeof NOTE_DELETED_LIST)["filters"];

/**
 * A note's first line, for anywhere a note has to be NAMED.
 *
 * A note has no title — the body is all there is — so every surface that has to
 * identify one shows its opening words: the list, the restore queue, and the
 * "this has been deleted" notice on its edit route. Three copies of this lived
 * in two route files before the third caller needed it.
 *
 * `max` is a parameter because the callers differ in kind, not in taste: a
 * table cell can carry 140 characters, but the deleted notice puts this INSIDE
 * A SENTENCE ("X has been deleted, so it can't be edited"), and 140 characters
 * of body text there is unreadable.
 */
export function notePreview(body: string, max = 140): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}…` : oneLine;
}
