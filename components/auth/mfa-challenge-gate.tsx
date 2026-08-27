"use client";

import { useActionState, useEffect, useRef } from "react";
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
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the code field after a rejected attempt -- the same behaviour
  // MfaEnrollGate's VerifyStep already had, and the reason it needs to match
  // is that these two screens are seen in sequence by the same person: they
  // enroll once, then meet this challenge on every later sign-in. A TOTP code
  // is dead the moment it is refused (it either was mistyped or its 30-second
  // window has passed), so leaving the failed digits in the box means the
  // user's first action after every failure is to select-all and delete
  // before they can retype -- and a screen-reader or switch user pays more
  // for that than anyone. Only the code clears; nothing else on this form is
  // worth losing.
  useEffect(() => {
    if (state.error) {
      const input = formRef.current?.elements.namedItem("code");
      if (input instanceof HTMLInputElement) input.value = "";
    }
  }, [state.error]);

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

      <form
        ref={formRef}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <input type="hidden" name="next" value={next} />
        {/*
          autoFocus HERE BUT NOT IN MfaEnrollGate'S VerifyStep -- reviewed in
          Task 10's gate and kept, because the difference tracks the content
          above each field rather than being an oversight. On this screen the
          code input is the only control and there is nothing to read first,
          so focusing it is what a per-sign-in interstitial should do; the
          <h1> and its explanation are still the first things a screen reader
          announces on load. VerifyStep must NOT autofocus: its field is step
          2 of 2, and moving focus past a QR code the user has to scan (or a
          secret they have to copy) would skip the instruction that makes the
          field answerable. Same rule, opposite outcome: focus the field only
          when nothing above it needs reading first.
        */}
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
