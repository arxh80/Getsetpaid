"use client";

import { useActionState } from "react";
import {
  addRoomAction,
  closeRoomAction,
  renameRoomAction,
  reopenRoomAction,
} from "@/lib/crm/venues";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// venue_rooms, managed inline on the venue's own page.
//
// ===========================================================================
// FOUR ACTIONS, NO ROUTES, AND THE RENAME IS A NATIVE DISCLOSURE
// ===========================================================================
// A room is a NAME (20260827232510: "Name-only at MVP -- PRD 6.4 confirms
// rooms and optional room-level event assignment but gives no room-level
// fields"). Five routes for one text field is ceremony, so the whole lifecycle
// lives here.
//
// The rename form is inside a `<details>`/`<summary>`. That is a real
// disclosure widget with the correct role, keyboard model and screen-reader
// announcement in every browser, it needs no JavaScript, and it costs no
// state -- where a hand-rolled "editing this row" toggle would need `useState`
// per row, an id per row, and its own focus management. The one thing it does
// NOT do is close itself after a successful save; the row above it re-renders
// with the new name, which is the confirmation that matters.
//
// ===========================================================================
// "CLOSE" AND "REOPEN", NOT "DELETE" AND "RESTORE"
// ===========================================================================
// The column is `deleted_at` and the operation is a soft delete, but the word
// the product uses is the word for what happens to a room. `deleted_at` exists
// on this table so Phase 3's events can still reference a room that has since
// closed, so a control labelled "Delete" would promise the row is gone -- and
// it is not, and must not be. A closed room stays on this page, below the open
// ones, with a Reopen control.
//
// ===========================================================================
// A DELETED VENUE'S ROOMS ARE NOT EDITABLE, AND THE DATABASE AGREES
// ===========================================================================
// `disabledReason` covers the three application reasons (suspended workspace,
// tier, role) plus the deleted venue. As of 20260829001000 the deleted-venue
// half is ALSO a policy term -- `p.deleted_at is null` in both venue_rooms
// write policies -- so a direct PostgREST call with the anon key is refused
// too, and lib/crm/venues.ts is the sentence rather than the only check.
//
// When the panel is blocked it renders no controls at all rather than disabled
// ones: offering a button whose action is guaranteed to refuse is worse than
// not offering it, and the explanation takes their place.

export interface RoomRecord {
  id: string;
  name: string;
  /** Soft-deleted: closed, not gone. Phase 3 events may still reference it. */
  isClosed: boolean;
}

