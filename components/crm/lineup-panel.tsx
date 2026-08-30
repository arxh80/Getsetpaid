"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  addLineupEntryAction,
  removeLineupEntryAction,
  restoreLineupEntryAction,
  updateLineupEntryAction,
} from "@/lib/crm/events";
import {
  BILLING_LABELS,
  BILLING_VALUES,
  LINEUP_LIST,
  MAX_POSITION,
  MIN_POSITION,
  type LineupParams,
  type LineupRow,
} from "@/lib/crm/lineup-list";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import type { RawSearchParams } from "@/lib/list/params";
import type { ListPage, RecoveryReason } from "@/lib/list/query";
import { ListPager } from "@/components/list/list-pager";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { formatDateTime, instantToLondonWallClock } from "@/lib/format/date";

// The lineup: who is playing this event, in what order, with what billing.
//
// Modelled on components/crm/room-panel.tsx -- a client panel of small forms,
// one per row plus one to add -- with four differences, each of which is the
// reason this header exists rather than a pointer to that one.
//
// ===========================================================================
// 1. IT PAGES. THE ROOMS PANEL DOES NOT.
// ===========================================================================
// A room list is capped at LINK_PANEL_LIMIT and has no pager, on the argument
// that a venue with more than 100 rooms is a festival site rather than a
// venue. A LINEUP genuinely grows -- a festival day is a hundred slots -- so
// this surface goes through lib/list/ (LINEUP_LIST, `paramPrefix: "lineup_"`)
// and renders a real keyset pager. lib/crm/lineup-list.ts carries the
// argument, including why the prefix is not optional on a page that also
// carries the activity timeline.
//
// ===========================================================================
// 2. NO DRAG-AND-DROP, AND NO "MOVE UP". `position` IS A NUMBER YOU TYPE.
// ===========================================================================
// Each row carries `<input type="number" min="0" max="999" step="1">`, saved
// by that row's own form. Two independent reasons, and the first is measured
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
//     off (lib/forms.ts); a reorder control that did not would be the one
//     place the product silently stops working, and it would still need this
//     number input underneath it as the fallback.
//
// DUPLICATE POSITIONS ARE LEGAL, and two artists both at 0 is an ordinary
// state rather than a mistake to refuse. The order is then decided by
// `(created_at, id)`, which is total and stable -- so the list does not
// reshuffle between reloads, which is the property that actually matters.
// `fetchListPage` supplies the `id` half on every sort; `created_at` is
// selected by LINEUP_SELECT for exactly this reason and is not rendered.
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
// control. The disclosure rather than a second list: it is a tail nobody
// scrolls, and a second pager on this page would need a third query-string
// namespace for it.
//
// ===========================================================================
// 4. EVERY `<select>` CARRIES A `key`, AND IT IS LOAD-BEARING
// ===========================================================================
// React syncs a text input's `defaultValue` to the DOM property on every
// update, so `form.reset()` after a Server Action restores the ECHOED value.
// It does NOT do the equivalent for a `<select>`, whose default lives in an
// `<option>`'s `selected` ATTRIBUTE -- written at mount and then left alone.
// Task 4 measured what that costs on the event form: a refused submit snapped
// four selects back to the options the page first rendered with, and retrying
// SAVED four values the user never chose. The `key` forces a remount so the
// new element mounts with the right option. Same mechanism as
// components/crm/merge-form.tsx keying its field rows on the survivor.
//
// ===========================================================================
// AND THE ONE THING THAT IS NOT A PROBLEM HERE, SAID OUT LOUD
// ===========================================================================
// lib/crm/event-picker.ts exists because a `<select>` that does not contain
// the value the record holds SILENTLY SUBMITS A DIFFERENT ONE, so the event
// form has to append its stored venue and room to the picker whatever else is
// true. THAT DOES NOT APPLY TO THE ARTIST PICKER, and the reason is
// structural rather than lucky: the artist select exists only on the ADD form,
// which holds no stored value. A slot's artist is fixed at creation --
// `updateLineupEntryAction` does not accept an `artistId` and this component
// renders no control for one -- so there is no stored id for a picker to lose.
// Changing who is playing is a removal and an add, which is also what it is on
// the night.

