import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  AGENCY_DELETED_LIST,
  AGENCY_DELETED_SELECT,
  type AgencyDeletedFilterKey,
  type AgencyDeletedSortKey,
  type DeletedAgencyRow,
} from "@/lib/crm/agencies-list";
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
import { formatDate } from "@/lib/format/date";

// The restore queue for agencies.
//
// A ROUTE RATHER THAN A FILTER ON THE LIVE LIST, and the reason is not layout.
// `lib/list/query.ts`'s `.is("deleted_at", null)` is one of four clauses that
// file calls non-negotiable -- a list that can be talked out of it by a query
// parameter is a list whose most important clause is optional. A separate route
// asks for `deleted_at is not null` explicitly, through `scope: "deleted"`,
// and the count line on the live list stays a true statement about live
// records.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/agencies/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted agencies · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedAgenciesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/agencies/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(AGENCY_DELETED_LIST, raw);
  const basePath = `/${org.slug}/agencies/deleted`;
  const narrowed = isNarrowed(AGENCY_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/agencies`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Agencies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted agencies
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — the
          representations it holds survived the delete and come back with it.
        </p>
      </div>

      <ListToolbar
        spec={AGENCY_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={2} />}
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
  listParams: ListParams<AgencyDeletedSortKey, AgencyDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedAgencyRow,
    AgencyDeletedSortKey,
    AgencyDeletedFilterKey
  >({
    spec: AGENCY_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "agencies",
    select: AGENCY_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={AGENCY_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted agencies assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "None of your agencies have been deleted"
              : "Nothing has been deleted"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted agencies collect here so they can be put back. Nothing is
            ever destroyed by the Delete button — which matters more here than
            anywhere: an artist’s representation history points at these
            records.
          </p>
        </div>
      }
    />
  );
}

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
