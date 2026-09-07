-- Phase 5 (Finance), Task 1b: private.finance_module_organisations().
--
-- SUBSCRIPTION ENTITLEMENT for the finance module, the second of the five
-- terms in CLAUDE.md § Permissions' intersection (platform policy ∩
-- ENTITLEMENT ∩ role ∩ record scope ∩ exception), applied to the one surface
-- CLAUDE.md § Subscription tiers gates on the `finance_module` column: Free and
-- Starter have `finance_module: false`, Pro has `true`. This is the Pro gate.
--
-- ===========================================================================
-- IT IS `private.crm_write_organisations()` WITH TWO SUBSTITUTIONS
-- ===========================================================================
-- Copied from 20260828140000 as 20260828150000 left it (the three-way status
-- gate), with `p.crm_writes` swapped for `p.finance_module` and the past-due
-- grace branch carried over from custom_field_limit's tier helper. The escape
-- branch, the deleted_at join, the aal2-via-permitted_organisations story and
-- everything else are unchanged. The shape is COPIED rather than reasoned about
-- afresh for the reason 20260828140500's header gives: a divergence here is
-- invisible today (the gate is inert) and would surface only in Phase 7.
--
-- ===========================================================================
-- IT IS INERT TODAY, DELIBERATELY, AND THAT IS THE WHOLE DESIGN
-- ===========================================================================
-- public.create_organisation() writes no organisation_subscriptions row, so
-- every organisation that exists resolves to "no subscription" -- which
-- `s.organisation_id is null` treats as "not yet billed, therefore not yet
-- gated", so finance is open in dev/MVP. A gate without that escape would deny
-- every finance write in the product immediately, to every user. The machinery
-- is threaded now, while there are exactly three finance write policies and a
-- test suite pointed at them, so Phase 7 removes the escape in ONE clause
-- rather than retrofitting entitlement into a larger schema during the billing
-- integration.
--
-- BECAUSE IT IS INERT, THE TEST IS THE ONLY THING THAT WILL NOTICE IF IT
-- BREAKS. Task 4's finance analogue of rls_phase2_crm.sql § N drives it
-- directly: with NO subscription row a finance write succeeds; insert a real
-- `starter` row (finance_module=false) and the same INSERT/UPDATE refuse with
-- 42501 while a SELECT of a pre-existing row still returns it; upgrade to `pro`
-- and writes come back. Those assertions fail if this function is reverted, if
-- a policy loses its finance_module conjunct, or if a plan row flips
-- finance_module.
--
-- GRACE: past_due keeps its paid entitlements for private.past_due_grace_days()
-- (3) days from current_period_end, exactly as crm_write_organisations() does.
-- private.past_due_grace_days() is reused, not redefined -- it is the Phase-3-
-- era constant bound to lib/entitlements/policy.ts's PAST_DUE_GRACE_DAYS by a
-- test. NULL-safe by three-valued logic: a NULL period end makes the grace
-- comparison NULL, which is not true, which denies.
-- ---------------------------------------------------------------------------
create or replace function private.finance_module_organisations()
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
      or (s.status = 'active' and p.finance_module)
      or (s.status = 'past_due'
          and pg_catalog.now() < s.current_period_end
              + pg_catalog.make_interval(days => private.past_due_grace_days())
          and p.finance_module)
    );
$$;

comment on function private.finance_module_organisations() is
  'Subscription entitlement (CLAUDE.md § Permissions, second term) for the FINANCE MODULE: the organisations in which auth.uid() is an active member AND the organisation''s plan has finance_module (Pro only -- Free and Starter are false). private.crm_write_organisations() with p.crm_writes -> p.finance_module and the past_due grace branch. Set-returning so a finance policy can say `organisation_id in (select ...)` and have it hoisted into one InitPlan per statement. DELIBERATELY INERT TODAY: create_organisation() writes no subscription row, so `s.organisation_id is null` -- "not yet billed, therefore not yet gated" -- matches every existing organisation, and without that branch this gate would deny every finance write in the product. Phase 7 removes the branch and backfills in one migration; Task 4''s finance analogue of rls_phase2_crm.sql § N proves the machinery works while it is inert.';

revoke all on function private.finance_module_organisations() from public, anon, authenticated, service_role;
grant execute on function private.finance_module_organisations() to authenticated;
