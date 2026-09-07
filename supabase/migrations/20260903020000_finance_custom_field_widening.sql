-- Phase 5 (Finance), Task 3: financial_entry becomes the SEVENTH custom-field
-- entity type, reusing the Phase 2 engine verbatim -- no new limit mechanism,
-- no new value store, no new dispatch machinery. This migration WIDENS the
-- shared allowlists and dispatches by one value; it does not extend them.
--
-- Method is 20260901001000's (the six-value precedent that added 'event'),
-- followed verbatim: the CHECK allowlists are drop-and-add in one ALTER per
-- table so the table is never momentarily unconstrained, and each dispatch is
-- `create or replace`d with its DEPLOYED body read out of pg_get_functiondef()
-- (NOT the migration that first created it) plus one arm.
--
-- ===========================================================================
-- (a) THE TWO CUSTOM-FIELD entity_type ALLOWLISTS GAIN 'financial_entry'
-- ===========================================================================
-- custom_field_definitions_entity_type_allowed and
-- custom_field_values_entity_type_allowed each go from SIX values to SEVEN.
-- Without this, an INSERT into custom_field_definitions or custom_field_values
-- with entity_type = 'financial_entry' raises a 23514 CHECK violation and the
-- feature does not exist for the entity this task is about. Constraint bodies
-- were read out of pg_constraint before this file was written (Constraint 13).
--
-- ===========================================================================
-- (b) merges_entity_type_allowed AND merge_candidates_entity_type_allowed ARE
--     DELIBERATELY *NOT* WIDENED -- financial entries are not dedup-screened or
--     mergeable, exactly as events are not
-- ===========================================================================
-- A finance line is not an identity: it has no email column and no identifying
-- name (a "Headliner fee" recurs on every event by design), so the only
-- auto-merge signal -- an exact, case-insensitive email match (20260829020000
-- DECISION 1) -- is unreachable by construction, and every candidate pair a
-- screen produced would be fuzzy_name noise. Widening `merges` without a
-- reachable merge path would ship a permission the product can never exercise,
-- which reads as a working control. So private.dedup_entity_table and
-- private.dedup_mergeable_columns get NO 'financial_entry' branch, lib/crm/
-- finance.ts calls no screenAfterCreate, and MERGE_ENTITY_TYPES in
-- lib/crm/dedup.ts is unchanged. Same reasoning, and same refusal, as
-- 20260901001000's header § (c) recorded for events.
--
-- ===========================================================================
-- (c) THE POLYMORPHIC DISPATCHES -- THREE ARE WIDENED, NOT TWO
-- ===========================================================================
-- The brief named entity_is_visible and entity_is_manageable. Reading the
-- DEPLOYED custom_field_values write policies out of pg_policy first
-- (Constraint 13) shows all three write policies -- insert/update/delete --
-- AND together BOTH private.entity_is_manageable() AND private.entity_is_live()
-- (the entity_is_live term was added by 20260829011000). So a financial_entry
-- custom-field VALUE write dispatches through entity_is_live() as well, and an
-- entity type with no arm there returns the function's `else false` -- a silent
-- DENY that would refuse EVERY finance custom-field value write and fail this
-- task's own acceptance test ("a Finance user writes a financial_entry value
-- and reads it back"). entity_is_live is therefore widened here too. This is a
-- correctness requirement verified against the deployed policy, not a guess;
-- the census in tests/integration/crm/entity-dispatch-branches-match-db.test.ts
-- records all three at seven arms.
--
--   entity_is_visible.financial_entry   -> view_finance    (backs the SELECT
--                                           policy, custom_field_values_select_
--                                           via_entity)
--   entity_is_manageable.financial_entry -> manage_finance  (backs all three
--                                           WRITE policies)
--   entity_is_live.financial_entry       -> deleted_at is null (ANDed into the
--                                           three WRITE policies alongside
--                                           entity_is_manageable)
--
-- NO owner_user_id/full_scope disjunction on the visible/manageable arms:
-- public.financial_entries has no owner_user_id column (measured) and finance
-- roles are full-scope, so the arm is the shape the table's OWN policies use --
-- organisation_id membership in permitted_organisations(<finance key>), nothing
-- more. entity_org_unchanged already carries a 'financial_entry' arm since
-- Task 1 (20260903000000); it is not touched here.
--
-- ===========================================================================
-- (d) TIER GATING (Q64) -- REUSED, NOT RE-INVENTED
-- ===========================================================================
-- DEFINITIONS go through the EXISTING enforce_custom_field_limit trigger and
-- private.custom_field_slot_available()/custom_field_limit() (Free 0 / Starter
-- 5 / Pro unlimited) with NO change -- the trigger is per-entity_type, so it
-- covers 'financial_entry' automatically. The finance MODULE gate is NOT
-- duplicated onto definitions.
--
-- It lands on VALUE writes instead, through the finance_module conjunct that
-- 20260903030000 (post-review fix I1) adds to the entity_is_manageable
-- 'financial_entry' arm below. A financial_entry custom-field value can only be
-- written for a row that entity_is_manageable() and entity_is_live() both
-- resolve to, and after that migration entity_is_manageable's finance arm
-- requires manage_finance AND finance_module -- the same intersection Task 1's
-- financial_entries INSERT/UPDATE policies use (20260903003000). Net: custom
-- finance fields are Pro-only, on the write path, by an explicit term.
--
-- CORRECTED, 2026-09-04 (review finding I1). THIS PARAGRAPH ORIGINALLY CLAIMED
-- THE GATE LANDED "FOR FREE", on the argument that "a Starter org therefore has
-- no financial_entries rows at all", so no bespoke gate was required. That
-- argument holds only for an organisation that was NEVER Pro. It is false for
-- the case Q67 exists to describe: a Pro organisation that DOWNGRADES KEEPS its
-- financial_entries rows (downgrading must never silently delete data), and the
-- deployed custom_field_values write policies carry
-- private.crm_write_organisations() as their tier term -- which Starter passes
-- (crm_writes=t, finance_module=f). So before 20260903030000 a downgraded
-- organisation could still write custom-field values against its surviving
-- finance lines. Inert at the time (create_organisation() writes no
-- subscription row, so the escape branch matched every org), but exactly the
-- defect Phase 7 would have inherited when the escape is removed. The fix, its
-- reasoning and its tests are in 20260903030000's header.

