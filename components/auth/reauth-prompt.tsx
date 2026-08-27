"use client";

import { useActionState } from "react";
import { reauthenticateAction } from "@/lib/auth/step-up-actions";
import type { StepUpProofMode } from "@/lib/auth/step-up-gate";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

/**
 * The re-auth prompt components/auth/step-up-gate.tsx renders whenever
 * checkStepUp() reports the session's last credential use is more than five
 * minutes old. `proof` (from lib/auth/step-up-gate.ts's stepUpProofMode())
 * decides WHICH form this actually shows -- see that file's header for why
 * MFA is preferred over a password and why a Google-SSO-only user with no
 * verified factor sees neither, rather than a password field that could
 * never succeed.
 */
export function ReauthPrompt({
  next,
  proof,
}: {
  next: string;
  proof: StepUpProofMode;
}) {
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
          {proof.mode === "mfa"
            ? "This action needs a fresh two-factor code, even though you're already signed in."
            : "This action needs a recent password check, even though you're already signed in."}
        </p>
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      {proof.mode === "unavailable" ? (
        <Alert tone="info">
          Your account doesn&apos;t have a password or two-factor
          authentication set up, so this check can&apos;t be completed here.
          Ask an admin for help, or set up two-factor authentication first.
        </Alert>
      ) : (
        <form action={formAction} className="flex flex-col gap-5" noValidate>
          <input type="hidden" name="next" value={next} />

          {proof.mode === "mfa" ? (
            <>
              <input type="hidden" name="factorId" value={proof.factorId} />
              <Field
                label="6-digit code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                hint="From the authenticator app you already set up."
              />
            </>
          ) : (
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              error={state.fieldErrors?.password}
            />
          )}

          <Button type="submit" pending={pending} pendingLabel="Checking…">
            Confirm
          </Button>
        </form>
      )}
    </div>
  );
}
