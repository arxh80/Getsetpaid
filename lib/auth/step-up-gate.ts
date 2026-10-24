import "server-only";

// The reusable step-up gate CLAUDE.md § Session security asks for: "Step-up
// re-authentication ... is required before: changing security settings (MFA,
// password, email), large data exports, deleting organisation data, and any
// high-risk admin/superuser function." lib/auth/step-up.ts already built the
// hard part -- reading session freshness from the JWT's `amr` claim and
// deciding whether a credential was presented within the last five minutes.
// This file does NOT reimplement that; it is the thin, request-bound wiring
// that a UI gate (components/auth/step-up-gate.tsx) and its future callers
// (Admin/Security phase: MFA changes, exports, org deletion, impersonation)
// actually call.
//
// SPLIT ON PURPOSE, mirroring lib/auth/idle-timeout.ts's split from its
// component: `checkStepUp` takes claims as an OPTIONAL parameter rather than
// always reaching for cookies() itself. Passed explicitly (as the wiring test
// in tests/unit/auth/step-up-gate.test.ts does), it is a pure decision over
// data the test controls -- exactly like the exhaustive isStepUpSatisfied
// cases in step-up.test.ts, just exercised through the function real callers
// use rather than re-deriving amr arithmetic a second time. Left undefined
// (every real call site), it reads the CURRENT request's own verified claims
// via getClaims() -- never a hand-decoded cookie, for the same reason
// step-up.ts insists on it: only getClaims() revalidates the JWT with the
// auth server rather than trusting whatever the cookie claims.
import { createClient } from "@/lib/supabase/server";
import { isStepUpSatisfied, readAuthFreshness } from "./step-up";
import type { StepUpPurpose } from "./step-up-purposes";

export async function checkStepUp(
  claims?: Record<string, unknown> | null,
): Promise<boolean> {
  let resolvedClaims = claims;
  if (resolvedClaims === undefined) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    resolvedClaims = data?.claims;
  }
  return isStepUpSatisfied(readAuthFreshness(resolvedClaims));
}

/**
 * The database's half of step-up (Phase 10 Task 6, G13). Call it ONLY right
 * after checkStepUp() passes and before the gated RPC or insert, which spends
 * it: public.mint_step_up_token() records one single-use, five-minute token
 * for this user and `purpose`, and refuses unless the request carries the
 * server mark, so a browser holding the session cannot mint one itself.
 * False when the database refused; the caller treats that as the step-up
 * refusal it is. tests/unit/security/step-up-token-callers.test.ts holds
 * every checkStepUp() caller to this.
 */
export async function mintStepUpToken(purpose: StepUpPurpose): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mint_step_up_token", { p_purpose: purpose });
  if (error) {
    console.error("[step-up] the database refused a step-up token:", error.code, error.hint ?? error.message);
  }
  return !error;
}

/**
 * True when the CURRENT session's verified claims say `aal: "aal2"`.
 *
 * Phase 8 Task 9c job 3b: closing a workspace needs BOTH a fresh credential
 * (checkStepUp, above) and an aal2 session. public.close_my_workspace()
 * refuses aal1 itself (`close_needs_step_up`), so this is the app-side half
 * that turns that refusal into a sentence before the round trip. Read through
 * getClaims() for the same reason checkStepUp is. NOT the enforcement.
 */
export async function sessionIsAal2(
  claims?: Record<string, unknown> | null,
): Promise<boolean> {
  let resolvedClaims = claims;
  if (resolvedClaims === undefined) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    resolvedClaims = data?.claims;
  }
  return resolvedClaims?.aal === "aal2";
}

// ===========================================================================
// FIX ROUND 1, IMPORTANT 4: what PROOF should the re-auth prompt actually
// ask for?
// ===========================================================================
// The original version always asked for a password, via signInWithPassword.
// Three problems, all traced to that one call:
//
//   1. A Google-SSO-only user has no usable password at all -- every attempt
//      fails, forever. CLAUDE.md § Session security: "Google sign-in ships at
//      MVP." lib/auth/step-up.ts:156-160 already reasons about this exact gap
//      for the password-CHANGE flow; the generic step-up gate didn't.
//   2. CLAUDE.md's own wording is "re-enter credentials/MFA". For the exact
//      roles step-up protects (the same ones lib/auth/mfa-gate.ts requires
//      TOTP for), a password is the WEAKER of the two proofs available, and
//      signInWithPassword() returns an aal1 session -- so step-up would
//      DOWNGRADE an MFA user's assurance level on every use.
//   3. signInWithPassword() mints a brand-new auth.sessions row, restarting
//      the 12h absolute-lifetime clock this same task's other half exists to
//      bound. A user prompted for step-up every ~5 minutes of sensitive work
//      could extend their session indefinitely.
//
// VERIFIED (not assumed) that MFA re-verification avoids problem 3: enrolled
// a TOTP factor on a live session, then called challengeAndVerify() with a
// real generated code -- the resulting token's `session_id` claim was
// IDENTICAL, and auth.sessions.created_at for that row was UNCHANGED (only
// `aal`/`updated_at` moved). Full session_id/created_at figures are recorded
// in the fix-round-1 section of the Task 7 report. This is also why
// lib/auth/mfa-gate.ts's evaluateMfaGate() can safely treat an MFA challenge
// as "the same session, now at aal2" rather than a new sign-in event.
//
// So: prefer MFA when the caller has a verified factor (solves 2 and 3 at
// once); fall back to password only when they don't; and when they have
// NEITHER a factor NOR a password-capable identity, say so honestly instead
// of presenting a password field that can never succeed (solves 1).
export type StepUpProofMode =
  | { mode: "mfa"; factorId: string }
  | { mode: "password" }
  | { mode: "unavailable" };

