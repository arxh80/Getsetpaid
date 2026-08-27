"use client";

import { useActionState } from "react";
import { mfaChallengeAction } from "@/lib/auth/mfa-actions";
import { EMPTY_FORM_STATE, type FormState } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

/**
 * The per-sign-in MFA challenge screen (fix round 1, Important 2).
 *
 * Rendered instead of components/auth/mfa-enroll-gate.tsx when
 * lib/auth/mfa-gate.ts's evaluateMfaGate() reports `{ kind: "challenge" }` --
 * i.e. the caller already has a verified TOTP factor, they just haven't
 * presented it THIS session. Deliberately the same shell/copy conventions as
 * MfaEnrollGate (a gate screen, not a silent block) but with no QR code or
 * secret to show: enrolling already happened, this is only asking for the
 * current 6-digit code.
 */
export function MfaChallengeGate({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    mfaChallengeAction,
    EMPTY_FORM_STATE,
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Enter your two-factor code
        </h1>
        <p className="text-lg text-ink-muted">
          Your role requires a fresh code from your authenticator app on
          every sign-in.
        </p>
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="next" value={next} />
        <Field
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          error={state.fieldErrors?.code}
        />
        <Button type="submit" pending={pending} pendingLabel="Checking…">
          Verify and continue
        </Button>
      </form>
    </div>
  );
}
