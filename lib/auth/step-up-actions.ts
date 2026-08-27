"use server";

// Server Action backing the reusable re-auth prompt
// (components/auth/reauth-prompt.tsx), which components/auth/step-up-gate.tsx
// renders whenever checkStepUp() says the current session's last credential
// use is stale. Two proofs are accepted -- see lib/auth/step-up-gate.ts's
// stepUpProofMode() for why MFA is preferred and password is the fallback,
// not the default.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "./index";
import { safeNextPath } from "./redirects";
import { field, type FormState } from "@/lib/forms";

/** Same mapping step-up's MFA path uses -- see lib/auth/mfa-actions.ts for
 * the full reasoning behind distinguishing these cases. Duplicated rather
 * than imported: mfa-actions.ts is a "use server" file, which may only
 * export async Server Actions, not a plain helper function. */
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

export async function reauthenticateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const next = safeNextPath(field(formData, "next"));
  const code = field(formData, "code");
  const factorId = field(formData, "factorId");
  const password = field(formData, "password");

  const user = await getCurrentUser();
  if (!user) {
    // No session at all -- send them through the normal front door rather
    // than failing this form in a confusing way.
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const supabase = await createClient();

  // MFA path -- preferred. Re-verifying an EXISTING factor upgrades the
  // CURRENT session's AAL in place (verified empirically, see
  // lib/auth/step-up-gate.ts's header): no new auth.sessions row, no restart
  // of the 12h timebox, and it satisfies isStepUpSatisfied() because `mfa/`
  // methods are in step-up.ts's CREDENTIAL_METHODS set.
  if (factorId && code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (error) {
      return { error: mfaErrorMessage(error) };
    }
    redirect(next);
  }

  // Password path -- fallback, only offered when the account actually has an
  // email/password identity (components/auth/reauth-prompt.tsx only renders
  // this field when lib/auth/step-up-gate.ts's stepUpProofMode() said
  // "password"). signInWithPassword() DOES mint a new session and restart the
  // 12h timebox -- an accepted, documented trade-off for the fallback case
  // only, per stepUpProofMode()'s header. A Google-SSO-only user with no
  // verified factor never reaches this branch at all: the prompt shows the
  // "unavailable" message instead of a password field that could never
  // succeed.
  if (!password) {
    return { fieldErrors: { password: "Enter your password." } };
  }
  if (!user.email) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });

  if (error) {
    // Same one-message rule as signInAction: never confirm or deny which
    // part was wrong.
    return { error: "That password wasn't right. Try again." };
  }

  redirect(next);
}
