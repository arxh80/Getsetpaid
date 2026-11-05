import Link from "next/link";
import {
  NOTE_DELETED_LIST,
  NOTE_DELETED_SELECT,
  mapDeletedNoteRow,
  type DeletedNoteRow,
  type NoteDeletedSortKey,
  notePreview,
} from "@/lib/crm/notes-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDateTime } from "@/lib/format/date";

// NO RECORD-SCOPE NOTE, AND THAT IS NOT AN OMISSION. A note is scoped by
// AUTHORSHIP, not by assignment: `private` reaches only its author and a
// `company` note is editable only by its author (founder Q54). "Assigned to
// you" would be the wrong sentence, so the blurb says the true one instead --
// you can only restore notes you wrote.
const { generateMetadata, Page } = deletedRecordsPage({
  segment: "notes",
  backLabel: "Notes",
  title: "Deleted notes",
  blurb: (
    <>
      Nothing here has been destroyed. Open a note to restore it — its links come
      back with it. You can only restore notes you wrote.
    </>
  ),
  spec: NOTE_DELETED_LIST,
  table: "notes",
  select: NOTE_DELETED_SELECT,
  mapRow: mapDeletedNoteRow,
  columns: columnsFor,
  skeletonColumns: 3,
  emptyState: () => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">Nothing deleted</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted notes stay here so they can be restored.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedNoteRow, NoteDeletedSortKey>[] {
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
      secondary: true,
      render: (row) => (
        <span className="text-ink-muted capitalize">{row.visibility}</span>
      ),
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

