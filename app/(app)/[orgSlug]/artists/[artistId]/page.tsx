import { ActivityTimeline } from "@/components/crm/activity-timeline";
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
  loadArtist,
  loadEventsForArtist,
  loadLinkOptions,
  loadRepresentationsForArtist,
} from "@/lib/crm/queries";
import {
  ARTIST_EVENTS_LIST,
  type ArtistEventsSortKey,
  type EventRow,
} from "@/lib/crm/events-list";
import { StatusChip } from "@/components/crm/status-chip";
import {
  ARTIST_FEE_LIST,
  ARTIST_FEE_SELECT,
  formatFee,
  type ArtistFeeFilterKey,
  type ArtistFeeRow,
  type ArtistFeeSortKey,
} from "@/lib/crm/artists-list";
import {
  isNarrowed,
  parseListParams,
  type ListParams,
  type RawSearchParams,
} from "@/lib/list/params";
import { fetchListPage, type ListQuery } from "@/lib/list/query";
import type { ListColumn } from "@/lib/list/spec";
import { deleteArtistAction, restoreArtistAction } from "@/lib/crm/artists";
import { loadCustomFieldPanel } from "@/lib/crm/custom-field-queries";
import { CustomFieldsPanel } from "@/components/crm/custom-fields-panel";
import { Alert } from "@/components/ui/alert";
import { MergedIntoNotice } from "@/components/crm/merged-notice";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";
import { RepresentationPanel } from "@/components/crm/representation-panel";
import { EntityList } from "@/components/list/entity-list";
import { ListSkeleton } from "@/components/list/list-skeleton";
import {
  SecondaryRecordAction,
  WriteBlockedNote,
} from "@/components/crm/write-gate";
import { formatDateOnly, formatDateTime } from "@/lib/format/date";

