-- Phase 3 (Events), Task 1b: the debts Phase 2 carried into "the migration
-- that creates public.events", discharged in the migration immediately after
-- it.
--
-- FOLLOW-UPS.md § "Phase 3 -- events" names four obligations. Three are
-- discharged here, one is REFUSED with the reason written onto the constraint
-- and re-filed in FOLLOW-UPS.md, and one arm of the fourth is deliberately
-- deferred one migration. Each is argued below.
--
-- ===========================================================================
-- (a) artist_fee_history.event_id GETS ITS TENANT-SCOPED FOREIGN KEY
-- ===========================================================================
-- 20260828001134 held the column NULL with
-- `artist_fee_history_event_id_unwritable_until_phase_3` rather than leave an
-- unvalidated uuid lying around, because ADD CONSTRAINT ... FOREIGN KEY
-- validates existing rows: one bad event_id written in the meantime turns THIS
-- migration into a failed deploy against the live hosted project. That
-- constraint's own comment in the database carries two traps, both of which
-- this file obeys:
--
--   * THE COMPOSITE FORM IS NOT OPTIONAL. A single-column
--     `foreign key (event_id) references public.events (id)` re-creates
--     exactly the cross-tenant write 20260828001132 exists to close -- a fee
--     row in org A naming an event in org B.
--   * THE `(event_id)` COLUMN LIST ON SET NULL IS NOT OPTIONAL. A bare
--     `on delete set null` on a composite key nulls EVERY referencing column
--     including organisation_id, which is NOT NULL, so deleting any referenced
--     event would fail outright with 23502. 20260828001132's header records
--     the measurement on artist_representations; it is the same mechanism.
--
-- ===========================================================================
-- (b) TWO OF THE THREE entity_type CHECK ALLOWLISTS GAIN 'event'
-- ===========================================================================
-- custom_field_definitions_entity_type_allowed and
-- custom_field_values_entity_type_allowed each go from five values to six.
-- PRD § 6.5 lists custom fields on events explicitly, so without this the
-- feature does not exist for the entity the phase is named after. The
-- constraint names were read out of pg_constraint before this file was
-- written, not copied from a plan.
--
-- ===========================================================================
-- (c) merges.entity_type IS DELIBERATELY *NOT* WIDENED -- events are not
--     dedup-screened and not mergeable in Phase 3
-- ===========================================================================
-- FOLLOW-UPS.md asks for three CHECKs. This migration discharges two and
-- refuses the third. The argument:
--
--   * 20260829020000's DECISION 1 established that a NAME is only ever a
--     FUZZY signal -- "two venues called The Social in two cities are two
--     venues" -- and that only an exact, case-insensitive EMAIL match may
--     auto-merge.
--   * An event's name is a weaker signal still. A recurring club night shares
--     its name with every previous instalment BY DESIGN; that is what a
--     residency is. So every candidate pair the screen produced would be
--     `fuzzy_name` noise.
--   * public.events has no `email` column, so the `exact_email` branch --
--     the only one that can ever auto-merge -- is unreachable for events by
--     construction. There is no reason to widen the allowlist and no signal
--     to widen it on.
--   * Widening `merges` WITHOUT wiring a reachable merge path would leave a
--     permission the product can never exercise, which is worse than a narrow
--     allowlist: it reads as a working control.
--
-- CONSEQUENCES, all of which this migration and this task carry out rather
-- than leave implied:
--   * private.dedup_entity_table and private.dedup_mergeable_columns get NO
--     'event' branch. Their comments are corrected below -- dedup_entity_table's
--     currently promises one, and that sentence is now false.
--   * public.merge_candidates_entity_type_allowed is a FOURTH copy of the
--     five-value allowlist that FOLLOW-UPS.md does not name (measured: four
--     constraints in pg_constraint match '%entity_type%'). It stays at five
--     for the same reason, and is now covered by the same written decision.
--   * lib/crm/dedup.ts's MERGEABLE_COLUMNS gains no 'event' entry, and
--     MERGE_ENTITY_TYPES stops being an alias of CUSTOM_FIELD_ENTITY_TYPES --
--     the two lists genuinely differ from this migration onwards.
--   * Phase 3's event create action does NOT call screenAfterCreate().
-- Re-filed as an open decision in FOLLOW-UPS.md § "Phase 3 -- events".
--
-- ===========================================================================
-- (d) THE POLYMORPHIC DISPATCHES -- THERE ARE SIX, NOT TWO
-- ===========================================================================
-- FOLLOW-UPS.md names two (entity_is_visible, entity_is_manageable).
-- Enumerated from the catalogue rather than from memory --
--
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='private' and p.prokind='f'
--      and pg_get_functiondef(p.oid) like '%case p_entity_type%';
--
-- -- there are SIX: entity_is_visible, entity_is_manageable, entity_is_live,
-- entity_org_unchanged, dedup_entity_table, dedup_mergeable_columns. Four
-- should know about events; two must not, per (c).
--
-- THE SPLIT ON entity_is_manageable, AND WHY IT IS NOT PEDANTRY. Its event
-- branch needs the permission key `manage_events`, which does not exist in
-- public.permissions until Task 2's 20260901010000 seeds it. A key absent from
-- the catalogue is absent from the join inside private.permitted_organisations(),
-- which returns no rows, which fails closed -- so adding the branch here would
-- be SAFE but the test asserting it would be asserting a coincidence rather
-- than a control. So: this migration widens entity_is_visible, entity_is_live
-- and entity_org_unchanged; 20260901010000 seeds `manage_events` and widens
-- entity_is_manageable IN THE SAME FILE, so the key and the branch that names
-- it can never exist apart.
--
-- tests/integration/crm/entity-dispatch-branches-match-db.test.ts is the
-- census that makes all six visible at once, and its EXPECTED map records the
-- interval: `entity_is_manageable` is listed WITHOUT 'event' until Task 2
-- flips that one line.
--
-- Each function below is re-declared with `create or replace` and its EXISTING
-- body verbatim plus one arm. The bodies were read out of pg_get_functiondef()
-- on the live database, not out of the migration that first created them --
-- entity_is_live was last replaced by 20260829011000 and entity_org_unchanged
-- by 20260828140000, so the original files are not what is deployed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (a) artist_fee_history.event_id
-- ---------------------------------------------------------------------------
alter table public.artist_fee_history
  drop constraint artist_fee_history_event_id_unwritable_until_phase_3;

