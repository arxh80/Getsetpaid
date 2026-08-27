"use client";

import { useActionState } from "react";
import { magicLinkAction } from "@/lib/auth/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

export function MagicLinkForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(
    magicLinkAction,
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
        autoComplete="email"
        inputMode="email"
        required
        error={state.fieldErrors?.email}
      />

      <Button type="submit" pending={pending} pendingLabel="Sending…">
        Email me a link
      </Button>
    </form>
  );
}