// One artist: the record, who represents them, and what they have been paid.
//
// ===========================================================================
// THE FEE HISTORY IS A REAL PAGINATED LIST ON A DETAIL PAGE
// ===========================================================================
// It goes through lib/list/ rather than through a LINK_PANEL_LIMIT cap,
// because fee history GROWS -- one row per booking, kept for seven years
// (CLAUDE.md § Non-negotiable rules) -- where a join panel does not. See
// ARTIST_FEE_LIST in lib/crm/artists-list.ts for the argument.
//
// ===========================================================================
// AND IT IS NOW ONE OF THREE, WHICH MAKES THIS THE MOST EXPOSED ROUTE HERE
// ===========================================================================
// The sentence above used to end "...so this route may carry exactly ONE
// lib/list/ surface and this is it." That stopped being true when Task 7 of
// Phase 2 gave `ListSpec` a `paramPrefix`, and this route now carries THREE:
//
//   fee history   ARTIST_FEE_LIST      no prefix -- bare `after`, `sort`, ...
//   event history ARTIST_EVENTS_LIST   `artistevents_`
//   timeline      ACTIVITY_LIST        `activity_`
//
// Bare and prefixed cannot collide, and two prefixed ones cannot collide while
// the prefixes differ -- which `tests/unit/crm/events-list.test.ts` asserts as
// a SET with its cardinality rather than one field at a time. What all three
// still need is `preserve`: `buildListHref` builds from scratch on purpose, so
// without it paging any one of them silently returns the other two to page
// one. Nothing errors, which is exactly why it is wired rather than written
// down.
//
// READ ONLY. There is no "add a fee" form and that is a scope decision, not an
// omission: MVP finance is budget and actuals at EVENT level (Phase 5), and
// `artist_fee_history.event_id` is currently held NULL by
// `artist_fee_history_event_id_unwritable_until_phase_3` -- confirmed in
// pg_constraint, not assumed -- so a fee entered here could not be attached to
// the booking it came from. Queued as a decision in the task report.
//
// ===========================================================================
// A DELETED ARTIST RENDERS, AND THAT IS THE RESTORE PATH
// ===========================================================================
// `loadArtist` does not filter `deleted_at`, so this route serves a
// soft-deleted record with a notice and a Restore control instead of a 404.
// While it is deleted its REPRESENTATIONS are not writable -- and as of
// 20260829001000 that is a policy term, not only an application check.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/artists/[artistId]">): Promise<Metadata> {
  const { orgSlug, artistId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadArtist(org.id, artistId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.name} · Artists · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

/** The id of the single explanation the Manage section's controls point at. */
const MANAGE_NOTE = "artist-manage-blocked";

export default async function ArtistDetailPage({
  params,
  searchParams,
}: PageProps<"/[orgSlug]/artists/[artistId]">) {
  const { orgSlug, artistId } = await params;
  // `?merged=1` -- see components/crm/merged-notice.tsx. A FLAG, never the
  // merged-away record's name: that name is personal data and a query string is
  // logged, bookmarked and pasted into support tickets.
  const justMerged = (await searchParams).merged === "1";
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadArtist(org.id, artistId),
    getCrmWriteAccess(org, "manage_artists"),
  ]);

  // A FAILED QUERY IS NOT A MISSING RECORD. "There is no such artist" is a
  // claim about the customer's data, and making it because the database was
  // unreachable reads as deletion.
  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this artist just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const artist = result.record;
  const rows = await loadRepresentationsForArtist(org.id, artist.id);
  // NO EXCLUSION LIST. The schema is explicit that the same agency
  // representing the same artist twice is legitimate -- two territories, or
  // two separate periods -- so there is no uniqueness to protect and filtering
  // an agency out would refuse a real relationship.
  const [agencyOptions, contactOptions] = access.canWrite
    ? await Promise.all([
        loadLinkOptions("agencies", org.id, []),
        loadLinkOptions("contacts", org.id, []),
      ])
    : [[], []];

  // WHY THE PANEL NEEDS THE ROLE AND NOT ONLY THE ACCESS. An empty picker
  // means "this workspace has none" for a full-scope viewer and "none are
  // assigned to you" for a record-scoped one. Task 4b's browser pass rendered
  // the first sentence to `pstd1` on a page listing six representations; see
  // RepresentationPanel's `recordScoped` prop.
  const recordScoped = isRecordScopedRole(org.role);
  const blocked = access.canWrite ? null : access.explanation;
  const panelBlocked =
    artist.deletedAt !== null ? DELETED_RECORD_EXPLANATION : blocked;
  // CUSTOM FIELD VALUES. Loaded here rather than inside the panel because
  // the panel is a Client Component and this is the only place with an
  // RLS-scoped server client. `includeRemoved` is implied: the loader
  // returns the values of REMOVED fields too, which is what makes
  // "removing a field keeps what was filled in" visible rather than merely
  // true (20260829010000, decision 1).
  const customFields = await loadCustomFieldPanel(org.id, "artist", artist.id);
  // A CUSTOM FIELD VALUE IS AN ORDINARY CRM WRITE ON THIS RECORD, so the
  // key that gates it is the artist's own key --
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
    artist.deletedAt !== null
      ? DELETED_RECORD_EXPLANATION
      : access.canWrite
        ? null
        : access.explanation;
  const basePath = `/${org.slug}/artists`;

  const raw = (await searchParams) as RawSearchParams;
  const feeParams = parseListParams(ARTIST_FEE_LIST, raw);

  // THE PAGE WITH THREE LISTS ON IT, and the reason ACTIVITY_LIST carries
  // `paramPrefix: "activity_"` and ARTIST_EVENTS_LIST carries
  // `paramPrefix: "artistevents_"`. Without the namespaces these
  // `parseListParams` calls would read the same `after`, and the fee list
  // would compare the timeline's timestamp against `occurred_on` -- a
  // PostgREST 400 rendered as "we couldn't load fees" on a page where nothing
  // is wrong. `raw` is passed to ALL THREE as `preserve` below, so paging any
  // one of them leaves the other two where they were.
  const activityListParams = activityParams(raw);
  const activity = await fetchActivityPage(
    org.id,
    "artist",
    artist.id,
    activityListParams,
  );

  return (
    <div className="flex flex-col gap-8">
      {justMerged ? (
        <MergedIntoNotice noun="artist" historyHref={`/${org.slug}/merges`} />
      ) : null}
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={basePath}
            className="text-primary underline underline-offset-4 hover:text-ink"
          >
            Artists
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {artist.name}
        </h1>
        {artist.genres.length > 0 ? (
          <p className="flex flex-wrap gap-2">
            {artist.genres.map((genre) => (
              // A TEXT CHIP AND NEVER AN href. React escapes the value.
              <span
                key={genre}
                className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase"
              >
                {genre}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      {artist.deletedAt !== null ? (
        <div role="status" className="border border-rule-strong bg-surface px-3 py-3">
          <p className="text-base text-ink">
            <span className="font-semibold text-warning">Deleted.</span> This
            artist was deleted on{" "}
            <time dateTime={artist.deletedAt} className="tabular-nums">
              {formatDateTime(artist.deletedAt)}
            </time>
            . Their representation and fee history are still here and come back
            with them; until then the representation can’t be changed.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Based">
          {artist.city || artist.country ? (
            <span className="break-words">
              {[artist.city, artist.country].filter(Boolean).join(", ")}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Website">
          {/* `websiteHref`, NEVER `website`. The raw column is user content and
              `normaliseWebsite()` only guards the form -- an import, a merge or
              a direct PostgREST call with the anon key writes this column
              without meeting it. safeHref() decides in lib/crm/queries.ts; this
              only renders the decision, and shows the raw value as inert text
              when the answer is no so the user can see and fix it. */}
          {artist.websiteHref ? (
            <a
              href={artist.websiteHref}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {artist.website}
            </a>
          ) : artist.website ? (
            <span translate="no" className="break-all">
              {artist.website}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
        <Detail label="Social">
          {artist.socials.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {artist.socials.map((entry) => (
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
                    // NOT A LINK -- the render-side half of the protocol rule.
                    // A handle is not a URL, and a stored `javascript:` reaches
                    // here as inert text rather than an anchor.
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
          <time dateTime={artist.createdAt} className="tabular-nums">
            {formatDateTime(artist.createdAt)}
          </time>
        </Detail>
        <Detail label="Last updated">
          <time dateTime={artist.updatedAt} className="tabular-nums">
            {formatDateTime(artist.updatedAt)}
          </time>
        </Detail>
      </dl>

      {artist.notes ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Notes</h2>
          {/* Untrusted free text, rendered as TEXT. React escapes it;
              `whitespace-pre-line` keeps the line breaks somebody typed without
              interpreting anything else in the string. Never
              `dangerouslySetInnerHTML` -- CLAUDE.md § Non-negotiable rules. */}
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {artist.notes}
          </p>
        </section>
      ) : null}

      <RepresentationPanel
        orgSlug={org.slug}
        side="artist"
        anchorId={artist.id}
        rows={rows.map((row) => ({
          id: row.id,
          artistId: row.artist.id,
          agencyId: row.agency.id,
          otherId: row.agency.id,
          otherName: row.agency.name,
          otherHref: `/${org.slug}/agencies/${row.agency.id}`,
          otherDeleted: row.agency.deleted,
          contactId: row.contact?.id ?? null,
          contactName: row.contact?.name ?? null,
          contactHref: row.contact ? `/${org.slug}/contacts/${row.contact.id}` : null,
          contactDeleted: row.contact?.deleted ?? false,
          role: row.role,
          territory: row.territory,
          isExclusive: row.isExclusive,
          primaryState: row.primaryState,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          isRemoved: row.deletedAt !== null,
        }))}
        otherOptions={agencyOptions}
        contactOptions={contactOptions}
        recordScoped={recordScoped}
        disabledReason={panelBlocked}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Fee history</h2>
        <p className="max-w-prose text-sm text-ink-muted">
          What this artist has been paid, by date. Read-only here — fees are
          recorded against the booking they belong to, which arrives with
          events.
        </p>
        {/* The key deliberately does NOT cover everything that changes the
            set of rows -- `feeParams.cursor` does too, and it is left out for
            the reason the contacts page measured: keying on the cursor
            remounts the pager on every page click and drops focus to <body>.
            What is left is the toolbar's half of the shape the list pages use,
            and the fee list has no toolbar today, so in practice this key
            never changes. It is here so that giving fees a search box later is
            one line rather than a bug. */}
        <Suspense
          key={JSON.stringify([feeParams.q, feeParams.pageSize])}
          fallback={<ListSkeleton columns={3} />}
        >
          <FeeHistory
            organisationId={org.id}
            artistId={artist.id}
            listParams={feeParams}
            basePath={`${basePath}/${artist.id}`}
            preserve={raw}
          />
        </Suspense>
      </section>

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Event history</h2>
        <p className="max-w-prose text-sm text-ink-muted">
          The events this artist is on the bill for, most recent first. PRD 6.3
          asks an artist record for its booking history; this reads it from the
          lineups themselves rather than keeping a second copy.
        </p>
        {/* Same key discipline as the fee history above, and the same reason
            the cursor is not in it. */}
        <Suspense
          key={JSON.stringify([artist.id])}
          // FOUR, matching `artistEventColumns` below -- Name, Date, Venue,
          // Status. The venue page's is three because that surface drops the
          // Venue column. A skeleton narrower than the table it stands in for
          // makes the columns jump when the boundary resolves.
          fallback={<ListSkeleton columns={4} />}
        >
          <EventHistory
            organisationId={org.id}
            orgSlug={org.slug}
            artistId={artist.id}
            basePath={`${basePath}/${artist.id}`}
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
          entityType="artist"
          entityId={artist.id}
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
        subjectType="artist"
        page={activity}
        params={activityListParams}
        basePath={`${basePath}/${artist.id}`}
        recordScoped={activityIsScoped(org.role)}
        preserve={raw}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        {/* ONE EXPLANATION FOR THE WHOLE GROUP, referenced by each control
            through aria-describedby. Repeating it per control puts the same
            sentence between a screen-reader user and every button. */}
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {artist.deletedAt === null ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${artist.id}/edit`}
                label="Edit artist"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteArtistAction}
              hiddenFields={{ orgSlug: org.slug, artistId: artist.id }}
              label="Delete artist"
              question={`Delete ${artist.name}? They come out of the artists list. Their representation and fee history stay recorded, and you can restore them from Artists › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreArtistAction}
            hiddenFields={{ orgSlug: org.slug, artistId: artist.id }}
            label="Restore artist"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

/**
 * "Event history": one page of the events this artist is on.
 *
 * THE READ IS TWO QUERIES AND THE CAP IS REAL -- see `loadEventsForArtist` in
 * lib/crm/queries.ts. In one line: the relation that knows which events an
 * artist is on is `event_lineup`, `fetchListPage` reads ONE relation, and the
 * alternative to a bounded two-step is a second cursor, which
 * lib/crm/activity.ts's header calls a defect outright. An artist on more than
 * 50 events therefore sees a stable 50-slot window rather than everything, and
 * that is recorded in FOLLOW-UPS.md § "Opened by Task 7" with the shape of the
 * real fix.
 */
async function EventHistory({
  organisationId,
  orgSlug,
  artistId,
  basePath,
  recordScoped,
  raw,
}: {
  organisationId: string;
  orgSlug: string;
  artistId: string;
  basePath: string;
  recordScoped: boolean;
  /** The page's whole query string -- see the header. THREE lists share it. */
  raw: RawSearchParams;
}) {
  const { params, page, venueNames } = await loadEventsForArtist(
    organisationId,
    artistId,
    raw,
  );

  return (
    <EntityList
      spec={ARTIST_EVENTS_LIST}
      params={params}
      basePath={basePath}
      page={page}
      columns={artistEventColumns(orgSlug, venueNames)}
      rowKey={(row) => row.id}
      // ALWAYS FALSE TODAY, and derived rather than written as `false`:
      // `artistEventsParams` drops this surface's only narrowing key
      // (`artistevents_q`) and the spec declares no filters. Deriving it means
      // giving the surface a filter later cannot leave the empty state lying.
      narrowed={isNarrowed(ARTIST_EVENTS_LIST, params)}
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
            {recordScoped ? "No events assigned to you" : "Not on any events yet"}
          </h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            {recordScoped
              ? "Events this artist is on that are assigned to you will appear here."
              : "Add this artist to an event’s lineup and the night appears here, with its date, venue and status."}
          </p>
        </div>
      }
    />
  );
}

function artistEventColumns(
  orgSlug: string,
  venueNames: ReadonlyMap<string, string>,
): readonly ListColumn<EventRow, ArtistEventsSortKey>[] {
  return [
    {
      key: "name",
      header: "Name",
      // NOT SORTABLE: this spec declares one sort, and `sortKey` is
      // constrained to its keys, so naming another would not compile.
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
        <time dateTime={row.startsAt}>{formatDateTime(row.startsAt)}</time>
      ),
    },
    {
      key: "venue",
      header: "Venue",
      secondary: true,
      render: (row) => {
        const name = row.venueId ? venueNames.get(row.venueId) : undefined;
        // ABSENT COVERS BOTH "no venue recorded" AND "a venue this caller
        // cannot read", identically and on purpose -- `loadVenueNames` records
        // why saying "(unavailable)" would be an oracle.
        return name ? <span className="break-words">{name}</span> : <Absent />;
      },
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusChip status={row.status} />,
    },
  ];
}

async function FeeHistory({
  organisationId,
  artistId,
  listParams,
  basePath,
  preserve,
}: {
  organisationId: string;
  artistId: string;
  listParams: ListParams<ArtistFeeSortKey, ArtistFeeFilterKey>;
  basePath: string;
  /**
   * The page's whole query string. THIS PAGE HAS A SECOND LIST -- the activity
   * timeline -- and without this every fee-history link would rebuild the URL
   * without the timeline's cursor and quietly send it back to its first page.
   * See HrefOverrides.preserve.
   */
  preserve: RawSearchParams;
}) {
  const page = await fetchListPage<
    ArtistFeeRow,
    ArtistFeeSortKey,
    ArtistFeeFilterKey
  >({
    spec: ARTIST_FEE_LIST,
    params: listParams,
    organisationId,
    table: "artist_fee_history",
    select: ARTIST_FEE_SELECT,
    mapRow: (row) => ({
      id: String(row.id),
      occurredOn: String(row.occurred_on),
      currency: String(row.currency),
      amountMinor: Number(row.amount_minor),
      note: (row.note as string | null) ?? null,
    }),
    // THE SECOND EQUALITY COLUMN. `fetchListPage` pins organisation_id itself;
    // this pins the artist, and the index is built as
    // (organisation_id, artist_id, occurred_on, id) to match. The id comes from
    // the resolved route, never from the query string.
    applyFilters: (query: ListQuery) => query.eq("artist_id", artistId),
  });

  return (
    <EntityList
      spec={ARTIST_FEE_LIST}
      params={listParams}
      basePath={basePath}
      page={page}
      columns={feeColumns()}
      rowKey={(row) => row.id}
      narrowed={isNarrowed(ARTIST_FEE_LIST, listParams)}
      preserve={preserve}
      emptyState={
        <div className="border border-rule bg-surface p-5">
          <h2 className="text-xl font-bold text-ink">No fees recorded</h2>
          <p className="mt-2 max-w-prose text-base text-ink-muted">
            Fees appear here once bookings are recorded against this artist.
            PRD 6.3 keeps a history by date rather than one number that gets
            overwritten, so what they were paid in 2023 is still readable in
            2026.
          </p>
        </div>
      }
    />
  );
}

function feeColumns(): readonly ListColumn<ArtistFeeRow, ArtistFeeSortKey>[] {
  return [
    {
      key: "occurred",
      header: "Date",
      sortKey: "occurred",
      // DESIGN.md § Numerals: tabular figures on every date column.
      numeric: true,
      render: (row) => (
        <time dateTime={row.occurredOn}>{formatDateOnly(row.occurredOn)}</time>
      ),
    },
    {
      key: "amount",
      header: "Fee",
      // NOT SORTABLE. `amount_minor` is NOT NULL and would be the obvious
      // second sort, and there is no index of the required shape for it -- so
      // `backedBy` would have nowhere honest to point. lib/list/spec.ts makes
      // that a compile error rather than a judgement call.
      //
      // DESIGN.md § Numerals: "every currency value" gets tabular figures.
      // Misaligned money is a legibility bug.
      numeric: true,
      render: (row) => (
        <span className="font-semibold">
          {formatFee(row.amountMinor, row.currency)}
        </span>
      ),
    },
    {
      key: "note",
      header: "Note",
      secondary: true,
      render: (row) =>
        row.note ? (
          <span className="break-words">{row.note}</span>
        ) : (
          <span className="text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No note</span>
          </span>
        ),
      // NO EVENT COLUMN, and it is not an oversight. `artist_fee_history` has
      // an `event_id`, and 20260828001134 holds it NULL with
      // `artist_fee_history_event_id_unwritable_until_phase_3` because
      // public.events does not exist yet -- a column that is always null is
      // not a column worth a header. Phase 3 adds the foreign key and this is
      // where the link goes.
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
