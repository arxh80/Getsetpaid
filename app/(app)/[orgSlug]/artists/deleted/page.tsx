import Link from "next/link";
import {
  ARTIST_DELETED_LIST,
  ARTIST_DELETED_SELECT,
  type ArtistDeletedSortKey,
  type DeletedArtistRow,
} from "@/lib/crm/artists-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "artists",
  backLabel: "Artists",
  title: "Deleted artists",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — its
      representation and its fee history survived the delete and come back with
      it.
    </>
  ),
  spec: ARTIST_DELETED_LIST,
  table: "artists",
  select: ARTIST_DELETED_SELECT,
  mapRow: (row): DeletedArtistRow => ({
    id: String(row.id),
    name: String(row.name),
    country: (row.country as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 3,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted artists assigned to you. Others in this workspace
        may see more.
      </p>
    ) : undefined,
  emptyState: (recordScoped) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped
          ? "None of your artists have been deleted"
          : "Nothing has been deleted"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted artists collect here so they can be put back. Nothing is ever
        destroyed by the Delete button.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedArtistRow, ArtistDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/artists/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "based",
      header: "Based",
      secondary: true,
      render: (row) => {
        const parts = [row.city, row.country].filter(Boolean);
        return parts.length > 0 ? (
          <span className="break-words">{parts.join(", ")}</span>
        ) : (
          <Absent />
        );
      },
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