alter table public.artist_fee_history
  add constraint artist_fee_history_event_fkey
    foreign key (event_id, organisation_id)
    references public.events (id, organisation_id)
    on delete set null (event_id);

comment on constraint artist_fee_history_event_fkey on public.artist_fee_history is
  'Tenant-scoped: a fee row can only name an event that agrees with it about which organisation it belongs to. Replaces artist_fee_history_event_id_unwritable_until_phase_3, the CHECK that held the column NULL from 20260828001134 until public.events existed. `on delete set null (event_id)` -- the Postgres 15+ column list is REQUIRED: a bare SET NULL on a composite key nulls organisation_id too, which is NOT NULL, so deleting any referenced event would raise 23502. A fee is a historical fact and must survive the event record being removed, which is why it is SET NULL rather than CASCADE.';

-- D3 ("every FK in public has its leading column indexed") applies to the new
-- FK. The composite order matches events_venue_id_org_idx and the other
-- Phase 3 FK-covering indexes: parent id first, because it is the selective
-- column (20260828001132 note (c) measured that shape).
create index artist_fee_history_event_id_org_idx
  on public.artist_fee_history (event_id, organisation_id);

-- ---------------------------------------------------------------------------
-- (b) The two custom-field entity_type allowlists.
--
-- drop-and-add in one ALTER per table, so the table is never momentarily
-- unconstrained: a single ALTER TABLE statement is atomic and takes one
-- ACCESS EXCLUSIVE lock rather than two. Same idiom as 20260828001132 § 2.
-- ---------------------------------------------------------------------------
alter table public.custom_field_definitions
  drop constraint custom_field_definitions_entity_type_allowed,
  add  constraint custom_field_definitions_entity_type_allowed
       check (entity_type in ('company','contact','agency','artist','venue','event'));

