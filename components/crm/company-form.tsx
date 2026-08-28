"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createCompanyAction, updateCompanyAction } from "@/lib/crm/companies";
import { COMPANY_TYPES } from "@/lib/crm/companies-list";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit a company. Same shape as ContactForm; two fields.
//
// ===========================================================================
// `type` IS A CHECKBOX GROUP, NOT A MULTI-SELECT AND NOT REQUIRED
// ===========================================================================
// `companies.type` is `text[]` with an element-level CHECK against six values
// (20260827232510), so the control has to express "zero or more of a fixed
// set". The honest HTML for that is a fieldset of checkboxes sharing one name:
// every option is visible without opening anything, every one is a 44px touch
// target, and it needs no JavaScript. A `<select multiple>` is the alternative
// and it is worse in every direction that matters -- ctrl-clicking to
// multi-select is undiscoverable, it collapses to a scrolling box on mobile,
// and its keyboard model is inconsistent between engines.
//
// NOT REQUIRED, and that is from the schema rather than from taste: the empty
// array passes the CHECK (`'{}' <@ anything` is true) and the column comment
// calls an untyped company "a legitimate half-entered record". Somebody typing
// a name they just heard on a call should not have to decide what kind of
// business it is before they can save it.

export interface CompanyFormValues {
  id?: string;
  name: string;
  type: string[];
}

export function CompanyForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: CompanyFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateCompanyAction : createCompanyAction,
    EMPTY_FORM_STATE,
  );
  const selected = new Set(values.type);
  const typeErrorId = "company-type-error";

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="companyId" value={values.id} /> : null}

      <Field
        label="Name"
        name="name"
        defaultValue={values.name}
        autoComplete="off"
        required
        maxLength={200}
        hint="The business as this workspace refers to it."
        error={state.fieldErrors?.name}
      />

      <fieldset
        className="flex flex-col gap-4 border border-rule p-5"
        aria-describedby={state.fieldErrors?.type ? typeErrorId : undefined}
        aria-invalid={state.fieldErrors?.type ? true : undefined}
      >
        <legend className="px-2 text-sm font-semibold tracking-[0.04em] text-ink-muted uppercase">
          Type
        </legend>
        <p className="max-w-prose text-sm text-ink-muted">
          Choose as many as apply, or none. A venue that promotes its own nights
          is one company with two types, not two records.
        </p>
        <div className="flex flex-col gap-1">
          {COMPANY_TYPES.map((type) => (
            <label
              key={type.value}
              className="flex min-h-11 items-center gap-3 text-base text-ink"
            >
              <input
                type="checkbox"
                name="type"
                value={type.value}
                defaultChecked={selected.has(type.value)}
                // accent-color, not a hand-built box: the native checkbox is
                // keyboard- and screen-reader-correct everywhere and the only
                // thing worth changing about it is the tick's colour.
                className="size-5 accent-[var(--color-primary)]"
              />
              {type.label}
            </label>
          ))}
        </div>
        {state.fieldErrors?.type ? (
          <p id={typeErrorId} role="alert" className="text-sm font-semibold text-danger">
            {state.fieldErrors.type}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create company"}
        </Button>
        <Link
          href={cancelHref}
          className="text-base text-primary underline underline-offset-4 hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
