import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  COMPANY_LIST,
  COMPANY_SELECT,
  companyTypeLabel,
  type CompanyFilterKey,
  type CompanyRow,
  type CompanySortKey,
} from "@/lib/crm/companies-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NewRecordAction } from "@/components/crm/write-gate";

// Companies.
//
// THE COPYABILITY TEST, AND WHAT IT COST. This file is
// app/(app)/[orgSlug]/contacts/page.tsx with the spec, the nouns and the
// columns changed. The server/client split, the Suspense key argument, the
// role-aware empty state, the scope note and the toolbar are unchanged, and
// nothing in lib/list/ or components/list/ had to move to accommodate it.
//
// What DID have to exist first was a pair of indexes (20260828230000), because
// `backedBy` is a required field naming a real index and companies had none.
// That is the field working as designed rather than an obstacle: the shape
// that is easy to copy is a page whose sorts are O(page), and the only way to
// keep that property while copying is to make the index a thing the author has
// to write down.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/companies">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Companies · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function CompaniesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/companies">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(COMPANY_LIST, raw);
  const basePath = `/${org.slug}/companies`;
  const narrowed = isNarrowed(COMPANY_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_contacts");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {org.name}
          </Link>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="tracking-display text-3xl font-extrabold text-ink">
            Companies
          </h1>
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="New company"
            id="new-company"
          />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted companies
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={COMPANY_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      {/* The key covers what the TOOLBAR changes and nothing else -- see the
          contacts page for the measurement behind that (keying on the full URL
          remounts the pager and drops focus to <body> on every page click). */}
      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={3} />}
      >
        <CompanyResults
          organisationId={org.id}
          orgSlug={org.slug}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
          access={access}
        />
      </Suspense>
    </div>
  );
}

async function CompanyResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
  access,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<CompanySortKey, CompanyFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<CompanyRow, CompanySortKey, CompanyFilterKey>({
    spec: COMPANY_LIST,
    params: listParams,
    organisationId,
    table: "companies",
    select: COMPANY_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      type: (row.type as string[] | null) ?? [],
      updatedAt: String(row.updated_at),
    }),
    applyFilters: (query: ListQuery, filters) =>
      // The caller's own id from the verified session, never a value from the
      // query string.
      filters.owner === "mine" && user
        ? query.eq("owner_user_id", user.id)
        : query,
  });

  return (
    <EntityList
      spec={COMPANY_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={companyColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing companies assigned to you. Others in this workspace
            may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          {/* THE ROLE-AWARE EMPTY STATE IS INHERITED, NOT REINVENTED. Task 3's
              browser pass found a Read Only user in a 71-contact workspace
              told "No contacts yet" -- a false claim about their employer's
              records. Every list built after that carries the distinction, and
              this is the first one that inherited it rather than being fixed
              into it. */}
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No companies assigned to you" : "No companies yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            A company is a business this workspace deals with — a promoter, a
            venue operator, an agency, an artist’s business, a supplier. One
            company can be several of those at once.
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
      }
    />
  );
}

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

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
