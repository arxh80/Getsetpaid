"use client";

import { useActionState } from "react";
import { completeAccountSetupAction } from "@/lib/auth/actions";
import { EMPTY_FORM_STATE, MIN_PASSWORD_LENGTH } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { PasswordInput } from "./password-input";

// Shown on the invite landing page.
//
// An invited user has NO PASSWORD -- admin.inviteUserByEmail() creates the
// auth.users row without one. They are signed in right now purely because they
// just clicked a single-use emailed link, and CLAUDE.md caps a session at 12
// hours. Without this form the invite flow delivers someone into a workspace
// they are then locked out of.
//
// Both fields are optional so an existing user who already has a password (a
// second-workspace invite) can ignore the whole block rather than being made
// to re-enter one.
export function AccountSetupForm({
  defaultName,
}: {
  defaultName?: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    completeAccountSetupAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <Field
        label="Your name"
        name="fullName"
        type="text"
        autoComplete="name"
        defaultValue={defaultName ?? ""}
        hint="Shown to colleagues in your workspace."
        error={state.fieldErrors?.fullName}
      />

      <PasswordInput
        label="Password"
        name="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Set one now so you can sign in again without an emailed link.`}
        error={state.fieldErrors?.password}
      />

      <Button
        type="submit"
        variant="secondary"
        pending={pending}
        pendingLabel="Saving…"
      >
        Save
      </Button>
    </form>
  );
}
