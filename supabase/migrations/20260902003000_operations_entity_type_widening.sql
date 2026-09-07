-- Phase 4 (Operations), Task 1d: the polymorphic dispatch widening.
--
-- ===========================================================================
-- THE TARGET END NEEDS NO NEW ARM -- CONFIRMED BY CENSUS, NOT ASSUMED
-- ===========================================================================
-- The four *_links tables' target end (entity_type, entity_id) is validated in
-- Task 2's policies by private.entity_is_visible / _manageable / _live. Those
-- already dispatch over exactly ('company','contact','agency','artist',
-- 'venue','event') -- Phase 3 added the 'event' arm. The link allowlist
-- (20260902002000) is precisely that set, so no target arm is missing.
--
-- Measured in this task against the live catalogue before this file was
-- written:
--
--   select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='private' and p.prokind='f'
--      and pg_get_functiondef(p.oid) like '%case p_entity_type%';
--
-- returned the SIX dispatches (dedup_entity_table, dedup_mergeable_columns,
-- entity_is_live, entity_is_manageable, entity_is_visible, entity_org_unchanged),
-- and entity_is_visible/_manageable/_live each carried exactly the six arms
-- above and no more. So this migration touches ONE function.
--
-- ===========================================================================
-- WHAT DOES NEED WIDENING: private.entity_org_unchanged, THE UPDATE GUARD
-- ===========================================================================
-- tasks, meetings, notes, documents and the four *_links tables all get an
-- UPDATE policy in Task 2, and each must pin its own (id, organisation_id)
-- immutable through WITH CHECK -- otherwise a user holding the manage key in
-- two organisations (an ordinary case under MVP multi-org membership) could
-- transfer a row between tenants on an UPDATE. So this migration adds EIGHT
-- arms: the four top-level operational entities named after the ENTITY, and
-- the four link tables named after the TABLE (matching the contact_company /
-- venue_room / event_lineup precedent -- a child/join table's arm is its table
-- name, not a CRM entity type).
--
-- public.document_versions gets NO arm: it is dormant with a SELECT-only policy
-- and NO UPDATE policy, so nothing ever calls entity_org_unchanged('document_
-- version', ...). Adding an arm for it would be a guard nobody runs (rule 13).
--
-- CUSTOM-FIELD ALLOWLISTS ARE DELIBERATELY NOT WIDENED (Q47). Tasks, meetings,
-- notes and documents do not get custom fields at MVP, so
-- custom_field_definitions_entity_type_allowed and
-- custom_field_values_entity_type_allowed stay at the six CRM entities. The
-- reversal is additive and cheap; the absence here is a decision, not an
-- oversight. Recorded in FOLLOW-UPS.md § "Phase 4 -- operations".
--
-- ADDITIVE FORM. `create or replace function` IS the additive statement for a
-- dispatch body (codebase rule 1). The body below is the LIVE body read out of
-- pg_get_functiondef() (last replaced by 20260828140000, then 20260901001000,
-- then extended with the 'event_lineup' arm by 20260901011000 -- so the file
-- that first created it is not what is deployed), reproduced verbatim with the
-- eight new arms inserted before `else false`.
-- ===========================================================================

create or replace function private.entity_org_unchanged(
  p_entity_type text, p_id uuid, p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_entity_type
    -- The top-level entities.
    when 'company' then exists (
      select 1 from public.companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'contact' then exists (
      select 1 from public.contacts e where e.id = p_id and e.organisation_id = p_org_id)
    when 'agency' then exists (
      select 1 from public.agencies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist' then exists (
      select 1 from public.artists e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue' then exists (
      select 1 from public.venues e where e.id = p_id and e.organisation_id = p_org_id)
    when 'event' then exists (
      select 1 from public.events e where e.id = p_id and e.organisation_id = p_org_id)
    -- Organisation configuration.
    when 'custom_field_definition' then exists (
      select 1 from public.custom_field_definitions e where e.id = p_id and e.organisation_id = p_org_id)
    -- IMP-3: the child/join tables that carry an UPDATE policy. Named after
    -- the TABLE, not after a CRM entity type.
    when 'contact_company' then exists (
      select 1 from public.contact_companies e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_representation' then exists (
      select 1 from public.artist_representations e where e.id = p_id and e.organisation_id = p_org_id)
    when 'artist_fee' then exists (
      select 1 from public.artist_fee_history e where e.id = p_id and e.organisation_id = p_org_id)
    when 'venue_room' then exists (
      select 1 from public.venue_rooms e where e.id = p_id and e.organisation_id = p_org_id)
    when 'custom_field_value' then exists (
      select 1 from public.custom_field_values e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 3 TASK 2, alongside event_lineup_update_via_event below.
    when 'event_lineup' then exists (
      select 1 from public.event_lineup e where e.id = p_id and e.organisation_id = p_org_id)
    -- PHASE 4 TASK 1: the four top-level operational entities (named after the
    -- entity) and the four link tables (named after the TABLE). Each carries an
    -- UPDATE policy in Task 2 that pins (id, organisation_id) through this
    -- guard. document_versions is absent on purpose -- dormant, no UPDATE.
    when 'task' then exists (
      select 1 from public.tasks e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting' then exists (
      select 1 from public.meetings e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note' then exists (
      select 1 from public.notes e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document' then exists (
      select 1 from public.documents e where e.id = p_id and e.organisation_id = p_org_id)
    when 'task_link' then exists (
      select 1 from public.task_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'meeting_link' then exists (
      select 1 from public.meeting_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'note_link' then exists (
      select 1 from public.note_links e where e.id = p_id and e.organisation_id = p_org_id)
    when 'document_link' then exists (
      select 1 from public.document_links e where e.id = p_id and e.organisation_id = p_org_id)
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations. TWENTY-ONE arms since Phase 4 Task 1: the thirteen from Phase 3 plus the four operational entities (task, meeting, note, document) and the four link tables (task_link, meeting_link, note_link, document_link -- named after the TABLE, matching contact_company / venue_room / event_lineup). document_versions has NO arm: it is dormant with no UPDATE policy. tests/integration/crm/entity-dispatch-branches-match-db.test.ts is the census that keeps this exact set honest. Fail-closed if p_id names no row.';
