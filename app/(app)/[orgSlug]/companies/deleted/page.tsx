import Link from "next/link";
import {
  COMPANY_DELETED_LIST,
  COMPANY_DELETED_SELECT,
  companyTypeLabel,
  type CompanyDeletedSortKey,
  type DeletedCompanyRow,
} from "@/lib/crm/companies-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "companies",
  backLabel: "Companies",
  title: "Deleted companies",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — links to
      people survived the delete and come back with it.
    </>
  ),
  spec: COMPANY_DELETED_LIST,
  table: "companies",
  select: COMPANY_DELETED_SELECT,
  mapRow: (row): DeletedCompanyRow => ({
    id: String(row.id),
    name: String(row.name),
    type: (row.type as string[] | null) ?? [],
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 3,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted companies assigned to you. Others in this
        workspace may see more.
      </p>
    ) : undefined,
  emptyState: (recordScoped) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped
          ? "None of your companies have been deleted"
          : "Nothing has been deleted"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted companies collect here so they can be put back. Nothing is ever
        destroyed by the Delete button.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedCompanyRow, CompanyDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/companies/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "type",
      header: "Type",
      secondary: true,
      render: (row) =>
        row.type.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.type.map((value) => (
              <span
                key={value}
                className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {companyTypeLabel(value)}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-muted">Untyped</span>
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
