"use server";

// Server Actions backing the MFA-enrollment gate screen
// (components/auth/mfa-enroll-gate.tsx). One action, two steps -- distinguished
// by whether a factorId+code came back from the client, exactly the pattern
// lib/auth/actions.ts uses nowhere else because nothing else here is a
// two-step flow. See lib/auth/mfa-gate.ts for why this exists and what it
// does and does not enforce.
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
        error:
          "That code didn't match. Check the time on your device and your authenticator app, then try again.",
      };
    }
    // Verified: the session now carries an aal2 amr entry (a fresh
    // credential-equivalent event) and mfaGateBlocks() will read false on the
    // next request. Redirect rather than returning state so the gate
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
