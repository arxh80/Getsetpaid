-- ===========================================================================
-- PHASE 7 TASK 6c -- FIX ROUND 2, REVIEW FINDING N5: private.is_impersonating()
-- IS PRODUCTION-DEAD, SO ITS GRANT GOES.
--
-- `20260917001000` replaced it at its one production call site: the
-- `feedback.during_support_access` label is stamped from
-- private.is_impersonating_route(new.route), because the route-blind form also
-- labelled the operator's OWN /super feedback whenever a support session
-- happened to be open in another tab (fix round 1's M2). After that change
-- NOTHING in lib/, app/, components/ or any migration body calls the blind
-- form. Only the RLS suite read it, and it stayed granted `execute` to
-- `authenticated`.
--
-- ===========================================================================
-- THE DECISION: REVOKE, KEEP THE FUNCTION
-- ===========================================================================
-- It is harmless as functions go -- SECURITY DEFINER but keyed entirely on
-- (select auth.uid()), so it reports one boolean about its own caller, grants
-- nothing, and discloses nothing about anybody else. That is exactly why it
-- would have survived indefinitely: nobody auditing grants would find a reason
-- to act, and a granted, unexplained, security-relevant function is how a
-- future caller ends up reaching for the route-BLIND predicate by accident --
-- which is the bug M2 was, on the one surface that had it.
--
-- So the EXECUTE grant to `authenticated` is revoked and the function is kept:
--   * it is the honest primitive ("am I in a support session at all"), and the
--     route-scoped form is literally it plus a slug join. Deleting it would
--     make the next person needing that question write it again, probably
--     without the aal2/allowlist term;
--   * a future caller must RE-GRANT it deliberately, in a migration, which is
--     the point -- the widening becomes a decision rather than an inheritance.
--
-- No session role can call it after this. `postgres` and other superusers
-- bypass EXECUTE privileges entirely, so the RLS suite can still read it as
-- the owner if it ever needs to -- but it no longer does: § FX9/FX15 now read
-- private.is_impersonating_route(), the predicate that actually ships, which
-- makes those two assertions witnesses of production rather than of a
-- test-only function. § FX9a pins the revocation itself.
--
-- ADDITIVE. No previously applied migration is edited; the function body is
-- untouched and only its comment (per the 20260909090000 / 20260915002000 /
-- 20260917000000 precedent) and its grant change.
-- ===========================================================================

revoke execute on function private.is_impersonating() from authenticated;

comment on function private.is_impersonating() is
  'True when auth.uid() is a platform superuser (allowlisted, at aal2) with a LIVE, unexpired impersonation session -- private.impersonated_organisations()''s conditions without the organisation and permission terms. Grants nothing: it is a fact about the caller. The 60-minute time-box is evaluated here too, so an expired session reads `active` in the column and false here -- the clock is the grant (Q95). NOT CALLABLE BY ANY SESSION ROLE, and deliberately so since fix round 2 (review finding N5): it was the first stamp behind feedback.during_support_access, `20260917001000` replaced that call with the route-scoped private.is_impersonating_route(text) because the blind form labelled the operator''s own /super feedback whenever a session was open anywhere, and nothing in the application has called it since. It is KEPT as the honest primitive -- the route-scoped form is this predicate plus a slug join, and a future caller who needs "am I in a session at all" should extend this rather than rewrite the aal2/allowlist terms -- but that caller must RE-GRANT it in a migration, so widening it is a decision instead of an inheritance. If you are reaching for it to gate a LABEL or an ATTRIBUTION, you almost certainly want is_impersonating_route().';
