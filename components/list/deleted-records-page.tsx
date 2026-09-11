import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage } from "@/lib/list/query";
import type { ListColumn, ListSpec } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";

// THE RESTORE QUEUE, ONCE, FOR EVERY ENTITY THAT HAS ONE.
//
// ===========================================================================
// WHY THIS IS A ROUTE PER ENTITY AND NOT A FILTER ON THE LIVE LIST
// ===========================================================================
// Kept here because it is the reason the shape below exists at all, and the
// nine route files that used to each carry a copy of this argument are now
// three-line configs that would carry it nowhere.
//
// CLAUDE.md requires soft delete, and a soft delete nobody can undo is a hard
// delete with extra steps -- so restore needs a way to REACH a deleted record.
// The two candidate shapes were a `?status=deleted` filter on the live list
// and a route of its own. It is the route, for three reasons:
//
//   1. `lib/list/query.ts` calls `.is("deleted_at", null)` one of four
//      non-negotiable clauses, with the partial indexes as half the argument.
//      A clause a query parameter can talk the list out of is not
//      non-negotiable. `scope` is an option the SERVER sets per route and the
//      request cannot reach -- and it is set to "deleted" in exactly one place
//      now, below, rather than in ten files a reviewer has to check.
//   2. The count line. "12 contacts" above the live list has to be a true
//      statement about live contacts; a mode that changes what it counts makes
//      it a statement about whatever mode you happen to be in.
//   3. The actions differ completely. A deleted record has no Edit and no
//      Delete; it has Restore. A list whose row actions change under a filter
//      is two lists sharing a URL.
//
// ===========================================================================
// WHAT THIS FACTORY OWNS, AND WHAT IT DELIBERATELY DOES NOT
// ===========================================================================
// It owns the frame every restore queue shares and must not drift on: metadata,
// org resolution and its 404, param parsing, the breadcrumb, the heading, the
// toolbar, the Suspense boundary and its key, the `scope: "deleted"` read, and
// the EntityList wiring.
//
// It does NOT own copy. `blurb`, `scopeNote` and `emptyState` are passed in per
// entity, and `scopeNote`/`emptyState` receive `recordScoped` so each page keeps
// the exact sentences it shipped with. That is not indecision: the nine pages
// genuinely differ there and the differences are load-bearing. A deleted
// document is scoped by who UPLOADED it, not by assignment; notes are scoped by
// authorship and so have no record-scope note at all; five pages name the
// entity in an empty-state heading and four say "Nothing deleted". Collapsing
// those into one generated sentence would be a product change wearing a
// refactor's clothes, so the factory refuses to make it.
//
// ===========================================================================
// NINE QUEUES USE THIS. DELETED DOCUMENTS DELIBERATELY DOES NOT
// ===========================================================================
// A document has no detail page, so its restore is an INLINE control in the
// row, and that control has to know whether the caller holds manage_documents
// -- which is an async permission read, feeding the COLUMNS rather than just a
// note under the list. It also renders a write-blocked explanation after the
// table when there is something the caller cannot restore.
//
// Threading that through here would mean an async `columns`, a permission this
// factory fetches for nine callers who never read it, and a second optional
// slot for the footer. That is three concepts added to every page to serve one.
// So app/(app)/[orgSlug]/documents/deleted/page.tsx stays written out, and the
// duplication it keeps is the frame only -- roughly forty lines, once, for a
// page that genuinely differs. If a second queue ever grows inline row actions,
// that is the moment to revisit, with two examples instead of one.
//
// THE SUSPENSE KEY IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. It
// remounts the boundary when the QUERY changes (q, filters, pageSize) and
// deliberately not when only the cursor moves, so paging does not throw the
// list back to a skeleton. Each page used to spell this out itself, which is
// nine chances to get it subtly different.

/** Everything one restore queue needs that another one's would differ on. */
export interface DeletedRecordsPageConfig<
  TRow extends { readonly id: string },
  TSort extends string,
  TFilter extends string,
