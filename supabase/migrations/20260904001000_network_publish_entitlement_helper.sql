-- Phase 6 (Network), Task 1b: private.network_publish_organisations().
--
-- SUBSCRIPTION ENTITLEMENT for network publishing, the second of the five
-- terms in CLAUDE.md § Permissions' intersection (platform policy ∩
-- ENTITLEMENT ∩ role ∩ record scope ∩ exception), applied to the surface
-- CLAUDE.md § Subscription tiers gates on the `network_publish` column: Free
-- has `network_publish: false` ("No — view-only network browsing"), Starter
-- and Pro have `true` ("Yes, can publish"). This is the Free gate (Q76), and
-- it is Global Constraints N7: the tier gate is SERVER-SIDE. Publishing,
-- sending, accepting and linking are all refused by a POLICY for a Free
-- organisation, from any client, including one that never loads this
-- application. Hiding a button is never the control (Constraint 12).
--
-- ===========================================================================
-- IT IS `private.finance_module_organisations()` WITH ONE SUBSTITUTION
-- ===========================================================================
-- Copied from 20260903001000 -- itself 20260828140000 as 20260828150000 left
-- it -- with `p.finance_module` swapped for `p.network_publish`. The escape
-- branch, the `o.deleted_at is null` join, the past_due grace branch using
-- private.past_due_grace_days(), the revoke/grant pair, the
-- `stable security definer set search_path = ''` header and everything else
-- are UNCHANGED. The shape is COPIED rather than reasoned about afresh for the
-- reason 20260828140500's header gives: a divergence here is invisible today
-- (the gate is inert) and would surface only in Phase 7, during the billing
-- integration, in a schema several times this size.
--
-- ===========================================================================
-- IT IS INERT TODAY, DELIBERATELY, AND THAT IS THE WHOLE DESIGN
-- ===========================================================================
-- public.create_organisation() writes no organisation_subscriptions row, so
-- every organisation that exists resolves to "no subscription" -- which
-- `s.organisation_id is null` treats as "not yet billed, therefore not yet
-- gated", so network publishing is open in dev/MVP. A gate without that escape
-- would deny every network write in the product immediately, to every user.
-- The machinery is threaded now, while there are exactly six network write
-- policies and a test suite pointed at them, so Phase 7 removes the escape in
-- ONE clause rather than retrofitting entitlement into a larger schema during
-- the billing integration.
--
-- BECAUSE IT IS INERT, THE TEST IS THE ONLY THING THAT WILL NOTICE IF IT
-- BREAKS. THE TEST IS `supabase/tests/rls_phase6_network.sql` § NT -- the
-- network analogue of rls_phase2_crm.sql § N, shipped by Task 1 and re-asserted
-- by Task 5. It drives the machinery directly: with NO subscription row a
-- manage_network_profile holder INSERTs a profile and succeeds (the escape);
-- insert a real `free` row (network_publish=false) and the same INSERT and
-- every UPDATE refuse with 42501 while a SELECT of the pre-existing row still
-- returns it; upgrade to `starter` and writes come back. Every step paired
-- with its control. Those assertions fail if this function is reverted, if a
-- policy loses its network_publish conjunct, or if a plan row flips
-- network_publish.
--
-- FOLLOW-UPS.md § Phase 5 records the lesson this phase carries: "an inert
-- gate makes a wrong test green". Every entitlement assertion written in this
-- phase is written to be RE-READ, not just re-run, when Phase 7 removes the
-- escape -- the escape branch is what makes the "no subscription row" step
-- pass, so a Phase 7 reviewer must check that step's EXPECTED RESULT flips
-- rather than checking that the suite is still green.
--
-- GRACE: past_due keeps its paid entitlements for private.past_due_grace_days()
-- (3) days from current_period_end, exactly as crm_write_organisations() and
-- finance_module_organisations() do. private.past_due_grace_days() is reused,
-- not redefined -- it is the Phase-3-era constant bound to
-- lib/entitlements/policy.ts's PAST_DUE_GRACE_DAYS by a test. NULL-safe by
-- three-valued logic: a NULL period end makes the grace comparison NULL, which
-- is not true, which denies.
-- ---------------------------------------------------------------------------
create or replace function private.network_publish_organisations()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select m.organisation_id
  from public.organisation_memberships m
  join public.organisations o on o.id = m.organisation_id and o.deleted_at is null
  left join public.organisation_subscriptions s on s.organisation_id = m.organisation_id
  left join public.subscription_plans p on p.key = s.plan_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (
      s.organisation_id is null                                   -- not yet billed => not yet gated (the crm_write_organisations escape, mirrored)
      or (s.status = 'active' and p.network_publish)
      or (s.status = 'past_due'
          and pg_catalog.now() < s.current_period_end
              + pg_catalog.make_interval(days => private.past_due_grace_days())
          and p.network_publish)
    );
$$;

comment on function private.network_publish_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term) for NETWORK PUBLISHING: the organisations in which auth.uid() is an active member AND the organisation''s plan has network_publish (Starter and Pro -- Free is false, "view-only network browsing"). private.finance_module_organisations() with p.finance_module -> p.network_publish, everything else verbatim. Set-returning so a network policy can say `organisation_id in (select ...)` and have it hoisted into one InitPlan per statement. DELIBERATELY INERT TODAY: create_organisation() writes no subscription row, so `s.organisation_id is null` -- "not yet billed, therefore not yet gated" -- matches every existing organisation, and without that branch this gate would deny every network write in the product. Phase 7 removes the branch and backfills in one migration; supabase/tests/rls_phase6_network.sql § NT -- the network analogue of rls_phase2_crm.sql § N -- proves the machinery works while it is inert, and is written to be RE-READ when the escape goes, because an inert gate makes a wrong test green (FOLLOW-UPS.md § Phase 5).';

revoke all on function private.network_publish_organisations() from public, anon, authenticated, service_role;
grant execute on function private.network_publish_organisations() to authenticated;
