"use client";

import { useActionState, useEffect, useRef } from "react";
import { mfaEnrollStepAction, type MfaEnrollState } from "@/lib/auth/mfa-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

const EMPTY_MFA_STATE: MfaEnrollState = EMPTY_FORM_STATE;

// The full-screen gate rendered by app/(app)/layout.tsx in place of the app
// for a user CLAUDE.md § Session security requires MFA for
// (Owner/Admin/Finance in any org, or the platform superuser) who has not yet
// verified a TOTP factor. See lib/auth/mfa-gate.ts for the "why any
// membership" and "this is routing, not enforcement" reasoning.
//
// A GATE SCREEN, NOT A SILENT BLOCK (the brief's own words): it explains what
// is happening and why, and gives the one thing that resolves it, rather than
// a bare 403 or a redirect with no explanation.
export function MfaEnrollGate({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(
    mfaEnrollStepAction,
    EMPTY_MFA_STATE,
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Set up two-factor authentication
        </h1>
        <p className="text-lg text-ink-muted">
          Your role can see or change things other people in your workspace
          can’t, so this account needs an authenticator app before you
          continue.
        </p>
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      {state.factorId && state.qrCodeSvg ? (
        <VerifyStep
          state={state}
          formAction={formAction}
          pending={pending}
          next={next}
        />
      ) : (
        <form action={formAction}>
          <input type="hidden" name="next" value={next} />
          <Button type="submit" pending={pending} pendingLabel="Starting…">
            Begin setup
          </Button>
        </form>
      )}
    </div>
  );
}

function VerifyStep({
  state,
  formAction,
  pending,
  next,
}: {
  state: MfaEnrollState;
  formAction: (formData: FormData) => void;
  pending: boolean;
  next: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  // A failed code should not force re-scanning the QR code -- only the
  // 6-digit field clears, so the user can just try typing again.
  useEffect(() => {
    if (state.error) {
      const input = formRef.current?.elements.namedItem("code");
      if (input instanceof HTMLInputElement) input.value = "";
    }
  }, [state.error]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-5"
      noValidate
    >
      <input type="hidden" name="factorId" value={state.factorId} />
      <input type="hidden" name="qrCodeSvg" value={state.qrCodeSvg ?? ""} />
      <input type="hidden" name="secret" value={state.secret ?? ""} />
      <input type="hidden" name="next" value={next} />

      <div className="flex flex-col gap-3 border border-rule bg-surface p-4">
        <p className="text-sm font-semibold text-ink">
          1. Scan this with your authenticator app
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI
            SVG has no meaningful width/height for next/image to optimise, and
            this never leaves the client, so there is no LCP/bandwidth case
            for it here. */}
        <img
          src={`data:image/svg+xml;utf-8,${encodeURIComponent(state.qrCodeSvg ?? "")}`}
          alt="QR code for your authenticator app"
          width={200}
          height={200}
          className="h-[200px] w-[200px] self-start border border-rule"
        />
        <p className="text-sm text-ink-muted">
          Can’t scan it? Enter this key manually:
        </p>
        <p className="break-all bg-shell px-3 py-2 font-mono text-sm tracking-wide text-ink">
          {state.secret}
        </p>
      </div>

      <Field
        label="2. Enter the 6-digit code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        hint="From the authenticator app, once it's added the account above."
      />

      <Button type="submit" pending={pending} pendingLabel="Checking…">
        Verify and continue
      </Button>
    </form>
  );
}