alter table public.custom_field_values
  drop constraint custom_field_values_entity_type_allowed,
  add  constraint custom_field_values_entity_type_allowed
       check (entity_type in ('company','contact','agency','artist','venue','event'));

comment on constraint custom_field_definitions_entity_type_allowed on public.custom_field_definitions is
  'SIX values since Phase 3 Task 1. Mirrored by custom_field_values_entity_type_allowed and by CUSTOM_FIELD_ENTITY_TYPES in lib/crm/custom-fields.ts; tests/integration/crm/custom-field-entity-types-match-db.test.ts binds all three. It is NOT mirrored by merges_entity_type_allowed or merge_candidates_entity_type_allowed, which stay at five -- events are not mergeable, see this migration''s header § (c).';

comment on constraint custom_field_values_entity_type_allowed on public.custom_field_values is
  'SIX values since Phase 3 Task 1, matching custom_field_definitions_entity_type_allowed. The dispatch in private.entity_is_visible/_manageable/_live is what actually resolves entity_id against the physical table; this CHECK only bounds the vocabulary.';

-- ---------------------------------------------------------------------------
-- (c) The refusal, written where someone widening the allowlist will read it.
-- ---------------------------------------------------------------------------
comment on constraint merges_entity_type_allowed on public.merges is
  'FIVE values, DELIBERATELY, and Phase 3 did NOT add ''event'' -- this is a product decision, not an omission. Events are not dedup-screened and not mergeable at MVP: 20260829020000 DECISION 1 makes a name a FUZZY signal only, a recurring club night shares its name with every previous instalment BY DESIGN, and public.events has no email column, so the exact_email branch that is the only auto-merge path is unreachable for events by construction. Every candidate pair would be fuzzy_name noise that trains users to dismiss the review queue. Widening this without a reachable merge path would ship a permission the product can never exercise. Recorded in 20260901001000''s header, in FOLLOW-UPS.md § "Phase 3 -- events", and asserted by tests/integration/crm/entity-dispatch-branches-match-db.test.ts, which checks the ABSENCE of an ''event'' arm in dedup_entity_table and dedup_mergeable_columns.';

comment on constraint merge_candidates_entity_type_allowed on public.merge_candidates is
  'FIVE values, for the same reason as merges_entity_type_allowed -- see that constraint''s comment and 20260901001000''s header § (c). This is the FOURTH copy of the entity-type allowlist and FOLLOW-UPS.md § "Phase 3 -- events" named only three; it is recorded here so the count is not rediscovered by hand a second time.';

-- ---------------------------------------------------------------------------
-- (d) The dispatches. Three here; entity_is_manageable in 20260901010000.
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
    else false
  end;
$$;

comment on function private.entity_is_visible(text, uuid, uuid) is
  'Polymorphic read dispatch: true iff p_entity_id resolves to a row of p_entity_type whose organisation_id equals p_org_id AND which the caller may read (view_crm + record scope). The organisation comparison is the control that closes the cross-tenant hole in custom_field_values.entity_id and merges.winner_id/loser_id, which no foreign key can reach -- see SECURITY.md § 10 and 20260827232512''s header. SIX branches since Phase 3 Task 1 (20260901001000 added ''event''). Unknown or NULL p_entity_type returns false. The census that keeps all six polymorphic dispatches honest is tests/integration/crm/entity-dispatch-branches-match-db.test.ts.';

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
    else false
  end;
$$;

