"use client";

import { useActionState } from "react";
import { reauthenticateAction } from "@/lib/auth/step-up-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

/**
 * The re-auth prompt components/auth/step-up-gate.tsx renders whenever
 * checkStepUp() reports the session's last credential use is more than five
 * minutes old. Re-entering the password is what makes the NEXT render of the
 * gate pass -- see lib/auth/step-up-actions.ts.
 */
export function ReauthPrompt({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(
    reauthenticateAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Confirm it&apos;s you
        </h1>
        <p className="text-lg text-ink-muted">
          This action needs a recent password check, even though you&apos;re
          already signed in.
        </p>
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="next" value={next} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={state.fieldErrors?.password}
        />
        <Button type="submit" pending={pending} pendingLabel="Checking…">
          Confirm
        </Button>
      </form>
    </div>
  );
}
