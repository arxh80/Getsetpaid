import "server-only";

// Whether the signed-in caller must enrol TOTP MFA before using the app,
// whether they already have, and whether THIS session has actually completed
// an MFA challenge yet.
//
// CLAUDE.md § Session security: "MFA is required for: Platform Superuser,
// Organisation Owner, Admin, Finance." This is the gate that requirement
// implies -- if any active membership hands the caller one of those roles, or
// they are the platform superuser, they must both HAVE a verified TOTP factor
// (components/auth/mfa-enroll-gate.tsx) and, on every sign-in, actually
// PRESENT it (components/auth/mfa-challenge-gate.tsx) before the app renders.
//
// ===========================================================================
// FIX ROUND 1, IMPORTANT 2: enrollment alone was not enough.
// ===========================================================================
// The original version of this file stopped at "does a verified factor
// exist?". Supabase does NOT force an MFA challenge at sign-in on its own --
// signInWithPassword() happily returns an aal1 session for a user who
// enrolled TOTP weeks ago, and nothing re-prompts them. So the real gap
// was not merely "no aal2-gated RLS policy yet" (true, and still named
// below) but starker: NO SESSION EVER REACHED aal2 AT ALL after the one-time
// enrollment moment. evaluateMfaGate() below is the fix: it reads
// getAuthenticatorAssuranceLevel() and treats "a verified factor exists but
// this session is still aal1" as its own distinct outcome (a CHALLENGE
// screen), separate from "no verified factor exists" (an ENROLL screen).
//
// Verified empirically before relying on it (not assumed): enrolled a TOTP
// factor on a live session, then called mfa.challengeAndVerify() with a
// real RFC 6238 code -- the resulting access token's `session_id` claim was
// IDENTICAL to the pre-challenge token's, and auth.sessions.created_at for
// that session id was UNCHANGED (only `aal` and `updated_at` moved). So an
// MFA challenge upgrades AAL on the EXISTING session in place; it does not
// mint a new one or restart the 12h timebox clock. This is exactly why
// lib/auth/step-up-actions.ts (fix round 1, Important 4) prefers an MFA
// re-challenge over signInWithPassword() when a verified factor exists.
//
// ===========================================================================
// SCOPE DECISION: "any active membership", because there is no "current org"
// yet. UNCHANGED from the original design and reviewed/accepted as-is.
// ===========================================================================
// A user's role is per-membership, not per-user -- the same person can be
// Owner in one workspace and Standard User in another. Task 8's workspace
// switcher will make "current org" a real, durable concept; until then there
// is nothing narrower to gate on than "every org this session can act in
// right now". So: MFA (both enrollment AND the per-sign-in challenge) is
// required the moment ANY active membership carries a privileged role,
// gating the whole app rather than one workspace. This is the conservative
// direction to get wrong -- re-scoping DOWN to "the current org's role only"
// once Task 8 exists is a narrowing, not a security regression to walk back.
//
// ===========================================================================
// WHY private.has_platform_permission NEEDED A NEW PUBLIC WRAPPER
// ===========================================================================
// The task brief this file was built from describes has_platform_permission
// as "callable via supabase.rpc(...)". Checked against the actual migration
// rather than trusted: it lives in the `private` schema, which
// supabase/config.toml's api.schemas does not expose to PostgREST at all --
// tests/integration/rls/rls.test.ts section F asserts a 404 for EVERY caller,
// including the superuser's own session. public.is_platform_admin(), added in
// 20260827180000_public_is_platform_admin.sql, is the actual reachable path:
// a public-schema SECURITY DEFINER wrapper, same shape as
// public.has_permission() for the org-scoped case.
//
// ===========================================================================
// FIX ROUND 1, IMPORTANT 3: fail CLOSED, not open, on a determination error.
// ===========================================================================
// The original version returned `false` (not required) whenever the
// platform-admin RPC or the role lookup errored -- reasoned, wrongly, as
// consistent with lib/auth/index.ts's hasPermission()/getMemberships(),
// which also collapse "error" into "no". The analogy inverts here:
// hasPermission()'s "could not determine -> no" DENIES a capability; this
// gate's "could not determine -> no" GRANTS entry past THE ONLY MFA CONTROL
// THAT EXISTS. A transient PostgREST failure must not silently wave a
// privileged user through. Both halves below now fail CLOSED (treat an error
// as "yes, this applies") and log it -- deliberately NOT reusing
// getActiveMemberships()/getMemberships() from lib/auth/index.ts for the role
// check, because that function collapses "a real error occurred" and
// "genuinely zero membership rows" into the same `[]`, and callers elsewhere
// (e.g. the onboarding page) correctly want the second case to read as
// empty. This file needs to tell the two apart, so it runs its own query.
// The fail-closed DECISION itself is pulled out as roleCheckRequiresMfa()/
// platformAdminCheckRequiresMfa() -- pure functions over a {data, error}
// shape -- specifically so a unit test can assert the fail-closed direction
// directly (tests/unit/auth/mfa-gate.test.ts) rather than trying to provoke
// a real PostgREST/RPC failure through the integration harness.
//
// ===========================================================================
// FINAL FIX WAVE: THIS FILE IS NO LONGER THE ONLY THING ENFORCING MFA.
// ===========================================================================
// An earlier version of this comment said no RLS policy checked the JWT's
// `aal` claim, "because nothing privileged enough to need it exists yet -- no
// table for an aal2-gated policy to protect", and treated this render-time
// content swap as sufficient. That was wrong on its own terms:
// organisation_memberships is such a table and inviteMemberAction is such an
// action, and both shipped in this same phase. The concrete path was a stolen
// Owner password -> an aal1 session -> POST inviteMemberAction {role:"admin"},
// or, skipping the app entirely, POST /rest/v1/organisation_memberships with
// that session token and the public anon key.
//
// It is now enforced at BOTH layers, and neither is redundant:
//
//   THIS LAYER   evaluateMfaGate() still decides what app/(app)/layout.tsx
//                renders, and assertMfaSatisfied() below is called at the top
//                of every privileged Server Action. Its job is to give the
//                user a readable refusal instead of an opaque 42501, and to
//                stop the action before it does any work (inviteMemberAction
//                would otherwise create an auth.users row for the invitee
//                before the database refused the membership).
//
//   THE DATABASE supabase/migrations/20260827210000_mfa_aal_permission_gate.sql
//                puts the requirement inside public.has_permission() and
//                private.has_platform_permission(), so every write policy in
//                the schema inherits it. That is the layer that actually
//                enforces: the anon key ships in the browser bundle by design,
//                so anyone holding a session token can talk to PostgREST
//                directly, and no amount of Server Action guarding is on that
//                request's path.
//
// The two layers scope the check differently, on purpose. This file gates the
// whole app on ANY privileged membership, because it has no current org to
// scope to (see the SCOPE DECISION note above). has_permission() is handed a
// specific organisation and scopes to THAT membership's role. The app-level
// rule is the conservative routing decision; the database's is the precise
// authorisation decision. Neither is a bug in the other.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { FormState } from "@/lib/forms";
import { getCurrentUser } from "./index";

