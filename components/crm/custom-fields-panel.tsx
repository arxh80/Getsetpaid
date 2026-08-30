"use client";

import { useActionState, useId } from "react";
import { saveCustomFieldValuesAction } from "@/lib/crm/custom-field-actions";
import {
  EMPTY_FORM_STATE,
  groupMarkerName,
  selectedInGroup,
  type FormState,
} from "@/lib/forms";
import {
  customFieldInputName,
  ENTITY_TYPE_LABELS,
  type CustomFieldCell,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The custom field VALUES on one entity row, on that row's own detail page.
//
// ===========================================================================
// A PANEL, NOT FIVE EDITS TO FIVE ENTITY FORMS
// ===========================================================================
// Custom field values live in their own table, with their own policies and
// their own permission derivation, and they apply to all five entity types
// identically. Threading them through contact-form.tsx, company-form.tsx,
// agency-form.tsx, artist-form.tsx and venue-form.tsx would mean five copies
// of the same rendering and five entity actions each learning to write a
// second table -- and every one of those five actions has already been through
// a review and two fix rounds. One panel, one action, five detail pages
// mounting it, is the shape RoomPanel and LinkPanel already establish.
//
// ===========================================================================
// THREE STATES PER VALUE, AND THE THIRD IS THE ONE THAT MATTERS
// ===========================================================================
// lib/crm/custom-fields.ts's describeCustomFieldValue() classifies every
// stored value as empty / valid / invalid, and "invalid" is a state that WILL
// occur rather than a defensive branch: changing a field's type, or removing a
// choice that stored values still name, produces it, and so does any direct
// PostgREST write with the anon key.
//
// An invalid value renders as an EMPTY input plus the stored text beside it
// and a sentence saying what to do. Nothing crashes, nothing is silently
// rewritten, and the user can see exactly what they are replacing. Saving the
// form with the input still empty CLEARS it -- which is why the stored value
// is shown rather than hidden: it is the only warning, and it is visible
// before the save rather than after.
//
// ===========================================================================
// READ-ONLY IS A DIFFERENT RENDER, NOT A DISABLED ONE
// ===========================================================================
// When `disabledReason` is set -- a read_only role, a suspended workspace, a
// Free tier, or a soft-deleted record -- this renders the VALUES AS TEXT with
// the reason underneath, and no controls at all. Offering a button whose
// action is guaranteed to refuse is worse than not offering it (RoomPanel's
// header makes the same call).
//
// AND THE VALUES ARE STILL THERE. "The empty state must not lie": a read_only
// user in a workspace with forty custom fields must not be told there are
// none, so the read-only render lists every field, filled or not, exactly as
// the editable one does.

export interface CustomFieldsPanelProps {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  entityId: string;
  live: readonly CustomFieldCell[];
  removed: readonly CustomFieldCell[];
  /** Non-null means read-only, and this is the sentence saying why. */
  disabledReason: string | null;
}

export function CustomFieldsPanel({
  orgSlug,
  entityType,
  entityId,
  live,
  removed,
  disabledReason,
}: CustomFieldsPanelProps) {
  const [state, formAction, pending] = useActionState(
    saveCustomFieldValuesAction,
    EMPTY_FORM_STATE,
  );
  const editable = disabledReason === null;

  if (live.length === 0 && removed.length === 0) {
    return (
      <section className="flex flex-col gap-3 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Custom fields</h2>
        <p className="max-w-prose text-base text-ink-muted">
          None yet. An Owner or Admin can add fields for{" "}
          {ENTITY_TYPE_LABELS[entityType].toLowerCase()} under Settings › Custom
          fields, and they appear here on every record.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 border-t border-rule pt-6">
      <h2 className="text-xl font-bold text-ink">Custom fields</h2>

      {editable ? (
        <form action={formAction} className="flex flex-col gap-6" noValidate>
          {state.error ? <Alert tone="error">{state.error}</Alert> : null}
          {state.message ? <Alert tone="success">{state.message}</Alert> : null}

          {/* The organisation travels as a SLUG and is re-resolved server-side
              through getCurrentOrg(), which is RLS-gated. It is not an
              organisation id and it is not trusted -- CLAUDE.md § Tenancy
              model. */}
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="entityType" value={entityType} />
          <input type="hidden" name="entityId" value={entityId} />

          {live.map((cell) => (
            <CustomFieldControl key={cell.definition.id} cell={cell} state={state} />
          ))}

          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" pending={pending} pendingLabel="Saving…">
              Save custom fields
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {live.map((cell) => (
              <ReadOnlyValue key={cell.definition.id} cell={cell} />
            ))}
          </dl>
          <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
        </>
      )}

      {removed.length > 0 ? <RemovedValues removed={removed} /> : null}
    </section>
  );
}

/**
 * One field's control, chosen by its type.
 *
 * EVERY CONTROL IS UNCONTROLLED and pre-filled from `defaultValue`, so the
 * form works with JavaScript disabled -- a Server Action bound to a
 * `<form action>` submits as an ordinary POST. React 19 RESETS the form once
 * the action resolves, which for an uncontrolled form means every input goes
 * back to its `defaultValue`; the action echoes what it was given
 * (FormState.values) and the `??` below is what makes the reset restore what
 * was typed rather than what was stored.
 */
function CustomFieldControl({
  cell,
  state,
}: {
  cell: CustomFieldCell;
  state: FormState;
}) {
  const definition = cell.definition;
  const name = customFieldInputName(definition.id);
  const error = state.fieldErrors?.[name];
  // The echo wins when there is one: it is newer than the record the page
  // loaded with.
  const shown = state.values?.[name] ?? cell.inputValue;
  const hint = cell.state === "invalid" ? <NeedsFixing cell={cell} /> : undefined;

  switch (definition.fieldType) {
    case "text":
      return (
        <Field
          label={definition.label}
          name={name}
          defaultValue={shown}
          autoComplete="off"
          maxLength={500}
          hint={hint}
          error={error}
        />
      );

    case "number":
      return (
        <Field
          label={definition.label}
          name={name}
          defaultValue={shown}
          autoComplete="off"
          // `type="text"` with a numeric keypad, NOT `type="number"`. A number
          // input in several browsers reports an empty value for input it
          // considers invalid, so a mistyped "12x" would be echoed back as ""
          // -- which is exactly the work-destroying reset FormState.values
          // exists to prevent. The validator in lib/crm/custom-fields.ts is
          // strict either way.
          inputMode="decimal"
          hint={hint}
          error={error}
        />
      );

    case "date":
      return (
        <Field
          label={definition.label}
          name={name}
          type="date"
          defaultValue={shown}
          hint={hint}
          error={error}
        />
      );

    case "url":
      return (
        <Field
          label={definition.label}
          name={name}
          type="url"
          defaultValue={shown}
          autoComplete="off"
          inputMode="url"
          hint={hint}
          error={error}
        />
      );

    case "boolean":
      return <BooleanControl cell={cell} state={state} />;

    case "single_select":
      return <SingleSelectControl cell={cell} state={state} />;

    case "multi_select":
      return <MultiSelectControl cell={cell} state={state} />;
  }
}

/** The sentence and the stored text an unusable value carries. */
function NeedsFixing({ cell }: { cell: CustomFieldCell }) {
  return (
    <>
      <span className="font-semibold text-warning">Needs fixing.</span>{" "}
      {cell.problem} What is stored now:{" "}
      {/* NEVER LINKIFIED AND NEVER PARSED. The raw stored jsonb, rendered as
          text by React's own escaping -- the same treatment a social handle
          gets on the detail pages. */}
      <span translate="no" className="break-all font-semibold text-ink">
        {cell.rawText}
      </span>
    </>
  );
}

function BooleanControl({ cell, state }: { cell: CustomFieldCell; state: FormState }) {
  const definition = cell.definition;
  const name = customFieldInputName(definition.id);
  const id = useId();
  const hintId = `${id}-hint`;
  // A GROUP OF ONE IS STILL A GROUP. An unticked checkbox submits nothing, so
  // without the marker an emptied box is indistinguishable from a form that
  // never had it -- and a failed submit would re-tick what the user just
  // cleared. Same defect as the company form's I-2, narrower.
  const ticked = selectedInGroup(
    state.values,
    name,
    cell.inputChecked ? ["true"] : [],
  ).includes("true");

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={groupMarkerName(name)} value="1" />
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={ticked}
          aria-describedby={cell.state === "invalid" ? hintId : undefined}
          className="size-5 border border-rule accent-primary"
        />
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {definition.label}
        </label>
      </div>
      {cell.state === "invalid" ? (
        <p id={hintId} className="text-sm text-ink-muted">
          <NeedsFixing cell={cell} />
        </p>
      ) : null}
    </div>
  );
}

function SingleSelectControl({
  cell,
  state,
}: {
  cell: CustomFieldCell;
  state: FormState;
}) {
  const definition = cell.definition;
  const name = customFieldInputName(definition.id);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const error = state.fieldErrors?.[name];
  const shown = state.values?.[name] ?? cell.inputValue;
  const describedBy =
    [cell.state === "invalid" ? hintId : null, error ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {definition.label}
        <span className="ml-2 font-normal text-ink-muted">Optional</span>
      </label>
      {cell.state === "invalid" ? (
        <p id={hintId} className="text-sm text-ink-muted">
          <NeedsFixing cell={cell} />
        </p>
      ) : null}
      <select
        id={id}
        name={name}
        defaultValue={shown}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={
          "h-11 w-full min-w-0 border bg-surface px-3 text-base text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (error ? "border-danger" : "border-rule hover:border-ink focus:border-accent")
        }
      >
        {/* A REAL EMPTY OPTION, so "not answered" is expressible. Without it
            the first choice is selected by default and every record silently
            acquires an answer nobody gave. */}
        <option value="">Not set</option>
        {definition.options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MultiSelectControl({
  cell,
  state,
}: {
  cell: CustomFieldCell;
  state: FormState;
}) {
  const definition = cell.definition;
  const name = customFieldInputName(definition.id);
  const id = useId();
  const error = state.fieldErrors?.[name];
  const ticked = selectedInGroup(state.values, name, cell.inputKeys);
  // I-12 / L858. The error <p> below carried an id and NOTHING REFERENCED IT,
  // so a screen-reader user was never told why the group was refused -- and
  // axe cannot see that, because an unreferenced paragraph is valid markup.
  // There is no single control to describe here, so every checkbox in the
  // group points at it: whichever one the user lands on, the error is read.
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : undefined;

  return (
    <fieldset className="flex flex-col gap-2 border-0 p-0">
      {/* A <legend> rather than a <label>: a group of checkboxes has no single
          control for a label to point at, and a screen reader announces the
          legend with each box in the group. */}
      <legend className="text-sm font-semibold text-ink">
        {definition.label}
        <span className="ml-2 font-normal text-ink-muted">Optional</span>
      </legend>
      {cell.state === "invalid" ? (
        <p className="text-sm text-ink-muted">
          <NeedsFixing cell={cell} />
        </p>
      ) : null}
      <input type="hidden" name={groupMarkerName(name)} value="1" />
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {definition.options.map((option) => (
          <label
            key={option.key}
            className="flex items-center gap-2 text-base text-ink"
          >
            <input
              type="checkbox"
              name={name}
              value={option.key}
              defaultChecked={ticked.includes(option.key)}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className="size-5 border border-rule accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** One field, rendered as text. Used for every read-only case. */
function ReadOnlyValue({ cell }: { cell: CustomFieldCell }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
        {cell.definition.label}
      </dt>
      <dd className="text-base break-words text-ink">
        <ValueText cell={cell} />
      </dd>
    </div>
  );
}

/**
 * A value as text.
 *
 * THE `url` BRANCH IS THE RENDER-SIDE HALF OF THE PROTOCOL RULE. `cell.href`
 * is `safeHref()`'s answer and never the raw column: a stored `javascript:` --
 * from an import, a merge, or a direct PostgREST call that never met
 * `normaliseWebsite()` -- arrives with `href === null` and is rendered as
 * inert text, so the user can see and fix it. Identical to what the venue and
 * company detail pages already do for `website`.
 */
function ValueText({ cell }: { cell: CustomFieldCell }) {
  if (cell.state === "empty") {
    return (
      <span className="text-ink-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not recorded</span>
      </span>
    );
  }
  if (cell.state === "invalid") {
    return (
      <span className="flex flex-col gap-1">
        <span translate="no" className="break-all text-ink">
          {cell.rawText}
        </span>
        <span className="text-sm text-ink-muted">
          <span className="font-semibold text-warning">Needs fixing.</span>{" "}
          {cell.problem}
        </span>
      </span>
    );
  }
  if (cell.definition.fieldType === "url") {
    return cell.href ? (
      <a
        href={cell.href}
        rel="noopener noreferrer nofollow"
        target="_blank"
        className="break-all text-primary underline underline-offset-4 hover:text-ink"
      >
        {cell.display}
      </a>
    ) : (
      <span translate="no" className="break-all">
        {cell.display}
      </span>
    );
  }
  if (cell.definition.fieldType === "number") {
    // DESIGN.md § Numerals: tabular figures on every number.
    return <span className="tabular-nums">{cell.display}</span>;
  }
  return <span>{cell.display}</span>;
}

/**
 * Values whose field has been removed.
 *
 * THIS BLOCK IS WHAT MAKES "THE VALUES SURVIVE A REMOVAL" A TRUE STATEMENT.
 * Removing a definition is a soft delete (20260829010000) precisely so the
 * cascade never fires, and rows nobody can reach would make that a technicality
 * rather than a feature. Read-only for everyone, including an Owner: the way
 * to edit one again is to restore its field.
 */
function RemovedValues({ removed }: { removed: readonly CustomFieldCell[] }) {
  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-4">
      <h3 className="text-base font-bold text-ink">Removed fields</h3>
      <p className="max-w-prose text-sm text-ink-muted">
        These fields were taken off the form. What was already filled in is kept
        and shown here; restoring the field in Settings › Custom fields brings
        it back, with these values still attached.
      </p>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {removed.map((cell) => (
          <ReadOnlyValue key={cell.definition.id} cell={cell} />
        ))}
      </dl>
    </div>
  );
}
