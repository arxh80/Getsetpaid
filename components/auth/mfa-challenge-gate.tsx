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
  // NO EFFECT CLEARS THE CODE FIELD, BECAUSE REACT ALREADY DOES IT.
  //
  // Task 10 added a `useEffect` here that blanked the input whenever
  // `state.error` was set, mirroring one MfaEnrollGate's VerifyStep already
  // carried. Fix round 1 then pointed out that its `[state.error]` dependency
  // could never fire twice in a row -- mfaErrorMessage() in
  // lib/auth/mfa-actions.ts maps every rejection to a FIXED string, so a
  // second consecutive wrong code produces a byte-identical value, and
  // useEffect compares deps with Object.is.
  //
  // That reasoning about the dependency is correct. The premise underneath it
  // -- that the stale digits therefore persist -- is not, on React 19.
  // Measured against this component on a real enrolled TOTP factor, three
  // consecutive wrong codes, in three separate production builds:
  //
  //   dependency [state.error] (the "buggy" version) -> cleared all 3 times
  //   dependency [state]       (the "fixed"  version) -> cleared all 3 times
  //   NO useEffect AT ALL                             -> cleared all 3 times
  //
  // React 19 resets a <form action={serverAction}>'s uncontrolled fields once
  // the action completes, so the field was never being cleared by this effect
  // in either version. Confirmed it is React's reset and not a stray
  // form.reset(): a raw <input> injected into the same form via the DOM --
  // one React does not own -- KEPT its value across the same submission that
  // emptied the code field.
  //
  // So the effect was dead code whose comment claimed credit for behaviour
  // the framework provides. Deleting it is the honest outcome; keeping a
  // redundant version would leave the next reader believing this screen
  // depends on it. If this form ever stops using a Server Action, or the
  // input becomes controlled, the reset goes away with it -- that is the
  // thing to re-check, not the dependency array.
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
