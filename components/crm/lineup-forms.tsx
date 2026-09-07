"use client";

import { useActionState } from "react";
import {
  addLineupEntryAction,
  removeLineupEntryAction,
  restoreLineupEntryAction,
  updateLineupEntryAction,
} from "@/lib/crm/events";
import {
  BILLING_LABELS,
  BILLING_VALUES,
  MAX_LINEUP_NOTES,
  MAX_POSITION,
  MIN_POSITION,
} from "@/lib/crm/lineup-list";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The four forms of the lineup panel. THE ONLY CLIENT CODE IN THAT SURFACE.
//
// ===========================================================================
// WHY THIS IS A SECOND FILE, AND IT IS NOT TIDINESS -- IT IS A DEFECT THE
// BROWSER WALK FOUND
// ===========================================================================
// The first version put the whole panel behind `"use client"`, which pulled
// `components/list/list-pager.tsx` into the browser bundle with it. That file
// calls `buildListHref`, which calls `encodeCursor`, which is
// `Buffer.from(...).toString("base64url")` (lib/list/cursor.ts) -- and the
// browser's `Buffer` polyfill does not know that encoding:
//
//     [browser] Uncaught TypeError: Unknown encoding: base64url
//
// It throws during HYDRATION, so the whole client tree for the page never
// hydrates. The panel still WORKED, which is why nothing else caught it: every
// form here is uncontrolled and posts natively, so React 19 falls back to a
// full round trip and the server re-renders the result. What was lost was
// every pending state, every in-place update, and the pager's `<Link>` -- a
// click on Next did nothing at all, which is how the walk found it.
//
// So the panel is a SERVER component and this file holds the four forms. The
// division is the one `components/crm/activity-timeline.tsx` already draws:
// markup, pagination and links are server-rendered; only `useActionState`
// needs a client.
//
// LATENT AND GENERAL: any client component that imports `ListPager` reaches
// the same throw, and nothing in the repository says so -- `lib/list/params.ts`
// deliberately is NOT `server-only`, because `components/list/list-toolbar.tsx`
// imports `buildListHref` and gets away with it only because it never passes a
// `cursor` override. Filed in FOLLOW-UPS.md.
//
// ===========================================================================
// EVERY `<select>` CARRIES A `key`, AND IT IS LOAD-BEARING
// ===========================================================================
// React syncs a text input's `defaultValue` to the DOM property on every
// update, so `form.reset()` after a Server Action restores the ECHOED value.
// It does NOT do the equivalent for a `<select>`, whose default lives in an
// `<option>`'s `selected` ATTRIBUTE -- written at mount and then left alone.
// Task 4 measured what that costs on the event form: a refused submit snapped
// four selects back to the options the page first rendered with, and retrying
// SAVED four values the user never chose. The `key` forces a remount so the
// new element mounts with the right option. Same mechanism as
// components/crm/merge-form.tsx keying its field rows on the survivor, and the
// walk re-measured it here on the duplicate-artist refusal.
//
// ===========================================================================
// AND THE ONE THING THAT IS NOT A PROBLEM HERE, SAID OUT LOUD
// ===========================================================================
// lib/crm/event-picker.ts exists because a `<select>` that does not contain the
// value the record holds SILENTLY SUBMITS A DIFFERENT ONE, so the event form
// has to append its stored venue and room to the picker whatever else is true.
// THAT DOES NOT APPLY TO THE ARTIST PICKER, and the reason is structural
// rather than lucky: the artist select exists only on the ADD form, which
// holds no stored value. A slot's artist is fixed at creation --
// `updateLineupEntryAction` accepts no `artistId` and nothing here renders a
// control for one -- so there is no stored id for a picker to lose. Changing
// who is playing is a removal and an add, which is also what it is on the
// night.

export interface LineupPanelArtist {
  id: string;
  name: string;
}

/** The five editable fields of one slot, as the form shows them. */
export interface SlotFieldValues {
  position: string;
  billing: string;
  /** Europe/London wall clocks, `YYYY-MM-DDTHH:mm`, never instants. */
  setStartsAt: string;
  setEndsAt: string;
  notes: string;
}

const FIELD_LABEL =
  "text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase";

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

/**
 * The five editable fields, rendered identically by both forms.
 *
 * THE ECHOES ARE READ BY THE CALLER and passed in, rather than read from
 * `state` here: routing them through one component would leave a single
 * `state.values?.` in the file, and a field added without an echo would then be
 * invisible to the census in tests/unit/crm/source-shape.test.ts. That census
 * is the only gate in this repository that can see a missing echo at all -- it
 * needs a DOM, a render and a re-render, and tests/unit is pure functions only.
 */
function SlotFields({
  idPrefix,
  state,
  values,
  disabled,
  noteId,
}: {
  idPrefix: string;
  state: FormState;
  values: SlotFieldValues;
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
          defaultValue={values.position}
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
          // THE `key`. See this file's header.
          key={`billing:${values.billing}`}
          id={`${idPrefix}-billing`}
          name="billing"
          disabled={disabled}
          defaultValue={values.billing}
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
          defaultValue={values.setStartsAt}
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
          defaultValue={values.setEndsAt}
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
          // THE CONSTANT, NOT THE NUMBER. `readLineup` in lib/crm/events.ts
          // checks the same one; a literal here would let the browser truncate
          // at a length the server no longer enforces (fix round 1, Minor 3).
          maxLength={MAX_LINEUP_NOTES}
          disabled={disabled}
          defaultValue={values.notes}
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
        <FieldError id={`${idPrefix}-notes-error`} message={state.fieldErrors?.notes} />
      </div>
    </div>
  );
}

