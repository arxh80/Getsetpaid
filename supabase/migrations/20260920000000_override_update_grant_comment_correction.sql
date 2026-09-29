-- ===========================================================================
-- PHASE 7 TASK 7, FIX ROUND 1 -- CORRECT WHICH RPCs UPDATE THE OVERRIDE TABLES
-- ===========================================================================
-- 20260919001000 narrowed `authenticated`'s UPDATE on
-- public.organisation_billing_overrides and
-- public.organisation_feature_overrides to the three revocation columns
-- (revoked_at, revoked_by, revoked_reason). THE NARROWING IS EXACTLY RIGHT AND
-- NOTHING CHANGES HERE -- this migration corrects the sentence that justifies
-- it, which is the sentence a future reader will check a new grant against.
--
-- What that migration said:
--
--   "The two `revoke_*` RPCs write exactly three columns between them, on both
--    tables ... Nothing else in the application updates either table."
--
-- What is true: `grant_billing_override` and `grant_feature_override` ALSO
-- UPDATE these tables, in their supersede branch -- "at most one ACTIVE
-- billing override per organisation" (20260909000000) revokes the incumbent
-- before inserting the replacement, writing `revoked_at`, `revoked_by` and
-- `revoked_reason`. THE SAME THREE COLUMNS. So the column list is still
-- exactly the set of client writes, no behaviour is lost, and the only defect
-- was the header reading as though the grant path never UPDATEs at all -- a
-- reader checking a new grant against it would have been checking against a
-- census of two writers where there are four.
--
-- Corrected ADDITIVELY: 20260919001000 is committed and immutable, so its
-- `--` header stands as written and the live objects' comments carry the
-- correction. (The house precedent, 20260904007000: a `comment on` statement
-- can be reissued; a plain `--` script comment has no database object behind
-- it and can only be corrected in prose elsewhere.)
-- ===========================================================================

comment on policy organisation_billing_overrides_update_platform
  on public.organisation_billing_overrides is
  'The revoke path, and the ONLY UPDATE any client role can make on this table. THREE independent controls, in the order a request meets them. (1) THE GRANT: since 20260919001000 `authenticated` holds UPDATE on `revoked_at`, `revoked_by` and `revoked_reason` ONLY. Those three are the whole set of client writes to this table, and FOUR RPCs make them, not two (corrected by 20260920000000, which supersedes 20260919001000''s header on this point): public.revoke_billing_override() writes all three, and public.grant_billing_override() writes the same three in its supersede branch -- "at most one ACTIVE billing override per organisation" revokes the incumbent before inserting its replacement. A column added by a later migration is therefore outside the grant and fails closed with 42501 instead of inheriting a table-level grant (DECISIONS-QUEUE Q125, second instance). Grants matter separately from policies because BYPASSRLS bypasses policies and not grants. (2) THIS POLICY: has_platform_permission() says WHO (the platform superuser at aal2), private.override_transition_in_progress() says THROUGH WHAT -- true only inside a transaction opened by private.begin_override_transition(), which only the grant/revoke RPCs call -- so a raw PATCH from the operator''s own browser matches no row. (3) private.override_table_guard(), a BEFORE INSERT OR UPDATE trigger that refuses the same writes without consulting any policy. An org''s own Owner or Admin can SELECT their overrides (their entitlement resolution needs it, Q103) and can touch nothing here. There is no DELETE policy for any client role: revocation is a column write and history is never removed.';

comment on policy organisation_feature_overrides_update_platform
  on public.organisation_feature_overrides is
  'The revoke path for feature flags, identical in shape to organisation_billing_overrides_update_platform -- see that policy''s comment for the three controls, for why the UPDATE grant is the three revocation columns only (20260919001000, DECISIONS-QUEUE Q125), and for the four RPCs that write them: public.revoke_feature_override() plus public.grant_feature_override()''s supersede branch, which revokes an incumbent flag of the same key before inserting its replacement (corrected by 20260920000000). The only other difference is the permission key: manage_feature_overrides rather than manage_billing.';
