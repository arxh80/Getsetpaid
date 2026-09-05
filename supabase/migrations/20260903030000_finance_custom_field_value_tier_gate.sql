-- Phase 5 (Finance), post-review fix I1: the FINANCE MODULE tier gate reaches
-- the finance CUSTOM-FIELD VALUE write path.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- 20260903020000's header § (d) argued that the finance-module gate lands on
-- `financial_entry` custom-field VALUE writes "for free", because a value can
-- only be written against a row entity_is_manageable() and entity_is_live()
-- both resolve to, and "a Starter org therefore has no financial_entries rows
-- at all".
--
-- That is true of an organisation that was NEVER Pro. It is FALSE of the exact
-- case Q67 exists to describe: a Pro organisation that DOWNGRADES keeps its
-- financial_entries rows -- by design, because "downgrading must never silently
-- delete data" (CLAUDE.md § Permissions) and because Q67 makes finance READS
-- survive a downgrade. Measured on the live database before this file was
-- written (Constraint 13):
--
--   * the three deployed custom_field_values WRITE policies carry
--     private.crm_write_organisations() as their tier term, NOT
--     private.finance_module_organisations();
--   * subscription_plans: starter is crm_writes=t, finance_module=f;
--   * the entity_is_manageable 'financial_entry' arm carried only
--     permitted_organisations('manage_finance') -- no tier term at all.
--
-- So on a DOWNGRADED organisation a Finance/Owner/Admin user at aal2 could
-- still INSERT/UPDATE/DELETE custom_field_values rows against its surviving
-- finance lines: a finance write that survives the downgrade, contradicting
-- Q67's "writes refuse, reads survive" and leaving one surface of the phase's
-- "three independent gates" claim without its tier gate.
--
-- NOT EXPLOITABLE TODAY, and that is precisely why it is fixed now:
-- create_organisation() writes no subscription row, so
-- finance_module_organisations()' `s.organisation_id is null` escape matches
-- every organisation and every branch of this is inert. Phase 7 removes that
-- escape. A hole that only opens when the escape is removed is a hole Phase 7
-- inherits silently.
--
-- ===========================================================================
-- THE FIX: ONE CONJUNCT, ON THE WRITE/MANAGEABLE PATH ONLY
-- ===========================================================================
-- `and e.organisation_id in (select private.finance_module_organisations())`
-- is added to the 'financial_entry' arm of private.entity_is_manageable() and
-- to NOTHING ELSE:
--
--   * NOT to entity_is_visible's arm. READS SURVIVE A DOWNGRADE (Q67) -- the
--     financial_entries SELECT policy itself carries no finance_module term
--     either, and the custom-field values of a line the caller can still read
--     must stay readable for the same reason the line does. Putting the tier
--     term on the read dispatch would hide data on downgrade, which is the
--     failure mode "never silently delete data" is about.
--   * NOT to entity_is_live's arm. That function deliberately carries no
--     permission or entitlement term (its own comment says so); it is ANDed
--     with entity_is_manageable, which now carries both.
--   * NOT to any other arm. financial_entry is the one entity whose module is
--     tier-gated; company/contact/agency/artist/venue/event writes are gated on
--     crm_writes, which the custom_field_values write policies already carry.
--
-- This mirrors public.financial_entries' own policies exactly (20260903003000):
-- SELECT = permitted_organisations('view_finance') alone; INSERT/UPDATE =
-- permitted_organisations('manage_finance') ∩ finance_module_organisations().
-- After this migration the value path is the same intersection as the line
-- path, which is the property the phase claims and now the property it has.
--
-- ADDITIVE (Constraint 1): `create or replace function` is the additive form
-- for a dispatch body. The body below is 20260903020000's, read back out of
-- pg_get_functiondef() on the live database and confirmed byte-identical to
-- that migration's text, plus the one conjunct and its comment. Arm count is
-- UNCHANGED at seven, so the census
-- (tests/integration/crm/entity-dispatch-branches-match-db.test.ts) and
-- schema_invariants § F2/F4 stay green; F4b below them is the new assertion
-- that this conjunct is present, with the `event` arm as its denominator.
--
-- PROVED BY:
--   supabase/tests/rls_phase5_finance.sql § FI7-FI13 -- a Pro organisation
--     writes a finance line AND a financial_entry custom-field value, is
--     downgraded to starter, and then: the value READ still returns (Q67), an
--     `artist` value write by the same session in the same instant still
--     succeeds (the non-vacuity control that says the refusal is about the
--     finance module and not about a Starter organisation that can write
--     nothing), and the financial_entry value write is REFUSED.
--   supabase/tests/schema_invariants.sql § F4b -- the structural half.
--   tests/integration/crm/finance-custom-field-values-rls.test.ts -- the same
--     chain through public.set_custom_field_values(), the RPC the application
--     actually calls, replacing the test that "proved" Starter safety by
--     writing against a nonexistent line id.
-- ---------------------------------------------------------------------------
create or replace function private.entity_is_manageable(
  p_entity_type text, p_entity_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    when 'company' then exists (
      select 1 from public.companies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_contacts'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_artists'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_venues'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    -- PHASE 3 TASK 2. The key this names is seeded by 20260901010000.
    when 'event' then exists (
      select 1 from public.events e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_events'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    -- PHASE 5 TASK 3, TIER-GATED BY THE POST-REVIEW FIX I1 (20260903030000).
    -- The write key is `manage_finance` (seeded by Task 1, 20260903000000).
    -- NO owner/full_scope disjunction -- public.financial_entries has no
    -- owner_user_id column and finance roles are full-scope, so this is the
    -- shape financial_entries' own UPDATE policy uses. This is the arm the
    -- three custom_field_values write policies dispatch through for a
    -- financial_entry value.
    --
    -- THE finance_module CONJUNCT IS THE TIER GATE, and it is on the
    -- MANAGEABLE (write) dispatch only -- entity_is_visible's arm deliberately
    -- has none, because finance READS survive a downgrade (Q67), exactly as
    -- public.financial_entries' own SELECT policy has no tier term while its
    -- INSERT/UPDATE policies do. Without it, an organisation that downgraded
    -- from Pro kept the ability to write custom-field values against the
    -- finance lines it is no longer allowed to edit.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_finance'))
        and e.organisation_id in (select private.finance_module_organisations()))
    else false
  end;
$$;

comment on function private.entity_is_manageable(text, uuid, uuid) is
  'Polymorphic write dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may write. The permission key is chosen by entity type -- company/contact/agency -> manage_contacts, artist -> manage_artists, venue -> manage_venues, event -> manage_events, financial_entry -> manage_finance -- so that mapping lives here rather than in twelve policies. Same organisation comparison, same reason, as entity_is_visible. SEVEN branches since Phase 5 Task 3 (20260903020000 added ''financial_entry''). The financial_entry arm ALSO carries private.finance_module_organisations() since 20260903030000 (post-review fix I1): it is the one entity type whose module is tier-gated, and without that conjunct a Pro organisation that downgraded to Starter kept the ability to write custom-field VALUES against its surviving finance lines -- a finance write that survived the downgrade. The tier term is on this dispatch only and NOT on entity_is_visible''s arm, because finance reads survive a downgrade (Q67), mirroring public.financial_entries'' own policies. Backs custom_field_values'' write policies (a Finance user filling in a finance line''s custom fields does so via manage_finance, NOT via manage_custom_fields, which governs the DEFINITION only) and merges'' insert policy. The census is tests/integration/crm/entity-dispatch-branches-match-db.test.ts; the TypeScript mirror of this key mapping is PERMISSION_FOR_ENTITY in lib/crm/custom-fields.ts, bound to the DEPLOYED catalogue by tests/integration/crm/permission-for-entity-matches-db.test.ts; the tier conjunct is asserted structurally by schema_invariants § F4b and behaviourally by rls_phase5_finance.sql § FI7-FI13.';
