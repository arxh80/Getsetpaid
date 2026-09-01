import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import {
  loadArtistsForPicker,
  loadEvent,
  loadLineupForEvent,
  loadLinkOptions,
} from "@/lib/crm/queries";
import {
  getFinanceReadAccess,
  getFinanceWriteAccess,
} from "@/lib/crm/finance-access";
import {
  loadEventFinanceSummary,
  loadFinancialEntriesForEvent,
} from "@/lib/crm/finance-queries";
import { ZERO_FINANCE_SUMMARY } from "@/lib/crm/finance-summary";
import { FinancePanel } from "@/components/crm/finance-panel";
import type { RawSearchParams } from "@/lib/list/params";
import { LineupPanel } from "@/components/crm/lineup-panel";
import { loadCustomFieldPanel } from "@/lib/crm/custom-field-queries";
import { CustomFieldsPanel } from "@/components/crm/custom-fields-panel";
import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { RelatedPanel } from "@/components/crm/related-panel";
import {
  activityIsScoped,
  activityParams,
  fetchActivityPage,
} from "@/lib/crm/activity";
import { deleteEventAction, restoreEventAction } from "@/lib/crm/events";
import { StatusChip } from "@/components/crm/status-chip";
import { TYPE_LABELS } from "@/lib/crm/event-status";
import { Alert } from "@/components/ui/alert";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";

