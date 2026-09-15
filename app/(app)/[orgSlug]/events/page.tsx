import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import { getCrmWriteAccess, type CrmWriteAccess } from "@/lib/crm/write-access";
import { loadVenueNames } from "@/lib/crm/queries";
import { StatusChip } from "@/components/crm/status-chip";
import {
  EVENT_LIST,
  EVENT_SELECT,
  mapEventRow,
  type EventFilterKey,
  type EventRow,
  type EventSortKey,
} from "@/lib/crm/events-list";
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
import { formatDateTime } from "@/lib/format/date";
import { Absent } from "@/components/ui/absent";

// Events. `manage_events` (20260901010000) -- a Booker and a Venue Manager
// both hold it, a Finance or Marketing user does not.
//
// The same file as the five Phase 2 lists with the spec, the nouns and the
// columns changed. Three things about it are not a copy:
//
//   1. THE VENUE NAME COMES FROM A SECOND QUERY, not a PostgREST embed. See
//      `loadVenueNames` in lib/crm/queries.ts for the argument, and `venueName`
//      below for what a missing entry means.
//   2. THE `when` BOUND IS THE SERVER'S CLOCK. It is computed here, per
//      request, and never read off the query string.
//   3. THE DATE COLUMN IS A `<time>` ELEMENT with the raw ISO instant in
//      `dateTime` and the UK-local rendering as its text, so the machine-
//      readable value is the instant and the human-readable one is the local
//      day. CLAUDE.md § Non-negotiable rules: "UTC in the database, UK local
//      time in the UI with explicit timezone handling."

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/events">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `Events · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function EventsPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/events">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const listParams = parseListParams(EVENT_LIST, raw);
  const basePath = `/${org.slug}/events`;
  const narrowed = isNarrowed(EVENT_LIST, listParams);
  const recordScoped = isRecordScopedRole(org.role);
  const access = await getCrmWriteAccess(org, "manage_events");

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
            Events
          </h1>
          {/* NOT HIDDEN WHEN IT IS UNAVAILABLE. components/crm/write-gate.tsx
              renders an inert <button> with a visible, `aria-describedby`
              sentence naming the reason -- for a Read Only user, "Your role in
              this workspace can view records but not change them." Hiding it
              would lose the explanation (FOLLOW-UPS Q6), and neither state is
              the enforcement: the INSERT policy in 20260901011000 refuses the
              write from any client, which supabase/tests/rls_phase3_events.sql
              EC9 asserts for `read_only` specifically. */}
          <NewRecordAction
            access={access}
            href={`${basePath}/new`}
            label="New event"
            id="new-event"
          />
        </div>
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/deleted`}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Deleted events
          </Link>
        </p>
      </div>

      <ListToolbar
        spec={EVENT_LIST}
        params={listParams}
        basePath={basePath}
        narrowed={narrowed}
      />

      <Suspense
        key={JSON.stringify([listParams.q, listParams.filters, listParams.pageSize])}
        fallback={<ListSkeleton columns={5} />}
      >
        <EventResults
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

async function EventResults({
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
  listParams: ListParams<EventSortKey, EventFilterKey>;
  basePath: string;
  narrowed: boolean;
  recordScoped: boolean;
  access: CrmWriteAccess;
}) {
  const user = await getCurrentUser();

  // ONE `now` FOR THE WHOLE REQUEST, TAKEN FROM THE SERVER'S CLOCK.
  //
  // `applyFilters` runs once for the page query and again for the count query
  // and the boundary probes (lib/list/query.ts issues up to four). Calling
  // `new Date()` inside the closure would give each of them a slightly
  // different bound, so the count could legitimately disagree with the rows --
  // "26 events" over 25 rows, intermittently, at exactly the moments an event
  // crosses the boundary. Hoisting it makes the page internally consistent.
  //
  // AND IT IS NOT FROM THE REQUEST. There is no `?when=after:2020-01-01` and
  // there must not be: the filter's whole vocabulary is `all | upcoming |
  // past`, and the instant that separates the last two is this line.
  //
  // CONSISTENT WITHIN A REQUEST, NOT ACROSS ONE (fix round 1, review Minor 6).
  // The next request recomputes it, so an event whose `starts_at` crosses the
  // wall clock between a "Next" click and a "Previous" click moves between the
  // `upcoming` and `past` windows underneath the keyset cursor -- and the two
  // page-ones can then legitimately differ by that one row. The window is
  // seconds wide and the alternative (pinning the bound into the cursor, or
  // into the URL) would make a shared link mean "upcoming as of whenever the
  // sender loaded it", which is worse and is the thing the paragraph above
  // refuses. Stated because the comment otherwise reads as though the bound
  // were stable for the life of a session.
  const now = new Date().toISOString();

  const page = await fetchListPage<EventRow, EventSortKey, EventFilterKey>({
    spec: EVENT_LIST,
    params: listParams,
    organisationId,
    table: "events",
    select: EVENT_SELECT,
    // THE SHARED MAPPER, moved to lib/crm/events-list.ts by Phase 3 Task 7.
    // It was written out here while this page was the only reader of
    // `EVENT_SELECT`; the venue and artist event histories are the second and
    // third, and three copies of one mapper over one literal is three chances
    // for a column added to the literal to be read back in only two of them.
    // It still maps `endsAt` and `eventType`, which no COLUMN on this page
    // renders -- see the note on `EventRow` for why that is deliberate.
    mapRow: mapEventRow,
    applyFilters: (query: ListQuery, filters) => {
      let q = query;
      // THREE ALLOWLISTED OPERATIONS AND NOTHING ELSE. Each `filters.*` value
      // has already been narrowed by `parseListParams` to one of the spec's
      // OWN declared choices (lib/list/params.ts, "Two allowlists, not one:
      // the KEY must be a filter this entity declares, and the VALUE must be
      // one of that filter's declared choices"), so although the line below
      // reads like user input reaching a query, `filters.status` cannot carry
      // arbitrary text -- an unrecognised `?status=` falls back to `any` and
      // this branch never runs. Said out loud because it is the line a
      // security review stops on.
      if (filters.when === "upcoming") q = q.filter("starts_at", "gte", now);
      if (filters.when === "past") q = q.filter("starts_at", "lt", now);
      if (filters.status !== "any") q = q.eq("status", filters.status);
      if (filters.owner === "mine" && user) {
        q = q.eq("owner_user_id", user.id);
      }
      return q;
    },
  });

  // Venue names for THIS page's rows only -- at most `MAX_PAGE_SIZE` = 50 ids,
  // and usually far fewer, because several events at one venue collapse to one
  // entry. Nothing is fetched when the page failed or nothing on it has a venue.
  const venueNames =
    page.outcome === "loaded"
      ? await loadVenueNames(
          organisationId,
          page.rows.flatMap((row) => (row.venueId ? [row.venueId] : [])),
        )
      : new Map<string, string>();

  return (
    <EntityList
      spec={EVENT_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={eventColumns(orgSlug, venueNames)}
      rowKey={(row) => row.id}
      narrowed={narrowed}
      scopeNote={
        recordScoped ? (
          <p className="text-sm text-ink-muted">
            You’re seeing events assigned to you. Others in this workspace may
            see more.
          </p>
        ) : undefined
      }
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">
            {recordScoped ? "No events assigned to you" : "No events yet"}
          </h2>
          {recordScoped ? (
            <p className="mt-2 max-w-prose text-base text-ink-muted">
              Ask an Owner or Admin to assign some to you.
            </p>
          ) : (
            <>
              <p className="mt-2 max-w-prose text-base text-ink-muted">
                An event is a night you are putting on: a date, a venue and a
                lineup. Create one and the artists and venue you have already
                added can be attached to it.
              </p>
              <div className="mt-4">
                <NewRecordAction
                  access={access}
                  href={`${basePath}/new`}
                  label="Add the first event"
                  id="empty-new-event"
                />
              </div>
            </>
          )}
        </div>
      }
    />
  );
}

