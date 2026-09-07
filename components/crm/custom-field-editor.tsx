"use client";

import { useActionState, useId } from "react";
import {
  createCustomFieldAction,
  deleteCustomFieldAction,
  restoreCustomFieldAction,
  updateCustomFieldAction,
} from "@/lib/crm/custom-field-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import {
  CUSTOM_FIELD_TYPES,
  ENTITY_TYPE_LABELS,
  FIELD_TYPE_LABELS,
  formatOptionsInput,
  isSelectType,
  MAX_CUSTOM_FIELD_LABEL,
  MAX_CUSTOM_FIELD_OPTIONS,
  type CustomFieldDefinition,
  type CustomFieldEntityType,
} from "@/lib/crm/custom-fields";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The definition editor: what fields exist on one entity type, and the four
// writes that change that.
//
// ===========================================================================
// EVERY LIFECYCLE CONTROL IS HERE, AND NONE OF THEM IS A ROUTE
// ===========================================================================
// A definition is a name, a type and (sometimes) a list of choices. Five
// routes for that is ceremony, so add / edit / remove / restore all live on
// this one screen -- the same call RoomPanel makes for `venue_rooms`, and for
// the same reason.
//
// The edit form is inside a `<details>`/`<summary>`. That is a real disclosure
// widget with the correct role, keyboard model and screen-reader announcement
// in every browser, it needs no JavaScript, and it costs no state -- where a
// hand-rolled "editing this row" toggle would need `useState` per row and its
// own focus management.
//
// ===========================================================================
// THE OPTIONS BOX IS ALWAYS RENDERED, NEVER CONDITIONALLY HIDDEN
// ===========================================================================
// Showing it only for the two select types would need the type dropdown to
// drive it, which means client state and a form that stops working with
// JavaScript disabled -- and every other form in this application deliberately
// still works without it. So it is always present, inside its own disclosure,
// labelled with the two types it applies to, and the server ignores it for the
// other five.
//
// ===========================================================================
// "REMOVE", NOT "DELETE", AND THE COPY SAYS WHY
// ===========================================================================
// The column is `deleted_at` and the operation is a soft delete, but a control
// labelled "Delete" would promise the values are gone -- and they are not, and
// must not be. `custom_field_values_definition_fkey` is ON DELETE CASCADE,
// which is exactly why this table has no DELETE grant at all: a hard delete
// would take every stored value with it. Removing takes the field off the
// forms and leaves what was filled in visible on each record under "Removed
// fields".

export interface CustomFieldEditorProps {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  live: readonly CustomFieldDefinition[];
  removed: readonly CustomFieldDefinition[];
  /** null means unlimited (Pro, or an organisation with no plan row yet). */
  limit: number | null;
  /** Non-null means read-only, and this is the sentence saying why. */
  disabledReason: string | null;
}

