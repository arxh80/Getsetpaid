import Link from "next/link";
import {
  BILLING_LABELS,
  LINEUP_LIST,
  type LineupParams,
  type LineupRow,
} from "@/lib/crm/lineup-list";
import type { RawSearchParams } from "@/lib/list/params";
import type { ListPage, RecoveryReason } from "@/lib/list/query";
import { ListPager } from "@/components/list/list-pager";
import {
  AddSlotForm,
  RemoveSlotForm,
  RestoreSlotForm,
  SlotEditForm,
  type LineupPanelArtist,
  type SlotFieldValues,
} from "@/components/crm/lineup-forms";
import { formatDateTime, instantToLondonWallClock } from "@/lib/format/date";

// The lineup: who is playing this event, in what order, with what billing.
//
// A SERVER COMPONENT. Only the forms are client code, and they are in
// components/crm/lineup-forms.tsx -- whose header carries the measurement that
// forced the split (a client `ListPager` throws `Unknown encoding: base64url`
// at hydration and takes the whole page's client tree with it). The division is
// the one components/crm/activity-timeline.tsx already draws: markup,
// pagination and links are server-rendered.
//
// Modelled on components/crm/room-panel.tsx otherwise, with three differences,
// each of which is the reason this header exists rather than a pointer to that
// one.
//
// ===========================================================================
// 1. IT PAGES. THE ROOMS PANEL DOES NOT.
// ===========================================================================
// A room list is capped at LINK_PANEL_LIMIT and has no pager, on the argument
// that a venue with more than 100 rooms is a festival site rather than a venue.
// A LINEUP genuinely grows -- a festival day is a hundred slots -- so this
// surface goes through lib/list/ (LINEUP_LIST, `paramPrefix: "lineup_"`) and
// renders a real keyset pager. lib/crm/lineup-list.ts carries the argument,
// including why the prefix is not optional on a page that also carries the
// activity timeline, and why both lists need `preserve`.
//
// ===========================================================================
// 2. NO DRAG-AND-DROP, AND NO "MOVE UP". `position` IS A NUMBER YOU TYPE.
// ===========================================================================
// Each row carries `<input type="number" min="0" max="999" step="1">`, saved by
// that row's own form. Two independent reasons, and the first is measured
// rather than aesthetic:
//
//   * A SWAP WOULD NEED A DEFERRED UNIQUE INDEX, AND THERE IS NO SUCH THING.
//     "Move this artist up" only means anything if positions are unique, and a
//     partial unique index in PostgreSQL cannot be deferred -- so swapping two
//     rows is two UPDATEs in one transaction plus a 23505 path for the instant
//     in between. That is the exact cost
//     `contact_companies_one_primary_per_contact` imposed on Phase 2 Task 4,
//     which is the precedent this decision is taken from and which is why
//     20260901000000 made `position` deliberately NOT unique.
//   * DRAG-AND-DROP NEEDS JAVASCRIPT, on a form set that deliberately works
//     without it. Every other write in this product survives JavaScript being
//     off (lib/forms.ts); a reorder control that did not would be the one place
//     the product silently stops working, and it would still need this number
//     input underneath it as the fallback.
//
// DUPLICATE POSITIONS ARE LEGAL, and two artists both at 0 is an ordinary state
// rather than a mistake to refuse. The tie is then broken by `id`, which
// `fetchListPage` appends to every sort -- so the order is TOTAL and PERMANENT
// and the list does not reshuffle between reloads, which is the property that
// actually matters here.
//
// IT IS NOT INSERTION ORDER, and the first version of this comment said it was.
// `public.event_lineup`'s table comment (20260901000000) describes the ordering
// as `(position, created_at, id)`; the rendered order cannot be that, because a
// keyset page carries ONE sort column plus the primary key (lib/list/query.ts,
// `buildPage`) and `id` is a `gen_random_uuid()`. Measured in the Rule 17 walk:
// two slots both at 0, added B-then-A, render A first and go on doing so across
// three reloads. The claim that survives is stability, and stability is what
// the criterion asked for; the divergence from the migration's comment is in
// FOLLOW-UPS.md rather than papered over.
//
// ===========================================================================
// 3. A REMOVED SLOT IS STILL HERE, BEHIND A DISCLOSURE
// ===========================================================================
// Removal is a soft delete, because there is no other kind on this table (no
// DELETE grant, no DELETE policy) and because the partial unique index is what
// lets the same artist be re-added afterwards. CLAUDE.md's rule that a soft
// delete nobody can undo is a hard delete with extra steps then requires the
// restore path to be REACHABLE -- so removed slots live in a `<details>` under
// the bill, exactly as a closed room stays on its venue's page with a Reopen
// control. A disclosure rather than a second list: it is a tail nobody scrolls,
// and a second pager on this page would need a third query-string namespace.

