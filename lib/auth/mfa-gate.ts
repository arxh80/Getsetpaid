import "server-only";

// Whether the signed-in caller must enrol TOTP MFA before using the app, and
// whether they already have.
//
// CLAUDE.md § Session security: "MFA is required for: Platform Superuser,
// Organisation Owner, Admin, Finance." This is the gate that requirement
// implies -- if any active membership hands the caller one of those roles, or
// they are the platform superuser, and they have not verified a TOTP factor,
// they see a full gate screen (components/auth/mfa-enroll-gate.tsx) instead
// of the app, on every signed-in page.
//
// ===========================================================================
// SCOPE DECISION: "any active membership", because there is no "current org"
// yet.
// ===========================================================================
// A user's role is per-membership, not per-user -- the same person can be
// Owner in one workspace and Standard User in another. Task 8's workspace
// switcher will make "current org" a real, durable concept; until then there
// is nothing narrower to gate on than "every org this session can act in
// right now" (getActiveMemberships(), already scoped to the caller by
// lib/auth/index.ts's own user_id filter). So: MFA is required the moment ANY
// active membership carries a privileged role, gating the whole app rather
// than one workspace. This is the conservative direction to get wrong --
// re-scoping DOWN to "the current org's role only" once Task 8 exists is a
// narrowing, not a security regression to walk back.
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
// THIS IS APP-LEVEL ROUTING, NOT A DATABASE-ENFORCED REQUIREMENT -- NAMED
// RATHER THAN QUIETLY TREATED AS SUFFICIENT.
// ===========================================================================
// CLAUDE.md § Permissions: "entitlements are enforced server-side -- hiding
// UI is not enforcement." No RLS policy in this schema currently checks the
// JWT's `aal` claim, because nothing privileged enough to need it exists yet
// (no Finance module, no Superuser dashboard) -- there is no table for an
// aal2-gated policy to protect. So today, this gate genuinely IS the control:
// skip past it (e.g. hit a Server Action directly with curl) and nothing in
// the database currently stops you. That is the same class of gap the
// existing sign-in check already has (lib/supabase/middleware.ts: "easy to
// bypass by anything that talks to Supabase directly... RLS is the
// enforcement"), not a new one -- but it means the MFA requirement stays a
// UX/routing guarantee, not a cryptographic one, until a later phase adds
// aal2-gated RLS policies alongside the privileged tables this is meant to
// protect. Flagged here so nobody mistakes this file for that policy.
import { createClient } from "@/lib/supabase/server";
import { getActiveMemberships } from "./index";

/** Org roles CLAUDE.md § Session security requires MFA for. */
const MFA_REQUIRED_ROLES = new Set(["owner", "admin", "finance"]);

/**
 * True if the signed-in caller holds a role that requires MFA -- in ANY
 * active membership, or as the platform superuser. False for a signed-out
 * caller (getActiveMemberships() already returns [] for one, and
 * is_platform_admin() requires auth.uid(), so both halves fail closed to
 * "not required" rather than raising).
 */
export async function requiresMfaEnrollment(): Promise<boolean> {
  const memberships = await getActiveMemberships();
  if (memberships.some((m) => MFA_REQUIRED_ROLES.has(m.role))) return true;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  // Same fail direction as lib/auth/index.ts's hasPermission(): an error
  // here denies the CAPABILITY being checked (platform-admin status) rather
  // than locking someone out of the whole app on a transient RPC failure.
  // This is a UX gate, not the enforcement (see the file header) -- failing
  // it open on error is consistent with everywhere else in this codebase
  // that treats "could not determine" as "no" for a permission predicate.
  if (error) return false;
  return data === true;
}

/** True if the caller has at least one VERIFIED TOTP factor enrolled. */
export async function hasVerifiedTotpFactor(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return false;
  // listFactors()'s `totp` array is ALREADY filtered to verified factors --
  // an enrolled-but-not-yet-verified factor lives only in `data.all`. See
  // AuthMFAListFactorsResponse in @supabase/auth-js's types.
  return data.totp.length > 0;
}

/** The gate's one decision: block this request behind the MFA screen? */
export async function mfaGateBlocks(): Promise<boolean> {
  if (!(await requiresMfaEnrollment())) return false;
  return !(await hasVerifiedTotpFactor());
}