-- ---------------------------------------------------------------------------
-- (a) The two custom-field entity_type allowlists, six values -> seven.
--
-- drop-and-add in one ALTER per table, so the table is never momentarily
-- unconstrained -- 20260901001000 § (b), which is 20260828001132 § 2's idiom.
-- ---------------------------------------------------------------------------
alter table public.custom_field_definitions
  drop constraint custom_field_definitions_entity_type_allowed,
  add  constraint custom_field_definitions_entity_type_allowed
       check (entity_type in ('company','contact','agency','artist','venue','event','financial_entry'));

alter table public.custom_field_values
  drop constraint custom_field_values_entity_type_allowed,
  add  constraint custom_field_values_entity_type_allowed
       check (entity_type in ('company','contact','agency','artist','venue','event','financial_entry'));

comment on constraint custom_field_definitions_entity_type_allowed on public.custom_field_definitions is
  'SEVEN values since Phase 5 Task 3 (20260903020000 added ''financial_entry''). Mirrored by custom_field_values_entity_type_allowed and by CUSTOM_FIELD_ENTITY_TYPES in lib/crm/custom-fields.ts; tests/integration/crm/custom-field-entity-types-match-db.test.ts binds all three. It is NOT mirrored by merges_entity_type_allowed or merge_candidates_entity_type_allowed, which stay at five -- financial entries, like events, are not mergeable, see this migration''s header § (b).';

comment on constraint custom_field_values_entity_type_allowed on public.custom_field_values is
  'SEVEN values since Phase 5 Task 3, matching custom_field_definitions_entity_type_allowed. The dispatch in private.entity_is_visible/_manageable/_live is what actually resolves entity_id against public.financial_entries; this CHECK only bounds the vocabulary.';

-- ---------------------------------------------------------------------------
-- (b) The refusal, written where someone widening a merge allowlist will read
-- it. The comments already carry the events decision; this appends the finance
-- one so the count is not rediscovered by hand.
-- ---------------------------------------------------------------------------
comment on constraint merges_entity_type_allowed on public.merges is
  'FIVE values, DELIBERATELY. Phase 3 did NOT add ''event'' and Phase 5 did NOT add ''financial_entry'' -- both are product decisions, not omissions. Neither is dedup-screened or mergeable at MVP: a name is a FUZZY signal only (20260829020000 DECISION 1), and neither public.events nor public.financial_entries has an email column, so the exact_email branch that is the only auto-merge path is unreachable for them by construction. Every candidate pair would be fuzzy_name noise that trains users to dismiss the review queue. Widening this without a reachable merge path would ship a permission the product can never exercise. Recorded in 20260901001000''s header § (c), 20260903020000''s header § (b), and asserted by tests/integration/crm/entity-dispatch-branches-match-db.test.ts, which checks the ABSENCE of an ''event'' or ''financial_entry'' arm in dedup_entity_table and dedup_mergeable_columns.';

comment on constraint merge_candidates_entity_type_allowed on public.merge_candidates is
  'FIVE values, for the same reason as merges_entity_type_allowed -- see that constraint''s comment, 20260901001000''s header § (c) and 20260903020000''s header § (b). This is the FOURTH copy of the entity-type allowlist; it stays at five while the custom-field pair grows.';

