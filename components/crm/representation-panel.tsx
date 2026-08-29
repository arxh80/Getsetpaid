"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  createRepresentationAction,
  deleteRepresentationAction,
  restoreRepresentationAction,
  setPrimaryRepresentationAction,
  updateRepresentationAction,
} from "@/lib/crm/artists";
import {
  EMPTY_FORM_STATE,
  groupMarkerName,
  selectedInGroup,
} from "@/lib/forms";
import {
  resolveClearPrimaryTargets,
  type ClearPrimaryTarget,
} from "@/lib/crm/representation-primary";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// artist_representations, edited from EITHER SIDE by the same component.
//
// ===========================================================================
// ONE COMPONENT, TWO DIRECTIONS, BECAUSE THERE IS ONE ROW
// ===========================================================================
// On an artist this lists agencies; on an agency it lists artists. The row
// being created, edited or removed is identical, the five Server Actions are
// identical, and the RLS policies decide access from the ARTIST in both
// directions (`artist_representations_*_via_artist` -- Task 1's Q3a
// adjudication). So what actually differs is a handful of strings and which id
// is fixed, and that is what `side` carries.
//
// Writing it twice would produce two panels that drift: the agency-side copy
// would eventually stop offering "make primary", or would offer it with the
// arguments the other way round, and nothing would fail.
//
// ===========================================================================
// "PRIMARY" IS A FACT ABOUT THE ARTIST, IN BOTH DIRECTIONS
// ===========================================================================
// `is_primary` means "this is the artist's main representation", and
// `artist_representations_one_current_primary_per_artist` is unique on
// `artist_id`. Read from an agency, that is easy to mis-say as "this is our
// main artist", which it is not -- so the agency-side copy says "primary for
// them" rather than "primary", and setting it from here really does change
// that ARTIST's primary representation, possibly to something involving a
// different agency entirely. Task 4 shipped the un-sided version of exactly
// this on the company page and had to fix it after seeing two bare "PRIMARY"
// chips on one screen.
//
// ===========================================================================
// THE THREE PRIMARY STATES, AND WHY A BARE "PRIMARY" CHIP IS NOT ENOUGH
// ===========================================================================
// The index is partial on `is_primary and ended_at is null and deleted_at is
// null`, so it enforces one OPEN-ENDED primary rather than one CURRENT one --
// `current_date` is not IMMUTABLE and cannot appear in an index predicate.
// Measured before this component was written: one artist held four
// `is_primary` rows at once. Task 4b accepted that gap (a representation that
// ends on a known future date is an ordinary fact) and paid for it with a
// display rule, computed once in lib/crm/queries.ts and rendered here:
//
//   current        "Primary"            the one the index guarantees is unique
//   scheduled-end  "Primary until <d>"  real, and NOT the current primary
//   past           "Was primary"        history; the demote never touches it
//
// So there is never more than one bare "Primary" chip on a page, whatever the
// data does.
//
// ===========================================================================
// THE CONTROLS A ROW GETS, AND THE ONE IT DOES NOT
// ===========================================================================
// "Make primary" is offered only on a LIVE, OPEN-ENDED row that is not already
// the current primary. That is not a cosmetic filter: the promote half of
// `set_artist_primary_representation()` is scoped `ended_at is null and
// deleted_at is null`, so offering it on an ended row would produce a 42501
// the user cannot interpret. The button matches what the function will accept.
//
// The EDIT form deliberately does not offer the artist, the agency or the
// primary flag. The first two would change which record's history the row is
// (lib/crm/artists.ts says why at length); the third is a two-statement
// transaction and cannot be composed from a checkbox.

