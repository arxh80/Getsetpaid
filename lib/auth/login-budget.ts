import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

// ===========================================================================
// THE PER-ACCOUNT PASSWORD BUDGET THE APP SPENDS BEFORE GoTrue (G4 fallback)
// ===========================================================================
// SECURITY.md § 5's "5 failed sign-ins per 15 minutes, per account" lives in
// GoTrue's password-verification hook, which the hosted plan refuses until
// founder action F8. public.meter_password_sign_in (20261108002000) is the
// same budget held by the app: signInAction and the step-up password path ask
// it BEFORE calling GoTrue and report the outcome after. The numbers live in
// public.rate_limit_policies ('login_email'), not here.
//
// Service-role and sessionless on purpose: the RPC refuses every browser,
// signed in or not, so nobody can spend or clear another person's budget over
// PostgREST. A password grant sent straight to GoTrue skips all of this; the
// hook (F8) or GoTrue's per-IP limit bounds that path (SECURITY.md § 5).
//
// FAILS CLOSED, as lib/security/rate-limit.ts does: if the budget cannot be
// read, the password attempt is refused. Magic link and Google still work.
// ===========================================================================

type Outcome = "attempt" | "succeeded";

async function meter(email: string, outcome: Outcome): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc("meter_password_sign_in", {
    p_email: email,
    p_outcome: outcome,
  });
  if (error || typeof data !== "boolean") {
    console.error(
      `[login-budget] meter_password_sign_in(${outcome}) failed; failing CLOSED:`,
      error?.message ?? "unexpected response shape",
    );
    return false;
  }
  return data;
}

/**
 * Spend one attempt and say whether it may go to GoTrue. Every attempt is
 * counted up front, atomically, so a burst of simultaneous guesses cannot all
 * pass before any failure lands; false once the account's budget is spent.
 */
export function mayTryPassword(email: string): Promise<boolean> {
  return meter(email, "attempt");
}

/** Report what GoTrue said: a success clears the account's count. */
export async function recordPasswordOutcome(email: string, error: unknown): Promise<void> {
  if (!error) await meter(email, "succeeded");
}
