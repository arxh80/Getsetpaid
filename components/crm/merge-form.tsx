"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { dismissCandidateAction, mergeRecordsAction } from "@/lib/crm/merge";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The field-resolution screen.
//
// ===========================================================================
// WHAT THIS SCREEN IS FOR, WHICH IS NOT "CONFIRM THE MERGE"
// ===========================================================================
// 20260827232512 says why `merges.field_resolution` exists: "'merged B into A'
// is not enough to undo or explain a merge six months later." The table records
// which record each surviving value came from AND what the discarded value was
// -- so the screen that produces it has to make the discarded value visible
// before it is discarded. A confirmation dialog would satisfy the workflow and
// none of that.
//
// So every field with two different values gets a row with both of them, one
// radio each, and the unchosen one is on screen while the choice is made.
// Fields where the two records agree are collapsed behind a disclosure: they
// are not a decision, and eight rows of "these both say Brighton" is how a
// reviewer stops reading the two rows that matter.
//
// ===========================================================================
// RADIOS, NOT A SELECT, AND NOT A "USE ALL FROM THIS RECORD" TOGGLE
// ===========================================================================
// Two options that are both visible and both permanent is the case radios are
// for. A `<select>` hides one of the two values behind a click, which is the
// one thing this screen must not do. A "take everything from the left"
// shortcut was considered and left out: it makes the common mistake (accepting
// a default without reading) one click cheaper than the careful path.
//
// ===========================================================================
// THE DIRECTION IS A CHOICE, AND SWAPPING IT FLIPS THE FIELDS WITH IT
// ===========================================================================
// The queue proposes the OLDER record as the survivor, because the older one
// usually carries the history that points at it. It is a proposal: a record
// created last week and filled in properly is a better survivor than a
// three-year-old stub. Swapping the direction re-labels the columns and
// `mergeRecordsAction` flips every choice with it -- otherwise a user who
// swaps at the last moment silently inverts every field they picked.

export interface MergeFieldRow {
  /** The column name, or a custom field definition id. */
  readonly key: string;
  readonly label: string;
  /** Rendered values. Null means "not recorded". */
  readonly keepValue: string | null;
  readonly duplicateValue: string | null;
  readonly custom: boolean;
}

export interface MergeSideSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly href: string;
}

