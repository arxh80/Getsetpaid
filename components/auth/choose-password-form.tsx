"use client";

import { useActionState } from "react";
import { choosePasswordAction } from "@/lib/auth/actions";
import { EMPTY_FORM_STATE, MIN_PASSWORD_LENGTH } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { PasswordInput } from "./password-input";

// The /set-password form (Phase 10 Task 20). See choosePasswordAction.
export function ChoosePasswordForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(choosePasswordAction, EMPTY_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="next" value={next} />

      <PasswordInput
        label="New password"
        name="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Longer beats complicated.`}
        required
        error={state.fieldErrors?.password}
      />

      <Button type="submit" pending={pending} pendingLabel="Saving…">
        Save password
      </Button>
    </form>
  );
}