export interface LineupPanelArtist {
  id: string;
  name: string;
}

/** A removed slot, as the disclosure renders it. */
export interface RemovedLineupEntry {
  id: string;
  artistId: string;
  position: number;
  deletedAt: string;
}

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
   * Null when this caller may write. Otherwise the sentence explaining why
   * not -- `DELETED_RECORD_EXPLANATION` when the event is soft-deleted, or
   * `access.explanation`. Controls are DISABLED with it, never hidden and
   * never present-and-failing (FOLLOW-UPS Q6).
   */
  disabledReason: string | null;
  /**
   * The page's whole `searchParams`, so this list's links keep the query
   * parameters of anything ELSE on the page. See HrefOverrides.preserve.
   */
  preserve?: RawSearchParams;
}

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
  const editable = disabledReason === null;
  const noteId = "lineup-blocked";

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
          id={noteId}
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
          editable={editable}
          noteId={noteId}
          preserve={preserve}
        />
      )}

      {removed.length > 0 ? (
        <RemovedSlots
          orgSlug={orgSlug}
          eventId={eventId}
          removed={removed}
          artistNames={artistNames}
          editable={editable}
          noteId={noteId}
        />
      ) : null}

      <AddSlot
        orgSlug={orgSlug}
        eventId={eventId}
        artistOptions={artistOptions}
        editable={editable}
        noteId={noteId}
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
  editable,
  noteId,
  preserve,
}: {
  orgSlug: string;
  eventId: string;
  page: Extract<ListPage<LineupRow>, { outcome: "loaded" }>;
  params: LineupParams;
  basePath: string;
  artistNames: ReadonlyMap<string, { name: string; deleted: boolean }>;
  editable: boolean;
  noteId: string;
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
              {rows.length === 1
                ? LINEUP_LIST.noun.one
                : LINEUP_LIST.noun.many}{" "}
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
          on every <ul>, and Safari/VoiceOver then stops exposing the element
          as a list at all -- so "3 items" is never announced. The role puts it
          back, and this is the rule DESIGN.md's accessibility pass applies to
          every list element in this product. Deliberately a <ul> and not an
          <ol>: the sequence is DATA the user edits (a `position` column), not
          document order, and an <ol> would announce a counter that disagrees
          with the numbers on screen the moment two slots share a position. */}
      <ul role="list" className="flex flex-col border-t border-rule">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-rule py-4">
            <SlotRow
              orgSlug={orgSlug}
              eventId={eventId}
              row={row}
              artist={artistNames.get(row.artistId) ?? null}
              editable={editable}
              noteId={noteId}
            />
          </li>
        ))}
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
 * markup and invalid content model). Every form here is a child of the row's
 * `<li>` or of a `<div>`.
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

/**
 * One hidden-field block, written once.
 *
 * Every action in this panel takes the same two or three ids, and a form that
 * omits one is refused with a sentence the user cannot act on. Writing them
 * out four times is four chances to leave one out.
 */
