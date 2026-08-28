import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  AGENCY_LIST,
  AGENCY_SELECT,
  type AgencyFilterKey,
  type AgencyRow,
  type AgencySortKey,
} from "@/lib/crm/agencies-list";
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

// Agencies.
//
// THE COPYABILITY TEST, ROUND TWO. This file is
// app/(app)/[orgSlug]/companies/page.tsx with the spec, the nouns and the
// columns changed. The server/client split, the Suspense key argument, the
// role-aware empty state, the scope note, the toolbar and the pager are
// unchanged, and nothing in lib/list/ or components/list/ moved to accommodate
// it. What had to exist first was the pair of indexes in 20260829000000,
// because `backedBy` is a required field naming a real index.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/agencies">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Agencies · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function AgenciesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/agencies">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(AGENCY_LIST, raw);
  const basePath = `/${org.slug}/agencies`;
  const narrowed = isNarrowed(AGENCY_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  // `manage_contacts`, not a `manage_agencies` that does not exist --
  // 20260828121000 groups agencies with contacts and companies as "the
  // relationship layer".
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
            Agencies
          </h1>
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="New agency"
            id="new-agency"
          />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted agencies
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={AGENCY_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      {/* The key covers what the TOOLBAR changes and nothing else -- see the
          contacts page for the measurement behind that (keying on the full URL
          remounts the pager and drops focus to <body> on every page click). */}
      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={2} />}
      >
        <AgencyResults
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

async function AgencyResults({
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
  listParams: ListParams<AgencySortKey, AgencyFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  const page = await fetchListPage<AgencyRow, AgencySortKey, AgencyFilterKey>({
    spec: AGENCY_LIST,
    params: listParams,
    organisationId,
    table: "agencies",
    select: AGENCY_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
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
      spec={AGENCY_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={agencyColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing agencies assigned to you. Others in this workspace may
            see more.
          </p>
        ) : undefined
      }
      emptyState={
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
            An agency books or manages artists. Record one, then say which of
            your artists it represents, in what territory, and from when.
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
      }
    />
  );
}

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

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