/**
 * Org roles CLAUDE.md § Session security requires MFA for.
 *
 * THIS IS ONE HALF OF A RULE THAT EXISTS TWICE. The other half is
 * private.role_requires_mfa() in
 * supabase/migrations/20260827210000_mfa_aal_permission_gate.sql, which is
 * what the permission engine actually enforces. Two copies in two languages
 * with nothing holding them together is exactly the drift that goes unnoticed
 * until it is a security incident -- and it fails silently in BOTH directions:
 * drop a role here and a privileged role stops being gated in the app; add one
 * here that SQL does not have and that role is sent to an enrolment screen for
 * a requirement the database will never enforce.
 *
 * EXPORTED SOLELY so tests/integration/mfa/roles-match-db.test.ts can assert
 * set equality against the live database. It is not part of this module's API
 * and nothing in app/ or lib/ should import it -- use requiresMfaEnrollment()
 * or roleCheckRequiresMfa() instead.
 */
export const MFA_REQUIRED_ROLES = new Set(["owner", "admin", "finance"]);

/**
 * Pure decision: given the organisation_memberships query's own {data, error}
 * shape, does the caller's role require MFA?
 *
 * EXTRACTED AS A PURE FUNCTION so fix round 1 Important 3's fail-closed rule
 * -- "an error means yes, MFA required" -- is unit-testable
 * (tests/unit/auth/mfa-gate.test.ts) without needing to provoke a genuine
 * PostgREST failure through a live integration harness. The network call and
 * logging live in callerHasPrivilegedRole() below; this is only the
 * decision.
 */