function SlotIds({
  orgSlug,
  eventId,
  lineupId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId?: string;
}) {
  return (
    <>
      {/* A SLUG, re-resolved server-side through the RLS-gated getCurrentOrg().
          Never an organisation id -- CLAUDE.md § Tenancy model. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="eventId" value={eventId} />
      {lineupId ? <input type="hidden" name="lineupId" value={lineupId} /> : null}
    </>
  );
}

const FIELD_LABEL = "text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase";

function inputClass(invalid: boolean): string {
  return (
    "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
    "transition-colors duration-[var(--dur-fast)] ease-brand " +
    "disabled:cursor-not-allowed disabled:opacity-55 " +
    (invalid ? "border-danger" : "border-rule hover:border-ink focus:border-accent")
  );
}

/** The error paragraph, wired to its own control and to nothing else. */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-semibold text-danger">
      {message}
    </p>
  );
}

/**
 * The five editable fields, rendered identically on the row form and the add
 * form.
 *
 * THE ECHOES ARE WRITTEN OUT ONE BY ONE by the caller and passed in, rather
 * than read from `state` here: routing them through one component would leave
 * a single `state.values?.` in the file, and a field added without an echo
 * would then be invisible to the census in
 * tests/unit/crm/source-shape.test.ts. That census is the only gate in this
 * repository that can see a missing echo at all -- it needs a DOM, a render
 * and a re-render, and tests/unit is pure functions only.
 */
function SlotFields({
  idPrefix,
  state,
  position,
  billing,
  setStartsAt,
  setEndsAt,
  notes,
  disabled,
  noteId,
}: {
  idPrefix: string;
  state: FormState;
  position: string;
  billing: string;
  setStartsAt: string;
  setEndsAt: string;
  notes: string;
  disabled: boolean;
  noteId: string;
}) {
  const describe = (field: string, errorId: string) =>
    state.fieldErrors?.[field] ? errorId : disabled ? noteId : undefined;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-position`} className={FIELD_LABEL}>
          Order
        </label>
        <input
          id={`${idPrefix}-position`}
          name="position"
          type="number"
          min={MIN_POSITION}
          max={MAX_POSITION}
          step={1}
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          defaultValue={position}
          aria-describedby={describe("position", `${idPrefix}-position-error`)}
          aria-invalid={state.fieldErrors?.position ? true : undefined}
          // DESIGN.md § Numerals: tabular figures on every number.
          className={`${inputClass(Boolean(state.fieldErrors?.position))} tabular-nums`}
        />
        <FieldError
          id={`${idPrefix}-position-error`}
          message={state.fieldErrors?.position}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-billing`} className={FIELD_LABEL}>
          Billing
        </label>
        <select
          // THE `key`. See § 4 of this file's header: without it a refused
          // submit restores the option this select had at MOUNT, not the one
          // the echo carries, and retrying saves a billing the user never
          // chose.
          key={`billing:${billing}`}
          id={`${idPrefix}-billing`}
          name="billing"
          disabled={disabled}
          defaultValue={billing}
          aria-describedby={describe("billing", `${idPrefix}-billing-error`)}
          aria-invalid={state.fieldErrors?.billing ? true : undefined}
          className={inputClass(Boolean(state.fieldErrors?.billing))}
        >
          {BILLING_VALUES.map((value) => (
            <option key={value} value={value}>
              {BILLING_LABELS[value]}
            </option>
          ))}
        </select>
        <FieldError
          id={`${idPrefix}-billing-error`}
          message={state.fieldErrors?.billing}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-starts`} className={FIELD_LABEL}>
          Set starts
        </label>
        <input
          id={`${idPrefix}-starts`}
          name="setStartsAt"
          type="datetime-local"
          disabled={disabled}
          defaultValue={setStartsAt}
          aria-describedby={describe("setStartsAt", `${idPrefix}-starts-error`)}
          aria-invalid={state.fieldErrors?.setStartsAt ? true : undefined}
          className={`${inputClass(Boolean(state.fieldErrors?.setStartsAt))} tabular-nums`}
        />
        <FieldError
          id={`${idPrefix}-starts-error`}
          message={state.fieldErrors?.setStartsAt}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-ends`} className={FIELD_LABEL}>
          Set ends
        </label>
        <input
          id={`${idPrefix}-ends`}
          name="setEndsAt"
          type="datetime-local"
          disabled={disabled}
          defaultValue={setEndsAt}
          aria-describedby={describe("setEndsAt", `${idPrefix}-ends-error`)}
          aria-invalid={state.fieldErrors?.setEndsAt ? true : undefined}
          className={`${inputClass(Boolean(state.fieldErrors?.setEndsAt))} tabular-nums`}
        />
        <FieldError
          id={`${idPrefix}-ends-error`}
          message={state.fieldErrors?.setEndsAt}
        />
      </div>

      <div className="flex flex-col gap-2 sm:col-span-2">
        <label htmlFor={`${idPrefix}-notes`} className={FIELD_LABEL}>
          Notes
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          disabled={disabled}
          defaultValue={notes}
          aria-describedby={describe("notes", `${idPrefix}-notes-error`)}
          aria-invalid={state.fieldErrors?.notes ? true : undefined}
          className={
            "w-full min-w-0 border bg-surface px-3 py-2 text-base text-ink " +
            "transition-colors duration-[var(--dur-fast)] ease-brand " +
            "disabled:cursor-not-allowed disabled:opacity-55 " +
            (state.fieldErrors?.notes
              ? "border-danger"
              : "border-rule hover:border-ink focus:border-accent")
          }
        />
        <FieldError
          id={`${idPrefix}-notes-error`}
          message={state.fieldErrors?.notes}
        />
      </div>
    </div>
  );
}

