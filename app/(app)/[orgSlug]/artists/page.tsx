import Link from "next/link";
import {
  ARTIST_LIST,
  ARTIST_SELECT,
  type ArtistRow,
  type ArtistSortKey,
} from "@/lib/crm/artists-list";
import type { ListColumn } from "@/lib/list/spec";
import { entityListPage } from "@/components/list/entity-list-page";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = entityListPage({
  segment: "artists",
  title: "Artists",
  newLabel: "New artist",
  newId: "new-artist",
  deletedLabel: "Deleted artists",
  permissionKey: "manage_artists",
  spec: ARTIST_LIST,
  table: "artists",
  select: ARTIST_SELECT,
  mapRow: (row): ArtistRow => ({
    id: String(row.id),
    name: String(row.name),
    genres: (row.genres as string[] | null) ?? [],
    country: (row.country as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    updatedAt: String(row.updated_at),
  }),
  columns: artistColumns,
  skeletonColumns: 4,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing artists assigned to you. Others in this workspace may see
        more.
      </p>
    ) : undefined,
  emptyState: ({ recordScoped, access, basePath }) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped ? "No artists assigned to you" : "No artists yet"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        An artist or DJ you book. Their representation, their fee history and
        eventually their events all hang off one record.
      </p>
      {recordScoped ? (
        <p className="mt-3 max-w-prose text-base text-ink-muted">
          Ask an Owner or Admin to assign some to you.
        </p>
      ) : (
        <div className="mt-4">
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="Add the first artist"
            id="empty-new-artist"
          />
        </div>
      )}
    </div>
  ),
});

export { generateMetadata };
export default Page;

function artistColumns(
  orgSlug: string,
): readonly ListColumn<ArtistRow, ArtistSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      key: "genres",
      header: "Genres",
      // NOT SORTABLE. `genres` is a text[]; ordering by it would compare
      // arrays element-wise, which is not what "sort by genre" means to
      // anybody, and there is no index for it. lib/list/spec.ts makes that a
      // compile error rather than a judgement call.
      render: (row) =>
        row.genres.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.genres.map((genre) => (
              // A TEXT CHIP AND NEVER AN href. React escapes the value; there
              // is no protocol to validate because nothing here is a link.
              <span
                key={genre}
                className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {genre}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-muted">No genres</span>
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
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not recorded</span>
          </span>
        );
      },
    },
    {
      key: "updated",
      header: "Updated",
      sortKey: "updated",
      numeric: true,
      render: (row) => (
        <time dateTime={row.updatedAt} className="text-ink-muted">
          {formatDate(row.updatedAt)}
        </time>
      ),
    },
  ];
}
