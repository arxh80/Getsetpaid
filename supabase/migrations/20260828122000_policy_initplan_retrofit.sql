-- Phase 2 (Core CRM), Task 2e: wrap the four Foundation policy predicates
-- whose function call takes NO column argument in `(select ...)`, so Postgres
-- evaluates them once per statement instead of once per row.
--
-- Carried in from FOLLOW-UPS.md § "Phase 2 — Core CRM": "Wrap constant-argument
-- policy calls in (select …) so Postgres caches the InitPlan. Performance only,
-- but Phase 2 is when row counts start to matter."
--
-- ===========================================================================
-- IT IS NOT "PERFORMANCE ONLY" AT THIS SIZE. MEASURED, NOT ASSUMED.
-- ===========================================================================
-- 200,000 committed audit_events rows, VACUUM ANALYZEd (not inside an open
-- transaction -- Task 1 drew a false conclusion from a plan measured that way
-- twice, and the lesson is recorded in 20260828001134's header). The query is
-- `select count(*) from public.audit_events` as an ordinary authenticated user
-- who is NOT a platform admin, so the predicate returns false and the correct
-- answer is zero rows either way. Only the cost of arriving at it changes.
--
--   BEFORE   qual: private.has_platform_permission('view_audit_log'::text)
--
--     Aggregate (actual time=6784.454..6784.455 rows=1 loops=1)
--       Buffers: shared hit=200263
--       ->  Index Only Scan using audit_events_created_at_idx (rows=0)
--             Filter: private.has_platform_permission('view_audit_log'::text)
--             Rows Removed by Filter: 200006
--             Buffers: shared hit=200263
--     Execution Time: 6785.848 ms
--
--   AFTER    qual: (SELECT private.has_platform_permission('view_audit_log'))
--
--     Aggregate (actual time=6.340..6.340 rows=1 loops=1)
--       Buffers: shared hit=161
--       InitPlan 1
--         ->  Result (actual time=0.155..0.156 rows=1 loops=1)
--               Buffers: shared hit=1
--       ->  Index Only Scan using audit_events_created_at_idx (rows=0)
--             Filter: (InitPlan 1).col1
--             Rows Removed by Filter: 200006
--             Buffers: shared hit=161
--     Execution Time: 6.360 ms
--
-- 6785.848 ms -> 6.360 ms. 200,263 buffer hits -> 161. The function is
-- SECURITY DEFINER and reads public.platform_admins, so unwrapped it performed
-- one index lookup per row scanned; wrapped, the planner hoists it into an
-- InitPlan and evaluates it once. The row count and the answer are identical.
--
-- THE PREMISE WAS WORTH CHECKING RATHER THAN ASSUMING. Postgres does gate some
-- variable-free quals as a one-time filter, and if it had done so here the
-- follow-up would have been a no-op that should be closed rather than
-- implemented. It does not: a STABLE function call in a qual is evaluated per
-- row unless it is written as a sub-select. The BEFORE plan above is the proof.
--
-- ===========================================================================
-- WHY EXACTLY FOUR POLICIES, AND NONE OF PHASE 2's
-- ===========================================================================
-- The optimisation applies only where every argument is constant for the whole
-- statement. Enumerated from pg_policy rather than by reading the migrations,
-- every policy in `public` falls into one of three groups:
--
--   * ALREADY WRAPPED -- profiles_select_own, profiles_update_own,
--     organisation_memberships_select_own and the invited_by clause all write
--     `(select auth.uid())` already. Foundation applied the same technique to
--     the one call it had.
--   * NOT WRAPPABLE -- has_permission(organisation_id, ...),
--     private.is_active_member(id), private.shares_active_organisation(id),
--     private.membership_update_is_permitted(id, ...) and EVERY policy this
--     phase added take a COLUMN as an argument. Their value genuinely differs
--     per row and there is nothing to hoist. Wrapping one in `(select ...)`
--     would not be a slower version of the same thing, it would be wrong.
--   * CONSTANT-ARGUMENT -- the four below, all calling
--     private.has_platform_permission with a literal. This is the whole set.
--
-- So Phase 2's own policies get no benefit from this follow-up, and that is
-- worth stating plainly rather than leaving a reader to assume they did. Their
-- per-row cost is real and is documented in 20260828121000's design notes and
-- in the Task 2 report; reducing it means changing what the predicate reads,
-- not how it is written, and that is a deliberate future decision rather than
-- a formatting one.
--
-- ===========================================================================
-- `alter policy`, NOT `create or replace policy`
-- ===========================================================================
-- The follow-up and the Task 2 brief both call this "an additive
-- `create or replace policy` migration". THAT STATEMENT DOES NOT EXIST in
-- PostgreSQL -- there is no CREATE OR REPLACE form for policies in any version
-- through 17 (`create or replace policy` is a syntax error, 42601). The
-- additive way to change a policy's expression in place is `ALTER POLICY ...
-- USING ... WITH CHECK ...`, which is what this file uses: it edits no previous
-- migration, it is re-runnable, and it does not drop and re-create the policy
-- (which would leave a window, however brief, in which the table was governed
-- by one fewer policy).
--
-- ALTER POLICY replaces the named clause wholesale, so both clauses are
-- restated on the UPDATE policy even though both are identical -- omitting
-- WITH CHECK would leave the old expression in place, not clear it, which is
-- correct here but is the kind of thing that is correct by accident.

-- ---------------------------------------------------------------------------
-- organisation_subscriptions -- superuser-only billing writes, plus the second
-- SELECT policy that exists so a targeted superuser UPDATE matches rows at all
-- (see its comment in 20260826154304). Semantics are unchanged by all four
-- statements; only the evaluation count moves.
-- ---------------------------------------------------------------------------
alter policy "organisation_subscriptions_select_platform_billing"
  on public.organisation_subscriptions
  using ( (select private.has_platform_permission('manage_billing')) );

alter policy "organisation_subscriptions_insert_platform_billing"
  on public.organisation_subscriptions
  with check ( (select private.has_platform_permission('manage_billing')) );

alter policy "organisation_subscriptions_update_platform_billing"
  on public.organisation_subscriptions
  using      ( (select private.has_platform_permission('manage_billing')) )
  with check ( (select private.has_platform_permission('manage_billing')) );

-- ---------------------------------------------------------------------------
-- audit_events -- the table the measurement above was taken on, and the one
-- that will grow fastest: SECURITY.md § 7 keeps 30 days hot and up to a year
-- archived, and every high-value action in the product writes a row.
-- ---------------------------------------------------------------------------
alter policy "audit_events_select_platform_superuser"
  on public.audit_events
  using ( (select private.has_platform_permission('view_audit_log')) );
