import "server-only";

// The one identity check every page under app/(app)/super/* makes of itself.
//
// ===========================================================================
// WHY THIS LIVES HERE AND NOT IN lib/auth/mfa-gate.ts
// ===========================================================================
// lib/auth/mfa-gate.ts already calls public.is_platform_admin() -- as a
// PRIVATE, unexported callerIsPlatformAdmin() -- to decide whether the MFA
// enrolment/challenge requirement applies to the caller. That is a narrower
// job than this file's: the MFA gate only needs a yes/no to pick a screen,
// and it already ran (and, for a real superuser, already forced aal2) by the
// time any app/(app)/super/* page renders at all (app/(app)/layout.tsx
// swaps <main>'s content for the enrol/challenge screen otherwise). This file
// answers a DIFFERENT question -- "may THIS page render for this caller at
// all" -- reusing the exact same RPC rather than inventing a second copy of
// it, which is the drift CLAUDE.md's "two copies in two languages" warning
// (mfa-gate.ts's own header, quoting the sibling role list) exists to avoid.
//
// ===========================================================================
// IDENTITY, NOT PERMISSION -- READ THIS BEFORE USING THIS FOR ANYTHING ELSE
// ===========================================================================
// public.is_platform_admin() is deliberately NOT aal-gated
// (20260827210000_mfa_aal_permission_gate.sql's header explains why: the MFA
// gate has to be able to ask "does this apply to me" from an aal1 session).
// So `isSuperuser()` alone answers "is this account on the allowlist",
// nothing about whether THIS SESSION may act. It is what every app/(app)/
// super/* page.tsx calls to decide whether to notFound() -- see that
// decision's own note below -- and it is NOT what authorises a read or a
// write. Every actual data access this route area performs goes through its
// own aal2-gated check: the audit_events RLS policy
// (has_platform_permission('view_audit_log')) for reads, and
// public.audit_superuser_audit_log_view()'s own internal
// has_platform_permission() check for the self-audit write. A caller who is
// on the allowlist but has not reached aal2 renders this area's chrome (no
// tenant or platform data in it) and then gets empty/refused results from
// every real query underneath -- never a page that shows anything.
//
// ===========================================================================
// WHY THE REFUSAL IS NOT DECIDED HERE
// ===========================================================================
// This module exports a predicate, not a guard. app/(app)/super/layout.tsx
// deliberately does not call it: DESIGN.md's streamed not-found contract
// (Task 1's brief, "same refusal parity as tenant routes") requires the
// notFound() call to run BELOW a route's own loading.tsx boundary, and a
// layout.tsx's body runs ABOVE the boundary its OWN segment's loading.tsx
// creates (app/(app)/[orgSlug]/layout.tsx is the precedent: its notFound()
// is the literal, non-streamed 404 named in DESIGN.md § Error pages, for
// exactly this structural reason). So every page.tsx under this segment
// calls isSuperuser() and notFound()s for itself, the same way a record
// detail page checks its own scope rather than trusting a parent layout to
// have done it -- see app/(app)/super/page.tsx and
// app/(app)/super/audit-log/page.tsx.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Is the signed-in caller on `public.platform_admins`?
 *
 * FAILS CLOSED on an RPC error: returns false (not-superuser), which is the
 * safe direction here -- the caller of this predicate is always deciding
 * whether to RENDER a superuser-only page, so "could not tell" must read as
 * "no", the same fail-closed direction lib/auth/mfa-gate.ts's own fix round 1
 * established for the identical RPC used for the opposite purpose (there,
 * "could not tell" reads as "MFA required", because that gate GRANTS entry;
 * here it reads as "not the superuser", because this one grants a page
 * render). Logged, not silent, so a real RPC outage reads as a spike of
 * refused superuser page loads in the server log rather than a mystery.
 *
 * cache()-wrapped: more than one page under this route area may call this in
 * one request as Phase 7 grows (a future nested layout, a future detail
 * page), and the RPC round trip should cost once per request, the same
 * memoisation lib/auth/index.ts's getCurrentUser()/getCurrentOrg() and
 * lib/auth/mfa-gate.ts's evaluateMfaGate() already use.
 */
export const isSuperuser = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) {
    console.error(
      "[admin] is_platform_admin() RPC failed; failing CLOSED (treating the caller as not the superuser):",
      error.message,
    );
    return false;
  }
  return data === true;
});