/**
 * The pure decision, extracted from stepUpProofMode() below.
 *
 * EXTRACTED FOR THE SAME REASON lib/auth/mfa-gate.ts extracts
 * roleCheckRequiresMfa()/platformAdminCheckRequiresMfa(): the fail-closed
 * direction is the whole point of the function and it must be assertable
 * directly (tests/unit/auth/step-up-gate.test.ts) rather than by trying to
 * provoke a genuine listFactors() failure through a live stack. The network
 * calls and the log line stay in stepUpProofMode(); this decides.
 */
export function proofModeFor(input: {
  factorId: string | null;
  factorsError: { message: string } | null;
  hasEmailIdentity: boolean;
}): StepUpProofMode {
  // FAIL CLOSED. See the long note above stepUpProofMode() for why "we could
  // not list the factors" must never fall through to the weaker password
  // proof.
  if (input.factorsError) return { mode: "unavailable" };
  if (input.factorId) return { mode: "mfa", factorId: input.factorId };
  return input.hasEmailIdentity ? { mode: "password" } : { mode: "unavailable" };
}

/**
 * Which proof the re-auth prompt should ask for, for the CURRENT signed-in
 * caller. Not cached: unlike lib/auth/mfa-gate.ts's per-request checks, this
 * only runs when the gate has already decided step-up is needed at all, so
 * there is at most one call per render of the prompt.
 */
export async function stepUpProofMode(): Promise<StepUpProofMode> {
  const supabase = await createClient();

  const { data: factors, error: factorsError } =
    await supabase.auth.mfa.listFactors();

  // FAIL CLOSED on a determination error, matching lib/auth/mfa-gate.ts.
  //
  // The original code fell through to the password branch here, which is the
  // wrong direction and was inconsistent with the sibling file written in the
  // same round. A transient listFactors() failure is indistinguishable from
  // "no factor enrolled", so falling through means a single blip silently
  // DOWNGRADES an MFA user's step-up from "present your factor" to "type your
  // password" -- and CLAUDE.md § Session security is explicit that the roles
  // step-up protects are exactly the roles that must hold a factor. Worse, a
  // password proof mints an aal1 session (see problem 2 above), so the
  // downgrade would also drop the caller's assurance level on the way past a
  // gate that exists to raise it.
  //
  // "unavailable" is the honest answer: we could not establish what proof this
  // caller can give, so we ask for none and grant nothing. The prompt says so
  // rather than presenting a password field that would quietly be the weaker
  // path. Callers treat it as a refusal, which is what it is.
  if (factorsError) {
    console.error(
      "[step-up] listFactors() failed; failing CLOSED (no proof mode offered) rather than silently downgrading to the weaker password proof:",
      factorsError.message,
    );
    return proofModeFor({
      factorId: null,
      factorsError: { message: factorsError.message },
      hasEmailIdentity: false,
    });
  }

  // No verified factor. Password is only a real option for an account that
  // has an email/password identity at all -- a pure Google-SSO signup has
  // ONLY a 'google' entry in `identities` and no 'email' entry whatsoever.
  // This is a different, more reliable signal than the one lib/auth/step-up.ts
  // deliberately treats as unobservable (whether an email-identity account's
  // password is *usable yet*, for an invitee mid-setup) -- this gate only
  // ever runs for an already-active, already-signed-in user, so "is there an
  // email identity at all" is the question that matters here.
  const { data: userData } = await supabase.auth.getUser();
  const hasEmailIdentity =
    userData.user?.identities?.some((identity) => identity.provider === "email") ??
    false;

  return proofModeFor({
    factorId: factors?.totp[0]?.id ?? null,
    factorsError: null,
    hasEmailIdentity,
  });
}
