-- Phase 3 (Events), Task 2a: the `manage_events` permission key, and the
-- `'event'` arm of private.entity_is_manageable() that names it.
--
-- ONE FILE FOR BOTH, DELIBERATELY. 20260901001000's header § (d) explains the
-- split it made and why the other half waits here:
--
--     Its event branch needs the permission key `manage_events`, which does
--     not exist in public.permissions until Task 2's 20260901010000 seeds it.
--     A key absent from the catalogue is absent from the join inside
--     private.permitted_organisations(), which returns no rows, which fails
--     closed -- so adding the branch there would be SAFE but the test
--     asserting it would be asserting a coincidence rather than a control.
--
-- So the key and the branch that names it can never exist apart: seeding the
-- key without the arm would leave every event custom-field value silently
-- unwritable, and adding the arm without the key would leave a branch that
-- denies everybody for a reason no test could tell apart from the branch
-- working.
--
-- ===========================================================================
-- WHO HOLDS IT -- founder-confirmed, DECISIONS-QUEUE § Q29, 2026-08-30
-- ===========================================================================
-- owner, admin, manager, booker, venue_manager, standard_user. SIX roles.
--
-- It is a SEPARATE KEY from manage_venues and manage_artists rather than a
-- reuse of either, and the asymmetry in the § Q2 matrix is the whole argument:
--
--   * a BOOKER holds manage_artists and NOT manage_venues. They build the
--     lineup for a show without administering the building.
--   * a VENUE MANAGER holds manage_venues and NOT manage_artists. They take a
--     booking into their own room without administering the acts.
--
-- Both of those people put on events, so neither existing key can stand in for
-- this one: `manage_venues` would lock the Booker out of their own show, and
-- `manage_artists` would lock the Venue Manager out of theirs.
--
-- NOT GRANTED, and each omission is a decision rather than an oversight:
--   * finance   -- holds view_crm and nothing else (rls_phase2_crm.sql A6).
--                  Finance READS the CRM and writes only inside the finance
--                  module, which is a later phase's surface.
--   * marketing -- holds manage_contacts and view_crm (A7). Marketing works the
--                  address book, not the calendar.
--   * read_only -- holds view_crm (A9). By definition.
--
-- `standard_user` holds it ORG-WIDE in public.role_permissions, exactly as it
-- holds manage_contacts / manage_artists / manage_venues (A8), and is narrowed
-- to their own records by the record-scope disjunction in the policy itself
-- (20260901011000). The catalogue is not where record scope lives --
-- private.full_scope_organisations() is -- and putting it here would be a
-- second, divergent copy of a rule that already has one.
--
-- `survives_suspension = false`, which is the column's DEFAULT and is written
-- out anyway. It is a WRITE key, and CLAUDE.md § Superuser dashboard / Q6 make
-- a suspended organisation read-only: today `view_crm` is the ONLY key in the
-- catalogue with `true`, and this migration does not change that.
-- rls_phase2_crm.sql M1f asserts that set by name; rls_phase3_events.sql § EI
-- drives the consequence for events, with the P11 technique.
-- ===========================================================================

insert into public.permissions (key, survives_suspension, description) values
  ('manage_events', false,
   'Write events and event lineup entries. A separate key from manage_venues and manage_artists because a Booker builds lineups without administering venues, and a Venue Manager takes bookings at their room without administering artists -- both hold this one.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner','manage_events'),
  ('admin','manage_events'),
  ('manager','manage_events'),
  ('booker','manage_events'),
  ('venue_manager','manage_events'),
  ('standard_user','manage_events')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- private.entity_is_manageable() -- the SIXTH arm.
--
-- The body below is 20260828120500's, read out of pg_get_functiondef() on the
-- live database rather than out of the migration file, plus one arm. Unlike
-- entity_is_visible -- whose event arm 20260901001000 could write by swapping
-- the table, because `view_crm` is the read key for every entity type -- this
-- dispatch's whole purpose is that THE KEY DIFFERS PER ENTITY TYPE, so the new
-- arm names the new key.
--
-- WHAT DEPENDS ON IT TODAY: the three custom_field_values write policies. A
-- Booker filling in a custom field on an event goes through `manage_events`
-- here, NOT through `manage_custom_fields` -- that key governs the DEFINITION
-- only (20260828121000's custom_field_definitions block). Without this arm the
-- `else false` fallthrough would make every custom field on every event
-- silently unwritable, which presents as an RLS bug and whose tempting fix
-- (loosening the policy) reopens the cross-tenant hole the dispatch exists to
-- close. That is the failure FOLLOW-UPS.md § "Phase 3 -- events" and
-- SECURITY.md § 10 both warn about.
--
-- IT IS NOT A TERM IN ANY EVENTS POLICY. 20260901011000's policies name
-- private.permitted_organisations('manage_events') directly, because they know
-- their own table; this dispatch exists for the POLYMORPHIC callers, which do
-- not.
-- ---------------------------------------------------------------------------
create or replace function private.entity_is_manageable(
  p_entity_type text,
  p_entity_id   uuid,
  p_org_id      uuid
)
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
    -- PHASE 3 TASK 2. The key this names is seeded IN THIS FILE, above.
    when 'event' then exists (
      select 1 from public.events e
      where e.id = p_entity_id
        and e.organisation_id = p_org_id
        and e.organisation_id in (select private.permitted_organisations('manage_events'))
        and ( e.organisation_id in (select private.full_scope_organisations())
              or e.owner_user_id = (select auth.uid()) ))
    else false
  end;
$$;

comment on function private.entity_is_manageable(text, uuid, uuid) is
  'Polymorphic write dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may write. The permission key is chosen by entity type -- company/contact/agency -> manage_contacts, artist -> manage_artists, venue -> manage_venues, event -> manage_events -- so that mapping lives here rather than in twelve policies. Same organisation comparison, same reason, as entity_is_visible. SIX branches since Phase 3 Task 2: 20260901010000 added ''event'' in the same file that seeds manage_events, because a branch naming an unseeded key fails closed and a test asserting it would be asserting a coincidence. Backs custom_field_values'' write policies (a Booker editing an artist fills in that artist''s custom fields via manage_artists, NOT via manage_custom_fields, which governs the DEFINITION only) and merges'' insert policy. The census that keeps all six polymorphic dispatches honest is tests/integration/crm/entity-dispatch-branches-match-db.test.ts; the TypeScript mirror of this key mapping is PERMISSION_FOR_ENTITY in lib/crm/custom-fields.ts, bound to the DEPLOYED catalogue by tests/integration/crm/permission-for-entity-matches-db.test.ts.';

revoke all on function private.entity_is_manageable(text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.entity_is_manageable(text, uuid, uuid) to authenticated;