function SlotRow({
  orgSlug,
  eventId,
  row,
  artist,
  editable,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  row: LineupRow;
  artist: { name: string; deleted: boolean } | null;
  editable: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateLineupEntryAction,
    EMPTY_FORM_STATE,
  );

  // THE FIVE ECHOES, one local per rendered field. The echo wins when there is
  // one -- it is newer than the record the page loaded with -- and falls back
  // to the STORED value rather than to "", because an edit form rendering an
  // empty input over a record that has a value is the mirror-image defect.
  const position = state.values?.position ?? String(row.position);
  const billing = state.values?.billing ?? (row.billing ?? "other");
  const setStartsAt =
    state.values?.setStartsAt ??
    (row.setStartsAt === null ? "" : instantToLondonWallClock(row.setStartsAt));
  const setEndsAt =
    state.values?.setEndsAt ??
    (row.setEndsAt === null ? "" : instantToLondonWallClock(row.setEndsAt));
  const notes = state.values?.notes ?? (row.notes ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <ArtistName orgSlug={orgSlug} artistId={row.artistId} artist={artist} />
        <span className="text-sm text-ink-muted">
          <span className="tabular-nums">{row.position}</span>
          {" · "}
          {/* A billing the database holds and this build does not know: the
              raw value, rather than a blank cell that would read as a
              rendering fault. Reachable during a rolling deploy that adds a
              value to the CHECK before this bundle ships. */}
          {row.billing === null
            ? row.rawBilling || "—"
            : BILLING_LABELS[row.billing]}
        </span>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <SlotIds orgSlug={orgSlug} eventId={eventId} lineupId={row.id} />
        <SlotFields
          idPrefix={`slot-${row.id}`}
          state={state}
          position={position}
          billing={billing}
          setStartsAt={setStartsAt}
          setEndsAt={setEndsAt}
          notes={notes}
          disabled={!editable}
          noteId={noteId}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="secondary"
            disabled={!editable}
            aria-describedby={editable ? undefined : noteId}
            pending={pending}
            pendingLabel="Saving…"
          >
            <span aria-hidden="true">Save</span>
            <span className="sr-only">
              Save {artist?.name ?? "this slot"}
            </span>
          </Button>
        </div>
      </form>

      <RemoveSlot
        orgSlug={orgSlug}
        eventId={eventId}
        lineupId={row.id}
        artistName={artist?.name ?? null}
        editable={editable}
        noteId={noteId}
      />
    </div>
  );
}

