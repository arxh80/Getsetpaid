import Link from "next/link";
import {
  CONTACT_DELETED_LIST,
  CONTACT_DELETED_SELECT,
  type ContactDeletedSortKey,
  type DeletedContactRow,
} from "@/lib/crm/contacts-list";
import type { ListColumn } from "@/lib/list/spec";
import { deletedRecordsPage } from "@/components/list/deleted-records-page";
import { formatDate } from "@/lib/format/date";

const { generateMetadata, Page } = deletedRecordsPage({
  segment: "contacts",
  backLabel: "Contacts",
  title: "Deleted contacts",
  blurb: (
    <>
      Nothing here has been destroyed. Open a record to restore it — it goes back
      into the contacts list exactly as it was, with its company links intact.
    </>
  ),
  spec: CONTACT_DELETED_LIST,
  table: "contacts",
  select: CONTACT_DELETED_SELECT,
  mapRow: (row): DeletedContactRow => ({
    id: String(row.id),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    deletedAt: String(row.deleted_at),
  }),
  columns: columnsFor,
  skeletonColumns: 4,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing deleted contacts assigned to you. Others in this workspace
        may see more.
      </p>
    ) : undefined,
  emptyState: (recordScoped) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped
          ? "None of your contacts have been deleted"
          : "Nothing has been deleted"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Deleted contacts collect here so they can be put back. Nothing is ever
        destroyed by the Delete button.
      </p>
    </div>
  ),
});

export { generateMetadata };
export default Page;

function columnsFor(
  orgSlug: string,
): readonly ListColumn<DeletedContactRow, ContactDeletedSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/contacts/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "title",
      header: "Role",
      secondary: true,
      render: (row) => row.title ?? <Absent />,
    },
    {
      key: "email",
      header: "Email",
      render: (row) =>
        row.email ? (
          <span translate="no" className="break-all text-ink-muted">
            {row.email}
          </span>
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

function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}
