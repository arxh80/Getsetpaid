import Link from "next/link";
import {
  AGENCY_LIST,
  AGENCY_SELECT,
  type AgencyRow,
  type AgencySortKey,
} from "@/lib/crm/agencies-list";
import type { ListColumn } from "@/lib/list/spec";
import { entityListPage } from "@/components/list/entity-list-page";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = entityListPage({
  segment: "agencies",
  title: "Agencies",
  newLabel: "New agency",
  newId: "new-agency",
  deletedLabel: "Deleted agencies",
  // `manage_contacts`, not a `manage_agencies` that does not exist --
  // 20260828121000 groups agencies with contacts and companies as "the
  // relationship layer".
  permissionKey: "manage_contacts",
  spec: AGENCY_LIST,
  table: "agencies",
  select: AGENCY_SELECT,
  mapRow: (row): AgencyRow => ({
    id: String(row.id),
    name: String(row.name),
    updatedAt: String(row.updated_at),
  }),
  columns: agencyColumns,
  skeletonColumns: 2,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing agencies assigned to you. Others in this workspace may see
        more.
      </p>
    ) : undefined,
  emptyState: ({ recordScoped, access, basePath }) => (
    <div className="border border-rule bg-surface p-5">
      {/* THE ROLE-AWARE EMPTY STATE IS INHERITED, NOT REINVENTED. Task 3's
          browser pass found a Read Only user in a 71-contact workspace told
          "No contacts yet" -- a false claim about their employer's records.
          A record-scoped user gets the other sentence AND no button: their
          list is empty because of assignment, not because nothing exists to
          create. */}
      <h2 className="text-xl font-bold text-ink">
        {recordScoped ? "No agencies assigned to you" : "No agencies yet"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        An agency books or manages artists. Record one, then say which of your
        artists it represents, in what territory, and from when.
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
            label="Add the first agency"
            id="empty-new-agency"
          />
        </div>
      )}
    </div>
  ),
});

export { generateMetadata };
export default Page;

function agencyColumns(
  orgSlug: string,
): readonly ListColumn<AgencyRow, AgencySortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