export function RoomPanel({
  orgSlug,
  venueId,
  rooms,
  disabledReason,
}: {
  orgSlug: string;
  venueId: string;
  rooms: readonly RoomRecord[];
  disabledReason: string | null;
}) {
  const open = rooms.filter((room) => !room.isClosed);
  const closed = rooms.filter((room) => room.isClosed);
  const editable = disabledReason === null;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-ink">Rooms</h2>

      {rooms.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          No rooms yet. Add one for each space events can be booked into — a
          main room and a basement are two rooms, not two venues.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {open.map((room) => (
            <li key={room.id} className="flex flex-col gap-2 border-b border-rule py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-semibold break-words text-ink">{room.name}</span>
                {editable ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <CloseRoomButton
                      orgSlug={orgSlug}
                      venueId={venueId}
                      room={room}
                    />
                  </div>
                ) : null}
              </div>
              {editable ? (
                <RenameRoom orgSlug={orgSlug} venueId={venueId} room={room} />
              ) : null}
            </li>
          ))}
          {closed.map((room) => (
            <li
              key={room.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-rule py-3"
            >
              <span className="flex flex-wrap items-center gap-2">
                {/* A closed room is SHOWN, not hidden. Hiding it would hide the
                    thing deleted_at was added for -- a room past events were
                    assigned to -- and would make the reopen path unreachable,
                    which turns a soft delete into a hard one with extra
                    steps. */}
                <span className="font-semibold break-words text-ink-muted">
                  {room.name}
                </span>
                <span className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
                  Closed
                </span>
              </span>
              {editable ? (
                <ReopenRoomButton orgSlug={orgSlug} venueId={venueId} room={room} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <AddRoom orgSlug={orgSlug} venueId={venueId} />
      ) : (
        <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
      )}
    </section>
  );
}

/**
 * One hidden-field block, written once.
 *
 * Every action in this panel takes the same three ids, and a form that omits
 * one of them is refused with a sentence the user cannot act on. Writing them
 * out four times is four chances to leave one out.
 */
function RoomIds({
  orgSlug,
  venueId,
  roomId,
}: {
  orgSlug: string;
  venueId: string;
  roomId?: string;
}) {
  return (
    <>
      {/* A SLUG, re-resolved server-side through the RLS-gated getCurrentOrg().
          Never an organisation id -- CLAUDE.md § Tenancy model. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="venueId" value={venueId} />
      {roomId ? <input type="hidden" name="roomId" value={roomId} /> : null}
    </>
  );
}

function AddRoom({ orgSlug, venueId }: { orgSlug: string; venueId: string }) {
  const [state, formAction, pending] = useActionState(
    addRoomAction,
    EMPTY_FORM_STATE,
  );
  const inputId = "add-room-name";
  const errorId = `${inputId}-error`;

  return (
    <form action={formAction} className="flex flex-col gap-3 border border-rule p-4">
      {/* ERRORS ONLY, NO SUCCESS ALERT. Task 4 measured the alternative: a
          Client Component's `useActionState` result outlives the thing it
          describes, because revalidation does not remount it, so "Done. Added."
          stayed on screen through every later action in the panel. The
          confirmation this action needs is the room appearing in the list
          above, which shows the actual new state instead of asserting that
          something happened. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <RoomIds orgSlug={orgSlug} venueId={venueId} />

      <label htmlFor={inputId} className="text-sm font-semibold text-ink">
        Add a room
      </label>
      <input
        id={inputId}
        name="roomName"
        maxLength={200}
        required
        autoComplete="off"
        // React 19 resets the form after the action, so a refused submit has to
        // get its value back or the user retypes it. `field()` server-side
        // trims and normalises "" to null, so the echo is what was typed.
        defaultValue={state.values?.roomName ?? ""}
        aria-describedby={state.fieldErrors?.roomName ? errorId : undefined}
        aria-invalid={state.fieldErrors?.roomName ? true : undefined}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (state.fieldErrors?.roomName
            ? "border-danger "
            : "border-rule hover:border-ink focus:border-accent")
        }
      />
      {state.fieldErrors?.roomName ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {state.fieldErrors.roomName}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Adding…">
          Add room
        </Button>
      </div>
    </form>
  );
}

function RenameRoom({
  orgSlug,
  venueId,
  room,
}: {
  orgSlug: string;
  venueId: string;
  room: RoomRecord;
}) {
  const [state, formAction, pending] = useActionState(
    renameRoomAction,
    EMPTY_FORM_STATE,
  );
  const inputId = `rename-${room.id}`;
  const errorId = `${inputId}-error`;

  return (
    <details className="border border-rule">
      {/* The accessible name names the ROOM. Ten "Rename" summaries down a page
          are ten controls a screen-reader user cannot tell apart. */}
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
        <span aria-hidden="true">Rename</span>
        <span className="sr-only">Rename {room.name}</span>
      </summary>
      <form action={formAction} className="flex flex-col gap-3 px-3 pt-1 pb-3">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <RoomIds orgSlug={orgSlug} venueId={venueId} roomId={room.id} />
        <label htmlFor={inputId} className="text-sm font-semibold text-ink">
          New name
        </label>
        <input
          id={inputId}
          name="roomName"
          maxLength={200}
          required
          autoComplete="off"
          defaultValue={state.values?.roomName ?? room.name}
          aria-describedby={state.fieldErrors?.roomName ? errorId : undefined}
          aria-invalid={state.fieldErrors?.roomName ? true : undefined}
          className={
            "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
            "transition-colors duration-[var(--dur-fast)] ease-brand " +
            (state.fieldErrors?.roomName
              ? "border-danger "
              : "border-rule hover:border-ink focus:border-accent")
          }
        />
        {state.fieldErrors?.roomName ? (
          <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
            {state.fieldErrors.roomName}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
            Save name
          </Button>
        </div>
      </form>
    </details>
  );
}

function CloseRoomButton({
  orgSlug,
  venueId,
  room,
}: {
  orgSlug: string;
  venueId: string;
  room: RoomRecord;
}) {
  const [state, formAction, pending] = useActionState(
    closeRoomAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <RoomIds orgSlug={orgSlug} venueId={venueId} roomId={room.id} />
      {/* NO CONFIRMATION STEP, unlike DeleteRecordForm. Closing a room is
          reversible in one click from the row it leaves behind, on the same
          page, with nothing else changed -- so a "are you sure" prompt here is
          the kind that trains people to stop reading prompts. Deleting a VENUE
          keeps its confirmation, because that one removes a record from a list
          other people use. */}
      <Button type="submit" variant="quiet" pending={pending} pendingLabel="Closing…">
        <span aria-hidden="true">Close</span>
        <span className="sr-only">Close {room.name}</span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function ReopenRoomButton({
  orgSlug,
  venueId,
  room,
}: {
  orgSlug: string;
  venueId: string;
  room: RoomRecord;
}) {
  const [state, formAction, pending] = useActionState(
    reopenRoomAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <RoomIds orgSlug={orgSlug} venueId={venueId} roomId={room.id} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Reopening…">
        <span aria-hidden="true">Reopen</span>
        <span className="sr-only">Reopen {room.name}</span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}
