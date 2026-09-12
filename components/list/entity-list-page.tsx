import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser, type CurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  getCrmWriteAccess,
  type CrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn, ListSpec } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NewRecordAction } from "@/components/crm/write-gate";

// THE CRM ENTITY LIST, ONCE.
//
// The five relationship-layer lists -- contacts, companies, artists, agencies,
// venues -- were one page copied five times, and the agencies copy says so in
// its own header: "This file is app/(app)/[orgSlug]/companies/page.tsx with the
// spec, the nouns and the columns changed." Measured line for line against
// contacts, the other four were 73-77% identical.
//
// It is the sibling of components/list/deleted-records-page.tsx and
// deliberately NOT the same function. A restore queue has no New button, no
// permission to resolve, no link to a deleted view and a blurb under its
// heading; a live list has all four and no blurb. Merging them would produce
// one config where half the keys are inert for half the callers, which is the
// shape both files exist to avoid.
//
// ===========================================================================
// THE SUSPENSE KEY IS THE REASON THIS IS WORTH DOING
// ===========================================================================
// It covers what the TOOLBAR changes and nothing else, and that was found in a
// browser rather than in review. Keying the boundary on the full URL -- the
// obvious thing -- tore the subtree down on every interaction, and the pager
// and the sort controls live INSIDE it. Clicking "Next" unmounted the "Next"
// link the user had just activated and dropped focus to <body>; measured,
// document.activeElement was BODY after a page click.
//
// Splitting it by WHERE THE CONTROL LIVES resolves both:
//
//   search, filters, page size   controls in the toolbar, OUTSIDE the
//                                boundary. Remounting is safe (focus is not in
//                                there) and the placeholder is worth having,
//                                because these change the result set.
//   sort, cursor                 controls INSIDE it. No remount, so React
//                                updates the same anchors in place and focus
//                                survives. Both are index-backed and measured
//                                well under a millisecond.
//
// Written out five times that is five chances to key it on the wrong thing,
// and the symptom -- focus silently lost on a pager click -- is invisible to
// every test that does not drive a keyboard. Written once, tests/e2e/keyboard.spec.ts
// covers it for every list that calls this.
//
// The heading and the toolbar sit OUTSIDE the boundary on purpose: on a sort
// or page click the frame stays put and only the results area shows the
// placeholder. A route-level loading.tsx would blank the toolbar too, which
// reads as the page reloading rather than the list updating -- and would take
// the search box's focus with it on every keystroke-then-Enter.
//
// ===========================================================================
// WHAT IT OWNS AND WHAT IT DOES NOT
// ===========================================================================
// Owns: metadata, org resolution and its 404, param parsing, the write-access
// read, the breadcrumb, the heading and its New control, the deleted-records
// link, the toolbar, the boundary and its key, the list read including the
// "Mine" owner filter, and the EntityList wiring.
//
// Does not own copy. `scopeNote` and `emptyState` are per entity and receive
// what they need to stay exactly as they shipped -- including the empty
// state's own NewRecordAction, which carries a different label and a different
// id from the one in the heading.

/** Everything one CRM list needs that another one's would differ on. */
export interface EntityListPageConfig<
  TRow extends { readonly id: string },
  TSort extends string,
  TFilter extends string,
> {
  /** Path segment, e.g. "contacts". A route literal. */
  readonly segment: string;
  /** Heading and metadata title, e.g. "Contacts". */
  readonly title: string;
  /** The heading's New control, e.g. "New contact" / "new-contact". */
  readonly newLabel: string;
  readonly newId: string;
  /** The link to the restore queue, e.g. "Deleted contacts". */
  readonly deletedLabel: string;
  /**
   * The permission the New control and every write on this entity are gated
   * on. NOT derivable from the segment: agencies and companies are gated on
   * `manage_contacts`, because 20260828121000 groups all three as "the
   * relationship layer" and no `manage_agencies` exists.
   */
  readonly permissionKey: string;
  readonly spec: ListSpec<TSort, TFilter>;
  /** Table name. A literal from this module's caller, never from a request. */
  readonly table: string;
  /** PostgREST select list. Likewise a literal. */
  readonly select: string;
  readonly mapRow: (raw: Record<string, unknown>) => TRow;
  readonly columns: (orgSlug: string) => readonly ListColumn<TRow, TSort>[];
  /** Column count for the streamed skeleton. Match the real table, or it jumps. */
  readonly skeletonColumns: number;
  readonly scopeNote: (recordScoped: boolean) => ReactNode;
  readonly emptyState: (context: {
    readonly recordScoped: boolean;
    readonly access: CrmWriteAccess;
    readonly basePath: string;
  }) => ReactNode;
}

