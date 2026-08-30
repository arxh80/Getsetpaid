import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  COMPANY_DELETED_LIST,
  COMPANY_DELETED_SELECT,
  companyTypeLabel,
  type CompanyDeletedFilterKey,
  type CompanyDeletedSortKey,
  type DeletedCompanyRow,
} from "@/lib/crm/companies-list";
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

// The restore queue for companies. See the contacts equivalent for why this is
// a route rather than a filter on the live list.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/companies/deleted">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Deleted companies · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DeletedCompaniesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/companies/deleted">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(COMPANY_DELETED_LIST, raw);
  const basePath = `/${org.slug}/companies/deleted`;
  const narrowed = isNarrowed(COMPANY_DELETED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/companies`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Companies
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Deleted companies
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Nothing here has been destroyed. Open a record to restore it — links
          to people survived the delete and come back with it.
        </p>
      </div>

      <ListToolbar
        spec={COMPANY_DELETED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={3} />}
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
  listParams: ListParams<CompanyDeletedSortKey, CompanyDeletedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    DeletedCompanyRow,
    CompanyDeletedSortKey,
    CompanyDeletedFilterKey
  >({
    spec: COMPANY_DELETED_LIST,
    params: listParams,
    organisationId,
    table: "companies",
    select: COMPANY_DELETED_SELECT,
    scope: "deleted",
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      type: (row.type as string[] | null) ?? [],
      deletedAt: String(row.deleted_at),
    }),
  });

  return (
    <EntityList
      spec={COMPANY_DELETED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={columnsFor(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing deleted companies assigned to you. Others in this
            workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "None of your companies have been deleted"
              : "Nothing has been deleted"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Deleted companies collect here so they can be put back. Nothing is
            ever destroyed by the Delete button.
          </p>
        </div>
      }
    />
  );
}

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