// One event.
//
// ===========================================================================
// A DELETED EVENT RENDERS, AND THAT IS THE RESTORE PATH
// ===========================================================================
// `loadEvent` does not filter `deleted_at`, so this route serves a
// soft-deleted record with a notice and a Restore control instead of a 404.
// Two things depend on it: the restore queue links straight here, and the
// delete confirmation leaves the user on the record they just deleted with the
// undo already in front of them. A 404 after deleting is the shape that makes
// people afraid of the delete button.
//
// ===========================================================================
// UNTRUSTED FREE TEXT AND ONE UNTRUSTED URL
// ===========================================================================
// `notes` and `location` are unstructured by design and are rendered inside
// ordinary elements, which React escapes -- never `dangerouslySetInnerHTML`,
// per CLAUDE.md § Non-negotiable rules. `whitespace-pre-line` keeps the line
// breaks somebody typed without interpreting anything else in the string.
//
// `ticket_link` is the one column here that becomes an `href`, and the anchor
// reads `ticketLinkHref` -- `safeHref()`'s answer, computed in
// lib/crm/queries.ts -- never the raw column. `events_ticket_link_is_http` is
// a CHECK on the column and 20260901000000 calls it "DEFENCE IN DEPTH, NOT THE
// CONTROL" precisely because it does not run on render: a row written before
// it, by an import, or by a direct PostgREST PATCH is still possible, and a
// value it rejects arrives here as null and renders as INERT TEXT so the user
// can see and fix it.
//
// ===========================================================================
// WHAT IS NOT HERE YET, AND WHERE IT GOES
// ===========================================================================
// Three panels are named in the brief's section order and belong to later
// tasks. Their slots are marked below rather than left to be re-derived, so
// neither task has to restructure this page to land:
//
//   Task 5   LANDED. The lineup panel is below, between the details and the
//            custom-fields slot, taking `panelBlocked` in the shape this note
//            predicted. It brings the page's FIRST namespaced list
//            (`lineup_`), which is why `searchParams` is now read here.
//   Task 6   LANDED. The CUSTOM FIELDS panel ('event' has been a custom-field
//            entity type since 20260901001000, and the engine is Phase 2's
//            unchanged -- no new limit, no new message) and the ACTIVITY
//            TIMELINE, in that order, exactly as on the venue page. The
//            timeline is the page's SECOND lib/list/ surface: it carries the
//            `activity_` namespace and gets the same `raw` as `preserve` that
//            the lineup panel does, which is what stops paging one from
//            returning the other to page one. See lib/crm/lineup-list.ts's
//            header for both halves.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/events/[eventId]">): Promise<Metadata> {
  const { orgSlug, eventId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadEvent(org.id, eventId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Events · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "event-manage-blocked";

export default async function EventDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/events/[eventId]">) {
  const { orgSlug, eventId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access, financeReadable, financeAccess] = await Promise.all([
    loadEvent(org.id, eventId),
    getCrmWriteAccess(org, "manage_events"),
    // THE FINANCE RENDER GATE: whether the panel shows at all. view_finance,
    // resolved through has_permission (which folds in aal2 and suspension) --
    // NOT tier-gated (Q67: a downgrade must not hide existing data). See
    // getFinanceReadAccess.
    getFinanceReadAccess(org),
    // THE FINANCE WRITE GATE: tier (finance_module, Pro only) ∩ manage_finance
    // ∩ aal2 ∩ not-suspended, as a CrmWriteAccess with the disabled-state
    // sentence. Resolved here so the panel's disabledReason and the picker
    // fetch below both have it.
    getFinanceWriteAccess(org),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this event just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const event = result.record;
  const basePath = `/${org.slug}/events`;
  const venueHref =
    event.venueId !== null && event.venueName !== null && !event.venueDeleted
      ? `/${org.slug}/venues/${event.venueId}`
      : null;

  // THE LINEUP PANEL'S GATE, the expression Task 4's slot comment spelled out.
  // A deleted event's lineup is READABLE and not WRITABLE, and as of
  // 20260901011000 that second half is a policy term (`p.deleted_at is null`
  // in all three event_lineup write policies), not only an application check
  // -- so this is the explanation rather than the enforcement.
  const panelBlocked =
    event.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : access.canWrite
        ? null
        : access.explanation;

  // THE FINANCE PANEL'S WRITE GATE, the finance analogue of `panelBlocked`. A
  // deleted event's finance is READABLE and not WRITABLE (the write policies
  // carry the event-live term); otherwise it is the finance write access's
  // sentence. Null means writable. The panel is only RENDERED at all when
  // `financeReadable` (view_finance) -- computed below.
  const financeDisabledReason =
    event.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : financeAccess.canWrite
        ? null
        : financeAccess.explanation;
  const financeCanWrite = financeDisabledReason === null;

  // THE FIRST PAGE IN THIS PHASE WITH A NAMESPACED LIST ON IT, and Task 6 adds
  // the second (the activity timeline, `activity_`). `lineupParams` reads only
  // keys beginning `lineup_`, so the two never see each other's cursor; `raw`
  // is passed to the panel as `preserve` so paging this list does not rebuild
  // the URL without the other one's state. lib/crm/lineup-list.ts's header and
  // the artist detail page carry both halves.
  const raw = (await searchParams) as RawSearchParams;

  // THE TIMELINE'S OWN PAGE OF ITS OWN LIST. `activityParams` reads only keys
  // beginning `activity_` and drops `activity_q` (there is no search control on
  // that surface), so this and `loadLineupForEvent`'s `lineup_` parsing cannot
  // see each other's cursor.
  const activityListParams = activityParams(raw);

  const [
    lineup,
    artistOptions,
    customFields,
    activity,
    finance,
    financeSummary,
    financeArtistOptions,
    financeSupplierOptions,
  ] = await Promise.all([
    // THE RAW QUERY STRING GOES IN and the parsed params come back: the loader
    // owns LINEUP_LIST's namespace and the `lineup_q` drop, so this page
    // cannot get either wrong. See `loadLineupForEvent`.
    loadLineupForEvent(org.id, event.id, raw),
    // ONLY WHEN THERE IS A FORM TO PUT THEM IN. A blocked panel renders
    // disabled controls with no options, so fetching a hundred artist names
    // for it would be a round trip nobody can see.
    panelBlocked === null
      ? loadArtistsForPicker(org.id)
      : Promise.resolve([] as { id: string; name: string }[]),
    // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
    // the panel is a Client Component and this is the only place with an
    // RLS-scoped server client. The loader returns the values of REMOVED
    // definitions too, which is what makes "removing a field keeps what was
    // filled in" visible rather than merely true (20260829010000, decision 1).
    loadCustomFieldPanel(org.id, "event", event.id),
    fetchActivityPage(org.id, "event", event.id, activityListParams),
    // THE SIXTH lib/list/ SURFACE (`fin_`), and its summary -- fetched ONLY
    // when the caller holds view_finance, mirroring the `panelBlocked ? [] :
    // loadArtistsForPicker` skip: a caller without it never renders the panel,
    // so the finance page and the security_invoker summary view (which would
    // return no rows for them anyway) are a wasted round trip. `raw` carries
    // every list's query state; loadFinancialEntriesForEvent owns the `fin_`
    // namespace so this page cannot get it wrong.
    financeReadable
      ? loadFinancialEntriesForEvent(org.id, event.id, raw)
      : Promise.resolve(null),
    financeReadable
      ? loadEventFinanceSummary(org.id, event.id)
      : Promise.resolve(null),
    // THE PICKERS, only when there is a form to put them in -- the same
    // argument the lineup's artist fetch makes. Bounded live artists/contacts,
    // by name, capped at 100 (loadLinkOptions).
    financeCanWrite
      ? loadArtistsForPicker(org.id)
      : Promise.resolve([] as { id: string; name: string }[]),
    financeCanWrite
      ? loadLinkOptions("contacts", org.id, [])
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Events
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {event.name}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip status={event.status} />
          <span className="text-base text-ink-muted">
            {TYPE_LABELS[event.eventType]}
          </span>
        </div>
      </div>

      {event.deletedAt !== null ? (
        <Alert tone="info">
          {DELETED_RECORD_EXPLANATION} It was deleted on{" "}
          <time dateTime={event.deletedAt} className="tabular-nums">
            {formatDateTime(event.deletedAt)}
          </time>
          .
        </Alert>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Starts">
          {/* `dateTime` carries the INSTANT; the text carries the UK-local
              rendering of it. A screen reader and a browser's "add to
              calendar" both read the attribute, and a human reads the text.
              DESIGN.md § Numerals: tabular figures on every date. */}
          <time dateTime={event.startsAt} className="tabular-nums">
            {formatDateTime(event.startsAt)}
          </time>
        </Detail>
        <Detail label="Ends">
          {event.endsAt === null ? (
            <Absent />
          ) : (
            <time dateTime={event.endsAt} className="tabular-nums">
              {formatDateTime(event.endsAt)}
            </time>
          )}
        </Detail>
        <Detail label="Venue">
          {venueHref !== null ? (
            <Link
              href={venueHref}
              className="break-words text-primary underline underline-offset-4 hover:text-ink"
            >
              {event.venueName}
            </Link>
          ) : event.venueName !== null ? (
            // A DELETED VENUE IS NAMED AND NOT LINKED. The name is what the
            // user recorded and hiding it would leave a dash they cannot act
            // on; the link is withheld because the venue is out of the venues
            // list. A venue this caller cannot READ is `venueName === null`
            // and falls through to the dash, identically to "no venue
            // recorded" -- that collision is deliberate and is the same one
            // the events list makes (`loadVenueNames`).
            <span className="break-words">
              {event.venueName}{" "}
              <span className="text-ink-muted">(deleted)</span>
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Room">
          {event.roomName === null ? (
            <Absent />
          ) : (
            <span className="break-words">
              {event.roomName}
              {event.roomClosed ? (
                // A closed room stays on the event that names it: that is what
                // `venue_rooms.deleted_at` was added for (20260827232510).
                <span className="text-ink-muted"> (closed)</span>
              ) : null}
            </span>
          )}
        </Detail>
        <Detail label="Location">
          {event.location ? (
            <span className="break-words">{event.location}</span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Tickets">
          {event.ticketLinkHref ? (
            // noreferrer as well as noopener: an outbound link from a CRM
            // should not carry the internal URL of the record it came from.
            <a
              href={event.ticketLinkHref}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {event.ticketLink}
            </a>
          ) : event.ticketLink ? (
            // NOT A LINK. A stored `javascript:` -- from an import, a merge, or
            // a direct PostgREST call that never met the form -- reaches here
            // as inert text rather than an anchor.
            <span translate="no" className="break-all">
              {event.ticketLink}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Added">
          <time dateTime={event.createdAt} className="tabular-nums">
            {formatDateTime(event.createdAt)}
          </time>
        </Detail>
        <Detail label="Last updated">
          <time dateTime={event.updatedAt} className="tabular-nums">
            {formatDateTime(event.updatedAt)}
          </time>
        </Detail>
      </dl>

      {event.notes ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Notes</h2>
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {event.notes}
          </p>
        </section>
      ) : null}

      {/* THE LINEUP (Phase 3 Task 5), in the slot Task 4 marked for it.
          `panelBlocked` is the expression that comment spelled out, computed
          above now that there is a consumer for it. */}
      <LineupPanel
        orgSlug={org.slug}
        eventId={event.id}
        page={lineup.page}
        params={lineup.params}
        basePath={`${basePath}/${event.id}`}
        removed={lineup.removed}
        artistNames={lineup.artists}
        artistOptions={artistOptions}
        disabledReason={panelBlocked}
        preserve={raw}
      />

      {/* A FAILED QUERY IS NOT AN EMPTY PANEL. Rendering nothing here would
          tell a user with forty custom fields on their events that they have
          none, which is the one thing the empty state must never do. */}
      {customFields.outcome === "unavailable" ? (
        <Alert tone="error">
          We couldn’t load this event’s custom fields just now. Refresh the page
          to try again — nothing has been changed.
        </Alert>
      ) : (
        // `disabledReason={panelBlocked}` IS THE SAME EXPRESSION THE LINEUP
        // GETS, and deliberately the same variable rather than a second copy:
        // a custom field value is an ordinary CRM write on this record, so
        // `manage_events` governs it (private.entity_is_manageable maps the
        // 'event' arm to that key, and lib/crm/custom-fields.ts's
        // PERMISSION_FOR_ENTITY mirrors it for the sentence), and a DELETED
        // event's values are read-only as a POLICY term
        // (private.entity_is_live() in the three custom_field_values write
        // policies, 20260829011000) rather than only as an application check.
        // So this is the explanation, not the enforcement.
        <CustomFieldsPanel
          orgSlug={org.slug}
          entityType="event"
          entityId={event.id}
          live={customFields.panel.live}
          removed={customFields.panel.removed}
          disabledReason={panelBlocked}
        />
      )}

      {/* THE FINANCE PANEL (Phase 5 Task 2): budget-vs-actuals summary and the
          line-item list. RENDERED ONLY WHEN `financeReadable` (view_finance) --
          both jobs of Constraint 12: the UI is hidden AND the security_invoker
          summary view refuses the rows to a caller without the permission. A
          Booker (view_crm, no view_finance) sees nothing here. `fin_` is the
          sixth namespaced surface; `preserve={raw}` keeps the other five's
          state when this list pages (Constraint 10). */}
      {financeReadable && finance !== null ? (
        <FinancePanel
          orgSlug={org.slug}
          eventId={event.id}
          basePath={`${basePath}/${event.id}`}
          summary={financeSummary ?? ZERO_FINANCE_SUMMARY}
          page={finance.page}
          params={finance.params}
          removed={finance.removed}
          artistNames={finance.artistNames}
          supplierNames={finance.supplierNames}
          artistOptions={financeArtistOptions}
          supplierOptions={financeSupplierOptions}
          disabledReason={financeDisabledReason}
          preserve={raw}
        />
      ) : null}

      {/* THE RELATED PANEL (Phase 4 Task 3): tasks, notes and documents linked
          to this event. `rel_tasks_`/`rel_notes_`/`rel_docs_` join the existing
          `lineup_` and `activity_` surfaces -- four lib/list/ surfaces now,
          each passed preserve (rule 10). This is the page the browser walk
          proves rule 10 on. */}
      <RelatedPanel
        orgSlug={org.slug}
        organisationId={org.id}
        entityType="event"
        entityId={event.id}
        basePath={`${basePath}/${event.id}`}
        raw={raw}
      />

      {/* THE SHARED ACTIVITY TIMELINE (Phase 2 Task 7, six pages since Phase 3
          Task 6). One component; the event's sources arrived as branches of
          public.activity_events (20260901030000, 20260901031000) rather than
          as a second component -- lib/crm/activity.ts's header is the
          contract. `preserve={raw}` for the reason the lineup panel has it. */}
      <ActivityTimeline
        orgSlug={org.slug}
        subjectType="event"
        page={activity}
        params={activityListParams}
        basePath={`${basePath}/${event.id}`}
        recordScoped={activityIsScoped(org.role)}
        preserve={raw}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {event.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              {/* NOT HIDDEN when write access is blocked -- an inert button
                  with a visible, aria-describedby sentence. Hiding loses the
                  explanation (FOLLOW-UPS Q6), and neither state is the
                  enforcement: 20260901011000's UPDATE policy is. */}
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${event.id}/edit`}
                label="Edit event"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteEventAction}
              hiddenFields={{ orgSlug: org.slug, eventId: event.id }}
              label="Delete event"
              question={`Delete ${event.name}? It comes out of the events list. Its lineup stays with it and can’t be changed until it is restored, from Events › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreEventAction}
            hiddenFields={{ orgSlug: org.slug, eventId: event.id }}
            label="Restore event"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
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
