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
import { mfaErrorMessage } from "./mfa-errors";
import { safeNextPath } from "./redirects";
import { mayTryPassword, recordPasswordOutcome } from "./login-budget";
import { field, type FormState } from "@/lib/forms";

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

  // The same per-account budget as signInAction (lib/auth/login-budget.ts):
  // a stolen session must not brute-force its owner's password here either.
  if (!(await mayTryPassword(user.email))) {
    return { error: "That password wasn't right. Try again." };
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });
  await recordPasswordOutcome(user.email, error);

  if (error) {
    // Same one-message rule as signInAction: never confirm or deny which
    // part was wrong.
    return { error: "That password wasn't right. Try again." };
  }

  redirect(next);
}
