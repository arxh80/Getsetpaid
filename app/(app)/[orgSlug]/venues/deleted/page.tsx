import Link from "next/link";
import {
  VENUE_DELETED_LIST,
  VENUE_DELETED_SELECT,
  type DeletedVenueRow,
  type VenueDeletedSortKey,
} from "@/lib/crm/venues-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "venues",
  backLabel: "Venues",
  title: "Deleted venues",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — its rooms
      survived the delete and come back with it. Until then they can’t be
      changed.
    </>
  ),
  spec: VENUE_DELETED_LIST,
  table: "venues",
  select: VENUE_DELETED_SELECT,
  mapRow: (row): DeletedVenueRow => ({
    id: String(row.id),
    name: String(row.name),
    location: (row.location as string | null) ?? null,
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 3,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted venues assigned to you. Others in this workspace
        may see more.
      </p>
    ) : undefined,
  emptyState: (recordScoped) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped
          ? "None of your venues have been deleted"
          : "Nothing has been deleted"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted venues collect here so they can be put back. Nothing is ever
        destroyed by the Delete button.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedVenueRow, VenueDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/venues/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "location",
      header: "Location",
      secondary: true,
      render: (row) =>
        row.location ? (
          <span className="break-words">{row.location}</span>
        ) : (
          <Absent />
        ),
    },
    {
      key: "deleted",
      header: "Deleted",
      sortKey: "deleted",
      numeric: true,
      render: (row) => (
        <time dateTime={row.deletedAt} className="text-ink-muted">
          {formatDate(row.deletedAt)}
        </time>
      ),
    },
  ];
}