export interface RepresentationRecord {
  id: string;
  artistId: string;
  agencyId: string;
  /** The end this panel is NOT anchored on: the agency, or the artist. */
  otherId: string;
  /**
   * Null when the caller may read the representation but not the record it
   * names -- the accepted Q3a identifier disclosure. Rendered as a sentence
   * rather than as a blank cell, because a blank next to a filled-in role and
   * territory reads as a rendering fault.
   */
  otherName: string | null;
  otherHref: string;
  otherDeleted: boolean;
  contactId: string | null;
  contactName: string | null;
  contactHref: string | null;
  contactDeleted: boolean;
  role: string | null;
  territory: string | null;
  isExclusive: boolean;
  primaryState: "current" | "scheduled-end" | "past" | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Soft-deleted. Shown, with a Restore control -- never hidden. */
  isRemoved: boolean;
}

export interface PickerOption {
  id: string;
  name: string;
}

export function RepresentationPanel({
  orgSlug,
  side,
  anchorId,
  rows,
  otherOptions,
  contactOptions,
  disabledReason,
  recordScoped,
}: {
  orgSlug: string;
  side: "artist" | "agency";
  /** The fixed end: the artist's id on an artist page, the agency's on an agency page. */
  anchorId: string;
  rows: readonly RepresentationRecord[];
  otherOptions: readonly PickerOption[];
  contactOptions: readonly PickerOption[];
  disabledReason: string | null;
  /**
   * The viewer sees only records assigned to them, so an EMPTY PICKER does not
   * mean an empty workspace.
   *
   * ADDED IN TASK 4b's BROWSER PASS, because the panel shipped the exact defect
   * Task 3 found on the contacts list and every list since has carried a
   * role-aware empty state for. Seen as `pstd1`, a Standard User who owns the
   * artist and none of the agencies: the page rendered six representations,
   * each naming an agency, above the sentence
   *
   *     There are no agencies in this workspace yet. Create one first and it
   *     will appear here.
   *
   * There are four. `loadLinkOptions` runs through the caller's own client --
   * which is correct, and is where the Q3a write half is closed -- so a
   * record-scoped user is offered nothing they cannot read, and an empty
   * result is the ordinary case for them rather than an empty workspace. The
   * copy has to know which of the two it is, and only the role can say.
   */
  recordScoped: boolean;
}) {
  const onArtist = side === "artist";
  const editable = disabledReason === null;
  const live = rows.filter((row) => !row.isRemoved);
  const removed = rows.filter((row) => row.isRemoved);
  // fix round 1, I-1: ONE TARGET PER CURRENT-PRIMARY ROW, not one shared
  // control that had to pick among them. See representation-primary.ts for
  // why the artist side always resolves to at most one and the agency side
  // does not.
  const clearTargets = resolveClearPrimaryTargets(rows, onArtist);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-bold text-ink">
        {onArtist ? "Representation" : "Artists represented"}
      </h2>

      {rows.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          {onArtist
            ? "No representation recorded. An artist can have more than one — a booking agency for the UK and a different one for Europe is ordinary, and each keeps its own territory and dates."
            : "No artists recorded against this agency yet. You’ll only see the ones whose artist records you can see."}
        </p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {[...live, ...removed].map((row) => (
            <li key={row.id} className="flex flex-col gap-2 border-b border-rule py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <OtherEnd row={row} />
                    <PrimaryChip state={row.primaryState} endedAt={row.endedAt} onArtist={onArtist} />
                    {row.isExclusive ? <Chip tone="muted">Exclusive</Chip> : null}
                    {row.isRemoved ? <Chip tone="muted">Removed</Chip> : null}
                  </span>
                  <RowDetail row={row} />
                </div>

                {/* A ROW WITH A DELETED OTHER END CARRIES NO CONTROLS -- not
                    disabled ones, none. `disabledReason` covers the anchor;
                    `row.otherDeleted` covers the other end. A link is only
                    editable while both ends are live, and lib/crm/artists.ts
                    enforces the same rule so this is the explanation and not
                    the control. */}
                {editable && !row.otherDeleted ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {!row.isRemoved &&
                    row.primaryState !== "current" &&
                    row.endedAt === null ? (
                      <PrimaryButton
                        orgSlug={orgSlug}
                        row={row}
                        label={onArtist ? "Make primary" : "Make primary for them"}
                      />
                    ) : null}
                    {row.isRemoved ? (
                      <RestoreButton orgSlug={orgSlug} row={row} />
                    ) : (
                      <RemoveButton orgSlug={orgSlug} row={row} />
                    )}
                  </div>
                ) : null}
              </div>

              {editable && !row.isRemoved && !row.otherDeleted ? (
                <EditRepresentation
                  orgSlug={orgSlug}
                  row={row}
                  contactOptions={contactOptions}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable
        ? clearTargets.map((target) => (
            <ClearPrimary
              key={`${target.artistId}:${target.agencyId}`}
              orgSlug={orgSlug}
              target={target}
              onArtist={onArtist}
            />
          ))
        : null}

      {editable ? (
        <AddRepresentation
          orgSlug={orgSlug}
          side={side}
          anchorId={anchorId}
          otherOptions={otherOptions}
          contactOptions={contactOptions}
          recordScoped={recordScoped}
        />
      ) : (
        <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
      )}
    </section>
  );
}

function OtherEnd({ row }: { row: RepresentationRecord }) {
  if (row.otherName === null) {
    // THE Q3a CASE, rendered rather than hidden. The SELECT policy is scoped
    // by the artist, so a record-scoped user reads this row and its
    // identifiers while the embedded record comes back null. Dropping the row
    // would hide a representation from the person whose artist it is, which is
    // the legitimate case Q3a exists to protect. Nothing is disclosed here
    // that the policy has not already handed over.
    return (
      <span className="font-semibold break-words text-ink-muted">
        A record you can’t see
      </span>
    );
  }
  if (row.otherDeleted) {
    // A deleted other end is SHOWN, not hidden, and is NOT a link: the detail
    // page of a deleted record is reachable from its restore queue, and a link
    // here would read as "this is fine".
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-semibold break-words text-ink-muted">{row.otherName}</span>
        <Chip tone="muted">Deleted</Chip>
      </span>
    );
  }
  return (
    <Link
      href={row.otherHref}
      className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
    >
      {row.otherName}
    </Link>
  );
}

/**
 * Role, territory, the named agent and the period, as one muted line.
 *
 * Everything here is FREE TEXT the user typed and React escapes it on the way
 * out. `role` and `territory` are free text by the schema's explicit
 * instruction (20260827232510 forbids inventing a vocabulary), so there is no
 * label to look up and nothing to normalise.
 */
function RowDetail({ row }: { row: RepresentationRecord }) {
  const parts: string[] = [];
  if (row.role) parts.push(row.role);
  if (row.territory) parts.push(row.territory);
  const period = formatPeriod(row.startedAt, row.endedAt);
  if (period) parts.push(period);

  if (parts.length === 0 && !row.contactId) return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
      {parts.length > 0 ? <span className="break-words">{parts.join(" · ")}</span> : null}
      {row.contactId ? (
        <span className="break-words">
          {parts.length > 0 ? "· " : ""}
          {row.contactName === null ? (
            "Agent: a contact you can’t see"
          ) : row.contactDeleted || row.contactHref === null ? (
            <>Agent: {row.contactName} (deleted)</>
          ) : (
            <>
              Agent:{" "}
              <Link
                href={row.contactHref}
                className="text-primary underline underline-offset-4 hover:text-ink"
              >
                {row.contactName}
              </Link>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

function PrimaryChip({
  state,
  endedAt,
  onArtist,
}: {
  state: RepresentationRecord["primaryState"];
  endedAt: string | null;
  onArtist: boolean;
}) {
  if (state === null) return null;
  if (state === "current") {
    return <Chip tone="primary">{onArtist ? "Primary" : "Primary for them"}</Chip>;
  }
  if (state === "scheduled-end") {
    return (
      <Chip tone="primary">
        {onArtist ? "Primary until " : "Primary for them until "}
        {formatDate(endedAt as string)}
      </Chip>
    );
  }
  return <Chip tone="muted">Was primary</Chip>;
}

function Chip({ tone, children }: { tone: "primary" | "muted"; children: React.ReactNode }) {
  // A bordered chip, no fill and no radius -- DESIGN.md. The word carries the
  // meaning; the border is decoration, so this is legible in greyscale.
  return (
    <span
      className={
        "border px-2 py-0.5 text-xs font-semibold tracking-[0.04em] uppercase " +
        (tone === "primary" ? "border-accent text-ink" : "border-rule text-ink-muted")
      }
    >
      {children}
    </span>
  );
}

/**
 * A `date` column as a date, with NO timezone conversion.
 *
 * `Date.UTC` in and `timeZone: "UTC"` out, so the day that comes back is the
 * day that was stored. `new Date("2026-03-03").toLocaleDateString("en-GB")` in
 * London during BST is 3 March; in Los Angeles it is 2 March -- the string is
 * parsed as UTC midnight and then rendered in the local zone. These are
 * calendar facts, not instants (20260827232510 convention (4)), so there is no
 * local zone to render them in.
 */
function formatDate(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatPeriod(startedAt: string | null, endedAt: string | null): string | null {
  if (startedAt && endedAt) return `${formatDate(startedAt)} – ${formatDate(endedAt)}`;
  if (startedAt) return `From ${formatDate(startedAt)}`;
  if (endedAt) return `Until ${formatDate(endedAt)}`;
  return null;
}

/** The three ids every action in this panel needs, written once. */
function RowIds({ orgSlug, row }: { orgSlug: string; row: RepresentationRecord }) {
  return (
    <>
      {/* A SLUG, re-resolved server-side through the RLS-gated getCurrentOrg().
          Never an organisation id -- CLAUDE.md § Tenancy model. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="artistId" value={row.artistId} />
      <input type="hidden" name="agencyId" value={row.agencyId} />
      <input type="hidden" name="representationId" value={row.id} />
    </>
  );
}

function PrimaryButton({
  orgSlug,
  row,
  label,
}: {
  orgSlug: string;
  row: RepresentationRecord;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(
    setPrimaryRepresentationAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <RowIds orgSlug={orgSlug} row={row} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
        {label}
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

/**
 * Clear one artist's primary representation.
 *
 * A SEPARATE CONTROL BECAUSE THERE IS NOWHERE ELSE TO PUT IT: unsetting the
 * primary is not an operation on any one row, and a "Make primary" button that
 * toggles would submit the same form for two different transactions.
 *
 * ONE CONTROL PER `target`, not one control for the whole panel (fix round 1,
 * I-1). `resolveClearPrimaryTargets` (lib/crm/representation-primary.ts) is
 * why: on the ARTIST side there is at most one target, because
 * `artist_representations_one_current_primary_per_artist` is unique on
 * `artist_id` and every row here shares that one id -- so the generic label
 * is unambiguous. On the AGENCY side an agency's roster can hold several
 * artists who are each independently current for THIS agency, and the
 * reviewed version had ONE shared control naming `rows[0]` -- an arbitrary,
 * order-dependent pick that cleared whichever artist happened to sort first,
 * silently, with no way for the user to tell which one they were about to
 * act on. Naming the artist per target removes the need to pick at all.
 *
 * Only rendered for a row that IS the current primary. That is not decoration
 * either: `set_artist_primary_representation()` raises 42501 when the clear
 * branch demotes nothing, so offering the control with nothing to clear would
 * produce a refusal the user cannot act on. (The RPC's own header records
 * that the same branch is reachable by a race even so, and that the
 * transaction still rolls back whole.)
 */
function ClearPrimary({
  orgSlug,
  target,
  onArtist,
}: {
  orgSlug: string;
  target: ClearPrimaryTarget;
  onArtist: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setPrimaryRepresentationAction,
    EMPTY_FORM_STATE,
  );
  const label = onArtist
    ? "Clear primary representation"
    : `Clear primary for ${target.artistName ?? "a record you can’t see"}`;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="artistId" value={target.artistId} />
      {/* The agency is passed so the OTHER page is revalidated too. No
          representationId at all: its absence is what means "clear". */}
      <input type="hidden" name="agencyId" value={target.agencyId} />
      <div>
        <Button type="submit" variant="quiet" pending={pending} pendingLabel="Clearing…">
          {label}
        </Button>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function RemoveButton({ orgSlug, row }: { orgSlug: string; row: RepresentationRecord }) {
  const [state, formAction, pending] = useActionState(
    deleteRepresentationAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <RowIds orgSlug={orgSlug} row={row} />
      <Button type="submit" variant="quiet" pending={pending} pendingLabel="Removing…">
        {/* The accessible name names the record. Ten "Remove" buttons down a
            page are ten controls a screen-reader user cannot tell apart. */}
        <span aria-hidden="true">Remove</span>
        <span className="sr-only">
          Remove the representation by {row.otherName ?? "a record you can’t see"}
        </span>
      </Button>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

function RestoreButton({ orgSlug, row }: { orgSlug: string; row: RepresentationRecord }) {
  const [state, formAction, pending] = useActionState(
    restoreRepresentationAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <RowIds orgSlug={orgSlug} row={row} />
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Restoring…">
        <span aria-hidden="true">Restore</span>
        <span className="sr-only">
          Restore the representation by {row.otherName ?? "a record you can’t see"}
        </span>
      </Button>
      {/* The one place in this panel where an error is EXPECTED rather than
          exceptional: restoring a row that was primary, when a different one is
          primary now, is a 23505. lib/crm/artists.ts turns that into a sentence
          naming the obstacle and the next move. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

/**
 * The fields both the add and the edit form share.
 *
 * `is_exclusive` CARRIES THE GROUP MARKER, and that is the non-obvious part.
 * HTML submits a checkbox only when it is ticked, so an unticked box is ABSENT
 * from the FormData -- indistinguishable from a form that never had the
 * control. `echoedValues` therefore omits the key, and a form that reads
 * `state.values?.isExclusive !== undefined ? echo : stored` falls back to the
 * STORED value and re-ticks the box the user just cleared. Task 4 measured
 * exactly that on the company type group; `selectedInGroup` plus the hidden
 * `isExclusive__submitted` marker is the fix, and it applies to a group of one
 * for the same reason it applies to a group of six.
 */
function RepresentationFields({
  idPrefix,
  values,
  fieldErrors,
  contactOptions,
  selectedExclusive,
}: {
  idPrefix: string;
  values: Readonly<Record<string, string>> | undefined;
  fieldErrors: Record<string, string> | undefined;
  contactOptions: readonly PickerOption[];
  selectedExclusive: boolean;
}) {
  const shown = (name: string, fallback: string) => values?.[name] ?? fallback;
  return (
    <>
      <TextInput
        id={`${idPrefix}-role`}
        name="role"
        label="Role"
        hint="Booking agent, manager, day-to-day — your words, not a fixed list."
        defaultValue={shown("role", "")}
        maxLength={200}
        error={fieldErrors?.role}
      />
      <TextInput
        id={`${idPrefix}-territory`}
        name="territory"
        label="Territory"
        hint="UK, Europe, worldwide — whatever the agreement says."
        defaultValue={shown("territory", "")}
        maxLength={200}
        error={fieldErrors?.territory}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-contact`} className="text-sm font-semibold text-ink">
          Named agent
          <span className="ml-2 font-normal text-ink-muted">Optional</span>
        </label>
        <p className="text-sm text-ink-muted">
          The individual you deal with. “Represented by the agency” is a
          complete answer on its own.
        </p>
        {/* A native <select>. THE LIST IS BOUNDED BY THE SERVER, not by this
            control -- the page passes at most LINK_PANEL_LIMIT options, and a
            workspace with thousands of contacts needs a search-backed picker
            this task deliberately does not build (FOLLOW-UPS.md). The options
            are also only the rows the CALLER can read, which is where the Q3a
            write half is closed. */}
        <select
          id={`${idPrefix}-contact`}
          name="contactId"
          defaultValue={shown("contactId", "")}
          className={
            "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
            "transition-colors duration-[var(--dur-fast)] ease-brand " +
            "border-rule hover:border-ink focus:border-accent"
          }
        >
          <option value="">Nobody in particular</option>
          {contactOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-4">
        <TextInput
          id={`${idPrefix}-started`}
          name="startedAt"
          type="date"
          label="Start date"
          defaultValue={shown("startedAt", "")}
          error={fieldErrors?.startedAt}
        />
        <TextInput
          id={`${idPrefix}-ended`}
          name="endedAt"
          type="date"
          label="End date"
          hint="Leave blank while it is current. A date in the future is fine."
          defaultValue={shown("endedAt", "")}
          error={fieldErrors?.endedAt}
        />
      </div>

      {/* THE MARKER. Always submitted, so the action's echo can say "this form
          asked about `isExclusive`" even when the answer was no. Without it an
          unticked box is indistinguishable from a box that was never on the
          form, and a failed submit re-ticks what the user cleared. Not part of
          the checkbox's own name, so `formData.get("isExclusive")` server-side
          needs no filtering. */}
      <input type="hidden" name={groupMarkerName("isExclusive")} value="1" />
      <label className="flex min-h-11 items-center gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="isExclusive"
          value="1"
          defaultChecked={selectedExclusive}
          // accent-color, not a hand-built box: the native checkbox is
          // keyboard- and screen-reader-correct everywhere and the only thing
          // worth changing about it is the tick's colour.
          className="size-5 accent-[var(--color-primary)]"
        />
        Exclusive
      </label>
    </>
  );
}

function TextInput({
  id,
  name,
  label,
  hint,
  error,
  ...props
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
} & React.ComponentProps<"input">) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
        <span className="ml-2 font-normal text-ink-muted">Optional</span>
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      <input
        {...props}
        id={id}
        name={name}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (error ? "border-danger " : "border-rule hover:border-ink focus:border-accent")
        }
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EditRepresentation({
  orgSlug,
  row,
  contactOptions,
}: {
  orgSlug: string;
  row: RepresentationRecord;
  contactOptions: readonly PickerOption[];
}) {
  const [state, formAction, pending] = useActionState(
    updateRepresentationAction,
    EMPTY_FORM_STATE,
  );
  // The stored value for the checkbox is the marker's vocabulary: the box
  // submits "1" when ticked, so "stored" is ["1"] or [].
  const selected = new Set(
    selectedInGroup(state.values, "isExclusive", row.isExclusive ? ["1"] : []),
  );
  // The stored record is the fallback for every field; the echo wins when a
  // submit has been refused, because it is newer.
  const stored: Record<string, string> = {
    role: row.role ?? "",
    territory: row.territory ?? "",
    contactId: row.contactId ?? "",
    startedAt: row.startedAt ?? "",
    endedAt: row.endedAt ?? "",
  };
  const merged = { ...stored, ...(state.values ?? {}) };

  return (
    <details className="border border-rule">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-primary hover:text-ink">
        <span aria-hidden="true">Edit</span>
        <span className="sr-only">
          Edit the representation by {row.otherName ?? "a record you can’t see"}
        </span>
      </summary>
      <form action={formAction} className="flex flex-col gap-4 px-3 pt-1 pb-3">
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        <RowIds orgSlug={orgSlug} row={row} />
        <RepresentationFields
          idPrefix={`edit-${row.id}`}
          values={merged}
          fieldErrors={state.fieldErrors}
          contactOptions={contactOptions}
          selectedExclusive={selected.has("1")}
        />
        <div>
          <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…">
            Save representation
          </Button>
        </div>
      </form>
    </details>
  );
}

function AddRepresentation({
  orgSlug,
  side,
  anchorId,
  otherOptions,
  contactOptions,
  recordScoped,
}: {
  orgSlug: string;
  side: "artist" | "agency";
  anchorId: string;
  otherOptions: readonly PickerOption[];
  contactOptions: readonly PickerOption[];
  recordScoped: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    createRepresentationAction,
    EMPTY_FORM_STATE,
  );
  const onArtist = side === "artist";
  const otherName = onArtist ? "agencyId" : "artistId";
  const selectId = `add-representation-${otherName}`;
  const errorId = `${selectId}-error`;
  const selected = new Set(selectedInGroup(state.values, "isExclusive", []));

  if (otherOptions.length === 0) {
    // TWO SENTENCES, NOT ONE, AND ONLY THE ROLE CAN CHOOSE BETWEEN THEM. An
    // empty picker means "this workspace has none" for a full-scope viewer and
    // "none are assigned to you" for a record-scoped one -- and the second
    // sentence rendered as the first is a false claim about the customer's own
    // data, which is the defect Task 3 found on the contacts list. Measured
    // here in a browser: `pstd1` saw six representations above the words
    // "There are no agencies in this workspace yet."
    return (
      <p className="max-w-prose text-sm text-ink-muted">
        {recordScoped
          ? onArtist
            ? "No agencies are assigned to you, so there are none to choose here. Ask an Owner or Admin to assign one — others in this workspace may see more."
            : "No artists are assigned to you, so there are none to choose here. Ask an Owner or Admin to assign one — others in this workspace may see more."
          : onArtist
            ? "There are no agencies in this workspace yet. Create one first and it will appear here."
            : "There are no artists in this workspace yet. Create one first and it will appear here."}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4 border border-rule p-4">
      {/* ERRORS ONLY, NO SUCCESS ALERT -- see room-panel.tsx and Task 4's
          measurement: a Client Component's action result outlives the thing it
          describes, because revalidation does not remount it. The row
          appearing in the list above is the better confirmation. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input
        type="hidden"
        name={onArtist ? "artistId" : "agencyId"}
        value={anchorId}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor={selectId} className="text-sm font-semibold text-ink">
          {onArtist ? "Add an agency" : "Add an artist"}
          <span className="ml-2 font-normal text-ink-muted">Required</span>
        </label>
        <select
          id={selectId}
          name={otherName}
          defaultValue={state.values?.[otherName] ?? ""}
          aria-describedby={state.fieldErrors?.[otherName] ? errorId : undefined}
          aria-invalid={state.fieldErrors?.[otherName] ? true : undefined}
          className={
            "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
            "transition-colors duration-[var(--dur-fast)] ease-brand " +
            (state.fieldErrors?.[otherName]
              ? "border-danger "
              : "border-rule hover:border-ink focus:border-accent")
          }
        >
          <option value="">Choose…</option>
          {otherOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {state.fieldErrors?.[otherName] ? (
          <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
            {state.fieldErrors[otherName]}
          </p>
        ) : null}
      </div>

      <RepresentationFields
        idPrefix="add-representation"
        values={state.values}
        fieldErrors={state.fieldErrors}
        contactOptions={contactOptions}
        selectedExclusive={selected.has("1")}
      />

      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Adding…">
          Add representation
        </Button>
      </div>
      <p className="max-w-prose text-sm text-ink-muted">
        New representations are not primary. Use “Make primary” on the row once
        it is here — changing the primary is one transaction that has to demote
        the old one first.
      </p>
    </form>
  );
}
