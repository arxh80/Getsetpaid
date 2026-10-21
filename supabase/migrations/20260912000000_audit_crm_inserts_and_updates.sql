-- Phase 7 Task 6b: audit every INSERT and UPDATE on the eleven mutable CRM
-- tables Phase 2 opened for writing (the twelfth, public.merges, is append-only
-- and its one INSERT has been audited since 20260828141000).
--
-- DECISIONS-QUEUE Q94 scheduled this; FOLLOW-UPS.md's "Full CRM write
-- auditing" entry and SECURITY.md § 7 both said it was future work. The binding
-- precedent is 20260828141000's header and its two decisions are not reopened
-- here:
--
--   1. A TRIGGER, NOT APPLICATION CODE. `grant ... to authenticated` plus the
--      anon key in the browser makes `PATCH /rest/v1/contacts?id=eq...`
--      reachable without the Next.js app. The database is the only chokepoint;
--      an application-side audit records the writes someone remembered to route
--      through it. Task 5's I2 re-learned this at cost on a second table.
--
--   2. IDENTIFIERS AND STRUCTURE, NEVER USER-ENTERED CONTENT. audit_events is
--      readable by exactly one principal, the platform superuser, and CLAUDE.md
--      § Superuser dashboard forbids showing record content outside an
--      admin-approved impersonation. `to_jsonb(old)`/`to_jsonb(new)` on an
--      UPDATE would create a superuser-readable channel carrying every tenant's
--      CRM content, from every tenant, with no impersonation request. That
--      channel is the thing this file is designed NOT to be.
--
-- ===========================================================================
-- THE DIFF SHAPE -- what an UPDATE row may carry without breaking rule 2
-- ===========================================================================
-- Every UPDATE row carries the NAMES of the columns that changed, and, for a
-- small per-table allowlist of STRUCTURAL columns, the old and new VALUES.
-- For every other column -- names, notes, free text, monetary amounts, custom
-- field values, emails, phones, URLs, tags, socials -- the row says "`notes`
-- changed" and never what it changed from or to.
--
--   before = { "values": { <allowlisted changed column>: <old value>, ... } }
--   after  = { "changed": [ <every changed column name, sorted> ],
--              "values":  { <allowlisted changed column>: <new value>, ... } }
--
-- An INSERT row carries the same `values` projection over the whole new row:
--
--   after  = { "values": { <every allowlisted column>: <value>, ... } }
--
-- `updated_at` is excluded from `changed`: private.set_updated_at() moves it on
-- every UPDATE (20260828121500), so listing it would say nothing. An UPDATE
-- that changes no other column writes NO audit row -- there is no change to
-- account for, and a row saying "changed: []" is noise in the table whose
-- purpose is evidence. Nested under "values"/"changed" rather than flat like
-- 20260828141000's DELETE rows, so a column ever named `changed` on one of
-- these tables cannot collide with the key.
--
-- ===========================================================================
-- THE ALLOWLIST, IN ONE PLACE, AND WHY IT IS AN ALLOWLIST
-- ===========================================================================
-- private.audit_crm_value_columns(target_type) is the ONLY thing the trigger
-- reads to decide which values it may copy. A column added to one of these
-- tables later is therefore NAME-ONLY until someone edits that function and
-- justifies the addition here -- the fail-SAFE direction. A denylist of
-- sensitive columns would leak the new column's values on the day it shipped.
-- The function returns '{}' for an unknown target type: name-only, never
-- value, never an error.
--
-- What qualifies, and the justification per column (the test of each entry is
-- "could the platform superuser learn something a tenant typed from this
-- value?"):
--
--   owner_user_id                 an assignment: a user id, which the operator
--                                 can already see on organisation_memberships.
--   deleted_at                    the soft-delete/restore clock -- the whole
--                                 reason soft_deleted/restored are distinct
--                                 actions below.
--   contact_id / company_id /     foreign keys between two tenant records: the
--   artist_id / agency_id /       SHAPE of the tenant's graph, already what
--   venue_id / field_id /         20260828141000 records for the hard-DELETE
--   entity_id / event_id          rows. An id is not what the record says.
--   is_primary / is_exclusive     booleans naming a relationship's role.
--   started_at / ended_at /       dates: when a representation ran, when a fee
--   occurred_on                   was paid. A date says nothing typed.
--   currency                      a three-letter ISO code (CHECK-constrained).
--   companies.type                a CLOSED product vocabulary (promoter, venue,
--                                 agency, ...) enforced by companies_type_allowed
--                                 -- a classification the product defined, not
--                                 text the tenant wrote.
--   entity_type / field_type      closed vocabularies, CHECK-constrained.
--
-- What does NOT qualify, so it is name-only by construction (not listed in the
-- function, and it is the absence that matters): name, email, phone, title,
-- location, website, socials, tags, genres, country, city, notes, address,
-- capacity, technical_info, role, territory, amount_minor, note, key, label,
-- options, value. Two of those are worth a sentence: `capacity` is a number
-- and `key` looks like an identifier, but both are what the tenant typed
-- about their own record, and the rule is about provenance, not type.
--
-- ===========================================================================
-- SOFT-DELETE AND RESTORE ARE THEIR OWN ACTIONS
-- ===========================================================================
-- deleted_at going null -> non-null is `<target>.soft_deleted`; non-null ->
-- null is `<target>.restored`; every other change is `<target>.updated`. The
-- audit log viewer filters on exact action names, so an action the founder
-- cannot filter for is an action they cannot find -- "updated" with deleted_at
-- somewhere in the diff would bury the one transition that matters. The spelling
-- is `soft_deleted`, not `deleted`, because `contact_company.deleted` and
-- `custom_field_value.deleted` (20260828141000) already mean a HARD delete and
-- one word must not mean two things in one column.
--
-- ===========================================================================
-- THE EXEMPTION -- which writers emit no row, and why it is auth.uid()
-- ===========================================================================
-- The trigger returns early when auth.uid() is null. That exempts exactly the
-- writers that are not client actions: migrations, seeds, DBA repair, and
-- foreign-key cascades those start (ON DELETE SET NULL on owner_user_id fires
-- an UPDATE when an auth user is hard-deleted, with no session). It exempts
-- NO client path: service_role holds no grant on any of these tables
-- (20260828121000 § 5), so there is no sessionless application writer to miss.
--
-- It is auth.uid() and NOT row_security_active(), for the reason Task 5's I4
-- fix round paid for: row_security_active() is FALSE inside any SECURITY
-- DEFINER function, so a trigger keyed on it silently skips every write made
-- from inside one -- and this trigger function is itself SECURITY DEFINER
-- (it must be, to call private.log_audit_event()). auth.uid() reads
-- request.jwt.claims, which a definer context does not change. Measured in
-- rls_phase7_crm_audit.sql § CX from three positions: a raw PostgREST-shaped
-- statement, a statement inside a SECURITY DEFINER function, and a sessionless
-- one.
--
-- The organisation is resolved through a live lookup rather than named from
-- OLD/NEW directly -- 20260828160000's New-1 lesson: a row written during a
-- cascade from public.organisations may name a parent that is already gone,
-- and audit_events.organisation_id is a foreign key.
--
-- ===========================================================================
-- VOLUME, AND THE RETENTION ANSWER (Q94's second question)
-- ===========================================================================
-- One row per INSERT, one per effective UPDATE, per table. Measured on the
-- golden path in the Task 6b report and stated in SECURITY.md § 7. The name-only
-- shape keeps a row to a few hundred bytes -- an audit row is smaller than the
-- record it describes, so the audit table grows at roughly the rate of the
-- tenant tables it watches, not faster, and CLAUDE.md's 30-day hot / 1-year
-- archive lifecycle bounds it. No per-table opt-out is built: that would be
-- speculative infrastructure for a volume nobody has measured as a problem,
-- and an opt-out is a hole in the audit trail with a switch on it.

-- ---------------------------------------------------------------------------
-- 1. THE ALLOWLIST
-- ---------------------------------------------------------------------------
create or replace function private.audit_crm_value_columns(p_target_type text)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_target_type
    when 'company'                 then array['owner_user_id', 'type', 'deleted_at']
    when 'contact'                 then array['owner_user_id', 'deleted_at']
    when 'contact_company'         then array['contact_id', 'company_id', 'is_primary']
    when 'agency'                  then array['owner_user_id', 'deleted_at']
    when 'artist'                  then array['owner_user_id', 'deleted_at']
    when 'artist_representation'   then array['artist_id', 'agency_id', 'contact_id',
                                              'is_exclusive', 'is_primary',
                                              'started_at', 'ended_at', 'deleted_at']
    when 'artist_fee'              then array['artist_id', 'event_id', 'occurred_on',
                                              'currency', 'deleted_at']
    when 'venue'                   then array['owner_user_id', 'deleted_at']
    when 'venue_room'              then array['venue_id', 'deleted_at']
    when 'custom_field_definition' then array['entity_type', 'field_type', 'deleted_at']
    when 'custom_field_value'      then array['field_id', 'entity_type', 'entity_id']
    else '{}'::text[]
  end;
$$;

comment on function private.audit_crm_value_columns(text) is
  'THE ONE ALLOWLIST of columns whose VALUES a CRM INSERT/UPDATE audit row may carry (Phase 7 Task 6b). Everything else on the row is recorded by NAME only ("notes changed", never what it changed to), because audit_events is readable by the platform superuser and CLAUDE.md § Superuser dashboard keeps tenant record content off that surface. Structural columns only: ownership/assignment ids, foreign keys, booleans, dates, deleted_at, CHECK-constrained closed vocabularies. An unknown target type yields {} -- name-only, the fail-safe direction -- so a column added later is excluded until someone edits this function and justifies it in 20260912000000''s header.';

revoke all on function private.audit_crm_value_columns(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE PROJECTION: a row as jsonb, down to the allowlisted keys only
-- ---------------------------------------------------------------------------
create or replace function private.audit_crm_project(p_row jsonb, p_columns text[])
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.jsonb_object_agg(e.key, e.value)
       from pg_catalog.jsonb_each(coalesce(p_row, '{}'::jsonb)) e
      where e.key = any(coalesce(p_columns, '{}'::text[]))),
    '{}'::jsonb);
$$;

comment on function private.audit_crm_project(jsonb, text[]) is
  'Keeps only the keys named in p_columns from a to_jsonb(row) object. The keep-list comes from private.audit_crm_value_columns(); an empty list yields {}. Pure, IMMUTABLE, and the only way values enter a CRM INSERT/UPDATE audit row.';

revoke all on function private.audit_crm_project(jsonb, text[]) from public, anon, authenticated, service_role;

create or replace function private.audit_crm_columns_intersect(p_allowed text[], p_changed text[])
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.array_agg(c order by c)
       from pg_catalog.unnest(coalesce(p_allowed, '{}'::text[])) c
      where c = any(coalesce(p_changed, '{}'::text[]))),
    '{}'::text[]);
