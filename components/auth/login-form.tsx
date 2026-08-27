"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signInAction } from "@/lib/auth/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { PasswordInput } from "./password-input";

// Sign-in form.
//
// A Client Component only so it can render pending and error state; the
// credentials themselves are handled entirely by the Server Action. `action`
// on the <form> means this still submits and works without JavaScript --
// useActionState degrades to a plain POST.
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(
    signInAction,
    EMPTY_FORM_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <input type="hidden" name="next" value={next} />

      <Field
        label="Email"
        name="email"
        type="email"
        // Semantic type + autocomplete: the right mobile keyboard, and the
        // password manager can actually fill it.
        autoComplete="email"
        // Browser validation is off (noValidate) so our messages are the only
        // ones shown -- native bubbles are unstyleable and disappear on blur.
        inputMode="email"
        required
        error={state.fieldErrors?.email}
      />

      <PasswordInput
        label="Password"
        name="password"
        autoComplete="current-password"
        required
        error={state.fieldErrors?.password}
      />

      <Button type="submit" pending={pending} pendingLabel="Signing in…">
        Sign in
      </Button>

      <p className="text-sm text-ink-muted">
        No password, or forgotten it?{" "}
        <Link href="/magic-link" className="text-primary underline underline-offset-4">
          Get a sign-in link by email
        </Link>
        .
      </p>
    </form>
  );
}