function eventColumns(
  orgSlug: string,
  venueNames: ReadonlyMap<string, string>,
): readonly ListColumn<EventRow, EventSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      render: (row) => (
        <Link
          href={`/${orgSlug}/events/${row.id}`}
          className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: "starts",
      header: "Date",
      sortKey: "starts",
      // DESIGN.md § Numerals: tabular figures on every date column.
      // Non-negotiable.
      numeric: true,
      render: (row) => (
        // `dateTime` carries the INSTANT; the text carries the UK-local
        // rendering of it. A screen reader and a browser's "add to calendar"
        // both read the attribute, and a human reads the text.
        <time dateTime={row.startsAt}>{formatDateTime(row.startsAt)}</time>
      ),
    },
    {
      key: "venue",
      header: "Venue",
      // NOT SORTABLE, and lib/list/spec.ts makes that a compile error rather
      // than a judgement call: `sortKey` is constrained to the spec's own sort
      // keys and there is no venue sort, because the name lives in another
      // table and a keyset cursor carries one column from THIS one.
      render: (row) => {
        const name = row.venueId ? venueNames.get(row.venueId) : undefined;
        // ABSENT COVERS BOTH "no venue recorded" AND "a venue this caller
        // cannot read", identically and on purpose -- see `loadVenueNames`.
        // Saying "(unavailable)" would confirm a record exists and is out of
        // reach, which is the oracle `toLinkRows()` already refuses to build.
        return name ? <span className="break-words">{name}</span> : <Absent />;
      },
    },
    {
      key: "status",
      header: "Status",
      // NOT SORTABLE: no index of the required shape, so `backedBy` would have
      // nowhere honest to point. The toolbar's Status FILTER is how this
      // column is interrogated.
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "updated",
      header: "Updated",
      sortKey: "updated",
      numeric: true,
      secondary: true,
      render: (row) => (
        <time dateTime={row.updatedAt} className="text-ink-muted">
          {formatDateTime(row.updatedAt)}
        </time>
      ),
    },
  ];
}