$$;

comment on function private.audit_crm_columns_intersect(text[], text[]) is
  'The allowlisted columns that actually changed on one UPDATE -- the only ones whose old/new VALUES the audit row carries. Pure set intersection, ordered.';

revoke all on function private.audit_crm_columns_intersect(text[], text[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE TRIGGER FUNCTION
-- ---------------------------------------------------------------------------
-- A SIBLING of private.audit_crm_row(), not a replacement: that function
-- carries the two hard-DELETE paths and the merges INSERT with their own flat
-- payload shape, and 20260828141000 is immutable. This one carries INSERT and
-- UPDATE with the diff shape above. One trigger argument: the target_type,
-- which is also the allowlist key and the action's prefix.
create or replace function private.audit_crm_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_target  text := tg_argv[0];
  v_columns text[];
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_action  text;
begin
  -- Sessionless writer: a migration, a seed, DBA repair, or a cascade one of
  -- them started. Not a client action and nothing to attribute -- see the
  -- header. auth.uid(), NOT row_security_active(): the latter is false inside
  -- every SECURITY DEFINER function, this one included (Task 5 I4).
  if v_actor is null then
    return null;
  end if;

  v_columns := private.audit_crm_value_columns(v_target);
  v_new     := pg_catalog.to_jsonb(new);

  if tg_op = 'INSERT' then
    perform private.log_audit_event(
      p_action          => v_target || '.created',
      p_target_type     => v_target,
      p_organisation_id => (select o.id from public.organisations o
                             where o.id = new.organisation_id),
      p_target_id       => new.id,
      p_after           => pg_catalog.jsonb_build_object(
                             'values', private.audit_crm_project(v_new, v_columns)));
    return null;
  end if;

  -- UPDATE. The changed set is every key whose value differs, updated_at
  -- excluded (the BEFORE trigger moves it on every write). `is distinct from`
  -- on jsonb treats a JSON null as a value, so null -> null is not a change
  -- and null -> 'x' is.
  v_old := pg_catalog.to_jsonb(old);
  select coalesce(pg_catalog.array_agg(n.key order by n.key), '{}'::text[])
    into v_changed
    from pg_catalog.jsonb_each(v_new) n
   where n.key <> 'updated_at'
     and (v_old -> n.key) is distinct from n.value;

  if pg_catalog.cardinality(v_changed) = 0 then
    -- Nothing but updated_at moved: a touch, not a change. No evidence to keep.
    return null;
  end if;

  v_action := v_target || case
    when 'deleted_at' = any(v_changed)
         and (v_old ->> 'deleted_at') is null
         and (v_new ->> 'deleted_at') is not null then '.soft_deleted'
    when 'deleted_at' = any(v_changed)
         and (v_old ->> 'deleted_at') is not null
         and (v_new ->> 'deleted_at') is null then '.restored'
    else '.updated'
  end;

  perform private.log_audit_event(
    p_action          => v_action,
    p_target_type     => v_target,
    p_organisation_id => (select o.id from public.organisations o
                           where o.id = new.organisation_id),
    p_target_id       => new.id,
    -- Values only for columns that BOTH changed AND are allowlisted: the
    -- intersection, so an unchanged structural column is not repeated on
    -- every row and a changed content column is never more than its name.
    p_before          => pg_catalog.jsonb_build_object(
                           'values', private.audit_crm_project(
                             v_old, private.audit_crm_columns_intersect(v_columns, v_changed))),
    p_after           => pg_catalog.jsonb_build_object(
                           'changed', pg_catalog.to_jsonb(v_changed),
                           'values',  private.audit_crm_project(
                             v_new, private.audit_crm_columns_intersect(v_columns, v_changed))));

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

comment on function private.audit_crm_change() is
  'AFTER INSERT OR UPDATE audit writer for the eleven mutable Phase 2 CRM tables (Phase 7 Task 6b). Sibling of private.audit_crm_row() (the hard-DELETE and merge paths). SECURITY DEFINER because private.log_audit_event() is granted to no client role. One trigger argument, the target_type: it is the allowlist key (private.audit_crm_value_columns), the audit target_type, and the action prefix -- <target>.created, .updated, .soft_deleted, .restored. An UPDATE row carries the NAMES of every changed column and the old/new VALUES of the allowlisted structural ones only; never user-entered content, because audit_events is superuser-readable (CLAUDE.md § Superuser dashboard). Returns early with no row when auth.uid() is null (migrations, seeds, DBA repair, sessionless cascades -- and NO client path, since service_role holds no grant on these tables), and when an UPDATE changed nothing but updated_at. auth.uid() rather than row_security_active() because the latter is false inside a SECURITY DEFINER function (Task 5 I4). The organisation is resolved by live lookup so a row written during an organisations cascade cannot violate audit_events'' foreign key (20260828160000 New-1).';

revoke all on function private.audit_crm_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. ATTACHMENT. Twenty-two triggers, one statement each, so the audited set
-- is greppable -- the 20260828121500 / 20260828141000 convention. FOR EACH ROW:
-- the audit needs each row's id and its own diff. Trigger names audit_insert /
-- audit_update sit beside the existing audit_delete on contact_companies and
-- custom_field_values without collision; merges keeps its 20260828141000
-- audit_insert and gains nothing here (append-only, no UPDATE grant).
-- ---------------------------------------------------------------------------
drop trigger if exists audit_insert on public.companies;
create trigger audit_insert after insert on public.companies
  for each row execute function private.audit_crm_change('company');
drop trigger if exists audit_update on public.companies;
create trigger audit_update after update on public.companies
  for each row execute function private.audit_crm_change('company');

drop trigger if exists audit_insert on public.contacts;
create trigger audit_insert after insert on public.contacts
  for each row execute function private.audit_crm_change('contact');
drop trigger if exists audit_update on public.contacts;
create trigger audit_update after update on public.contacts
  for each row execute function private.audit_crm_change('contact');

drop trigger if exists audit_insert on public.contact_companies;
create trigger audit_insert after insert on public.contact_companies
  for each row execute function private.audit_crm_change('contact_company');
drop trigger if exists audit_update on public.contact_companies;
create trigger audit_update after update on public.contact_companies
  for each row execute function private.audit_crm_change('contact_company');

drop trigger if exists audit_insert on public.agencies;
create trigger audit_insert after insert on public.agencies
  for each row execute function private.audit_crm_change('agency');
drop trigger if exists audit_update on public.agencies;
create trigger audit_update after update on public.agencies
  for each row execute function private.audit_crm_change('agency');

drop trigger if exists audit_insert on public.artists;
create trigger audit_insert after insert on public.artists
  for each row execute function private.audit_crm_change('artist');
drop trigger if exists audit_update on public.artists;
create trigger audit_update after update on public.artists
  for each row execute function private.audit_crm_change('artist');

drop trigger if exists audit_insert on public.artist_representations;
create trigger audit_insert after insert on public.artist_representations
  for each row execute function private.audit_crm_change('artist_representation');
drop trigger if exists audit_update on public.artist_representations;
create trigger audit_update after update on public.artist_representations
  for each row execute function private.audit_crm_change('artist_representation');

drop trigger if exists audit_insert on public.artist_fee_history;
create trigger audit_insert after insert on public.artist_fee_history
  for each row execute function private.audit_crm_change('artist_fee');
drop trigger if exists audit_update on public.artist_fee_history;
create trigger audit_update after update on public.artist_fee_history
  for each row execute function private.audit_crm_change('artist_fee');

drop trigger if exists audit_insert on public.venues;
create trigger audit_insert after insert on public.venues
  for each row execute function private.audit_crm_change('venue');
drop trigger if exists audit_update on public.venues;
create trigger audit_update after update on public.venues
  for each row execute function private.audit_crm_change('venue');

drop trigger if exists audit_insert on public.venue_rooms;
create trigger audit_insert after insert on public.venue_rooms
  for each row execute function private.audit_crm_change('venue_room');
drop trigger if exists audit_update on public.venue_rooms;
create trigger audit_update after update on public.venue_rooms
  for each row execute function private.audit_crm_change('venue_room');

drop trigger if exists audit_insert on public.custom_field_definitions;
create trigger audit_insert after insert on public.custom_field_definitions
  for each row execute function private.audit_crm_change('custom_field_definition');
drop trigger if exists audit_update on public.custom_field_definitions;
create trigger audit_update after update on public.custom_field_definitions
  for each row execute function private.audit_crm_change('custom_field_definition');

drop trigger if exists audit_insert on public.custom_field_values;
create trigger audit_insert after insert on public.custom_field_values
  for each row execute function private.audit_crm_change('custom_field_value');
drop trigger if exists audit_update on public.custom_field_values;
create trigger audit_update after update on public.custom_field_values
  for each row execute function private.audit_crm_change('custom_field_value');

-- ---------------------------------------------------------------------------
-- 5. THE INDEX THE VIEWER'S ACTION FILTER NOW NEEDS
-- ---------------------------------------------------------------------------
-- /super/audit-log filters `action = $1` and pages by (created_at desc, id
-- desc). Task 1's audit_events_created_at_id_desc_idx serves the unfiltered
-- page; for a filtered one the planner must either walk that index and discard
-- non-matching rows until it has a page (fine for a common action, a full scan
-- for a rare one once CRM writes dominate the table) or bitmap the single-column
-- audit_events_action_idx and sort every matching row (fine for a rare action,
-- a sort of the whole `contact.updated` set for a common one). One composite
-- index answers both with an ordered range scan. Measured on a 5,000-row bulk
-- fixture in the Task 6b report.
create index if not exists audit_events_action_created_at_id_desc_idx
  on public.audit_events (action, created_at desc, id desc);

comment on index public.audit_events_action_created_at_id_desc_idx is
  'The audit log viewer''s action-filtered keyset page: WHERE action = $1 ORDER BY created_at DESC, id DESC. Added in Phase 7 Task 6b when CRM INSERT/UPDATE auditing made a handful of action names dominate the table; audit_events_created_at_id_desc_idx (Task 1) still serves the unfiltered page.';
