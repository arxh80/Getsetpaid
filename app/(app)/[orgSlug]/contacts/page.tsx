import Link from "next/link";
import {
  CONTACT_LIST,
  CONTACT_SELECT,
  type ContactRow,
  type ContactSortKey,
} from "@/lib/crm/contacts-list";
import type { ListColumn } from "@/lib/list/spec";
import { entityListPage } from "@/components/list/entity-list-page";
import { NewRecordAction } from "@/components/crm/write-gate";
import { formatDate } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

const { generateMetadata, Page } = entityListPage({
  segment: "contacts",
  title: "Contacts",
  newLabel: "New contact",
  newId: "new-contact",
  deletedLabel: "Deleted contacts",
  permissionKey: "manage_contacts",
  spec: CONTACT_LIST,
  table: "contacts",
  select: CONTACT_SELECT,
  mapRow: (row): ContactRow => ({
    id: String(row.id),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    updatedAt: String(row.updated_at),
  }),
  columns: contactColumns,
  skeletonColumns: 5,
  scopeNote: (recordScoped) =>
    recordScoped ? (
      <p className="text-sm text-ink-muted">
        You’re seeing contacts assigned to you. Others in this workspace may see
        more.
      </p>
    ) : undefined,
  emptyState: ({ recordScoped, access, basePath }) => (
    <div className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">
        {recordScoped ? "No contacts assigned to you" : "No contacts yet"}
      </h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        A contact is a person this workspace works with — a promoter, a booking
        agent, a venue manager, a driver. Events, holds and settlements all
        point back to someone here, so this is where the rest of the workflow
        starts.
      </p>
      {/* A RECORD-SCOPED USER GETS A DIFFERENT SENTENCE AND NO BUTTON, because
          the button would not help them: contacts_insert lets a Standard User
          create records they own, but the reason their list is empty is
          assignment, not creation. That branch is the fix for the defect Task
          3's browser pass found -- a Read Only user in a 71-contact workspace
          shown "No contacts yet" -- and it survives intact here. */}
      {recordScoped ? (
        <p className="mt-3 max-w-prose text-base text-ink-muted">
          Ask an Owner or Admin to assign some to you.
        </p>
      ) : (
        <div className="mt-4">
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="Add the first contact"
            id="empty-new-contact"
          />
        </div>
      )}
    </div>
  ),
});

export { generateMetadata };
export default Page;

function contactColumns(
  orgSlug: string,
): readonly ListColumn<ContactRow, ContactSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
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
      // translate="no": an address is an identifier, and a browser's page
      // translator will happily rewrite the domain into something that is no
      // longer the contact's address. Same reasoning as the app header.
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
      key: "location",
      header: "Location",
      secondary: true,
      render: (row) => row.location ?? <Absent />,
    },
    {
      key: "updated",
      header: "Updated",
      sortKey: "updated",
      // DESIGN.md § Numerals: tabular figures on every date column, so the
      // column aligns instead of shimmering down the page.
      numeric: true,
      render: (row) => (
        <time dateTime={row.updatedAt} className="text-ink-muted">
          {formatDate(row.updatedAt)}
        </time>
      ),
    },
  ];
}