comment on function private.entity_is_live(text, uuid, uuid) is
  'Polymorphic soft-delete dispatch: true iff p_entity_id resolves to a NOT-soft-deleted row of p_entity_type in p_org_id. Deliberately carries NO permission or record-scope term -- it is ANDed with private.entity_is_manageable(), which carries both, and duplicating them would mean two places to change. Backs the three custom_field_values WRITE policies only; the SELECT policy is untouched, because a deleted entity''s page still has to render its values (20260828121000 design note (g), the restore path). SIX branches since Phase 3 Task 1. Unknown or NULL p_entity_type returns false.';

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
    -- the TABLE, not after a CRM entity type. `event_lineup` is NOT here: it
    -- has no UPDATE policy until Task 2, and 20260901010000 owns adding both
    -- together for the same reason entity_is_manageable's event arm waits.
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
    else false
  end;
$$;

comment on function private.entity_org_unchanged(text, uuid, uuid) is
  'UPDATE guard: true iff the row stored under p_id (read on the statement-start snapshot, STABLE) still has organisation_id = p_org_id. Called from WITH CHECK with the NEW values, so it pins BOTH organisation_id and id immutable through the client UPDATE policies -- closing the tenant-to-tenant record transfer available to a user who holds the manage key in two organisations, which multi-org membership at MVP makes an ordinary case. TWELVE tables since Phase 3 Task 1: the five Phase 2 top-level entities plus public.events, custom_field_definitions, and the five child/join tables with an UPDATE policy. public.event_lineup joins the list in 20260901010000, alongside the UPDATE policy that needs it. Fail-closed if p_id names no row.';

-- ---------------------------------------------------------------------------
-- The two dispatches that deliberately get NO event branch.
--
-- Only their comments change. dedup_entity_table's currently ends "Phase 3
-- adds ''event'' here at the same time it widens the three CHECK allowlists
-- and entity_is_visible/manageable/live" -- that sentence is now FALSE and is
-- corrected rather than left. dedup_mergeable_columns never carried the
-- promise; it gains the decision anyway, because the two functions are read
-- together and an unexplained asymmetry invites someone to "fix" it.
-- ---------------------------------------------------------------------------
comment on function private.dedup_entity_table(text) is
  'entity_type -> physical table name, as a CLOSED allowlist over the five values merges_entity_type_allowed permits. The single source of a table identifier for the dynamic SQL in private.duplicate_probe() and public.merge_records(); every other element of those statements is a bound parameter. Unknown or NULL input returns NULL, which makes format() return NULL and the statement fail rather than producing something executable. PHASE 3 DELIBERATELY DID NOT ADD ''event'' HERE, and an earlier version of this comment promised that it would: events are not dedup-screened and not mergeable at MVP, because a recurring club night shares its name with every previous instalment by design and public.events has no email column, so the only auto-merge signal is unreachable. Full argument in 20260901001000''s header § (c) and on merges_entity_type_allowed. Adding an ''event'' branch here is a PRODUCT DECISION and turns tests/integration/crm/entity-dispatch-branches-match-db.test.ts red on purpose.';

comment on function private.dedup_mergeable_columns(text) is
  'The columns a merge may take from either record, per entity type. An ALLOWLIST: id, organisation_id, owner_user_id and the three timestamps are excluded because they are structure rather than content. Drives both the SET list of the winner update in public.merge_records() and the "fields" section of merges.field_resolution, so the record of what was discarded covers exactly the set that could be chosen. FIVE ENTITY TYPES, AND PHASE 3 DID NOT ADD ''event'' -- see private.dedup_entity_table()''s comment and 20260901001000''s header § (c). lib/crm/dedup.ts''s MERGEABLE_COLUMNS is the TypeScript mirror and gains no event entry either; MERGE_ENTITY_TYPES stopped being an alias of CUSTOM_FIELD_ENTITY_TYPES in the same change, because the two lists genuinely differ from here on.';
