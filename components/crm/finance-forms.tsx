"use client";

import { useActionState } from "react";
import {
  createFinancialEntryAction,
  updateFinancialEntryAction,
  deleteFinancialEntryAction,
  restoreFinancialEntryAction,
} from "@/lib/crm/finance";
import {
  FINANCE_CATEGORIES,
  FINANCE_STATUSES,
  FINANCE_CATEGORY_LABELS,
  FINANCE_STATUS_LABELS,
} from "@/lib/crm/finance-category";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The client forms of the finance panel. THE ONLY CLIENT CODE IN THAT SURFACE.
//
// ===========================================================================
// WHY THIS IS A SECOND FILE -- THE SAME DEFECT `lib/crm/lineup-forms.tsx` FOUND
// ===========================================================================
// components/crm/finance-panel.tsx renders `components/list/list-pager.tsx`
// (through the shared list surface), and that file's `encodeCursor` is
// `Buffer.from(...).toString("base64url")` -- an encoding the browser's Buffer
// polyfill does not know. Put the panel behind `"use client"` and it throws
// `Unknown encoding: base64url` during hydration and takes the whole client
// tree with it. So the panel is a SERVER component and this file holds the
// forms; only `useActionState` needs a client. Identical division to the
// lineup panel, whose forms file states the full measurement.
//
// ===========================================================================
// EVERY `<select>` CARRIES A `key`, AND IT IS LOAD-BEARING
// ===========================================================================
// React does not sync a `<select>`'s default (an `<option>`'s `selected`
// attribute) on re-render the way it syncs a text input's `defaultValue`. After
// a refused Server Action, React 19 resets the form, and a select with no `key`
// snaps back to the option the page first mounted with -- so a retry SAVES a
// value the user never chose. The `key` forces a remount with the echoed
// option. `category`, `status`, `artistId` and `supplierContactId` all carry
// it, the same mechanism lineup-forms.tsx documents.
//
// ===========================================================================
// THE PICKERS APPEND THEIR STORED VALUE -- lib/crm/event-picker.ts's DEFECT
// ===========================================================================
// A `<select>` that does not contain the value the record holds silently
// submits a DIFFERENT one. The artist and supplier pickers are bounded at 100
// live records (loadArtistsForPicker / loadLinkOptions), and a line may link an
// artist that is deleted or past that cap. So the EDIT form appends the stored
// id as its own option when the picker does not already list it -- marked, and
// selected -- so a save preserves the link rather than nulling or changing it.
// The ADD form holds no stored value and needs none of this.

/** Mirrors lib/crm/finance.ts's MAX_DESCRIPTION. The server is the enforcement;
 *  this is the browser hint, and a literal here would let the browser truncate
 *  at a length the server no longer checks. */
const MAX_DESCRIPTION = 200;

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

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-semibold text-danger">
      {message}
    </p>
  );
}

/** One id the picker must contain even when the live-records query did not
 *  return it -- the stored link on an edit form. */
export interface PickerOption {
  id: string;
  name: string;
}

/** The seven editable fields, as the form shows them. */
export interface FinanceFieldValues {
  category: string;
  status: string;
  /** Pounds as a human types them: "1234.56", "£500", "1,234.5". */
  amount: string;
  /** A `YYYY-MM-DD` calendar date, what a `<input type="date">` speaks. */
  occurredOn: string;
  description: string;
  artistId: string;
  supplierContactId: string;
}

/** Append `stored` to `options` unless it is already there, so an edit form's
 *  select always contains the value the record holds. */
function withStored(
  options: readonly PickerOption[],
  stored: PickerOption | null,
): readonly PickerOption[] {
  if (stored === null) return options;
  if (options.some((option) => option.id === stored.id)) return options;
  return [{ id: stored.id, name: `${stored.name} (not in list)` }, ...options];
}