/** A removed slot, as the disclosure renders it. */
export interface RemovedLineupEntry {
  id: string;
  artistId: string;
  position: number;
  deletedAt: string;
}

export type { LineupPanelArtist };

interface LineupPanelProps {
  orgSlug: string;
  eventId: string;
  page: ListPage<LineupRow>;
  params: LineupParams;
  /** The event's own URL. The pager builds its links from it. */
  basePath: string;
  removed: readonly RemovedLineupEntry[];
  /** Artist names, keyed by id. A missing id is one this caller cannot read. */
  artistNames: ReadonlyMap<string, { name: string; deleted: boolean }>;
  /** Live artists to offer, already ordered and capped by the server. */
  artistOptions: readonly LineupPanelArtist[];
  /**
   * Null when this caller may write. Otherwise the sentence explaining why not
   * -- `DELETED_RECORD_EXPLANATION` when the event is soft-deleted, or
   * `access.explanation`. Controls are DISABLED with it, never hidden and never
   * present-and-failing (FOLLOW-UPS Q6).
   */
  disabledReason: string | null;
  /**
   * The page's whole `searchParams`, so this list's links keep the query
   * parameters of anything ELSE on the page. See HrefOverrides.preserve.
   */
  preserve?: RawSearchParams;
}

/** The id of the single explanation every disabled control points at. */
const NOTE_ID = "lineup-blocked";

export function LineupPanel({
  orgSlug,
  eventId,
  page,
  params,
  basePath,
  removed,
  artistNames,
  artistOptions,
  disabledReason,
  preserve,
}: LineupPanelProps) {
  const disabled = disabledReason !== null;

  return (
    <section
      aria-labelledby="lineup-heading"
      className="flex flex-col gap-4 border-t border-rule pt-6"
    >
      <h2 id="lineup-heading" className="text-xl font-bold text-ink">
        Lineup
      </h2>

      {/* ONE EXPLANATION FOR THE WHOLE PANEL, referenced by every disabled
          control through aria-describedby. Repeating it per control puts the
          same sentence between a screen-reader user and every field. */}
      {disabledReason !== null ? (
        <p
          id={NOTE_ID}
          className="max-w-prose border border-rule bg-surface px-3 py-3 text-sm text-ink-muted"
        >
          <span className="font-semibold text-ink">Read-only.</span>{" "}
          {disabledReason}
        </p>
      ) : null}

      {/* A FAILED QUERY IS NOT AN EMPTY LINEUP. "There is nobody on this bill"
          is a claim about the customer's data, and making it because a query
          failed reads as deletion -- the same rule the list surface, the
          members page and the activity timeline follow. */}
      {page.outcome === "unavailable" ? (
        <p
          role="status"
          className="border border-danger bg-surface px-3 py-3 text-base text-ink"
        >
          <span className="font-semibold text-danger">Error.</span> We couldn’t
          load this event’s lineup just now. Refresh the page to try again —
          nothing has been removed.
        </p>
      ) : (
        <Bill
          orgSlug={orgSlug}
          eventId={eventId}
          page={page}
          params={params}
          basePath={basePath}
          artistNames={artistNames}
          disabled={disabled}
          preserve={preserve}
        />
      )}

      {removed.length > 0 ? (
        <RemovedSlots
          orgSlug={orgSlug}
          eventId={eventId}
          removed={removed}
          artistNames={artistNames}
          disabled={disabled}
        />
      ) : null}

      <AddSlotForm
        orgSlug={orgSlug}
        eventId={eventId}
        artistOptions={artistOptions}
        disabled={disabled}
        noteId={NOTE_ID}
      />
    </section>
  );
}

/** One sentence per recovery cause -- the same three EntityList renders. */
const RECOVERY_NOTICE: Record<NonNullable<RecoveryReason>, string> = {
  "past-end":
    "That link pointed past the end of this lineup, so this is the first page.",
  "before-start":
    "That link pointed before the start of this lineup, so this is the first page.",
  "stale-sort":
    "That link was made under a different order, so this is the first page.",
};

