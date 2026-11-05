// Shared by lib/auth/mfa-actions.ts and lib/auth/step-up-actions.ts. Those are
// "use server" modules, which may export only Server Actions.

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
export function mfaErrorMessage(error: { code?: string } | null): string {
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
