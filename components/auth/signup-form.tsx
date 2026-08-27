"use client";

import { useActionState } from "react";
import { signUpAction } from "@/lib/auth/actions";
import { EMPTY_FORM_STATE, MIN_PASSWORD_LENGTH } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { PasswordInput } from "./password-input";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(
    signUpAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="next" value={next} />

      <Field
        label="Your name"
        name="fullName"
        type="text"
        autoComplete="name"
        // Genuinely optional -- it is a display name, nothing depends on it,
        // and making it required just adds a step between someone and the
        // product. The label says "Optional" rather than leaving them to infer
        // it from the absence of an asterisk.
        hint="Shown to colleagues in your workspace."
        error={state.fieldErrors?.fullName}
      />

      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        error={state.fieldErrors?.email}
      />

      <PasswordInput
        label="Password"
        name="password"
        autoComplete="new-password"
        // Stated up front, not revealed by a rejection after they have chosen
        // one. Length only -- see lib/forms.ts on why there are no character
        // -class rules.
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Longer beats complicated.`}
        required
        error={state.fieldErrors?.password}
      />

      <Button type="submit" pending={pending} pendingLabel="Creating account…">
        Create account
      </Button>
    </form>
  );
}