function FinanceHiddenIds({
  orgSlug,
  eventId,
  entryId,
}: {
  orgSlug: string;
  eventId: string;
  entryId?: string;
}) {
  return (
    <>
      {/* A SLUG, re-resolved server-side through the RLS-gated getCurrentOrg().
          Never an organisation id -- CLAUDE.md § Tenancy model. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="eventId" value={eventId} />
      {entryId ? <input type="hidden" name="entryId" value={entryId} /> : null}
    </>
  );
}

/**
 * The seven fields, rendered identically by the add and edit forms.
 *
 * THE ECHOES ARE READ BY THE CALLER and passed in, rather than read from
 * `state` here -- the same reason lineup-forms.tsx routes them through the
 * caller: a single `state.values?.` in this file would leave a field added
 * without an echo invisible to the census in tests/unit/crm/source-shape.test.ts.
 */
function FinanceFields({
  idPrefix,
  state,
  values,
  artistOptions,
  supplierOptions,
  disabled,
  noteId,
}: {
  idPrefix: string;
  state: FormState;
  values: FinanceFieldValues;
  artistOptions: readonly PickerOption[];
  supplierOptions: readonly PickerOption[];
  disabled: boolean;
  noteId: string;
}) {
  const describe = (field: string, errorId: string) =>
    state.fieldErrors?.[field] ? errorId : disabled ? noteId : undefined;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-category`} className={FIELD_LABEL}>
          Category
        </label>
        <select
          key={`category:${values.category}`}
          id={`${idPrefix}-category`}
          name="category"
          disabled={disabled}
          defaultValue={values.category}
          aria-describedby={describe("category", `${idPrefix}-category-error`)}
          aria-invalid={state.fieldErrors?.category ? true : undefined}
          className={inputClass(Boolean(state.fieldErrors?.category))}
        >
          {FINANCE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {FINANCE_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
        <FieldError
          id={`${idPrefix}-category-error`}
          message={state.fieldErrors?.category}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-status`} className={FIELD_LABEL}>
          Status
        </label>
        <select
          key={`status:${values.status}`}
          id={`${idPrefix}-status`}
          name="status"
          disabled={disabled}
          defaultValue={values.status}
          aria-describedby={describe("status", `${idPrefix}-status-error`)}
          aria-invalid={state.fieldErrors?.status ? true : undefined}
          className={inputClass(Boolean(state.fieldErrors?.status))}
        >
          {FINANCE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {FINANCE_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <FieldError
          id={`${idPrefix}-status-error`}
          message={state.fieldErrors?.status}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-amount`} className={FIELD_LABEL}>
          Amount
        </label>
        <div className="flex items-stretch">
          {/* A visible £ adornment. aria-hidden because the label already says
              "Amount" and the input's value is the number; the server strips a
              leading £ either way (lib/crm/finance.ts). */}
          <span
            aria-hidden="true"
            className="inline-flex h-11 items-center border border-r-0 border-rule bg-shell px-3 text-base text-ink-muted"
          >
            £
          </span>
          <input
            id={`${idPrefix}-amount`}
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            defaultValue={values.amount}
            placeholder="0.00"
            aria-describedby={describe("amount", `${idPrefix}-amount-error`)}
            aria-invalid={state.fieldErrors?.amount ? true : undefined}
            // DESIGN.md § Numerals: tabular figures on every money value.
            className={`${inputClass(Boolean(state.fieldErrors?.amount))} tabular-nums`}
          />
        </div>
        <FieldError
          id={`${idPrefix}-amount-error`}
          message={state.fieldErrors?.amount}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-occurred`} className={FIELD_LABEL}>
          Date
        </label>
        <input
          id={`${idPrefix}-occurred`}
          name="occurredOn"
          type="date"
          disabled={disabled}
          defaultValue={values.occurredOn}
          aria-describedby={describe("occurredOn", `${idPrefix}-occurred-error`)}
          aria-invalid={state.fieldErrors?.occurredOn ? true : undefined}
          className={`${inputClass(Boolean(state.fieldErrors?.occurredOn))} tabular-nums`}
        />
        <FieldError
          id={`${idPrefix}-occurred-error`}
          message={state.fieldErrors?.occurredOn}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-artist`} className={FIELD_LABEL}>
          Artist (optional)
        </label>
        <select
          key={`artistId:${values.artistId}`}
          id={`${idPrefix}-artist`}
          name="artistId"
          disabled={disabled}
          defaultValue={values.artistId}
          aria-describedby={disabled ? noteId : undefined}
          className={inputClass(false)}
        >
          <option value="">No artist</option>
          {artistOptions.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-supplier`} className={FIELD_LABEL}>
          Supplier contact (optional)
        </label>
        <select
          key={`supplierContactId:${values.supplierContactId}`}
          id={`${idPrefix}-supplier`}
          name="supplierContactId"
          disabled={disabled}
          defaultValue={values.supplierContactId}
          aria-describedby={disabled ? noteId : undefined}
          className={inputClass(false)}
        >
          <option value="">No supplier contact</option>
          {supplierOptions.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2 sm:col-span-2">
        <label htmlFor={`${idPrefix}-description`} className={FIELD_LABEL}>
          Description (optional)
        </label>
        <input
          id={`${idPrefix}-description`}
          name="description"
          type="text"
          maxLength={MAX_DESCRIPTION}
          disabled={disabled}
          defaultValue={values.description}
          placeholder="e.g. Headliner fee"
          aria-describedby={describe("description", `${idPrefix}-description-error`)}
          aria-invalid={state.fieldErrors?.description ? true : undefined}
          className={inputClass(Boolean(state.fieldErrors?.description))}
        />
        <FieldError
          id={`${idPrefix}-description-error`}
          message={state.fieldErrors?.description}
        />
      </div>
    </div>
  );
}

export function AddFinanceForm({
  orgSlug,
  eventId,
  artistOptions,
  supplierOptions,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  artistOptions: readonly PickerOption[];
  supplierOptions: readonly PickerOption[];
  disabled: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    createFinancialEntryAction,
    EMPTY_FORM_STATE,
  );

  // THE SEVEN ECHOES. A refused add snaps every uncontrolled field back to the
  // echo the action returned, so the retry is the user's numbers, not the
  // page's defaults. `budgeted` and today's default land only on a first,
  // un-refused render.
  const values: FinanceFieldValues = {
    category: state.values?.category ?? "fee",
    status: state.values?.status ?? "budgeted",
    amount: state.values?.amount ?? "",
    occurredOn: state.values?.occurredOn ?? "",
    description: state.values?.description ?? "",
    artistId: state.values?.artistId ?? "",
    supplierContactId: state.values?.supplierContactId ?? "",
  };

  return (
    <form action={formAction} className="flex flex-col gap-3 border border-rule p-4">
      {/* ERRORS ONLY, NO SUCCESS ALERT: a Client Component's useActionState
          result outlives the thing it describes (revalidation does not remount
          it), so "Saved" would linger through later actions. The confirmation
          is the line appearing in the list above. */}
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <FinanceHiddenIds orgSlug={orgSlug} eventId={eventId} />

      <h3 className="text-sm font-semibold text-ink">Add a finance line</h3>

      <FinanceFields
        idPrefix="add-finance"
        state={state}
        values={values}
        artistOptions={artistOptions}
        supplierOptions={supplierOptions}
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
          Add finance line
        </Button>
      </div>
    </form>
  );
}

export function FinanceEditForm({
  orgSlug,
  eventId,
  entryId,
  label,
  stored,
  artistOptions,
  supplierOptions,
  storedArtist,
  storedSupplier,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  entryId: string;
  /** For the control's accessible name -- e.g. the line's description. */
  label: string;
  stored: FinanceFieldValues;
  artistOptions: readonly PickerOption[];
  supplierOptions: readonly PickerOption[];
  /** The line's stored artist/supplier, so the picker keeps it if it is deleted
   *  or past the 100-record cap. Null when the line links none. */
  storedArtist: PickerOption | null;
  storedSupplier: PickerOption | null;
  disabled: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateFinancialEntryAction,
    EMPTY_FORM_STATE,
  );

  // The echo wins when there is one -- it is newer than the record the page
  // loaded with -- and falls back to the STORED value, never to "", so an edit
  // form never renders an empty field over a value the record has.
  const values: FinanceFieldValues = {
    category: state.values?.category ?? stored.category,
    status: state.values?.status ?? stored.status,
    amount: state.values?.amount ?? stored.amount,
    occurredOn: state.values?.occurredOn ?? stored.occurredOn,
    description: state.values?.description ?? stored.description,
    artistId: state.values?.artistId ?? stored.artistId,
    supplierContactId: state.values?.supplierContactId ?? stored.supplierContactId,
  };

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}
      <FinanceHiddenIds orgSlug={orgSlug} eventId={eventId} entryId={entryId} />
      <FinanceFields
        idPrefix={`edit-finance-${entryId}`}
        state={state}
        values={values}
        artistOptions={withStored(artistOptions, storedArtist)}
        supplierOptions={withStored(supplierOptions, storedSupplier)}
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
          <span className="sr-only">Save {label}</span>
        </Button>
      </div>
    </form>
  );
}

export function DeleteFinanceForm({
  orgSlug,
  eventId,
  entryId,
  label,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  entryId: string;
  label: string;
  disabled: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    deleteFinancialEntryAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FinanceHiddenIds orgSlug={orgSlug} eventId={eventId} entryId={entryId} />
      {/* NO CONFIRMATION STEP, like RemoveSlotForm: a removed finance line is
          reversible in one click from the disclosure below, on the same page,
          with nothing else changed -- an "are you sure" here is the kind that
          trains people to stop reading prompts. */}
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
          <span className="sr-only">Remove {label}</span>
        </Button>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

export function RestoreFinanceForm({
  orgSlug,
  eventId,
  entryId,
  label,
  disabled,
  noteId,
}: {
  orgSlug: string;
  eventId: string;
  entryId: string;
  label: string;
  disabled: boolean;
  noteId: string;
}) {
  const [state, formAction, pending] = useActionState(
    restoreFinancialEntryAction,
    EMPTY_FORM_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FinanceHiddenIds orgSlug={orgSlug} eventId={eventId} entryId={entryId} />
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
          <span className="sr-only">Put {label} back in the finance list</span>
        </Button>
      </div>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}
