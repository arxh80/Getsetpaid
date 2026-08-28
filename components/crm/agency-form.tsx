"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createAgencyAction, updateAgencyAction } from "@/lib/crm/agencies";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Create / edit an agency. One component, two actions, ONE FIELD.
//
// The one-field form is the schema's doing and not a shortcut: `public.agencies`
// is name-only, because 20260827232510 declined to invent columns the PRD does
// not name. Adding a `website` here so the form looks less bare would be a
// schema decision taken for a layout reason, and it would have to be a
// migration, an index, a validator and a render-side `safeHref()` -- all to
// fill a gap that only looks like one.
//
// EVERY FIELD IS PRE-FILLED FROM `defaultValue`, NOT FROM CONTROLLED STATE, so
// the form works with JavaScript disabled -- a Server Action bound to a
// `<form action>` submits as an ordinary POST -- and there is no re-render per
// keystroke.
//
// React 19 RESETS a `<form action>` once the action resolves, which for an
// uncontrolled form means every input goes back to its `defaultValue`. Task 4
// measured it in a browser: type a name, submit, trip a validation error, and
// the name comes back empty. The action echoes what it was given
// (FormState.values) and `shownName` below is what makes the reset restore it.

export interface AgencyFormValues {
  id?: string;
  name: string;
}

export function AgencyForm({
  orgSlug,
  values,
  cancelHref,
}: {
  orgSlug: string;
  values: AgencyFormValues;
  cancelHref: string;
}) {
  const editing = values.id !== undefined;
  const [state, formAction, pending] = useActionState(
    editing ? updateAgencyAction : createAgencyAction,
    EMPTY_FORM_STATE,
  );
  // The `??` order matters: the echo wins when there is one, because it is
  // newer than the record the page loaded with.
  const shownName = state.values?.name ?? values.name;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      {/* The organisation is carried as a SLUG and re-resolved server-side
          through getCurrentOrg(), which is RLS-gated. It is not an
          organisation id and it is not trusted: CLAUDE.md § Tenancy model.
          Editing this input gets you a workspace you are already a member of,
          or nothing. */}
      <input type="hidden" name="orgSlug" value={orgSlug} />
      {editing ? <input type="hidden" name="agencyId" value={values.id} /> : null}

      <Field
        label="Name"
        name="name"
        defaultValue={shownName}
        autoComplete="off"
        required
        maxLength={200}
        hint="The agency as this workspace refers to it. This is what every list and search matches on."
        error={state.fieldErrors?.name}
      />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" pending={pending} pendingLabel="Saving…">
          {editing ? "Save changes" : "Create agency"}
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