export function roleCheckRequiresMfa(result: {
  data: { role: string }[] | null;
  error: { message: string } | null;
}): boolean {
  if (result.error) return true;
  return (result.data ?? []).some((m) => MFA_REQUIRED_ROLES.has(m.role));
}

/**
 * Pure decision: given is_platform_admin()'s own {data, error} shape, does
 * platform-superuser status require MFA? Same fail-closed reasoning and same
 * testability motive as roleCheckRequiresMfa() above.
 */
export function platformAdminCheckRequiresMfa(result: {
  data: boolean | null;
  error: { message: string } | null;
}): boolean {
  if (result.error) return true;
  return result.data === true;
}

/**
 * Does the caller hold one of MFA_REQUIRED_ROLES in any ACTIVE membership?
 *
 * A DEDICATED query rather than lib/auth/index.ts's getActiveMemberships(),
 * on purpose (fix round 1, Important 3): that function fails to `[]` on
 * BOTH a real query error and a genuine zero-membership user, which is
 * exactly right for its other callers (an onboarding page showing "no
 * workspaces yet" should look the same whether that's true or a blip) and
 * exactly wrong here, where the two cases must lead to opposite outcomes --
 * fail CLOSED (require MFA) on an error, fail OPEN (don't require it) on a
 * real empty result for a brand-new signup who hasn't joined/created an org.
 * The decision itself is roleCheckRequiresMfa() above; this is only the
 * network call, the type coercion PostgREST's untyped response needs, and
 * the error log.
 */
async function callerHasPrivilegedRole(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false; // no session at all; AppLayout redirects before this runs.

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organisation_memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("status", "active");

  const required = roleCheckRequiresMfa({
    data: (data as { role: string }[] | null) ?? null,
    error: error ? { message: error.message } : null,
  });
  if (error) {
    console.error(
      "[mfa-gate] organisation_memberships lookup failed; failing CLOSED (treating as MFA-required) rather than silently granting entry:",
      error.message,
    );
  }
  return required;
}

/** Is the caller the platform superuser, per public.is_platform_admin()? */
async function callerIsPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");

  const required = platformAdminCheckRequiresMfa({
    data: (data as boolean | null) ?? null,
    error: error ? { message: error.message } : null,
  });
  if (error) {
    console.error(
      "[mfa-gate] is_platform_admin() RPC failed; failing CLOSED (treating as MFA-required) rather than silently granting entry:",
      error.message,
    );
  }
  return required;
}

/**
 * True if the signed-in caller holds a role that requires MFA -- in ANY
 * active membership, or as the platform superuser. Wrapped in React's
 * `cache()` (fix round 1, Minor) so the two network round trips it makes
 * happen once per request rather than once per call site, the same
 * memoisation lib/auth/index.ts's getMemberships()/getCurrentUser() already
 * use.
 */
export const requiresMfaEnrollment = cache(async (): Promise<boolean> => {
  if (await callerHasPrivilegedRole()) return true;
  return callerIsPlatformAdmin();
});

/** The id of the caller's first verified TOTP factor, or null if none. */
async function verifiedTotpFactorId(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return null;
  // listFactors()'s `totp` array is ALREADY filtered to verified factors --
  // an enrolled-but-not-yet-verified factor lives only in `data.all`. See
  // AuthMFAListFactorsResponse in @supabase/auth-js's types.
  return data.totp[0]?.id ?? null;
}

export type MfaGateResult =
  | { kind: "pass" }
  | { kind: "enroll" }
  | { kind: "challenge"; factorId: string };

/**
 * The gate's one decision, cached per request. Three outcomes:
 *
 *   pass       MFA doesn't apply to this caller, or this SESSION has already
 *              reached aal2 (a challenge was completed since sign-in).
 *   enroll     MFA applies and no verified TOTP factor exists yet.
 *   challenge  MFA applies, a verified factor exists, but THIS session is
 *              still aal1 -- render the code-only challenge screen, not the
 *              QR/enrollment screen (they already have a factor; scanning a
 *              new QR would be enrolling a second one for no reason).
 *
 * getAuthenticatorAssuranceLevel() failing is treated the same as
 * "no verified factor" (-> enroll) rather than "pass": per Important 3's
 * fail-closed rule, an error determining assurance level must not be read as
 * "already satisfied".
 */