function Bill({
  orgSlug,
  eventId,
  page,
  params,
  basePath,
  artistNames,
  disabled,
  preserve,
}: {
  orgSlug: string;
  eventId: string;
  page: Extract<ListPage<LineupRow>, { outcome: "loaded" }>;
  params: LineupParams;
  basePath: string;
  artistNames: ReadonlyMap<string, { name: string; deleted: boolean }>;
  disabled: boolean;
  preserve?: RawSearchParams;
}) {
  const { rows, total } = page;

  if (rows.length === 0) {
    return (
      <div className="border border-rule bg-surface p-5">
        <h3 className="text-lg font-bold text-ink">No lineup yet</h3>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          Add the artists playing. The first artist you add is the whole lineup
          until you add another — order and billing can be set on each row.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <p role="status" className="text-sm text-ink-muted">
          {total === null ? (
            <>
              <span className="tabular-nums">{rows.length}</span>{" "}
              {rows.length === 1 ? LINEUP_LIST.noun.one : LINEUP_LIST.noun.many}{" "}
              on this page
            </>
          ) : (
            <>
              <span className="tabular-nums">{total}</span>{" "}
              {total === 1 ? LINEUP_LIST.noun.one : LINEUP_LIST.noun.many}
            </>
          )}
          {" · in order"}
        </p>
        {page.recovered ? (
          <p role="status" className="text-sm text-ink-muted">
            {RECOVERY_NOTICE[page.recovered]}
          </p>
        ) : null}
      </div>

      {/* AN EXPLICIT role="list". Tailwind's preflight sets `list-style: none`
          on every <ul>, and Safari/VoiceOver then stops exposing the element as
          a list at all -- so "3 items" is never announced. Deliberately a <ul>
          and not an <ol>: the sequence is DATA the user edits (a `position`
          column), not document order, and an <ol> would announce a counter that
          disagrees with the numbers on screen the moment two slots share a
          position. */}
      <ul role="list" className="flex flex-col border-t border-rule">
        {rows.map((row) => {
          const artist = artistNames.get(row.artistId) ?? null;
          return (
            <li key={row.id} className="flex flex-col gap-3 border-b border-rule py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <ArtistName
                  orgSlug={orgSlug}
                  artistId={row.artistId}
                  artist={artist}
                />
                <span className="text-sm text-ink-muted">
                  <span className="tabular-nums">{row.position}</span>
                  {" · "}
                  {/* A billing the database holds and this build does not know:
                      the raw value, rather than a blank cell that would read as
                      a rendering fault. Reachable during a rolling deploy that
                      widens the CHECK before this bundle ships. */}
                  {row.billing === null
                    ? row.rawBilling || "—"
                    : BILLING_LABELS[row.billing]}
                </span>
              </div>
              <SlotEditForm
                orgSlug={orgSlug}
                eventId={eventId}
                lineupId={row.id}
                artistName={artist?.name ?? null}
                stored={storedFields(row)}
                disabled={disabled}
                noteId={NOTE_ID}
              />
              <RemoveSlotForm
                orgSlug={orgSlug}
                eventId={eventId}
                lineupId={row.id}
                artistName={artist?.name ?? null}
                disabled={disabled}
                noteId={NOTE_ID}
              />
            </li>
          );
        })}
      </ul>

      <ListPager
        spec={LINEUP_LIST}
        params={params}
        basePath={basePath}
        hasPrevious={page.hasPrevious}
        hasNext={page.hasNext}
        firstCursor={page.firstCursor}
        lastCursor={page.lastCursor}
        shown={rows.length}
        noun={LINEUP_LIST.noun}
        preserve={preserve}
      />
    </>
  );
}

/**
 * The stored row as the form shows it.
 *
 * INSTANT -> UK WALL CLOCK, because that is what a `datetime-local` speaks, and
 * the action converts back through the inverse. Done HERE, on the server, so
 * the client bundle does not need the Intl machinery in lib/format/date.ts --
 * and so both halves of the conversion sit in modules that already import it.
 *
 * ===========================================================================
 * `billing` FALLS BACK TO `other`, AND THAT REWRITES THE RECORD ON THE NEXT
 * SAVE. SAID PLAINLY BECAUSE IT IS A LOSS, NOT A DISPLAY CHOICE.
 * ===========================================================================
 * When the database holds a billing this build does not know, saving ANY field
 * on that row writes `other` over it. The alternative is worse, not better: a
 * `<select>` whose `defaultValue` matches no option selects the FIRST one, so
 * doing nothing rewrites it to "headliner" -- a plausible value, silently
 * wrong, where `other` at least reads as "we do not know". The row summary
 * above the form shows the RAW stored value, so the user can see what is there
 * before they touch it.
 *
 * REACHABLE ONLY DURING A ROLLING DEPLOY that widens the CHECK before this
 * bundle ships, or through an import. THE CORRECT LONG-RUN ANSWER IS TO RENDER
 * THE UNKNOWN VALUE AS AN OPTION OF ITS OWN -- marked, and selected -- so a
 * save preserves it and there is no fallback at all. Not built here because it
 * needs copy for a value the product cannot name, and it is not worth guessing
 * that copy for a window measured in minutes. Recorded rather than
 * rediscovered; fix round 1, Minor 6.
 */
function storedFields(row: LineupRow): SlotFieldValues {
  return {
    position: String(row.position),
    billing: row.billing ?? "other",
    setStartsAt:
      row.setStartsAt === null ? "" : instantToLondonWallClock(row.setStartsAt),
    setEndsAt: row.setEndsAt === null ? "" : instantToLondonWallClock(row.setEndsAt),
    notes: row.notes ?? "",
  };
}

/**
 * The artist's name, as a link when there is one to give.
 *
 * THREE STATES, and the third has no name to render. A DELETED artist keeps
 * their name with a marker and loses the link, exactly as the detail page
 * treats a deleted venue -- the name is what the user recorded and hiding it
 * would leave a row they cannot act on. An artist this caller cannot READ is
 * not in the map at all, and gets a sentence about the situation rather than a
 * name, for lib/crm/event-picker.ts's reason: no attribute crosses the
 * boundary, because none is fetched.
 *
 * NOT A `<span>` WRAPPING A `<form>` ANYWHERE IN THIS FILE -- that was the
 * Task 5 deferred minor from Phase 2 (a `<form>` inside a `<span>` is valid
 * markup and an invalid content model, and browsers repair it silently by
 * moving the form). Every form here is a child of the row's `<li>`.
 */
function ArtistName({
  orgSlug,
  artistId,
  artist,
}: {
  orgSlug: string;
  artistId: string;
  artist: { name: string; deleted: boolean } | null;
}) {
  if (artist === null) {
    return (
      <span className="text-ink-muted italic">An artist outside your access</span>
    );
  }
  if (artist.deleted) {
    return (
      <span className="font-semibold break-words text-ink">
        {artist.name} <span className="font-normal text-ink-muted">(deleted)</span>
      </span>
    );
  }
  return (
    <Link
      href={`/${orgSlug}/artists/${artistId}`}
      className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
    >
      {artist.name}
    </Link>
  );
}

function RemovedSlots({
  orgSlug,
  eventId,
  removed,
  artistNames,
  disabled,
}: {
  orgSlug: string;
  eventId: string;
  removed: readonly RemovedLineupEntry[];
  artistNames: ReadonlyMap<string, { name: string; deleted: boolean }>;
  disabled: boolean;
}) {
  return (
    <details className="border border-rule">
      {/* A real disclosure widget: correct role, keyboard model and screen-reader
          announcement in every browser, no JavaScript, no state -- the same
          argument components/crm/room-panel.tsx makes for its rename row. */}
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
        Removed from this lineup (
        <span className="tabular-nums">{removed.length}</span>)
      </summary>
      {/* NOT A CLAIM ABOUT THE TOTAL: the read is capped at LINK_PANEL_LIMIT, so
          past a hundred this is the hundred most recently removed. Said in the
          sentence rather than implied by the number. */}
      <p className="px-3 pt-1 text-sm text-ink-muted">
        Removed slots stay here so they can be put back. The hundred most
        recently removed are shown.
      </p>
      <ul role="list" className="flex flex-col px-3 pt-2 pb-3">
        {removed.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0"
          >
            <span className="flex flex-wrap items-baseline gap-2">
              <ArtistName
                orgSlug={orgSlug}
                artistId={entry.artistId}
                artist={artistNames.get(entry.artistId) ?? null}
              />
              <span className="text-sm text-ink-muted">
                removed{" "}
                <time dateTime={entry.deletedAt} className="tabular-nums">
                  {formatDateTime(entry.deletedAt)}
                </time>
              </span>
            </span>
            <RestoreSlotForm
              orgSlug={orgSlug}
              eventId={eventId}
              lineupId={entry.id}
              artistName={artistNames.get(entry.artistId)?.name ?? null}
              disabled={disabled}
              noteId={NOTE_ID}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}
