import Link from "next/link";
import {
  COMPANY_LIST,
  COMPANY_SELECT,
  companyTypeLabel,
  type CompanyRow,
  type CompanySortKey,
} from "@/lib/crm/companies-list";
import type { ListColumn } from "@/lib/list/spec";
import { entityListPage } from "@/components/list/entity-list-page";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = entityListPage({
  segment: "companies",
  title: "Companies",
  newLabel: "New company",
  newId: "new-company",
  deletedLabel: "Deleted companies",
  // The relationship layer shares one key -- see the factory's own note.
  permissionKey: "manage_contacts",
  spec: COMPANY_LIST,
  table: "companies",
  select: COMPANY_SELECT,
  mapRow: (row): CompanyRow => ({
    id: String(row.id),
    name: String(row.name),
    type: (row.type as string[] | null) ?? [],
    updatedAt: String(row.updated_at),
  }),
  columns: companyColumns,
  skeletonColumns: 3,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing companies assigned to you. Others in this workspace may
        see more.
      </p>
    ) : undefined,
  emptyState: ({ recordScoped, access, basePath }) => (
    <div className="border border-rule bg-surface p-5">
      {/* THE ROLE-AWARE EMPTY STATE IS INHERITED, NOT REINVENTED. Task 3's
          browser pass found a Read Only user in a 71-contact workspace told
          "No contacts yet" -- a false claim about their employer's records.
          Every list built after that carries the distinction, and this is the
          first one that inherited it rather than being fixed into it. */}
      <h2 className="text-xl font-bold text-ink">
        {recordScoped ? "No companies assigned to you" : "No companies yet"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        A company is a business this workspace deals with — a promoter, a venue
        operator, an agency, an artist’s business, a supplier. One company can
        be several of those at once.
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
            label="Add the first company"
            id="empty-new-company"
          />
        </div>
      )}
    </div>
  ),
});

export { generateMetadata };
export default Page;

function companyColumns(
  orgSlug: string,
): readonly ListColumn<CompanyRow, CompanySortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      // NOT SORTABLE. `type` is a text[]; ordering by it would compare arrays
      // element-wise, which is not what "sort by type" means to anybody, and
      // there is no index for it. lib/list/spec.ts makes that a compile error
      // rather than a judgement call: `sortKey` is constrained to the spec's
      // own sort keys, and `type` is not one.
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
          // "Untyped" rather than a blank cell or an em dash, because the
          // empty array is a real, valid state the schema calls "a legitimate
          // half-entered record" -- not a missing value.
          <span className="text-ink-muted">Untyped</span>
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
