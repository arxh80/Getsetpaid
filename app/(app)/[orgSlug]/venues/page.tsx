import Link from "next/link";
import {
  VENUE_LIST,
  VENUE_SELECT,
  type VenueRow,
  type VenueSortKey,
} from "@/lib/crm/venues-list";
import type { ListColumn } from "@/lib/list/spec";
import { entityListPage } from "@/components/list/entity-list-page";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

const { generateMetadata, Page } = entityListPage({
  segment: "venues",
  title: "Venues",
  newLabel: "New venue",
  newId: "new-venue",
  deletedLabel: "Deleted venues",
  permissionKey: "manage_venues",
  spec: VENUE_LIST,
  table: "venues",
  select: VENUE_SELECT,
  mapRow: (row): VenueRow => ({
    id: String(row.id),
    name: String(row.name),
    location: (row.location as string | null) ?? null,
    // NOT `?? 0`. Unknown capacity is a real state and zero is a lie.
    capacity: (row.capacity as number | null) ?? null,
    updatedAt: String(row.updated_at),
  }),
  columns: venueColumns,
  skeletonColumns: 4,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing venues assigned to you. Others in this workspace may see
        more.
      </p>
    ) : undefined,
  emptyState: ({ recordScoped, access, basePath }) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped ? "No venues assigned to you" : "No venues yet"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        A venue is a place you put events on. Add its rooms once it exists — a
        main room and a basement are two rooms of one venue, not two venues.
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
            label="Add the first venue"
            id="empty-new-venue"
          />
        </div>
      )}
    </div>
  ),
});

export { generateMetadata };
export default Page;

function venueColumns(
  orgSlug: string,
): readonly ListColumn<VenueRow, VenueSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      render: (row) =>
        row.location ? (
          <span className="break-words">{row.location}</span>
        ) : (
          <Absent />
        ),
    },
    {
      key: "capacity",
      header: "Capacity",
      // NOT SORTABLE, and lib/list/spec.ts makes that a compile error rather
      // than a judgement call: `sortKey` is constrained to the spec's own sort
      // keys and `capacity` is deliberately not one, because it is nullable and
      // keyset pagination over a nullable column drops a contiguous band of
      // rows out of the middle of the list. See lib/crm/venues-list.ts.
      //
      // DESIGN.md § Numerals: tabular figures on every table cell containing a
      // number. `numeric` is what applies them.
      numeric: true,
      secondary: true,
      render: (row) =>
        row.capacity === null ? (
          // "Unknown", not a blank and not 0. The column is nullable precisely
          // so that "we have not found out yet" is expressible, and rendering
          // it as an em dash would put it in the same visual class as a field
          // nobody filled in.
          <span className="text-ink-muted">Unknown</span>
        ) : (
          <span>{row.capacity.toLocaleString("en-GB")}</span>
        ),
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

