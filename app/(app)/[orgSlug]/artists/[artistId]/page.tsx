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
  loadLinkOptions,
  loadRepresentationsForArtist,
} from "@/lib/crm/queries";
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

// One artist: the record, who represents them, and what they have been paid.
//
// ===========================================================================
// THE FEE HISTORY IS A REAL PAGINATED LIST ON A DETAIL PAGE
// ===========================================================================
// It goes through lib/list/ rather than through a LINK_PANEL_LIMIT cap,
// because fee history GROWS -- one row per booking, kept for seven years
// (CLAUDE.md § Non-negotiable rules) -- where a join panel does not. See
// ARTIST_FEE_LIST in lib/crm/artists-list.ts for the argument and for the
// consequence: lib/list/params.ts owns `q`, `sort`, `dir`, `size`, `after` and
// `before` unconditionally, so this route may carry exactly ONE lib/list/
// surface and this is it.
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

  return (
    <div className="flex flex-col gap-8">
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
        {/* The key covers what would change the SET of rows. Nothing on this
            page changes it today (the fee list has no toolbar), so this is the
            same shape the list pages use rather than a different one. */}
        <Suspense
          key={JSON.stringify([feeParams.q, feeParams.pageSize])}
          fallback={<ListSkeleton columns={3} />}
        >
          <FeeHistory
            organisationId={org.id}
            artistId={artist.id}
            listParams={feeParams}
            basePath={`${basePath}/${artist.id}`}
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

      {/* Task 7's activity timeline goes here. No placeholder heading: a dead
          affordance is worse than a comment. */}

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

async function FeeHistory({
  organisationId,
  artistId,
  listParams,
  basePath,
}: {
  organisationId: string;
  artistId: string;
  listParams: ListParams<ArtistFeeSortKey, ArtistFeeFilterKey>;
  basePath: string;
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

/**
 * A `date` column as a date, with NO timezone conversion.
 *
 * `occurred_on` is `date`, not `timestamptz` -- a fee agreed on the 3rd was
 * agreed on the 3rd everywhere (20260827232510 convention (4)). Parsing it
 * with `new Date("2026-03-03")` reads UTC midnight and then renders it in the
 * viewer's zone, which is a day earlier west of Greenwich. `Date.UTC` in,
 * `timeZone: "UTC"` out, so the day that comes back is the day that was
 * stored.
 */
function formatDateOnly(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** en-GB and Europe/London explicitly -- these ARE instants. CLAUDE.md
 *  § Non-functional targets: UTC in the database, UK local time in the UI. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}
