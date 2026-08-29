import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  entityHref,
  entityNoun,
  mapResolvedCandidate,
  reasonLabel,
  RESOLVED_LIST,
  RESOLVED_SELECT,
  type ResolvedCandidateRow,
  type ResolvedFilterKey,
  type ResolvedSortKey,
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

// The pairs that have already been decided.
//
// ===========================================================================
// WHY THIS PAGE EXISTS AT ALL
// ===========================================================================
// A queue whose decisions vanish is a queue nobody trusts: "did I already say
// these two are different people, or did the dismissal not save?" is a
// question with no answer, and the second visit re-opens the first decision.
// `merge_candidates.deleted_at` and `resolution` already record both, so this
// is the same list surface with `scope: "deleted"` and costs one route.
//
// It is also what gives merge_candidates_org_deleted_at_id_idx a consumer.
// FOLLOW-UPS' rule about indexes with no reachable consumer is the reason the
// five trigram indexes had a drop condition written on them; an index added in
// the same migration as its own dead end would be the same mistake made twice.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/duplicates/resolved">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Resolved duplicates · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function ResolvedDuplicatesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/duplicates/resolved">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(RESOLVED_LIST, raw);
  const basePath = `/${org.slug}/duplicates/resolved`;
  const narrowed = isNarrowed(RESOLVED_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`/${org.slug}/duplicates`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Possible duplicates
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Resolved duplicates
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Pairs that have been merged or set aside. A dismissed pair is not
          flagged again, so this is where to look if two records you expected to
          be flagged are not.
        </p>
      </div>

      <ListToolbar
        spec={RESOLVED_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={4} />}
      >
        <ResolvedResults
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

async function ResolvedResults({
  organisationId,
  orgSlug,
  listParams,
  basePath,
  narrowed,
  recordScoped,
}: {
  organisationId: string;
  orgSlug: string;
  listParams: ListParams<ResolvedSortKey, ResolvedFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  const page = await fetchListPage<
    ResolvedCandidateRow,
    ResolvedSortKey,
    ResolvedFilterKey
  >({
    spec: RESOLVED_LIST,
    params: listParams,
    organisationId,
    table: "merge_candidates",
    select: RESOLVED_SELECT,
    // `scope: "deleted"` puts `deleted_at is not null` on every query this page
    // makes, which is both the semantics ("resolved") and the partial index's
    // predicate. There is no value of `scope` that omits the clause.
    scope: "deleted",
    mapRow: mapResolvedCandidate,
  });

  return (
    <EntityList
      spec={RESOLVED_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={resolvedColumns(orgSlug)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing pairs where both records are assigned to you.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">Nothing resolved yet</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            When a flagged pair is merged or set aside, it moves here with the
            decision recorded against it.
          </p>
        </div>
      }
    />
  );
}

function resolvedColumns(
  orgSlug: string,
): readonly ListColumn<ResolvedCandidateRow, ResolvedSortKey>[] {
  return [
    {
      key: "label",
      header: "Records",
      render: (row) => (
        <span className="flex flex-col gap-1">
          {/* Links to the SURVIVING side. For a merged pair the other record is
              soft-deleted and its page still resolves, but the useful
              destination is the one the data ended up on. */}
          <Link
            href={entityHref(orgSlug, row.entityType, row.keepId)}
            className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {row.label}
          </Link>
          <span className="text-sm text-ink-muted">
            two {entityNoun(row.entityType)} records
          </span>
        </span>
      ),
    },
    {
      key: "resolution",
      header: "Decision",
      // TEXT, NEVER COLOUR ALONE. DESIGN.md: the label is the signal.
      render: (row) => (
        <span className="text-ink">
          {row.resolution === "merged" ? "Merged" : "Different records"}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Flagged because",
      secondary: true,
      render: (row) => (
        <span className="text-ink-muted">{reasonLabel(row.reason)}</span>
      ),
    },
    {
      key: "resolved",
      header: "Resolved",
      sortKey: "resolved",
      numeric: true,
      render: (row) => (
        <time dateTime={row.resolvedAt} className="text-ink-muted">
          {formatDate(row.resolvedAt)}
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
