import { ActivityTimeline } from "@/components/crm/activity-timeline";
import {
  activityIsScoped,
  activityParams,
  fetchActivityPage,
} from "@/lib/crm/activity";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import { loadRoomsForVenue, loadVenue } from "@/lib/crm/queries";
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

  // THE TIMELINE'S OWN PAGE OF ITS OWN LIST. `activityParams` reads only keys
  // beginning `activity_`, and not even `activity_q` -- there is no search
  // control on this surface (lib/crm/activity.ts). So it cannot be confused by
  // `?merged=1`, or narrowed by a hand-edited URL, or disturbed by anything a
  // later phase adds to this route.
  const activityListParams = activityParams(await searchParams);
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