-- ---------------------------------------------------------------------------
-- (c) The three dispatches. Bodies read out of pg_get_functiondef() on the
-- live database (each was last replaced by 20260901001000 / 20260901010000),
-- reproduced verbatim plus one 'financial_entry' arm.
-- ---------------------------------------------------------------------------
create or replace function private.entity_is_visible(
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
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    -- PHASE 3. `view_crm` is the read key for every entity type, so the event
    -- arm is the venue arm with the table swapped -- unlike the manageable
    -- dispatch, whose key differs per entity type.
    when 'event' then exists (
      select 1 from public.events e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_crm'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    -- PHASE 5 TASK 3. FINANCE IS THE EXCEPTION TO "view_crm reads everything":
    -- the read key is `view_finance`, not `view_crm`, so a Booker (view_crm, no
    -- view_finance) cannot read a finance line's custom-field values any more
    -- than they can read the line. And NO owner/full_scope disjunction --
    -- public.financial_entries has no owner_user_id column and finance roles are
    -- full-scope, matching the table's own policies.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('view_finance')))
    else false
  end;
$$;

comment on function private.entity_is_visible(text, uuid, uuid) is
  'Polymorphic read dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may read. The organisation comparison is the control that closes the cross-tenant hole in custom_field_values.entity_id and merges.winner_id/loser_id, which no foreign key can reach -- see SECURITY.md § 10. SEVEN branches since Phase 5 Task 3 (20260903020000 added ''financial_entry'', keyed on view_finance rather than view_crm). Unknown or NULL p_entity_type returns false. The census that keeps all six polymorphic dispatches honest is tests/integration/crm/entity-dispatch-branches-match-db.test.ts.';

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
    -- PHASE 5 TASK 3. The write key is `manage_finance` (seeded by Task 1,
    -- 20260903000000). NO owner/full_scope disjunction -- public.financial_
    -- entries has no owner_user_id column and finance roles are full-scope, so
    -- this is the shape financial_entries' own UPDATE policy uses. This is the
    -- arm the three custom_field_values write policies dispatch through for a
    -- financial_entry value.
    --
    -- SUPERSEDED BY 20260903030000 (review finding I1): this arm carries NO
    -- tier term, which left a downgraded (Pro -> Starter) organisation able to
    -- write finance custom-field values against its surviving lines. The
    -- replacement body adds `and e.organisation_id in (select
    -- private.finance_module_organisations())` here. This text is left as
    -- shipped -- the file is history, not the deployed definition.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_finance')))
    else false
  end;
$$;

comment on function private.entity_is_manageable(text, uuid, uuid) is
  'Polymorphic write dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may write. The permission key is chosen by entity type -- company/contact/agency -> manage_contacts, artist -> manage_artists, venue -> manage_venues, event -> manage_events, financial_entry -> manage_finance -- so that mapping lives here rather than in twelve policies. Same organisation comparison, same reason, as entity_is_visible. SEVEN branches since Phase 5 Task 3 (20260903020000 added ''financial_entry''). Backs custom_field_values'' write policies (a Finance user filling in a finance line''s custom fields does so via manage_finance, NOT via manage_custom_fields, which governs the DEFINITION only) and merges'' insert policy. The census is tests/integration/crm/entity-dispatch-branches-match-db.test.ts; the TypeScript mirror of this key mapping is PERMISSION_FOR_ENTITY in lib/crm/custom-fields.ts, bound to the DEPLOYED catalogue by tests/integration/crm/permission-for-entity-matches-db.test.ts.';

create or replace function private.entity_is_live(
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
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'contact' then exists (
      select 1 from public.contacts e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'agency' then exists (
      select 1 from public.agencies e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'artist' then exists (
      select 1 from public.artists e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'venue' then exists (
      select 1 from public.venues e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    when 'event' then exists (
      select 1 from public.events e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    -- PHASE 5 TASK 3. REQUIRED, not optional: the three custom_field_values
    -- WRITE policies AND private.entity_is_live() alongside entity_is_manageable
    -- (20260829011000), so without this arm every finance custom-field value
    -- write would hit `else false` and be silently refused. No permission or
    -- record-scope term here by design -- it is ANDed with entity_is_manageable,
    -- which carries both.
    when 'financial_entry' then exists (
      select 1 from public.financial_entries e
      where e.id = p_entity_id and e.organisation_id = p_org_id and e.deleted_at is null)
    else false
  end;
$$;

comment on function private.entity_is_live(text, uuid, uuid) is
  'Polymorphic soft-delete dispatch: true iff p_entity_id resolves to a NOT-soft-deleted row of p_entity_type in p_org_id. Deliberately carries NO permission or record-scope term -- it is ANDed with private.entity_is_manageable(), which carries both, and duplicating them would mean two places to change. Backs the three custom_field_values WRITE policies only; the SELECT policy is untouched, because a deleted entity''s page still has to render its values. SEVEN branches since Phase 5 Task 3 (20260903020000 added ''financial_entry'' -- REQUIRED, because the write policies AND this function, so a missing arm silently refuses every finance custom-field value write). Unknown or NULL p_entity_type returns false.';