/** The `generateMetadata` and page component for one CRM entity list. */
export function entityListPage<
  TRow extends { readonly id: string },
  TSort extends string,
  TFilter extends string,
>(config: EntityListPageConfig<TRow, TSort, TFilter>) {
  async function generateMetadata({
    params,
  }: {
    params: Promise<{ orgSlug: string }>;
  }): Promise<Metadata> {
    const { orgSlug } = await params;
    const org = await getCurrentOrg(orgSlug);
    // Not found and not-yours share a title, same as they share a 404 body.
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

    // NULL COVERS THREE CASES AND MUST NOT DISTINGUISH THEM: no such
    // workspace, someone else's workspace, or one the caller is only invited
    // to. All three render the identical 404 -- DESIGN.md § Error pages,
    // tenant-isolation rule.
    const org = await getCurrentOrg(orgSlug);
    if (!org) notFound();

    const raw = (await searchParams) as RawSearchParams;
    const listParams = parseListParams(config.spec, raw);
    const basePath = `/${org.slug}/${config.segment}`;
    const narrowed = isNarrowed(config.spec, listParams);
    const recordScoped = isRecordScopedRole(org.role);

    // Resolved OUTSIDE the Suspense boundary, alongside the heading, because
    // the New button belongs to the page frame rather than to the results: it
    // must not vanish and reappear on every search. getCurrentOrg() is already
    // cached for this request, so this costs the two lookups getCrmWriteAccess
    // makes in parallel and nothing else.
    const access = await getCrmWriteAccess(org, config.permissionKey);

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          {/* Eyebrow directly above the heading in the same column, never
              beside it -- hallmark gate 54. break-words because the workspace
              name is user-supplied and html/body carry `overflow-x: clip`, so
              an unbroken name is silently cut off rather than scrollable. */}
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
              {config.title}
            </h1>
            {/* Disabled with a visible reason rather than hidden -- see
                components/crm/write-gate.tsx. A Read Only user, a Free-tier
                workspace and a suspended one each get a different sentence,
                and none of them gets a control that silently does nothing. */}
            <NewRecordAction
              access={access}
              href={`${basePath}/new`}
              label={config.newLabel}
              id={config.newId}
            />
          </div>
          <p className="text-sm text-ink-muted">
            <Link
              href={`${basePath}/deleted`}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              {config.deletedLabel}
            </Link>
          </p>
        </div>

        <ListToolbar
          spec={config.spec}
          params={listParams}
          basePath={basePath}
          narrowed={narrowed}
        />

        {/* The key covers what the TOOLBAR changes and nothing else -- the
            module header carries the measurement behind that. */}
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
            access={access}
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
    access,
  }: {
    org: CurrentOrg;
    listParams: ListParams<TSort, TFilter>;
    basePath: string;
    narrowed: boolean;
    recordScoped: boolean;
    access: CrmWriteAccess;
  }) {
    // The signed-in user's own id, read from the VERIFIED JWT (getClaims(),
    // not the cookie's contents) and cached for the request, so this costs no
    // extra round trip on top of getCurrentOrg's. It is the only identity the
    // "Mine" filter uses; nothing about who the caller is comes from the
    // query string.
    const user = await getCurrentUser();

    const page = await fetchListPage<TRow, TSort, TFilter>({
      spec: config.spec,
      params: listParams,
      organisationId: org.id,
      table: config.table,
      select: config.select,
      mapRow: config.mapRow,
      applyFilters: (query: ListQuery, filters) =>
        // The caller's own id from the verified session, never a value from
        // the query string. Byte-identical in all five callers before this
        // module existed, which is why it lives here rather than in a prop.
        (filters as Record<string, string>).owner === "mine" && user
          ? query.eq("owner_user_id", user.id)
          : query,
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
        scopeNote={config.scopeNote(recordScoped)}
        emptyState={config.emptyState({ recordScoped, access, basePath })}
      />
    );
  }

  return { generateMetadata, Page };
}
