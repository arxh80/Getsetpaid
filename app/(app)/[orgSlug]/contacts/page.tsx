import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  CONTACT_LIST,
  CONTACT_SELECT,
  type ContactFilterKey,
  type ContactRow,
  type ContactSortKey,
} from "@/lib/crm/contacts-list";
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

// Contacts -- the first caller of the shared list surface, and the one Task 4
// copies for companies, artists, agencies and venues.
//
// THE SERVER/CLIENT SPLIT, stated once because Task 4 inherits it:
//
//   this file          Server Component. Resolves the organisation, parses the
//                      query string against the allowlist, and renders the
//                      page frame.
//   ContactResults     Server Component, async, inside <Suspense>. Runs the
//                      two queries. Everything below it is server-rendered
//                      HTML -- rows, sort links, pager.
//   ListToolbar        the ONLY Client Component, and only because it pushes
//                      a route.
//
// The heading and the toolbar sit OUTSIDE the Suspense boundary on purpose:
// on a sort or page click the frame stays put and only the results area shows
// the placeholder. A route-level loading.tsx would have blanked the toolbar
// too, which reads as the page reloading rather than the list updating -- and
// would take the search box's focus with it on every keystroke-then-Enter.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/contacts">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  // Not found and not-yours share a title, same as they share a 404 body.
  return {
    title: org ? `Contacts · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function ContactsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/contacts">) {
  const { orgSlug } = await params;

  // NULL COVERS THREE CASES AND MUST NOT DISTINGUISH THEM: no such workspace,
  // someone else's workspace, or one the caller is only invited to. All three
  // render the identical 404 -- DESIGN.md § Error pages, tenant-isolation
  // rule. Same as every other org-scoped page.
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(CONTACT_LIST, raw);
  const basePath = `/${org.slug}/contacts`;
  const narrowed = isNarrowed(CONTACT_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);

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
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Contacts
        </h1>
      </div>

      <ListToolbar
        spec={CONTACT_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      {/* THE KEY COVERS WHAT THE TOOLBAR CHANGES, AND NOTHING ELSE. Found in
          the browser, not in review, and it is the whole reason this comment
          is long.

          Keying the boundary on the full URL -- the obvious thing -- showed a
          placeholder on every interaction, which reads well. It also tore the
          subtree down on every interaction, and the pager and the sort
          controls live INSIDE it. So clicking "Next" unmounted the "Next"
          link the user had just activated and dropped focus to <body>,
          undoing the whole reason list-pager.tsx renders an unavailable
          direction as a focusable anchor. Measured: document.activeElement
          was BODY after a page click.

          Splitting it by WHERE THE CONTROL LIVES resolves both:

            search, filters, page size   controls in the toolbar, OUTSIDE this
                                         boundary. Remounting is safe (focus
                                         is not in here) and the placeholder
                                         is worth having, because these change
                                         the result set.
            sort, cursor                 controls INSIDE this boundary. No
                                         remount, so React updates the same
                                         anchors in place and focus survives.
                                         Both are index-backed and measured at
                                         well under a millisecond, so there is
                                         nothing worth showing a placeholder
                                         for.

          Verified after the change: focus stays on "Next" across a page
          click, and on the column header across a sort click. */}
      <Suspense
        key={JSON.stringify([
          listParams.q,
          listParams.filters,
          listParams.pageSize,
        ])}
        fallback={<ListSkeleton columns={CONTACT_COLUMNS.length} />}
      >
        <ContactResults
          organisationId={org.id}
          listParams={listParams}
          basePath={basePath}
          narrowed={narrowed}
          recordScoped={recordScoped}
        />
      </Suspense>
    </div>
  );
}

async function ContactResults({
  organisationId,
  listParams,
  basePath,
  narrowed,
  recordScoped,
}: {
  organisationId: string;
  listParams: ListParams<ContactSortKey, ContactFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
}) {
  // The signed-in user's own id, read from the VERIFIED JWT
  // (getClaims(), not the cookie's contents) and cached for the request, so
  // this costs no extra round trip on top of getCurrentOrg's. It is the only
  // identity the "Mine" filter uses; nothing about who the caller is comes
  // from the query string.
  const user = await getCurrentUser();

  const page = await fetchListPage<ContactRow, ContactSortKey, ContactFilterKey>({
    spec: CONTACT_LIST,
    params: listParams,
    organisationId,
    table: "contacts",
    select: CONTACT_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      name: String(row.name),
      email: (row.email as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      updatedAt: String(row.updated_at),
    }),
    // NO `sortValue` HERE ANY MORE. It was
    //   (row, sort) => sort === "updated" ? String(row.updated_at) : String(row.name)
    // -- a hand-written copy of a map the spec already holds, whose `else`
    // branch is a catch-all. Review finding M-6: add a third sort to
    // CONTACT_LIST without touching this line and every cursor silently
    // carries the wrong column's value, which is I-2's failure arrived at by
    // omission rather than by a forged URL. `fetchListPage` derives it from
    // `spec.sort[sort].column`; the only remaining obligation is that
    // CONTACT_SELECT contains every sortable column, and that is checked and
    // logged at runtime.
    applyFilters: (query: ListQuery, filters) =>
      // "Mine" is the caller's own id from the verified session above -- never
      // a value from the request. The only two things that reach this query
      // from the query string are the search term and the cursor, and both go
      // through lib/list/postgrest.ts on the way.
      //
      // Measured: 0.399 ms on a 25,000-row tenant, an Index Only Scan on
      // contacts_org_name_id_live_idx, because owner_user_id is in that
      // index's INCLUDE list. No separate index is needed for this filter.
      filters.owner === "mine" && user
        ? query.eq("owner_user_id", user.id)
        : query,
  });

  return (
    <EntityList
      spec={CONTACT_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={CONTACT_COLUMNS}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing contacts assigned to you. Others in this workspace
            may see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped
              ? "No contacts assigned to you"
              : "No contacts yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            A contact is a person this workspace works with — a promoter, a
            booking agent, a venue manager, a driver. Events, holds and
            settlements all point back to someone here, so this is where the
            rest of the workflow starts.
          </p>
          <p className="mt-3 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? "Ask an Owner or Admin to assign some to you."
              : "Adding contacts arrives with the next release."}
          </p>
        </div>
      }
    />
  );
}

const CONTACT_COLUMNS: readonly ListColumn<ContactRow, ContactSortKey>[] = [
  {
    key: "name",
    header: "Name",
    sortKey: "name",
    // No link, deliberately. Contact detail pages are Task 4; a name styled
    // as a link that navigates nowhere is the "dead affordance" the Foundation
    // review caught three times. Task 4 wraps this in a <Link> and nothing
    // else on this page changes.
    render: (row) => (
      <span className="font-semibold break-words text-ink">{row.name}</span>
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
    // translate="no": an address is an identifier, and a browser's page
    // translator will happily rewrite the domain into something that is no
    // longer the contact's address. Same reasoning as the app header.
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
    key: "location",
    header: "Location",
    secondary: true,
    render: (row) => row.location ?? <Absent />,
  },
  {
    key: "updated",
    header: "Updated",
    sortKey: "updated",
    // DESIGN.md § Numerals: tabular figures on every date column, so the
    // column aligns instead of shimmering down the page.
    numeric: true,
    render: (row) => (
      <time dateTime={row.updatedAt} className="text-ink-muted">
        {formatDate(row.updatedAt)}
      </time>
    ),
  },
];

/**
 * An empty cell, said out loud.
 *
 * A blank <td> in a dense table is indistinguishable from a rendering fault,
 * and a screen reader passes over it in silence, so the listener cannot tell
 * "no email recorded" from "the email column is broken". An em dash with an
 * accessible name says which.
 */
function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
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
