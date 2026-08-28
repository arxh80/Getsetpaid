import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  CONTACT_DELETED_LIST,
  CONTACT_DELETED_SELECT,
  type ContactDeletedFilterKey,
  type ContactDeletedSortKey,
  type DeletedContactRow,
} from "@/lib/crm/contacts-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";

// The restore queue: contacts this workspace has deleted.
//
// ===========================================================================
// WHY THIS IS A ROUTE AND NOT A FILTER ON THE CONTACTS LIST
// ===========================================================================
// CLAUDE.md requires soft delete, and a soft delete nobody can undo is a hard
// delete with extra steps -- so restore needs a way to REACH a deleted record.
// The two candidate shapes were a `?status=deleted` filter on the live list
// and a route of its own. This is the route, for three reasons:
//
//   1. `lib/list/query.ts` calls `.is("deleted_at", null)` one of four
//      non-negotiable clauses, with the partial indexes as half the argument.
//      A clause a query parameter can talk the list out of is not
//      non-negotiable. `scope` is an option the SERVER sets per route and the
//      request cannot reach.
//   2. The count line. "12 contacts" above the live list has to be a true
//      statement about live contacts; a mode that changes what it counts makes
//      it a statement about whatever mode you happen to be in.
//   3. The actions differ completely. A deleted record has no Edit and no
//      Delete; it has Restore. A list whose row actions change under a filter
//      is two lists sharing a URL.
//
// The cost, said plainly: one more route per entity, so Task 4b ships four
// more. It is a copy of this file with three identifiers changed.
//
// ONE SORT AND NO FILTERS. See CONTACT_DELETED_LIST -- the live list's two
// indexes are partial on `deleted_at is null` and cannot serve this query, so
// there is exactly one sort and it names an index that exists.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/contacts/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted contacts · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedContactsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/contacts/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(CONTACT_DELETED_LIST, raw);
  const basePath = `/${org.slug}/contacts/deleted`;
  const narrowed = isNarrowed(CONTACT_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/contacts`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Contacts
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted contacts
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — it goes
          back into the contacts list exactly as it was, with its company links
          intact.
        </p>
      </div>

      <ListToolbar
        spec={CONTACT_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <Results
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
        />
      </Suspense>
    </div>
  );
}

async function Results({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<ContactDeletedSortKey, ContactDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedContactRow,
    ContactDeletedSortKey,
    ContactDeletedFilterKey
  >({
    spec: CONTACT_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "contacts",
    select: CONTACT_DELETED_SELECT,
    // The one line that makes this the other side of the soft-delete boundary.
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      email: (row.email as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={CONTACT_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        // THE SAME RULE AS THE LIVE LIST, AND IT HAS TO BE. Task 3's browser
        // pass found a Read Only user in a 71-contact workspace told "No
        // contacts yet" -- a false claim about their employer's records. The
        // record-scope policies apply identically here, so a Standard User
        // sees only the deleted contacts they own and the copy must say which
        // of the two sentences is true.
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted contacts assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "None of your contacts have been deleted"
              : "Nothing has been deleted"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted contacts collect here so they can be put back. Nothing is
            ever destroyed by the Delete button.
          </p>
        </div>
      }
    />
  );
}

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
