import { defineListSpec } from "@/lib/list/spec";
import {
  SCAN_STATUSES,
  SCAN_STATUS_LABELS,
  type ScanStatus,
} from "@/lib/crm/task-status";

// The org-wide Documents list specification (Task 6).
//
// The events-list.ts shape with the documents spec. Two things about it are
// not a straight copy of the five Phase 2 lists:
//
//   1. ONE SORT, `created_at`, NOT THREE. A document has no name/title sort of
//      the required index shape (`filename` is NOT NULL and non-blank, but no
//      (organisation_id, filename, id) live index exists and rule 9 forbids a
//      sort naming an index nobody created), and no `updated_at` list index
//      either. `created_at` is NOT NULL and IS backed
//      (documents_org_created_at_id_live_idx, brought forward in Task 3's
//      20260902020000). So the single sort is the default and there is no
//      "sort by name" a reader would expect and not get.
//   2. THE `storage_key` IS NEVER SELECTED. It is opaque, it is the one column
//      a leak would matter for, and no cell renders it — so DOCUMENT_SELECT
//      omits it. `mime_type` is carried for a future "kind" affordance and the
//      row type keeps it faithfully; the columns render filename / linked-to /
//      uploaded-by / size / scan status / date.
//
// SIBLING OF related-list.ts's read-only reverse-read row: that one is the
// minimum the related PANEL needs (no uploader), this one carries
// `owner_user_id` for the org-wide list's "uploaded by" column. They are
// deliberately two shapes over the same table — the panel reads "documents
// linked to THIS record", this reads "every document in the org".

/**
 * PostgREST select list for the org-wide documents list. A literal, never
 * assembled from a request. Excludes `storage_key` (opaque; no cell renders
 * it) and `scanned_at` (the chip shows the status, not the instant it landed).
 * `owner_user_id` drives the "Uploaded by" column and the "Mine" filter.
 */
export const DOCUMENT_SELECT =
  "id, filename, mime_type, size_bytes, scan_status, owner_user_id, created_at, updated_at";

export interface DocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapDocumentRow(row: Record<string, unknown>): DocumentRow {
  return {
    id: String(row.id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    scanStatus: row.scan_status as ScanStatus,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const DOCUMENT_LIST = defineListSpec({
  entity: "documents",
  noun: { one: "document", many: "documents" },
  searchColumn: "filename",
  searchLabel: "Search documents by name",
  sort: {
    created: {
      column: "created_at",
      label: "Uploaded",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "newest first" },
      // NOT NULL by declaration; the ONLY sort, and the default. See the file
      // header for why filename and updated_at are not offered.
      notNull: true,
      backedBy: "documents_org_created_at_id_live_idx",
    },
  },
  defaultSort: "created",
  filters: {
    // ONE CHOICE PER SCAN STATUS, generated from SCAN_STATUSES so the filter
    // cannot drift from the CHECK constraint. The first choice filters nothing
    // (lib/list/spec.ts's rule). Labels are the chip labels (SCAN_STATUS_LABELS)
    // so "Ready" here means the same as the chip in the row.
    scan: {
      label: "Scan status",
      choices: [
        { value: "any", label: "Any scan status" },
        ...SCAN_STATUSES.map((status) => ({
          value: status,
          label: SCAN_STATUS_LABELS[status],
        })),
      ],
    },
    owner: {
      label: "Uploaded by",
      choices: [
        { value: "anyone", label: "Anyone" },
        { value: "mine", label: "Me" },
      ],
    },
  },
});

export type DocumentSortKey = keyof (typeof DOCUMENT_LIST)["sort"];
export type DocumentFilterKey = keyof (typeof DOCUMENT_LIST)["filters"];

/**
 * The restore view's spec. See events-list.ts's EVENT_DELETED_LIST for the copy
 * of this note: one sort, "most recently deleted first", backed by the
 * deleted-scope partial index. `notNull: true` is true OF THE ROWS THIS LIST
 * READS (scope: "deleted" writes `deleted_at is not null`), not of the column.
 */
export const DOCUMENT_DELETED_LIST = defineListSpec({
  entity: "documents-deleted",
  noun: { one: "deleted document", many: "deleted documents" },
  searchColumn: "filename",
  searchLabel: "Search deleted documents by name",
  sort: {
    deleted: {
      column: "deleted_at",
      label: "Deleted",
      defaultDirection: "desc",
      directionLabels: { asc: "oldest first", desc: "most recent first" },
      notNull: true,
      backedBy: "documents_org_deleted_at_id_idx",
    },
  },
  defaultSort: "deleted",
  filters: {},
});

export const DOCUMENT_DELETED_SELECT =
  "id, filename, size_bytes, scan_status, owner_user_id, deleted_at";

export interface DeletedDocumentRow {
  id: string;
  filename: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  ownerUserId: string | null;
  deletedAt: string;
}

export type DocumentDeletedSortKey = keyof (typeof DOCUMENT_DELETED_LIST)["sort"];
export type DocumentDeletedFilterKey =
  keyof (typeof DOCUMENT_DELETED_LIST)["filters"];
