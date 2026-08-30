import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  columnLabel,
  entityHref,
  entityNoun,
  mapMerge,
  MERGE_LIST,
  MERGE_SELECT,
  type MergeFilterKey,
  type MergeHistoryRow,
  type MergeSortKey,
} from "@/lib/crm/dedup";
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

// The merge history.
//
// ===========================================================================
// TWO THINGS ABOUT THIS LIST ARE NOT LIKE THE OTHER SEVEN
// ===========================================================================
// 1. `public.merges` HAS NO deleted_at, and `fetchListPage` constrains that
//    column on every query it makes -- deliberately, because a list with no
//    soft-delete predicate cannot use either partial index and would show
//    deleted records among live ones. Asking PostgREST to filter a column that
//    does not exist is a 400, so this page would have rendered "unavailable"
//    forever. Handled in lib/list/query.ts by TABLES_WITHOUT_SOFT_DELETE, a
//    set keyed on the TABLE rather than an option a spec can pass, so the
//    escape cannot be pointed at `contacts` by a copied file. `merges` is
//    append-only by design -- no UPDATE grant, no DELETE grant, no updated_at
//    -- and adding a deleted_at to make this page simpler would have been a
//    schema decision taken for a layout reason.
//
// 2. THE RECORD-SCOPED READ IS THE ONE WITH A MEASURED CEILING. FOLLOW-UPS
//    recorded it at ~2.3 s per page at 20k rows, because merges_select_via_winner
//    is the one CRM SELECT policy calling a function with COLUMN arguments and
//    the polymorphic dispatch cannot be hoisted. Task 6's migration puts two
//    denormalised owner equalities in FRONT of that dispatch, which is
//    indexable and discards a merge that is not entirely the caller's before
//    any function runs. Measured on 20,000 merges over 20,000 contacts, 200 of
//    them visible to the record-scoped reader, 50-row page:
//
//        before   602.463 ms   Index Scan, 4851 rows removed by filter
//        after     39.859 ms   the same scan, the dispatch reached only for
//                              rows both of whose owner columns already match
//
//    The full-scope reader never reaches either branch and is unchanged at
//    0.599 -> 1.098 ms, both inside the noise of a warm cache.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/merges">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Merge history · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function MergesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/merges">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(MERGE_LIST, raw);
  const basePath = `/${org.slug}/merges`;
  const narrowed = isNarrowed(MERGE_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

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
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Merge history
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Every merge this workspace has performed, with the record that
          survived, the one that was deleted, and which fields were taken from
          it. Merges cannot be edited or removed.
        </p>
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/duplicates`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Possible duplicates
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={MERGE_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <MergeResults
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

async function MergeResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<MergeSortKey, MergeFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<MergeHistoryRow, MergeSortKey, MergeFilterKey>({
    spec: MERGE_LIST,
    params: listParams,
    organisationId,
    table: "merges",
    select: MERGE_SELECT,
    mapRow: mapMerge,
  });

  return (
    <EntityList
      spec={MERGE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={mergeColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing merges where both records were assigned to you at the
            time. Others in this workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No merges of your records" : "Nothing merged yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? "A merge appears here only when both of its records were assigned to you when it happened. This being empty doesn’t mean the workspace has merged nothing."
              : "Merging two records puts a permanent entry here, including every value the merge discarded."}
          </p>
        </div>
      }
    />
  );
}

function mergeColumns(
  orgSlug: string,
): readonly ListColumn<MergeHistoryRow, MergeSortKey>[] {
  return [
    {
      key: "winner",
      header: "Survived",
      render: (row) => (
        <Link
          href={entityHref(orgSlug, row.entityType, row.winnerId)}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {/* The name out of `field_resolution`, which is a snapshot taken at
              the merge. It goes stale if the record is renamed afterwards, and
              that is the right trade: a merges row whose subject has since been
              hard-deleted still renders, which is the case this history exists
              for. */}
          {row.winnerName ?? `This ${entityNoun(row.entityType)}`}
        </Link>
      ),
    },
    {
      key: "loser",
      header: "Merged in",
      render: (row) => (
        <Link
          href={entityHref(orgSlug, row.entityType, row.loserId)}
          className="break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.loserName ?? "the deleted record"}
        </Link>
      ),
    },
    {
      key: "fields",
      header: "Taken from it",
      secondary: true,
      render: (row) =>
        row.fieldsFromLoser.length === 0 ? (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No fields taken</span>
          </span>
        ) : (
          <span className="text-ink-muted">
            {row.fieldsFromLoser.map(columnLabel).join(", ")}
          </span>
        ),
    },
    {
      key: "merged",
      header: "Merged",
      sortKey: "merged",
      numeric: true,
      render: (row) => (
        <time dateTime={row.mergedAt} className="text-ink-muted">
          {formatDate(row.mergedAt)}
        </time>
      ),
    },
  ];
}