export function MergeForm({
  orgSlug,
  entityType,
  keep,
  duplicate,
  rows,
  candidateId,
  cancelHref,
}: {
  orgSlug: string;
  entityType: string;
  keep: MergeSideSummary;
  duplicate: MergeSideSummary;
  rows: readonly MergeFieldRow[];
  /** Null when the merge was started from a record rather than the queue. */
  candidateId: string | null;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(
    mergeRecordsAction,
    EMPTY_FORM_STATE,
  );
  const [survivor, setSurvivor] = useState<"keep" | "duplicate">("keep");
  const [showAgreed, setShowAgreed] = useState(false);

  const winner = survivor === "keep" ? keep : duplicate;
  const loser = survivor === "keep" ? duplicate : keep;

  const differing = rows.filter((row) => row.keepValue !== row.duplicateValue);
  const agreed = rows.filter((row) => row.keepValue === row.duplicateValue);

  return (
    <div className="flex flex-col gap-6">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <section className="border border-rule bg-surface p-5">
        <h2 className="text-xl font-bold text-ink">Which record survives?</h2>
        <p className="mt-2 max-w-prose text-base text-ink-muted">
          The other one is deleted and everything attached to it — links,
          representation, fee history, custom fields — moves across. Deleted, not
          erased: an Owner can restore it, and this merge is recorded with every
          value that was discarded.
        </p>
        {/* A radiogroup, and its accessible name is the heading above it. Two
            options, both always visible, so the choice cannot be made without
            seeing the other side of it. */}
        <fieldset className="mt-4">
          <legend className="sr-only">Which record survives</legend>
          <div className="flex flex-col gap-3 sm:flex-row">
            {(
              [
                ["keep", keep, "Created first"],
                ["duplicate", duplicate, "Created later"],
              ] as const
            ).map(([value, side, note]) => (
              <label
                key={value}
                className={`flex flex-1 cursor-pointer items-start gap-3 border p-4 ${
                  survivor === value
                    ? "border-l-[3px] border-rule border-l-accent bg-surface"
                    : "border-rule bg-shell"
                }`}
              >
                <input
                  type="radio"
                  name="survivor"
                  value={value}
                  checked={survivor === value}
                  onChange={() => setSurvivor(value)}
                  className="mt-1 accent-[var(--primary)]"
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="font-semibold break-words text-ink">
                    {side.name}
                  </span>
                  <span className="text-sm text-ink-muted">
                    {note} · {formatDate(side.createdAt)}
                  </span>
                  <Link
                    href={side.href}
                    className="text-sm text-primary underline underline-offset-4 hover:text-ink"
                  >
                    Open this record
                  </Link>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 max-w-prose text-base text-ink">
          <span className="font-semibold">{loser.name}</span> will be deleted and
          merged into <span className="font-semibold">{winner.name}</span>.
        </p>
      </section>

      <form action={formAction} className="flex flex-col gap-6">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="keepId" value={keep.id} />
        <input type="hidden" name="duplicateId" value={duplicate.id} />
        {/* The radio above lives outside this form so the summary sentence can
            react to it without a submit. Its value is carried in here. */}
        <input type="hidden" name="survivor" value={survivor} />

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-bold text-ink">
            {differing.length === 0
              ? "These records agree on every field"
              : `${differing.length} field${differing.length === 1 ? "" : "s"} to decide`}
          </h2>
          {differing.length === 0 ? (
            <p className="max-w-prose text-base text-ink-muted">
              Nothing will be lost from either side — every field either matches
              or is empty on one of them. The empty ones are filled in from
              whichever record has a value.
            </p>
          ) : (
            <p className="max-w-prose text-base text-ink-muted">
              Pick the value that survives. The one you don’t pick is recorded in
              the merge history, so it can be read back later even though it
              leaves the record.
            </p>
          )}

          {differing.length > 0 ? (
            <ul className="border-t border-rule">
              {differing.map((row) => (
                <FieldRow
                  key={row.key}
                  row={row}
                  survivor={survivor}
                  keepName={keep.name}
                  duplicateName={duplicate.name}
                />
              ))}
            </ul>
          ) : null}
        </section>

        {agreed.length > 0 ? (
          <section className="border border-rule bg-surface p-5">
            <button
              type="button"
              onClick={() => setShowAgreed((open) => !open)}
              aria-expanded={showAgreed}
              className="text-base font-semibold text-primary underline underline-offset-4 hover:text-ink"
            >
              {showAgreed ? "Hide" : "Show"} the {agreed.length} field
              {agreed.length === 1 ? "" : "s"} they agree on
            </button>
            {showAgreed ? (
              <ul className="mt-4 border-t border-rule">
                {agreed.map((row) => (
                  <li
                    key={row.key}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-3"
                  >
                    <span className="text-sm font-semibold text-ink">
                      {row.label}
                    </span>
                    <span className="min-w-0 break-words text-base text-ink-muted">
                      {row.keepValue ?? "Not recorded on either"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" variant="danger" pending={pending} pendingLabel="Merging…">
            Merge into {winner.name}
          </Button>
          <Link
            href={cancelHref}
            className="text-base text-primary underline underline-offset-4 hover:text-ink"
          >
            Cancel
          </Link>
        </div>
      </form>

      {candidateId ? <DismissForm orgSlug={orgSlug} candidateId={candidateId} /> : null}
    </div>
  );
}

function FieldRow({
  row,
  survivor,
  keepName,
  duplicateName,
}: {
  row: MergeFieldRow;
  survivor: "keep" | "duplicate";
  keepName: string;
  duplicateName: string;
}) {
  const name = `${row.custom ? "custom_" : "choice_"}${row.key}`;
  // THE DEFAULT IS THE SURVIVOR'S OWN VALUE, UNLESS IT HAS NONE. Same rule as
  // public.merge_records() applies when a choice is absent, written here too so
  // the screen shows what the database would do rather than a different default
  // that then changes on submit.
  const survivorValue = survivor === "keep" ? row.keepValue : row.duplicateValue;
  const fallbackSide = survivor === "keep" ? "duplicate" : "keep";
  const defaultSide = survivorValue === null ? fallbackSide : survivor;

  return (
    <li className="border-b border-rule py-4">
      <fieldset>
        <legend className="text-sm font-semibold text-ink">{row.label}</legend>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
          <Choice
            name={name}
            value="keep"
            defaultChecked={defaultSide === "keep"}
            recordName={keepName}
            text={row.keepValue}
          />
          <Choice
            name={name}
            value="duplicate"
            defaultChecked={defaultSide === "duplicate"}
            recordName={duplicateName}
            text={row.duplicateValue}
          />
        </div>
      </fieldset>
    </li>
  );
}

function Choice({
  name,
  value,
  defaultChecked,
  recordName,
  text,
}: {
  name: string;
  value: "keep" | "duplicate";
  defaultChecked: boolean;
  recordName: string;
  text: string | null;
}) {
  return (
    <label className="flex flex-1 cursor-pointer items-start gap-2 border border-rule bg-surface p-3">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1 accent-[var(--primary)]"
      />
      <span className="flex min-w-0 flex-col gap-1">
        {/* THE VALUE IS RENDERED AS TEXT AND NEVER LINKIFIED. `website` and
            `socials` are unvalidated user content out of somebody else's
            record; the record's own page renders them through safeHref(), and
            this screen is asking which string survives, which a rendered link
            answers less well and more dangerously. */}
        <span className="break-words text-base text-ink">
          {text ?? <span className="text-ink-muted">Not recorded</span>}
        </span>
        <span className="text-xs text-ink-muted">from {recordName}</span>
      </span>
    </label>
  );
}

/**
 * "These are two different people."
 *
 * A separate form, below the merge, and deliberately not a second button
 * inside it: one form with two submit buttons makes Enter in a text field pick
 * whichever button the browser happens to consider first, and the two
 * outcomes here are "destroy a record" and "leave both alone".
 */
function DismissForm({
  orgSlug,
  candidateId,
}: {
  orgSlug: string;
  candidateId: string;
}) {
  const [state, formAction, pending] = useActionState(
    dismissCandidateAction,
    EMPTY_FORM_STATE,
  );
  return (
    <section className="border border-rule bg-surface p-5">
      <h2 className="text-xl font-bold text-ink">Not a duplicate?</h2>
      <p className="mt-2 max-w-prose text-base text-ink-muted">
        Take this pair off the review queue and leave both records alone. The
        two won’t be flagged together again.
      </p>
      {state.error ? (
        <div className="mt-3">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}
      {state.message ? (
        <div className="mt-3">
          <Alert tone="success">{state.message}</Alert>
        </div>
      ) : null}
      <form action={formAction} className="mt-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="candidateId" value={candidateId} />
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Dismissing…">
          These are different records
        </Button>
      </form>
    </section>
  );
}

/** en-GB and Europe/London explicitly -- CLAUDE.md § Non-functional targets. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}