export const evaluateMfaGate = cache(async (): Promise<MfaGateResult> => {
  if (!(await requiresMfaEnrollment())) return { kind: "pass" };

  const supabase = await createClient();
  const { data: aal, error: aalError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalError || !aal) {
    console.error(
      "[mfa-gate] getAuthenticatorAssuranceLevel() failed; failing toward the stricter 'enroll' screen rather than passing the user through:",
      aalError?.message,
    );
    return { kind: "enroll" };
  }

  if (aal.currentLevel === "aal2") return { kind: "pass" };

  // currentLevel is aal1. nextLevel === 'aal2' means a verified factor
  // exists and an upgrade is POSSIBLE -- i.e. a challenge, not an enrollment,
  // is what's missing.
  if (aal.nextLevel !== "aal2") return { kind: "enroll" };

  const factorId = await verifiedTotpFactorId();
  if (!factorId) {
    // nextLevel said aal2 was reachable but listFactors() disagrees --
    // shouldn't happen, but if it does, the stricter screen is the safe
    // default rather than silently passing the user through.
    return { kind: "enroll" };
  }

  return { kind: "challenge", factorId };
});

/**
 * The Server Action guard. Returns null to allow, or the FormState to hand
 * straight back to the form.
 *
 * ONE SOURCE OF TRUTH, DELIBERATELY. This is a thin adapter over
 * evaluateMfaGate() and nothing more -- it re-derives no part of "does this
 * caller need MFA". A second implementation of that question would drift from
 * this one, and the two would disagree in exactly the situation neither was
 * tested for. Everything the gate already reasons about (fail-closed on a
 * determination error, enrol vs challenge, the cache() wrapper that keeps a
 * layout render and an action in the same request down to one pair of round
 * trips) applies here unchanged.
 *
 * WHICH ACTIONS CALL THIS, and why the others deliberately do not:
 *
 *   GATED   createOrganisationAction, inviteMemberAction, acceptInviteAction
 *           -- every Server Action in the branch that performs a privileged
 *           tenant write. Note none of them is a chicken-and-egg: a caller
 *           who is refused here is refused precisely BECAUSE they already
 *           hold a privileged role, which means the enrolment screen is
 *           already what the app layout is rendering for them. They enrol,
 *           they retry, it works.
 *
 *   NOT GATED, on purpose:
 *     mfaEnrollStepAction / mfaChallengeAction -- these ARE the enrolment and
 *       challenge. Gating them is the lockout: no privileged user could ever
 *       reach aal2, forever, with no path back in.
 *     reauthenticateAction -- the step-up prompt, whose MFA branch is one of
 *       the ways a session reaches aal2. Same reason.
 *     signIn/signUp/magicLink/signInWithGoogle/signOut -- pre-session, or the
 *       way out. Gating sign-out in particular would trap a user in a session
 *       they cannot leave.
 *     completeAccountSetupAction -- writes only the caller's OWN password and
 *       profile name, no tenant data, and already has its own fail-closed
 *       step-up gate (passwordChangeGate, lib/auth/actions.ts). It is also the
 *       screen an invited Admin must pass through BEFORE they can accept the
 *       invite that makes them privileged, so gating it would put a gate in
 *       front of the account it is meant to protect.
 *     switchWorkspaceAction / recordCurrentOrgAction -- navigation state (a
 *       cookie), no tenant write. Both already re-derive the target from the
 *       caller's own RLS-filtered membership list.
 */
export async function assertMfaSatisfied(): Promise<FormState | null> {
  const gate = await evaluateMfaGate();
  if (gate.kind === "pass") return null;

  // ONE message for both refusal kinds. "Set one up" and "enter your code"
  // differ by whether this account already has a factor enrolled -- account
  // metadata, and the caller is on a path they are not authorised to be on.
  // The app layout is already rendering the right screen for whichever case
  // they are actually in, so the message only has to point them at it.
  return {
    error:
      "Your role requires two-step verification. Set it up, or enter your code, before making this change.",
  };
}
