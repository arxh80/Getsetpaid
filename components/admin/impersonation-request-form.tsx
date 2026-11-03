"use client";

import { useActionState } from "react";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { requestImpersonationAction } from "@/lib/admin/impersonation";
import { IMPERSONATION_TIME_BOX_MINUTES } from "@/lib/admin/impersonation-contract";
import { Field, TextAreaField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// Step 1 of the break-glass flow: ask one workspace's admins for support
// access.
//
// TWO FIELDS, BOTH REQUIRED, AND THE SECOND IS THE POINT. The reason is
// mandatory in the database (a CHECK on impersonation_sessions.reason, not
// merely `required` here), goes verbatim into the audit row's `after`
// payload, and is shown to the admin who has to decide. A support engineer
// typing "checking something" is making a permanent record of having typed
// "checking something".
//
// THE FORM IS RENDERED INSIDE <StepUpGate>, and the action re-checks step-up
// anyway (lib/admin/impersonation.ts's authoriseSuperuser). Hiding a form is
// not enforcement -- CLAUDE.md § Permissions -- so the gate is for the human
// and the re-check is the control.
//
// UNCONTROLLED, with `defaultValue` fed from `state.values`, for the reason
// lib/forms.ts's FormState.values documents at length: React 19 resets a
// `<form action={...}>` after the action resolves, so without the echo a
// refused submit blanks the reason the user just wrote out.

export function ImpersonationRequestForm() {
  const [state, formAction, pending] = useActionState(
    requestImpersonationAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex max-w-prose flex-col gap-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <Field
        label="Workspace URL name"
        name="organisationSlug"
        required
        defaultValue={state.values?.organisationSlug ?? ""}
        error={state.fieldErrors?.organisationSlug}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        hint="The slug from the workspace’s URL — the part after the first slash."
      />

      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={3}
        maxLength={500}
        defaultValue={state.values?.reason ?? ""}
        error={state.fieldErrors?.reason}
        hint="Shown to the workspace’s Owner and Admins, and written to the permanent audit record. Name the ticket or the problem."
      />

      <p className="max-w-prose text-sm text-ink-muted">
        Nothing is visible to you until an Owner or Admin of that workspace
        accepts. After they do, you start the session yourself and it lasts{" "}
        <span className="tabular-nums">{IMPERSONATION_TIME_BOX_MINUTES}</span>{" "}
        minutes, read-only.
      </p>

      <div>
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel="Requesting…"
        >
          Request access
        </Button>
      </div>
    </form>
  );
}
