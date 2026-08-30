import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import {
  CANDIDATE_SELECT,
  DUPLICATE_LIST,
  entityHref,
  entityNoun,
  mapCandidate,
  mergeBlockedExplanation,
  reasonLabel,
  type CandidateFilterKey,
  type CandidateRow,
  type CandidateSortKey,
} from "@/lib/crm/dedup";
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
import { formatDate } from "@/lib/format/date";

// The duplicate review queue.
//
// ===========================================================================
// THE EMPTY STATE MUST NOT LIE, AND HERE THAT IS TWO SEPARATE PROBLEMS
// ===========================================================================
// Task 3's browser pass found a Read Only user in a 71-contact workspace shown
// "No contacts yet". This page can produce two versions of that mistake, and
// they need different sentences:
//
//   a RECORD-SCOPED user sees only candidates where BOTH records are theirs.
//   The policy requires both sides visible, because field_resolution copies
//   the discarded values of both records verbatim -- so a Standard User in a
//   workspace with forty flagged pairs may legitimately see none. "No possible
//   duplicates" would be a false statement about the workspace.
//
//   a user WITHOUT merge_records -- Booker, Venue Manager, Finance,
//   Marketing, Standard User, Read Only -- can read the whole queue and cannot
//   action any of it. Telling them the queue is a to-do list is worse than
//   telling them nothing. The banner below says who can act, on every visit
//   rather than only when the list is empty, because a queue full of rows with
//   no controls is exactly as confusing as an empty one.
//
// Neither is a permission check standing in for a read: every role that
// reaches this page holds view_crm and the queue is genuinely readable to all
// of them. What differs is what they can do next, and that is said out loud.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/duplicates">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org
      ? `Possible duplicates · ${org.name} · GetSetPaid`
      : "Not found · GetSetPaid",
  };
}

export default async function DuplicatesPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/duplicates">) {
  const { orgSlug } = await params;
  // NULL COVERS THREE CASES AND MUST NOT DISTINGUISH THEM: no such workspace,
  // someone else's, or one the caller is only invited to.
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(DUPLICATE_LIST, raw);
  const basePath = `/${org.slug}/duplicates`;
  const narrowed = isNarrowed(DUPLICATE_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "merge_records");

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
          Possible duplicates
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Records that look like two copies of the same thing. Contacts sharing
          an email address are merged automatically when they’re created;
          everything else waits here for somebody to look.
        </p>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/resolved`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Already resolved
          </Link>
          {" · "}
          <Link
            href={`/${org.slug}/merges`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Merge history
          </Link>
        </p>
        {/* SAID ON EVERY VISIT, not only when the list is empty. A row with no
            control on it is the same confusion as an empty list, and the
            explanation belongs where the rows are. */}
        {access.canWrite ? null : (
          <p className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted">
            <span className="font-semibold text-ink">
              You can read this queue, and not act on it.
            </span>{" "}
            {mergeBlockedExplanation(access)}
          </p>
        )}
      </div>

      <ListToolbar
        spec={DUPLICATE_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      {/* Keyed on what the TOOLBAR changes and nothing else -- sort and cursor
          controls live inside the boundary, so remounting on those would drop
          focus off the control the user just activated. See the contacts
          page's note for the measurement. */}
      <Suspense
        key={JSON.stringify([
          listParams.q,
          listParams.filters,
          listParams.pageSize,
        ])}
        fallback={<ListSkeleton columns={4} />}
      >
        <DuplicateResults
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

async function DuplicateResults({
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
  listParams: ListParams<CandidateSortKey, CandidateFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const page = await fetchListPage<CandidateRow, CandidateSortKey, CandidateFilterKey>({
    spec: DUPLICATE_LIST,
    params: listParams,
    organisationId,
    table: "merge_candidates",
    select: CANDIDATE_SELECT,
    mapRow: mapCandidate,
    applyFilters: (query: ListQuery, filters) =>
      // The value is one of the spec's own choices -- parseListParams rejects
      // anything else before it reaches here -- so this is an allowlisted
      // equality and not a request-supplied predicate.
      filters.reason === "any" ? query : query.eq("reason", filters.reason),
  });

  return (
    <EntityList
      spec={DUPLICATE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={candidateColumns(orgSlug, access.canWrite)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing pairs where both records are assigned to you. Others
            in this workspace may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "No possible duplicates among your records"
              : "Nothing to review"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? "A pair only appears here when both records are assigned to you — a duplicate of one of yours and one of a colleague’s goes to an Owner, Admin or Manager instead. So this being empty doesn’t mean the workspace has none."
              : "Every new record is checked against the ones already here. Two contacts with the same email address are merged on the spot; a near-match on a name is flagged and lands on this page."}
          </p>
        </div>
      }
    />
  );
}

function candidateColumns(
  orgSlug: string,
  canMerge: boolean,
): readonly ListColumn<CandidateRow, CandidateSortKey>[] {
  return [
    {
      key: "label",
      header: "Records",
      render: (row) => (
        <span className="flex flex-col gap-1">
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
      key: "reason",
      header: "Why",
      render: (row) => (
        <span className="text-ink-muted">{reasonLabel(row.reason)}</span>
      ),
    },
    {
      key: "similarity",
      header: "Similarity",
      // DESIGN.md § Numerals: tabular figures on every number in a table.
      numeric: true,
      secondary: true,
      render: (row) =>
        row.similarity === null ? (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not applicable</span>
          </span>
        ) : (
          <span className="text-ink-muted">
            {Math.round(row.similarity * 100)}%
          </span>
        ),
    },
    {
      key: "detected",
      header: "Flagged",
      sortKey: "detected",
      numeric: true,
      render: (row) => (
        <time dateTime={row.detectedAt} className="text-ink-muted">
          {formatDate(row.detectedAt)}
        </time>
      ),
    },
    {
      key: "review",
      // NAMED, not blank. An empty <th scope="col"> gives the cells under it
      // no accessible column name, so a screen reader announces the link with
      // no idea what column it is in.
      header: "Review",
      render: (row) =>
        // NOT HIDDEN WHEN THE USER CANNOT MERGE. The screen is where both
        // records are shown side by side, which is worth reading whether or not
        // the reader can act on it -- and the page itself renders its controls
        // inert with an explanation. Hiding the link would leave a queue of
        // rows with nothing to click and no way to find out why.
        canMerge ? (
          <Link
            href={`/${orgSlug}/duplicates/${row.id}`}
            className="font-semibold text-primary underline underline-offset-4 hover:text-ink"
          >
            Review
          </Link>
        ) : (
          <Link
            href={`/${orgSlug}/duplicates/${row.id}`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Compare
          </Link>
        ),
    },
  ];
}