export function SlotEditForm({
  orgSlug,
  eventId,
  lineupId,
  artistName,
  stored,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId: string;
  /** For the control's accessible name. Null when the caller cannot read it. */
  artistName: string | null;
  stored: SlotFieldValues;
  disabled: boolean;
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
  const values: SlotFieldValues = {
    position: state.values?.position ?? stored.position,
    billing: state.values?.billing ?? stored.billing,
    setStartsAt: state.values?.setStartsAt ?? stored.setStartsAt,
    setEndsAt: state.values?.setEndsAt ?? stored.setEndsAt,
    notes: state.values?.notes ?? stored.notes,
  };

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SlotIds orgSlug={orgSlug} eventId={eventId} lineupId={lineupId} />
      <SlotFields
        idPrefix={`slot-${lineupId}`}
        state={state}
        values={values}
        disabled={disabled}
        noteId={noteId}
      />
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled}
          aria-describedby={disabled ? noteId : undefined}
          pending={pending}
          pendingLabel="Saving…"
        >
          <span aria-hidden="true">Save</span>
          {/* The accessible name names the ARTIST. Ten "Save" buttons down a
              page are ten controls a screen-reader user cannot tell apart. */}
          <span className="sr-only">Save {artistName ?? "this slot"}</span>
        </Button>
      </div>
    </form>
  );
}

export function RemoveSlotForm({
  orgSlug,
  eventId,
  lineupId,
  artistName,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId: string;
  artistName: string | null;
  disabled: boolean;
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
          reversible in one click from the disclosure it drops into, on the same
          page, with nothing else changed -- so an "are you sure" prompt here is
          the kind that trains people to stop reading prompts. Deleting the
          EVENT keeps its confirmation, because that removes a record from a
          list other people use. */}
      <div>
        <Button
          type="submit"
          variant="quiet"
          disabled={disabled}
          aria-describedby={disabled ? noteId : undefined}
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

export function RestoreSlotForm({
  orgSlug,
  eventId,
  lineupId,
  artistName,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  lineupId: string;
  artistName: string | null;
  disabled: boolean;
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
          disabled={disabled}
          aria-describedby={disabled ? noteId : undefined}
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

export function AddSlotForm({
  orgSlug,
  eventId,
  artistOptions,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  /** Live artists, already ordered and capped by the server. */
  artistOptions: readonly LineupPanelArtist[];
  disabled: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    addLineupEntryAction,
    EMPTY_FORM_STATE,
  );

  // THE SIX ECHOES. Five are the shared slot fields; `artistId` is this form's
  // own, and it is the reason the census in tests/unit/crm/source-shape.test.ts
  // names six and not five. It is also the one whose loss is worst: a refused
  // add that snapped the picker back to its first option would book somebody
  // the user never chose on the retry.
  const artistId = state.values?.artistId ?? "";
  const values: SlotFieldValues = {
    position: state.values?.position ?? "",
    billing: state.values?.billing ?? "support",
    setStartsAt: state.values?.setStartsAt ?? "",
    setEndsAt: state.values?.setEndsAt ?? "",
    notes: state.values?.notes ?? "",
  };

  return (
    <form action={formAction} className="flex flex-col gap-3 border border-rule p-4">
      {/* ERRORS ONLY, NO SUCCESS ALERT -- room-panel.tsx's measurement: a Client
          Component's `useActionState` result outlives the thing it describes,
          because revalidation does not remount it, so "Added" would stay on
          screen through every later action in the panel. The confirmation is
          the artist appearing in the list above. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SlotIds orgSlug={orgSlug} eventId={eventId} />

      <h3 className="text-sm font-semibold text-ink">Add an artist</h3>

      <div className="flex flex-col gap-2">
        <label htmlFor="add-lineup-artist" className={FIELD_LABEL}>
          Artist
        </label>
        <select
          // THE `key`, for the header's reason. Without it a refused add -- a
          // duplicate artist is the ordinary one -- snaps this back to the
          // first option and the retry books somebody else. Re-measured in the
          // Rule 17 walk.
          key={`artistId:${artistId}`}
          id="add-lineup-artist"
          name="artistId"
          required
          disabled={disabled}
          defaultValue={artistId}
          aria-describedby={
            state.fieldErrors?.artistId
              ? "add-lineup-artist-error"
              : disabled
                ? noteId
                : "add-lineup-artist-hint"
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
          {/* THE CAP, NAMED AS THE STOPGAP IT IS. `LINK_PANEL_LIMIT` = 100, and
              past that the picker offers the alphabetically first hundred. The
              real answer is a search-backed picker with its own keyset page; it
              is in FOLLOW-UPS.md rather than guessed at here. */}
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
        values={values}
        disabled={disabled}
        noteId={noteId}
      />

      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled}
          aria-describedby={disabled ? noteId : undefined}
          pending={pending}
          pendingLabel="Adding…"
        >
          Add to lineup
        </Button>
      </div>
    </form>
  );
}