> {
  /** The live list's path segment, e.g. "contacts". A route literal. */
  readonly segment: string;
  /** The breadcrumb's text, e.g. "Contacts". */
  readonly backLabel: string;
  /** Heading and metadata title, e.g. "Deleted contacts". */
  readonly title: string;
  /** The paragraph under the heading. Per entity, never generated. */
  readonly blurb: ReactNode;
  readonly spec: ListSpec<TSort, TFilter>;
  /** Table name. A literal from this module's caller, never from a request. */
  readonly table: string;
  /** PostgREST select list. Likewise a literal. */
  readonly select: string;
  readonly mapRow: (raw: Record<string, unknown>) => TRow;
  /** Columns need the slug to build row links, so they arrive as a function. */
  readonly columns: (orgSlug: string) => readonly ListColumn<TRow, TSort>[];
  /** Column count for the streamed skeleton. Match the real table, or it jumps. */
  readonly skeletonColumns: number;
  /**
   * The record-scope note, or omitted where the concept does not apply.
   *
   * THE SAME RULE AS THE LIVE LIST, AND IT HAS TO BE. Task 3's browser pass
   * found a Read Only user in a 71-contact workspace told "No contacts yet" --
   * a false claim about their employer's records. The record-scope policies
   * apply identically on this side of the soft-delete line, so a Standard User
   * sees only the deleted records they own and the copy must say which of the
   * two sentences is true.
   */
  readonly scopeNote?: (recordScoped: boolean) => ReactNode;
  readonly emptyState: (recordScoped: boolean) => ReactNode;
}

/** The `generateMetadata` and page component for one restore queue. */
export function deletedRecordsPage<
  TRow extends { readonly id: string },
  TSort extends string,
  TFilter extends string,
>(config: DeletedRecordsPageConfig<TRow, TSort, TFilter>) {
  async function generateMetadata({
    params,
  }: {
    params: Promise<{ orgSlug: string }>;
  }): Promise<Metadata> {
    const { orgSlug } = await params;
    const org = await getCurrentOrg(orgSlug);
    return {
      title: org
        ? `${config.title} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
    };
  }

  async function Page({
    params,
    searchParams,
  }: {
    params: Promise<{ orgSlug: string }>;
    searchParams: Promise<RawSearchParams>;
  }) {
    const { orgSlug } = await params;
    const org = await getCurrentOrg(orgSlug);
    if (!org) notFound();

    const raw = (await searchParams) as RawSearchParams;
    const listParams = parseListParams(config.spec, raw);
    const basePath = `/${org.slug}/${config.segment}/deleted`;
    const narrowed = isNarrowed(config.spec, listParams);
    const recordScoped = isRecordScopedRole(org.role);

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            <Link
              href={`/${org.slug}/${config.segment}`}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              {config.backLabel}
            </Link>
          </p>
          <h1 className="tracking-display text-3xl font-extrabold text-ink">
            {config.title}
          </h1>
          <p className="max-w-prose text-base text-ink-muted">{config.blurb}</p>
        </div>

        <ListToolbar
          spec={config.spec}
          params={listParams}
          basePath={basePath}
          narrowed={narrowed}
        />

        <Suspense
          key={JSON.stringify([
            listParams.q,
            listParams.filters,
            listParams.pageSize,
          ])}
          fallback={<ListSkeleton columns={config.skeletonColumns} />}
        >
          <Results
            org={org}
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
    org,
    listParams,
    basePath,
    narrowed,
    recordScoped,
  }: {
    org: CurrentOrg;
    listParams: ListParams<TSort, TFilter>;
    basePath: string;
    narrowed: boolean;
    recordScoped: boolean;
  }) {
    const page = await fetchListPage<TRow, TSort, TFilter>({
      spec: config.spec,
      params: listParams,
      organisationId: org.id,
      table: config.table,
      select: config.select,
      // The one line that makes this the other side of the soft-delete
      // boundary, and it is now written once for every restore queue.
      scope: "deleted",
      mapRow: config.mapRow,
    });

    return (
      <EntityList
        spec={config.spec}
        params={listParams}
        basePath={basePath}
        page={page}
        columns={config.columns(org.slug)}
        rowKey={(row) => row.id}
        narrowed={narrowed}
        scopeNote={config.scopeNote?.(recordScoped)}
        emptyState={config.emptyState(recordScoped)}
      />
    );
  }

  return { generateMetadata, Page };
}
