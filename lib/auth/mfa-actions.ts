"use server";

// Server Actions backing the MFA screens:
//   - components/auth/mfa-enroll-gate.tsx  (mfaEnrollStepAction)
//   - components/auth/mfa-challenge-gate.tsx (mfaChallengeAction, fix round 1)
// See lib/auth/mfa-gate.ts for why both exist and what they do and don't
// enforce.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { field, type FormState } from "@/lib/forms";
import { safeNextPath } from "./redirects";

export interface MfaEnrollState extends FormState {
  /** Set once enroll() has produced a fresh, unverified factor to show. */
  factorId?: string;
  /** SVG markup -- render as `data:image/svg+xml;utf-8,${encodeURIComponent(...)}`. */
  qrCodeSvg?: string;
  /** Shown alongside the QR code for manual entry into an authenticator app. */
  secret?: string;
}

/**
 * Maps a failed challengeAndVerify() to copy a person can act on, rather than
 * collapsing every failure into "wrong code" (fix round 1, Minor).
 *
 * error-codes.d.ts in @supabase/auth-js enumerates the MFA-specific codes
 * this switches on. `mfa_challenge_expired` is realistically unreachable
 * through challengeAndVerify() specifically (it mints and consumes its own
 * challenge inside one call, far under the challenge TTL) but is handled
 * defensively rather than assumed impossible -- GoTrue's behaviour here is
 * not something this codebase controls.
 */
function mfaErrorMessage(error: { code?: string } | null): string {
  switch (error?.code) {
    case "over_request_rate_limit":
      return "Too many attempts. Wait a minute and try again.";
    case "mfa_challenge_expired":
      return "That code expired before it was checked. Enter the newest 6-digit code from your app and try again.";
    case "mfa_verification_failed":
    case "mfa_verification_rejected":
    default:
      return "That code didn't match. Check the time on your device and your authenticator app, then try again.";
  }
}

/**
 * Step 1 (no factorId/code in the form): start a fresh TOTP enrollment.
 * Step 2 (factorId+code present): verify the code against that enrollment.
 *
 * WHY EVERY STALE UNVERIFIED FACTOR IS UNENROLLED BEFORE A FRESH ONE STARTS:
 * enroll()'s secret and QR code are returned ONCE, at enroll time --
 * listFactors() never returns them again. If this action ran only "enroll a
 * new factor" without cleanup, reloading the gate screen (a lost tab, a
 * accidental refresh) would pile up unverified factors the user can no longer
 * see the secret for, eventually hitting
 * [auth.mfa] max_enrolled_factors = 10 and locking them out of their own
 * enrollment. Cleaning up first means the screen always shows a secret it can
 * actually verify against, at the cost of invalidating an in-progress scan if
 * the user has the setup screen open in two tabs -- an acceptable trade for
 * an enrollment flow, which is inherently single-session.
 */
export async function mfaEnrollStepAction(
  _prev: MfaEnrollState,
  formData: FormData,
): Promise<MfaEnrollState> {
  const supabase = await createClient();
  const factorId = field(formData, "factorId");
  const code = field(formData, "code");

  if (factorId && code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (error) {
      // Round-trip the QR/secret through hidden fields rather than refetching
      // them: enroll() returns a factor's secret exactly once, so a failed
      // verify attempt has to carry forward what the FIRST call already
      // returned, not ask for it again.
      return {
        factorId,
        qrCodeSvg: field(formData, "qrCodeSvg") ?? undefined,
        secret: field(formData, "secret") ?? undefined,
        error: mfaErrorMessage(error),
      };
    }
    // Verified: the session now carries an aal2 amr entry (a fresh
    // credential-equivalent event) and evaluateMfaGate() will read "pass" on
    // the next request. Redirect rather than returning state so the gate
    // re-evaluates from a clean request, the same pattern every other
    // state-changing action in this file uses.
    redirect(safeNextPath(field(formData, "next")));
  }

  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const stale of existing?.all ?? []) {
    if (stale.factor_type === "totp" && stale.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: stale.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    issuer: "GetSetPaid",
  });
  if (error || !data) {
    return {
      error: "Could not start two-factor setup. Try again in a moment.",
    };
  }

  return {
    factorId: data.id,
    qrCodeSvg: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

/**
 * The per-sign-in MFA challenge (fix round 1, Important 2): a privileged
 * user who already has a verified TOTP factor still needs to PRESENT it once
 * per session before evaluateMfaGate() reads "pass" -- Supabase does not
 * force this on its own. The factor to challenge is resolved SERVER-SIDE via
 * listFactors() rather than trusted from a hidden form field: the browser
 * has no business asserting which factor id is "the" verified one, and the
 * server already knows.
 */
export async function mfaChallengeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = field(formData, "code");
  const next = safeNextPath(field(formData, "next"));

  if (!code) {
    return { fieldErrors: { code: "Enter the 6-digit code." } };
  }

  const supabase = await createClient();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  const factorId = factors?.totp[0]?.id;

  if (listError || !factorId) {
    // The verified factor evaluateMfaGate() saw a moment ago is gone (e.g.
    // unenrolled from another tab mid-challenge). Re-render the gate fresh
    // rather than erroring here -- it will correctly fall through to the
    // enrollment screen.
    redirect(next);
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code,
  });
  if (error) {
    return { error: mfaErrorMessage(error) };
  }

  redirect(next);
}
