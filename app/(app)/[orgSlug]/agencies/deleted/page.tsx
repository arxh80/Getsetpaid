import Link from "next/link";
import {
  AGENCY_DELETED_LIST,
  AGENCY_DELETED_SELECT,
  type AgencyDeletedSortKey,
  type DeletedAgencyRow,
} from "@/lib/crm/agencies-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "agencies",
  backLabel: "Agencies",
  title: "Deleted agencies",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — the
      representations it holds survived the delete and come back with it.
    </>
  ),
  spec: AGENCY_DELETED_LIST,
  table: "agencies",
  select: AGENCY_DELETED_SELECT,
  mapRow: (row): DeletedAgencyRow => ({
    id: String(row.id),
    name: String(row.name),
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 2,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted agencies assigned to you. Others in this workspace
        may see more.
      </p>
    ) : undefined,
  emptyState: (recordScoped) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped
          ? "None of your agencies have been deleted"
          : "Nothing has been deleted"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted agencies collect here so they can be put back. Nothing is ever
        destroyed by the Delete button — which matters more here than anywhere:
        an artist’s representation history points at these records.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedAgencyRow, AgencyDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/agencies/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
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
