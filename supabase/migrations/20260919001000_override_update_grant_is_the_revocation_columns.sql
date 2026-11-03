-- ===========================================================================
-- PHASE 7 TASK 7 -- NARROW `authenticated`'s UPDATE ON THE TWO OVERRIDE TABLES
-- TO THE THREE REVOCATION COLUMNS.
-- ===========================================================================
-- THE SECOND INSTANCE OF THE SAME CLASS 20260919000000 CLOSED ON
-- public.incident_alerts, found by the same mechanical sweep and not by
-- reading either table -- which is the whole argument for building the
-- inventory from the catalogue rather than from what a task remembers.
--
-- `public.organisation_billing_overrides` and
-- `public.organisation_feature_overrides` each granted `authenticated`
-- TABLE-level UPDATE. As with incident_alerts, this was never a member-
-- reachable write: `*_update_platform` gates USING and WITH CHECK on
-- private.has_platform_permission() AND private.override_transition_in_
-- progress(), so a raw PATCH matches nothing even from the superuser's own
-- browser, and private.override_table_guard() refuses independently of any
-- policy. Task 7's permission matrix measures exactly that, principal by
-- principal, and finds it closed.
--
-- What a table-level grant leaves open is the slow failure: a column added by
-- a later migration is inside the grant the moment it exists, and only the
-- guard's own logic stands in the way. Fail-closed is the other way round.
--
-- WHY `UPDATE` AND NOT `INSERT`. These RPCs are SECURITY INVOKER by design
-- (Task 4's header: so the policies are the enforcement rather than dead code
-- beside a definer that bypasses RLS), which means their own statements run as
-- `authenticated` and need the grant. `grant_billing_override` /
-- `grant_feature_override` INSERT a whole row, so the INSERT grant stays as it
-- is -- narrowing it would be a column list that has to be maintained in step
-- with the table for no gain, since an INSERT names every column anyway. The
-- two `revoke_*` RPCs write exactly three columns between them, on both
-- tables: `revoked_at`, `revoked_by`, `revoked_reason`. Nothing else in the
-- application updates either table (grepped: no client writer at all outside
-- those four RPCs). So the UPDATE grant is those three, and a future column is
-- outside it.
--
-- NO BEHAVIOUR CHANGE: rls_phase7_overrides.sql's 51 assertions, the
-- /super/billing e2e walk and tests/integration/entitlements/
-- billing-override-matches-db.test.ts all drive grant -> read -> revoke ->
-- expiry through the RPCs, and all of them still pass.
-- ===========================================================================

revoke update on public.organisation_billing_overrides from authenticated;
grant update (revoked_at, revoked_by, revoked_reason)
  on public.organisation_billing_overrides to authenticated;

revoke update on public.organisation_feature_overrides from authenticated;
grant update (revoked_at, revoked_by, revoked_reason)
  on public.organisation_feature_overrides to authenticated;

comment on policy organisation_billing_overrides_update_platform
  on public.organisation_billing_overrides is
  'The revoke path, and the ONLY UPDATE any client role can make on this table. THREE independent controls, in the order a request meets them. (1) THE GRANT: since 20260919001000 `authenticated` holds UPDATE on `revoked_at`, `revoked_by` and `revoked_reason` ONLY -- the three columns public.revoke_billing_override() writes -- so a column added by a later migration is outside the grant and fails closed with 42501 instead of inheriting a table-level grant (DECISIONS-QUEUE Q125, second instance). Grants matter separately from policies because BYPASSRLS bypasses policies and not grants. (2) THIS POLICY: has_platform_permission() says WHO (the platform superuser at aal2), private.override_transition_in_progress() says THROUGH WHAT -- true only inside a transaction opened by private.begin_override_transition(), which only the grant/revoke RPCs call -- so a raw PATCH from the operator''s own browser matches no row. (3) private.override_table_guard(), a BEFORE INSERT OR UPDATE trigger that refuses the same writes without consulting any policy. An org''s own Owner or Admin can SELECT their overrides (their entitlement resolution needs it, Q103) and can touch nothing here. There is no DELETE policy for any client role: revocation is a column write and history is never removed.';

comment on policy organisation_feature_overrides_update_platform
  on public.organisation_feature_overrides is
  'The revoke path for feature flags, identical in shape to organisation_billing_overrides_update_platform -- see that policy''s comment for the three controls and why the UPDATE grant is the three revocation columns only (20260919001000, DECISIONS-QUEUE Q125). The only difference is the permission key: manage_feature_overrides rather than manage_billing.';
