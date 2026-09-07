import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { RelatedPanel } from "@/components/crm/related-panel";
import {
  activityIsScoped,
  activityParams,
  fetchActivityPage,
} from "@/lib/crm/activity";
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { isRecordScopedRole } from "@/lib/crm/record-scope";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  loadEventsForVenue,
  loadRoomsForVenue,
  loadVenue,
} from "@/lib/crm/queries";
import {
  VENUE_EVENTS_LIST,
  type EventRow,
  type VenueEventsSortKey,
} from "@/lib/crm/events-list";
import { isNarrowed, type RawSearchParams } from "@/lib/list/params";
import type { ListColumn } from "@/lib/list/spec";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { StatusChip } from "@/components/crm/status-chip";
import { deleteVenueAction, restoreVenueAction } from "@/lib/crm/venues";
import { loadCustomFieldPanel } from "@/lib/crm/custom-field-queries";
import { CustomFieldsPanel } from "@/components/crm/custom-fields-panel";
import { Alert } from "@/components/ui/alert";
import { MergedIntoNotice } from "@/components/crm/merged-notice";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import { RoomPanel } from "@/components/crm/room-panel";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";

// One venue, with its rooms managed inline.
//
// ===========================================================================
// A DELETED VENUE RENDERS, AND THAT IS THE RESTORE PATH
// ===========================================================================
// `loadVenue` does not filter `deleted_at`, so this route serves a
// soft-deleted record with a notice and a Restore control instead of a 404.
// Two things depend on it: the restore queue links straight here, and the
// delete confirmation leaves the user on the record they just deleted with the
// undo already in front of them. A 404 after deleting is the shape that makes
// people afraid of the delete button.
//
// While it is deleted its ROOMS are not writable -- and as of 20260829001000
// that is a policy term (`p.deleted_at is null` in both venue_rooms write
// policies), not only an application check. The panel says so rather than
// leaving the user to discover it through a refused click.
//
// ===========================================================================
// TWO lib/list/ SURFACES SINCE PHASE 3 TASK 7, AND THE RULE THAT COMES WITH IT
// ===========================================================================
// "Events here" (VENUE_EVENTS_LIST, `venueevents_`) and the activity timeline
// (ACTIVITY_LIST, `activity_`). Both read a cursor off THIS page's one query
// string, so both need their own `paramPrefix` -- or one hands the other its
// cursor and the symptom is a PostgREST 400 rendered as "we couldn't load" on
// a page where nothing is wrong (lib/crm/activity.ts's header states it in
// full) -- and both need `preserve`, or paging one silently returns the other
// to page one. The ROOM panel is neither: it is a `LINK_PANEL_LIMIT` capped
// read with no pager and no query keys at all.
//
// THE TIMELINE IS NOT THE EVENTS LIST AND NEITHER REPLACES THE OTHER. Since
// Task 6 the timeline carries this venue's `link_added` entries -- "an event
// was booked here", the moment it happened, in date-of-change order. "Events
// here" is the BOOKING DIARY: the nights themselves, in date-of-night order,
// with their status. One is what changed; the other is what is on.
//
// ===========================================================================
// UNTRUSTED FREE TEXT, RENDERED AS TEXT
// ===========================================================================
// `technical_info` and `address` are unstructured by design (PRD 6.4 asks for
// "technical information" and specifies no schema). They are rendered inside
// ordinary elements, which React escapes -- never `dangerouslySetInnerHTML`,
// per CLAUDE.md § Non-negotiable rules. `whitespace-pre-line` preserves the
// line breaks somebody typed without interpreting anything else in the string.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/venues/[venueId]">): Promise<Metadata> {
  const { orgSlug, venueId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadVenue(org.id, venueId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Venues · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "venue-manage-blocked";

export default async function VenueDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/venues/[venueId]">) {
  const { orgSlug, venueId } = await params;
  // `?merged=1` -- see components/crm/merged-notice.tsx. A FLAG, never the
  // merged-away record's name: that name is personal data and a query string is
  // logged, bookmarked and pasted into support tickets.
  const justMerged = (await searchParams).merged === "1";
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadVenue(org.id, venueId),
    getCrmWriteAccess(org, "manage_venues"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this venue just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const venue = result.record;
  const rooms = await loadRoomsForVenue(org.id, venue.id);
  // WHY THE ROLE AND NOT ONLY THE ACCESS. A short events list means "this
  // venue has had few nights" for a full-scope viewer and "few of them are
  // assigned to you" for a record-scoped one, and only the role tells the page
  // which sentence is true. Same argument as the events list's own scope note.
  const recordScoped = isRecordScopedRole(org.role);

  const blocked = access.canWrite ? null : access.explanation;
  const panelBlocked =
    venue.deletedAt !== null ? DELETED_RECORD_EXPLANATION : blocked;
  // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
  // the panel is a Client Component and this is the only place with an
  // RLS-scoped server client. `includeRemoved` is implied: the loader
  // returns the values of REMOVED fields too, which is what makes
  // "removing a field keeps what was filled in" visible rather than merely
  // true (20260829010000, decision 1).
  const customFields = await loadCustomFieldPanel(org.id, "venue", venue.id);
  // A CUSTOM FIELD VALUE IS AN ORDINARY CRM WRITE ON THIS RECORD, so the
  // key that gates it is the venue's own key --
  // private.entity_is_manageable() maps this entity type to it in the
  // database, and lib/crm/custom-fields.ts's PERMISSION_FOR_ENTITY mirrors
  // that mapping for the sentence. `manage_custom_fields` governs the
  // DEFINITION and nothing here.
  //
  // A DELETED RECORD'S VALUES ARE READ-ONLY, and as of 20260829011000 that
  // is a policy term (private.entity_is_live() in the three
  // custom_field_values write policies), not only an application check --
  // so this is the explanation rather than the control.
  const customFieldsBlocked =
    venue.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : access.canWrite
        ? null
        : access.explanation;
  const basePath = `/${org.slug}/venues`;

  // THE WHOLE QUERY STRING, READ ONCE. Both list surfaces on this route take
  // it: each parses only the keys its own `paramPrefix` owns, and each is
  // handed the whole object again as `preserve` so paging one leaves the other
  // where it was. See the header.
  const raw = (await searchParams) as RawSearchParams;

  // THE TIMELINE'S OWN PAGE OF ITS OWN LIST. `activityParams` reads only keys
  // beginning `activity_`, and not even `activity_q` -- there is no search
  // control on this surface (lib/crm/activity.ts). So it cannot be confused by
  // `?merged=1`, or narrowed by a hand-edited URL, or disturbed by anything a
  // later phase adds to this route.
  const activityListParams = activityParams(raw);
  const activity = await fetchActivityPage(
    org.id,
    "venue",
    venue.id,
    activityListParams,
  );

  return (
    <div className="flex flex-col gap-8">
      {justMerged ? (
        <MergedIntoNotice noun="venue" historyHref={`/${org.slug}/merges`} />
      ) : null}
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Venues
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {venue.name}
        </h1>
        {venue.location ? (
          <p className="text-base break-words text-ink-muted">{venue.location}</p>
        ) : null}
      </div>

      {venue.deletedAt !== null ? (
        <div role="status" className="border border-rule-strong bg-surface px-3 py-3">
          <p className="text-base text-ink">
            <span className="font-semibold text-warning">Deleted.</span> This
            venue was deleted on{" "}
            <time dateTime={venue.deletedAt} className="tabular-nums">
              {formatDateTime(venue.deletedAt)}
            </time>
            . Its rooms are still here and come back with it; until then they
            can’t be changed.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Capacity">
          {venue.capacity === null ? (
            // "Unknown", not an em dash and never 0 -- the column is nullable
            // precisely so this is expressible.
            <span className="text-ink-muted">Unknown</span>
          ) : (
            // DESIGN.md § Numerals: tabular figures on every number.
            <span className="tabular-nums">
              {venue.capacity.toLocaleString("en-GB")}
            </span>
          )}
        </Detail>
        <Detail label="Website">
          {/* `websiteHref`, NEVER `website`. The raw column is user content and
              `normaliseWebsite()` only guards the form -- an import, a merge or
              a direct PostgREST call with the anon key writes this column
              without meeting it. safeHref() decides in lib/crm/queries.ts; this
              only renders the decision, and renders the raw value as inert text
              when the answer is no, so the user can see and fix it.

              noreferrer as well as noopener: an outbound link from a CRM should
              not carry the internal URL of the record it came from. */}
          {venue.websiteHref ? (
            <a
              href={venue.websiteHref}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {venue.website}
            </a>
          ) : venue.website ? (
            <span translate="no" className="break-all">
              {venue.website}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Address">
          {venue.address ? (
            <span className="break-words whitespace-pre-line">{venue.address}</span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Social">
          {venue.socials.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {venue.socials.map((entry) => (
                <li key={entry.key} className="break-all">
                  <span className="text-ink-muted">{entry.label}: </span>
                  {entry.href ? (
                    <a
                      href={entry.href}
                      rel="noopener noreferrer nofollow"
                      target="_blank"
                      className="text-primary underline underline-offset-4 hover:text-ink"
                    >
                      {entry.value}
                    </a>
                  ) : (
                    // NOT A LINK, and this is the render-side half of the
                    // protocol rule. A handle is not a URL, and a stored
                    // `javascript:` -- from an import, a merge, or a direct
                    // PostgREST call that never met the form -- reaches here as
                    // inert text rather than an anchor.
                    <span translate="no">{entry.value}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Added">
          <time dateTime={venue.createdAt} className="tabular-nums">
            {formatDateTime(venue.createdAt)}
          </time>
        </Detail>
        <Detail label="Last updated">
          <time dateTime={venue.updatedAt} className="tabular-nums">
            {formatDateTime(venue.updatedAt)}
          </time>
        </Detail>
      </dl>

      {venue.technicalInfo ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Technical information</h2>
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {venue.technicalInfo}
          </p>
        </section>
      ) : null}

      <RoomPanel
        orgSlug={org.slug}
        venueId={venue.id}
        rooms={rooms.map((room) => ({
          id: room.id,
          name: room.name,
          isClosed: room.deletedAt !== null,
        }))}
        disabledReason={panelBlocked}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Events here</h2>
        <p className="max-w-prose text-sm text-ink-muted">
          The nights booked at this venue, most recent first. PRD 6.4 asks a
          venue for its event history; this is it, read from the events
          themselves rather than kept as a second copy.
        </p>
        {/* The key covers the toolbar's half of the shape, exactly as the
            artist page's fee history does, and deliberately NOT the cursor:
            keying on the cursor remounts the pager on every page click and
            drops focus to <body> (measured on the contacts page). This surface
            has no toolbar, so in practice the key never changes -- it is here
            so that giving it one later is one line rather than a bug. */}
        <Suspense
          key={JSON.stringify([venue.id])}
          fallback={<ListSkeleton columns={3} />}
        >
          <VenueEvents
            organisationId={org.id}
            orgSlug={org.slug}
            venueId={venue.id}
            basePath={`${basePath}/${venue.id}`}
            recordScoped={recordScoped}
            raw={raw}
          />
        </Suspense>
      </section>

      {/* A FAILED QUERY IS NOT AN EMPTY PANEL. Rendering nothing here
          would tell a user with forty custom fields that they have none,
          which is the one thing the empty state must never do. */}
      {customFields.outcome === "unavailable" ? (
        <Alert tone="error">
          We couldn’t load this record’s custom fields just now. Refresh the
          page to try again — nothing has been changed.
        </Alert>
      ) : (
        <CustomFieldsPanel
          orgSlug={org.slug}
          entityType="venue"
          entityId={venue.id}
          live={customFields.panel.live}
          removed={customFields.panel.removed}
          disabledReason={customFieldsBlocked}
        />
      )}

      {/* THE RELATED PANEL (Phase 4 Task 3): tasks, notes and documents linked
          to this venue. `rel_tasks_`/`rel_notes_`/`rel_docs_` join the existing
          `venueevents_` and `activity_` surfaces on this route -- all passed
          preserve (rule 10). */}
      <RelatedPanel
        orgSlug={org.slug}
        organisationId={org.id}
        entityType="venue"
        entityId={venue.id}
        basePath={`${basePath}/${venue.id}`}
        raw={raw}
      />

      {/* THE SHARED ACTIVITY TIMELINE (Task 7). One component, five pages,
          and every later phase's sources arrive as branches of
          public.activity_events rather than as a second component --
          lib/crm/activity.ts's header is the contract. */}
      <ActivityTimeline
        orgSlug={org.slug}
        subjectType="venue"
        page={activity}
        params={activityListParams}
        basePath={`${basePath}/${venue.id}`}
        recordScoped={activityIsScoped(org.role)}
        // ADDED BY TASK 7 WITH THE SECOND LIST, not before it: without this,
        // paging "Events here" would rebuild the URL without the timeline's
        // cursor and quietly send it back to page one. Nothing errors, which
        // is what makes it worth wiring rather than documenting.
        preserve={raw}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {venue.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${venue.id}/edit`}
                label="Edit venue"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteVenueAction}
              hiddenFields={{ orgSlug: org.slug, venueId: venue.id }}
              label="Delete venue"
              question={`Delete ${venue.name}? It comes out of the venues list. Its rooms stay with it and can’t be changed until it is restored, from Venues › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreVenueAction}
            hiddenFields={{ orgSlug: org.slug, venueId: venue.id }}
            label="Restore venue"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

/**
 * "Events here": one page of the venue's booking diary.
 *
 * A `Suspense` boundary of its own, so the rest of the record renders while
 * this streams -- the shape the artist page's fee history established.
 */
async function VenueEvents({
  organisationId,
  orgSlug,
  venueId,
  basePath,
  recordScoped,
  raw,
}: {
  organisationId: string;
  orgSlug: string;
  venueId: string;
  basePath: string;
  recordScoped: boolean;
  /**
   * The page's whole query string. THIS PAGE HAS A SECOND LIST -- the activity
   * timeline -- and without this every link built here would rebuild the URL
   * without the timeline's cursor. See HrefOverrides.preserve.
   */
  raw: RawSearchParams;
}) {
  const { params, page } = await loadEventsForVenue(organisationId, venueId, raw);

  return (
    <EntityList
      spec={VENUE_EVENTS_LIST}
      params={params}
      basePath={basePath}
      page={page}
      columns={venueEventColumns(orgSlug)}
      rowKey={(row) => row.id}
      // ALWAYS FALSE TODAY, and derived rather than written as `false`:
      // `venueEventsParams` drops this surface's only narrowing key
      // (`venueevents_q`) and the spec declares no filters, so nothing can
      // narrow it. Deriving it means giving the surface a filter later cannot
      // leave the empty state lying.
      narrowed={isNarrowed(VENUE_EVENTS_LIST, params)}
      preserve={raw}
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
            {recordScoped ? "No events assigned to you here" : "No events here yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? "Events at this venue that are assigned to you will appear here."
              : "An event booked at this venue appears here. Set the venue on an event and it shows up, with its date and status."}
          </p>
        </div>
      }
    />
  );
}

/**
 * Three columns, and the VENUE column is the one deliberately missing.
 *
 * Every row here is at this venue, so a Venue column would be the page's own
 * heading repeated down the table. That is also why this surface needs no
 * `loadVenueNames` second query, which the events list and the artist's event
 * history both do.
 */
function venueEventColumns(
  orgSlug: string,
): readonly ListColumn<EventRow, VenueEventsSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      // NOT SORTABLE, and `sortKey` being constrained to the spec's own keys
      // makes that a compile error rather than a judgement call: this spec
      // declares one sort. A name sort here would need
      // `events_org_name_id_live_idx` and a second column header on a panel
      // inside a record page, which is noise.
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
      numeric: true,
      render: (row) => (
        // `dateTime` carries the INSTANT; the text carries the UK-local
        // rendering of it.
        <time dateTime={row.startsAt}>{formatDateTime(row.startsAt)}</time>
      ),
    },
    {
      key: "status",
      header: "Status",
      // A LABEL, NOT A COLOUR. `StatusChip` renders the word and uses colour
      // only to reinforce it -- DESIGN.md forbids colour as the only signal.
      render: (row) => <StatusChip status={row.status} />,
    },
  ];
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
        {label}
      </dt>
      <dd className="text-base break-words text-ink">{children}</dd>
    </div>
  );
}

/** A blank cell is indistinguishable from a rendering fault, and silent to a
 *  screen reader. */
function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}