function RemoveSlot({
  orgSlug,
  eventId,
  lineupId,
  artistName,
  editable,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId: string;
  artistName: string | null;
  editable: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    removeLineupEntryAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <SlotIds orgSlug={orgSlug} eventId={eventId} lineupId={lineupId} />
      {/* NO CONFIRMATION STEP, unlike DeleteRecordForm. Removing a slot is
          reversible in one click from the disclosure it drops into, on the
          same page, with nothing else changed -- so an "are you sure" prompt
          here is the kind that trains people to stop reading prompts.
          Deleting the EVENT keeps its confirmation. */}
      <div>
        <Button
          type="submit"
          variant="quiet"
          disabled={!editable}
          aria-describedby={editable ? undefined : noteId}
          pending={pending}
          pendingLabel="Removing…"
        >
          <span aria-hidden="true">Remove</span>
          <span className="sr-only">
            Remove {artistName ?? "this artist"} from the lineup
          </span>
        </Button>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function RemovedSlots({
  orgSlug,
  eventId,
  removed,
  artistNames,
  editable,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  removed: readonly RemovedLineupEntry[];
  artistNames: ReadonlyMap<string, { name: string; deleted: boolean }>;
  editable: boolean;
  noteId: string;
}) {
  return (
    <details className="border border-rule">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
        Removed from this lineup (
        <span className="tabular-nums">{removed.length}</span>)
      </summary>
      {/* Not a live-region count and not a claim about the total: the read is
          capped at LINK_PANEL_LIMIT, so this is "the most recently removed
          hundred" past that. Said in the sentence below rather than implied by
          a number. */}
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
            <RestoreSlot
              orgSlug={orgSlug}
              eventId={eventId}
              lineupId={entry.id}
              artistName={artistNames.get(entry.artistId)?.name ?? null}
              editable={editable}
              noteId={noteId}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}

function RestoreSlot({
  orgSlug,
  eventId,
  lineupId,
  artistName,
  editable,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId: string;
  artistName: string | null;
  editable: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    restoreLineupEntryAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <SlotIds orgSlug={orgSlug} eventId={eventId} lineupId={lineupId} />
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={!editable}
          aria-describedby={editable ? undefined : noteId}
          pending={pending}
          pendingLabel="Putting back…"
        >
          <span aria-hidden="true">Put back</span>
          <span className="sr-only">
            Put {artistName ?? "this artist"} back on the lineup
          </span>
        </Button>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function AddSlot({
  orgSlug,
  eventId,
  artistOptions,
  editable,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  artistOptions: readonly LineupPanelArtist[];
  editable: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    addLineupEntryAction,
    EMPTY_FORM_STATE,
  );

  // THE SIX ECHOES. Five are the shared fields; `artistId` is this form's own,
  // and it is the reason the census in tests/unit/crm/source-shape.test.ts
  // names six and not five.
  const artistId = state.values?.artistId ?? "";
  const position = state.values?.position ?? "";
  const billing = state.values?.billing ?? "support";
  const setStartsAt = state.values?.setStartsAt ?? "";
  const setEndsAt = state.values?.setEndsAt ?? "";
  const notes = state.values?.notes ?? "";

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 border border-rule p-4"
    >
      {/* ERRORS ONLY, NO SUCCESS ALERT -- room-panel.tsx's measurement: a
          Client Component's `useActionState` result outlives the thing it
          describes, because revalidation does not remount it, so "Added"
          would stay on screen through every later action in the panel. The
          confirmation is the artist appearing in the list above. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SlotIds orgSlug={orgSlug} eventId={eventId} />

      <h3 className="text-sm font-semibold text-ink">Add an artist</h3>

      <div className="flex flex-col gap-2">
        <label htmlFor="add-lineup-artist" className={FIELD_LABEL}>
          Artist
        </label>
        <select
          // THE `key`, for § 4's reason. Without it a refused add -- a
          // duplicate artist is the ordinary one -- snaps this back to the
          // first option and the retry books somebody else.
          key={`artistId:${artistId}`}
          id="add-lineup-artist"
          name="artistId"
          required
          disabled={!editable}
          defaultValue={artistId}
          aria-describedby={
            state.fieldErrors?.artistId
              ? "add-lineup-artist-error"
              : editable
                ? "add-lineup-artist-hint"
                : noteId
          }
          aria-invalid={state.fieldErrors?.artistId ? true : undefined}
          className={inputClass(Boolean(state.fieldErrors?.artistId))}
        >
          <option value="">Choose an artist</option>
          {artistOptions.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </select>
        <p id="add-lineup-artist-hint" className="text-sm text-ink-muted">
          {/* THE CAP, NAMED AS THE STOPGAP IT IS. `LINK_PANEL_LIMIT` = 100,
              and past that the picker offers the alphabetically first hundred.
              The real answer is a search-backed picker with its own keyset
              page; it is in FOLLOW-UPS.md rather than guessed at here. */}
          Live artists you can see, by name — the first 100. Artists already on
          this lineup are still listed; adding one again is refused with a
          message rather than hidden from the list.
        </p>
        <FieldError
          id="add-lineup-artist-error"
          message={state.fieldErrors?.artistId}
        />
      </div>

      <SlotFields
        idPrefix="add-lineup"
        state={state}
        position={position}
        billing={billing}
        setStartsAt={setStartsAt}
        setEndsAt={setEndsAt}
        notes={notes}
        disabled={!editable}
        noteId={noteId}
      />

      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={!editable}
          aria-describedby={editable ? undefined : noteId}
          pending={pending}
          pendingLabel="Adding…"
        >
          Add to lineup
        </Button>
      </div>
    </form>
  );
}
