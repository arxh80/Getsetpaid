"use client";

import { useActionState } from "react";
import { mfaEnrollStepAction, type MfaEnrollState } from "@/lib/auth/mfa-actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

const EMPTY_MFA_STATE: MfaEnrollState = EMPTY_FORM_STATE;

/** The data-URI prefix Supabase's `totp.qr_code` already carries. */
const SVG_DATA_URI_PREFIX = "data:image/svg+xml;utf-8,";

/**
 * Turns Supabase's `enroll().data.totp.qr_code` into a usable <img src>.
 *
 * ===========================================================================
 * THE BUG THIS FIXES (review NEW-2)
 * ===========================================================================
 * This was `data:image/svg+xml;utf-8,${encodeURIComponent(qrCodeSvg)}` -- and
 * `qr_code` is ALREADY A COMPLETE DATA URI, not a bare SVG. So the prefix was
 * applied twice and the whole thing percent-encoded, producing:
 *
 *   data:image/svg+xml;utf-8,data%3Aimage%2Fsvg%2Bxml%3Butf-8%2C%3C%3Fxml...
 *
 * which is not an image. The QR code never rendered on ANY enrolment, for
 * ANY user -- `naturalWidth` was 0 and the box was empty. Every Owner, Admin
 * and Finance user has to pass this screen and it is the first thing they see,
 * so "Scan this with your authenticator app" sat above nothing. It was only
 * survivable because the manual key underneath is a working fallback, which is
 * also why it was never noticed: enrolment still completes if you type the key.
 *
 * MEASURED, not assumed, against the running stack before fixing it:
 *   typeof qr_code            string, 362657 chars
 *   first 25 chars            "data:image/svg+xml;utf-8,"
 *   body contains '#'         false
 *
 * ===========================================================================
 * WHY IT STILL ENCODES, RATHER THAN JUST PASSING qr_code STRAIGHT THROUGH
 * ===========================================================================
 * Passing the raw value works today and is what Supabase's own docs show. It
 * is one upstream change away from breaking silently: an unencoded `data:`
 * URI ends at the first `#`, and `#` is the single most likely character to
 * appear in an SVG (`fill:#fff`). Today's payload uses `style="fill:white"`
 * and contains none -- verified above -- but "the QR silently truncates if
 * they ever switch to hex colours" is not a property worth having on the one
 * screen every privileged user must complete.
 *
 * So: strip the prefix if it is there (the actual fix), then encode the body
 * exactly once. Also correct if Supabase ever returns a bare SVG instead.
 */
export function qrCodeDataUri(qrCode: string): string {
  const body = qrCode.startsWith(SVG_DATA_URI_PREFIX)
    ? qrCode.slice(SVG_DATA_URI_PREFIX.length)
    : qrCode;
  return `${SVG_DATA_URI_PREFIX}${encodeURIComponent(body)}`;
}

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
  // A failed code should not force re-scanning the QR code, and only the
  // 6-digit field should clear -- BUT NOTHING HERE HAS TO MAKE THAT HAPPEN.
  //
  // This is where the pattern originated: a `useEffect` keyed on
  // `[state.error]` that blanked the code input, which MfaChallengeGate later
  // copied. Fix round 1 correctly flagged that dependency as unable to fire
  // on consecutive failures -- mfaErrorMessage() returns a FIXED string per
  // rejection reason, and useEffect compares deps with Object.is. But
  // measuring it showed the effect was never doing the work at all: React 19
  // resets a <form action={serverAction}>'s uncontrolled fields once the
  // action completes, so the code field emptied itself with the effect
  // present, with the dependency "fixed", and with the effect deleted
  // outright.
  //
  // The hidden factorId/qrCodeSvg/secret inputs survive that reset because
  // they are React-controlled from `state`, and mfaEnrollStepAction's failure
  // branch round-trips all three back verbatim -- so the "don't force a
  // re-scan" guarantee comes from the action carrying its state forward, not
  // from this effect either. Verified end to end on a fresh un-enrolled
  // account, six consecutive wrong codes: the code field was empty after
  // every one, and factorId, the rendered QR image and the enrollment secret
  // were byte-identical throughout (compared as booleans, so no key material
  // left the page).
  //
  // See components/auth/mfa-challenge-gate.tsx for the three-build
  // measurement this conclusion rests on.
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
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
          src={qrCodeDataUri(state.qrCodeSvg ?? "")}
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