export function CustomFieldEditor({
  orgSlug,
  entityType,
  live,
  removed,
  limit,
  disabledReason,
}: CustomFieldEditorProps) {
  const editable = disabledReason === null;
  const atLimit = limit !== null && live.length >= limit;
  const plural = ENTITY_TYPE_LABELS[entityType].toLowerCase();

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-base text-ink-muted">
        {/* A LIMIT OF ZERO IS FREE'S REAL LIMIT, not an absent one, and it
            needs its own sentence: "0 of 0 fields used" is arithmetically
            true and reads as a bug. A Free workspace may still HOLD fields
            from when it was paid -- a downgrade never deletes -- so the count
            is still shown, and the list below still renders them. */}
        {limit === 0 ? (
          <>
            Your plan doesn’t include custom fields.{" "}
            {live.length > 0 ? (
              <>
                The{" "}
                <span className="tabular-nums">{live.length}</span> already on{" "}
                {plural} are kept and still filled in on your records; an Owner
                can upgrade the workspace to add or change them.
              </>
            ) : (
              "An Owner can upgrade the workspace to add some."
            )}
          </>
        ) : limit === null ? (
          <>
            <span className="tabular-nums">{live.length}</span>{" "}
            {live.length === 1 ? "field" : "fields"} on {plural}. Your plan
            doesn’t limit how many.
          </>
        ) : (
          <>
            <span className="tabular-nums">{live.length}</span> of{" "}
            <span className="tabular-nums">{limit}</span> fields used on {plural}
            .{" "}
            {atLimit
              ? "Remove one to add another, or ask an Owner to upgrade the workspace."
              : "Removing a field frees its slot; what was filled in is kept."}
          </>
        )}
      </p>

      {live.length === 0 ? (
        <p className="max-w-prose text-base text-ink-muted">
          No custom fields on {plural} yet. Add one and it appears on every{" "}
          {entityType} record in this workspace.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {live.map((definition) => (
            <li
              key={definition.id}
              className="flex flex-col gap-2 border-b border-rule py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold break-words text-ink">
                    {definition.label}
                  </span>
                  <span
                    translate="no"
                    className="text-sm break-all text-ink-muted"
                  >
                    {definition.key}
                  </span>
                  <span className="border border-rule px-2 py-0.5 text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
                    {FIELD_TYPE_LABELS[definition.fieldType]}
                  </span>
                </span>
                {editable ? (
                  <RemoveField
                    orgSlug={orgSlug}
                    entityType={entityType}
                    definition={definition}
                  />
                ) : null}
              </div>
              {isSelectType(definition.fieldType) ? (
                <p className="text-sm text-ink-muted">
                  Choices:{" "}
                  {definition.options.map((option) => option.label).join(", ")}
                </p>
              ) : null}
              {editable ? (
                <EditField
                  orgSlug={orgSlug}
                  entityType={entityType}
                  definition={definition}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <AddField
          orgSlug={orgSlug}
          entityType={entityType}
          atLimit={atLimit}
          limit={limit}
        />
      ) : (
        <p className="max-w-prose text-sm text-ink-muted">{disabledReason}</p>
      )}

      {removed.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Removed fields</h2>
          <p className="max-w-prose text-sm text-ink-muted">
            Off the forms, not deleted. Everything already filled in is kept and
            shown on each record, and restoring a field brings it back with
            those values attached. The name stays reserved, so restoring can
            never collide with a new field.
          </p>
          <ul className="flex flex-col border-t border-rule">
            {removed.map((definition) => (
              <li
                key={definition.id}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-3"
              >
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold break-words text-ink-muted">
                    {definition.label}
                  </span>
                  <span translate="no" className="text-sm break-all text-ink-muted">
                    {definition.key}
                  </span>
                </span>
                {editable ? (
                  <RestoreField
                    orgSlug={orgSlug}
                    entityType={entityType}
                    definition={definition}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The type dropdown and the choices box, shared by the add and edit forms. */
function TypeAndOptions({
  fieldType,
  options,
  typeError,
  optionsError,
}: {
  fieldType: string;
  options: string;
  typeError?: string;
  optionsError?: string;
}) {
  // I-12 / L858. The error used to sit INSIDE the <label>, which makes it part
  // of the select's accessible name -- so the control announces as "Kind of
  // field Choose a kind of field, combo box" and there is no separately
  // announced error at all. The pattern here is the one components/ui/field.tsx
  // implements: a bound <label>, the error BELOW the control in its own <p>,
  // referenced by aria-describedby and carrying role="alert".
  const typeId = useId();
  const typeErrorId = `${typeId}-error`;

  return (
    <>
      <div className="flex flex-col gap-2">
        <label htmlFor={typeId} className="text-sm font-semibold text-ink">
          Kind of field
        </label>
        <select
          id={typeId}
          name="fieldType"
          defaultValue={fieldType}
          aria-invalid={typeError ? true : undefined}
          aria-describedby={typeError ? typeErrorId : undefined}
          className={
            "h-11 w-full min-w-0 border bg-surface px-3 text-base font-normal text-ink " +
            (typeError
              ? "border-danger"
              : "border-rule hover:border-ink focus:border-accent")
          }
        >
          {CUSTOM_FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {FIELD_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        {typeError ? (
          <p
            id={typeErrorId}
            role="alert"
            className="text-sm font-semibold text-danger"
          >
            {typeError}
          </p>
        ) : null}
      </div>

      <details className="border border-rule px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          Choices — for “Choose one” and “Choose several” only
        </summary>
        <div className="pt-3">
          <TextAreaField
            label="One per line"
            name="options"
            defaultValue={options}
            rows={5}
            hint={
              <>
                Write <code>name = What people see</code> on each line — for
                example <code>guest_list = Guest list</code>. The name on the
                left is what gets stored, so you can reword the right-hand side
                later without losing anything. Up to {MAX_CUSTOM_FIELD_OPTIONS}{" "}
                choices. Ignored for the other kinds of field.
              </>
            }
            error={optionsError}
          />
        </div>
      </details>
    </>
  );
}

function AddField({
  orgSlug,
  entityType,
  atLimit,
  limit,
}: {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  atLimit: boolean;
  limit: number | null;
}) {
  const [state, formAction, pending] = useActionState(
    createCustomFieldAction,
    EMPTY_FORM_STATE,
  );

  // AT THE LIMIT, THE FORM IS NOT RENDERED AT ALL, and the sentence takes its
  // place -- the same call RoomPanel makes for a blocked panel. It is NOT the
  // enforcement: the trigger in 20260829010500 refuses a direct POST, and the
  // Server Action re-measures and says the same thing. This is only the part
  // that stops somebody filling a form in for nothing.
  if (atLimit && limit !== null) {
    return (
      <div className="flex flex-col gap-2 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Add a field</h2>
        <p className="max-w-prose text-base text-ink-muted">
          All <span className="tabular-nums">{limit}</span> of this plan’s
          custom fields for this record type are in use. Remove one above to
          free a slot — anything already filled in is kept — or ask an Owner to
          upgrade the workspace.
        </p>
      </div>
    );
  }

  return (
    <details className="border-t border-rule pt-6">
      <summary className="cursor-pointer text-xl font-bold text-ink">
        Add a field
      </summary>
      <form action={formAction} className="flex flex-col gap-6 pt-4" noValidate>
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.message ? <Alert tone="success">{state.message}</Alert> : null}

        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="entityType" value={entityType} />

        <Field
          label="Label"
          name="label"
          defaultValue={state.values?.label ?? ""}
          autoComplete="off"
          required
          maxLength={MAX_CUSTOM_FIELD_LABEL}
          hint="What people read on the record. You can change this later."
          error={state.fieldErrors?.label}
        />

        <Field
          label="Name"
          name="key"
          defaultValue={state.values?.key ?? ""}
          autoComplete="off"
          required
          maxLength={63}
          hint="Lowercase letters, numbers and underscores — for example contact_ref. This is the field’s permanent name and can’t be changed afterwards; to correct one, remove the field and add it again."
          error={state.fieldErrors?.key}
        />

        <TypeAndOptions
          fieldType={state.values?.fieldType ?? "text"}
          options={state.values?.options ?? ""}
          typeError={state.fieldErrors?.fieldType}
          optionsError={state.fieldErrors?.options}
        />

        <div>
          <Button type="submit" pending={pending} pendingLabel="Adding…">
            Add field
          </Button>
        </div>
      </form>
    </details>
  );
}

function EditField({
  orgSlug,
  entityType,
  definition,
}: {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  definition: CustomFieldDefinition;
}) {
  const [state, formAction, pending] = useActionState(
    updateCustomFieldAction,
    EMPTY_FORM_STATE,
  );

  return (
    <details>
      {/* sr-only name (keyboard-a11y pass): one Edit disclosure PER
          definition, so without the field's name a screen reader's controls
          list reads "Edit, Edit, Edit…" — the same fix room-panel.tsx and
          representation-panel.tsx already carry. */}
      <summary className="cursor-pointer text-sm text-primary underline underline-offset-4">
        Edit
        <span className="sr-only"> {definition.label}</span>
      </summary>
      <form action={formAction} className="flex flex-col gap-4 pt-3" noValidate>
        {state.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state.message ? <Alert tone="success">{state.message}</Alert> : null}

        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="fieldId" value={definition.id} />

        <Field
          label="Label"
          name="label"
          defaultValue={state.values?.label ?? definition.label}
          autoComplete="off"
          required
          maxLength={MAX_CUSTOM_FIELD_LABEL}
          error={state.fieldErrors?.label}
        />

        <TypeAndOptions
          fieldType={state.values?.fieldType ?? definition.fieldType}
          options={state.values?.options ?? formatOptionsInput(definition.options)}
          typeError={state.fieldErrors?.fieldType}
          optionsError={state.fieldErrors?.options}
        />

        <p className="max-w-prose text-sm text-ink-muted">
          Changing the kind of field, or removing a choice, leaves anything
          already filled in exactly as it is. Values that no longer match are
          shown on each record marked “needs fixing”, with what is stored, so
          they can be re-entered rather than guessed at.
        </p>

        <div>
          <Button
            type="submit"
            variant="secondary"
            pending={pending}
            pendingLabel="Saving…"
          >
            Save changes
          </Button>
        </div>
      </form>
    </details>
  );
}

function RemoveField({
  orgSlug,
  entityType,
  definition,
}: {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  definition: CustomFieldDefinition;
}) {
  const [state, formAction, pending] = useActionState(
    deleteCustomFieldAction,
    EMPTY_FORM_STATE,
  );
  // I-12 / L859. This wrapper was a <span>, and a <span> cannot legally
  // contain a <form>: phrasing content cannot contain flow content. Both
  // parents are already flex <div>/<li> containers, so a <div> is a drop-in
  // and the layout is unchanged. The two messages become <p role="alert"> and
  // <p role="status">, matching components/ui/field.tsx.
  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="fieldId" value={definition.id} />
        <Button
          type="submit"
          variant="danger"
          pending={pending}
          pendingLabel="Removing…"
        >
          Remove
          <span className="sr-only"> {definition.label}</span>
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="max-w-prose text-sm font-semibold text-danger">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="max-w-prose text-sm text-ink-muted">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function RestoreField({
  orgSlug,
  entityType,
  definition,
}: {
  orgSlug: string;
  entityType: CustomFieldEntityType;
  definition: CustomFieldDefinition;
}) {
  const [state, formAction, pending] = useActionState(
    restoreCustomFieldAction,
    EMPTY_FORM_STATE,
  );
  // I-12 / L859. This wrapper was a <span>, and a <span> cannot legally
  // contain a <form>: phrasing content cannot contain flow content. Both
  // parents are already flex <div>/<li> containers, so a <div> is a drop-in
  // and the layout is unchanged. The two messages become <p role="alert"> and
  // <p role="status">, matching components/ui/field.tsx.
  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="fieldId" value={definition.id} />
        <Button
          type="submit"
          variant="secondary"
          pending={pending}
          pendingLabel="Restoring…"
        >
          Restore
          <span className="sr-only"> {definition.label}</span>
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="max-w-prose text-sm font-semibold text-danger">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="max-w-prose text-sm text-ink-muted">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
