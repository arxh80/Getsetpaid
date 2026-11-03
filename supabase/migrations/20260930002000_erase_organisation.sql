-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 3: THE WORKSPACE PURGE PRIMITIVE.
--
-- Task 6 owns the 60-day clock (Q88); this is the thing it calls. It is here,
-- before the account erasure that also uses it, because an account erasure
-- that would leave an EMPTY, OWNERLESS workspace behind removes the workspace
-- too (Q131 -- see 20260930003000).
--
-- ===========================================================================
-- THE RULE THAT IS ENFORCED RATHER THAN WRITTEN DOWN
-- ===========================================================================
-- `session_replication_role = replica` is the usual advice for making a large
-- cascading delete fast, and it is CATASTROPHIC here. Task 3's fix-round-1
-- re-review measured it: under `replica` the referential-integrity triggers do
-- not fire, so deleting an organisation SUCCEEDS WITHOUT running
-- `data_subject_requests.routed_to_organisation_id`'s ON DELETE SET NULL and
-- leaves the column pointing at a workspace that no longer exists -- the exact
-- evidence a routed request needs, silently broken.
--
-- `phase-8-inventory.md` and `task-6-brief.md` both say "do not do this". A
-- sentence in a brief is not a control. So THIS FUNCTION REFUSES TO RUN unless
-- the session's replication role is `origin`, and Task 6 cannot reach for the
-- shortcut without first deleting that check -- which is a diff a reviewer
-- sees and a psql assertion goes red on.
--
-- ===========================================================================
-- THE ORDERING TRAPS
-- ===========================================================================
--  * `public.custom_field_values` is POLYMORPHIC with no foreign key to any
--    entity (`entity_type` + `entity_id`). Its `organisation_id` FK does
--    cascade -- MEASURED, and worth saying plainly because the inventory
--    presents the sweep as the thing standing between this and orphaned rows
--    and it is not; the cascade is. The sweep matters where the ENTITY dies
--    and the workspace lives, which is why it ships as its own callable
--    primitive with a per-type count, and why the check at the end of this
--    function is a GLOBAL orphan census rather than a count of what the sweep
--    did.
--    The allowed entity types are SEVEN, not the six the brief and the
--    inventory both say: company, contact, agency, artist, venue, event AND
--    financial_entry. The seventh is read from the live CHECK constraint
--    rather than typed out, so an eighth arrives swept instead of orphaned.
--  * `public.merges.field_resolution` holds the DISCARDED record's field
--    values verbatim -- an email address, a phone number, a private note's
--    worth of CRM data belonging to a record the workspace decided was a
--    duplicate. It is scrubbed before the delete, so that a backup taken
--    between the scrub and the delete already has nothing in it.
--  * Document BYTES survive a soft delete (Q52). They are purged by the
--    runner BEFORE this function is called, and this function REFUSES to run
--    while any of them are still there -- the row delete must not be what
--    makes the bytes unreachable-but-present.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE SEVEN ENTITY TYPES, READ FROM THE LIVE CHECK CONSTRAINT.
--
--    Not a list. `custom_field_values_entity_type_allowed` is the declaration;
--    a later migration that adds an eighth type changes this function's answer
--    on the same deploy, and the psql suite asserts the two agree.
-- ---------------------------------------------------------------------------

create or replace function private.custom_field_entity_types()
returns setof text
language sql
stable
set search_path = ''
as $$
  select t
    from pg_catalog.pg_constraint c
    cross join lateral (
      select pg_catalog.unnest(
        pg_catalog.regexp_split_to_array(
          (pg_catalog.regexp_match(
             pg_catalog.pg_get_constraintdef(c.oid),
             'ARRAY\[(.*)\]'))[1],
          '\s*,\s*')) as raw) u
    cross join lateral (select pg_catalog.btrim(
      pg_catalog.replace(pg_catalog.split_part(u.raw, '::', 1), '''', '')) as t) v
   where c.conrelid = 'public.custom_field_values'::pg_catalog.regclass
     and c.conname = 'custom_field_values_entity_type_allowed'
   order by 1
$$;

comment on function private.custom_field_entity_types() is
  'The entity types public.custom_field_values may name, READ FROM THE LIVE CHECK CONSTRAINT rather than listed. Seven today -- agency, artist, company, contact, event, financial_entry, venue -- where phase-8-inventory.md and task-5-brief.md both say six; `financial_entry` was added after the inventory was written. An eighth type therefore arrives swept by private.sweep_custom_field_values() instead of silently orphaned, which is the whole reason this is a derivation and not a list.';


-- ---------------------------------------------------------------------------
-- 2. THE SWEEP, AS A CALLABLE PRIMITIVE.
--
--    public.custom_field_values has NO foreign key to the entity its
--    `entity_id` names, so hard-deleting an entity leaves its custom field
--    values behind for ever: invisible (every policy joins through
--    private.entity_is_visible()), un-queryable by the product, and still
--    holding whatever the workspace typed into them. This is the call every
--    hard delete of an entity owes.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_custom_field_values(
  p_organisation_id uuid,
  p_entity_type     text,
  p_entity_id       uuid default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint;
begin
  -- ASSERT WHAT THE DERIVATION WOULD DROP. A caller naming a type the CHECK
  -- does not allow has either mistyped it or is working from a stale list, and
  -- either way its rows would go unswept. Refuse rather than delete nothing.
  if p_entity_type is null
     or p_entity_type not in (select t from private.custom_field_entity_types() t) then
    raise exception 'sweep_custom_field_values: % is not a custom-field entity type', coalesce(p_entity_type, '<null>')
      using errcode = '22023', hint = 'unknown_custom_field_entity_type';
  end if;

  delete from public.custom_field_values v
   where v.organisation_id = p_organisation_id
     and v.entity_type = p_entity_type
     and (p_entity_id is null or v.entity_id = p_entity_id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function private.sweep_custom_field_values(uuid, text, uuid) is
  'Delete the custom field values of one entity, or of every entity of one type in a workspace. public.custom_field_values names its entity POLYMORPHICALLY (entity_type + entity_id) and has NO foreign key to it, so a hard-deleted entity leaves its values behind for ever -- invisible to every policy, un-queryable by the product, and still holding what the workspace typed. It refuses an entity type the live CHECK constraint does not allow (22023, hint unknown_custom_field_entity_type) rather than quietly deleting nothing, because a stale caller list is exactly how rows go unswept.';

revoke all on function private.sweep_custom_field_values(uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.custom_field_entity_types()
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. IS THIS WORKSPACE EMPTY?
--
--    Derived, not listed: every table in `public` with an `organisation_id`
--    column, minus a declared roll of tables whose rows are the PLATFORM's
--    records ABOUT the workspace rather than the workspace's own records. A
--    table added tomorrow counts as data by default, which is the safe
--    direction -- the only thing emptiness unlocks is deleting the workspace.
-- ---------------------------------------------------------------------------

create or replace function private.organisation_data_tables()
returns setof text
language sql
stable
set search_path = ''
as $$
  select c.relname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attname = 'organisation_id'
         and a.attnum > 0 and not a.attisdropped
   where c.relnamespace = 'public'::pg_catalog.regnamespace
     and c.relkind in ('r', 'p')
     and c.relname not in (
       -- THE PLATFORM'S OWN RECORDS ABOUT A WORKSPACE, not the workspace's
       -- records. None of these is a reason to keep an empty workspace alive.
       'organisation_memberships',   -- counted separately: "other members"
       'organisation_subscriptions', -- created with the workspace itself
       'audit_events',               -- the security log; never a reason
       'incident_alerts',            -- operational alerts about the workspace
       'feedback',                   -- sent to US, about the product
       'export_jobs',                -- the record of exports taken
       'erasure_jobs',               -- this register
       'data_subject_requests',      -- belong to the person who made them
       'rate_limit_counters'         -- enforcement state, not records
     )
   order by 1
$$;

comment on function private.organisation_data_tables() is
  'Every table in `public` carrying an organisation_id column, minus a declared roll of nine that hold the PLATFORM''s records ABOUT a workspace rather than the workspace''s own records. Used by private.organisation_is_empty(). A table added by a later phase counts as data BY DEFAULT, which is the safe direction: the only thing emptiness unlocks is deleting a workspace outright, so being wrong the other way strands rows nobody can reach.';

create or replace function private.organisation_is_empty(p_organisation_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_t text; v_n bigint;
begin
  for v_t in select t from private.organisation_data_tables() t loop
    execute pg_catalog.format(
      'select count(*) from public.%I where organisation_id = $1', v_t)
      into v_n using p_organisation_id;
    if v_n > 0 then return false; end if;
  end loop;
  return true;
end;
$$;

comment on function private.organisation_is_empty(uuid) is
  'True when a workspace holds no records of its own, across every table private.organisation_data_tables() derives. The one thing it unlocks is Q131''s narrow case: a person erasing their account who is the last Owner of a workspace that has no other members and nothing in it takes that workspace with them, instead of leaving an ownerless shell nobody can manage or delete.';

revoke all on function private.organisation_data_tables() from public, anon, authenticated, service_role;
revoke all on function private.organisation_is_empty(uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. THE PURGE ITSELF.
-- ---------------------------------------------------------------------------

create or replace function private.erase_organisation(
  p_organisation_id uuid,
  p_job_id          uuid default null,
  p_require_closed  boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counts   jsonb := '{}'::jsonb;
  v_org      public.organisations%rowtype;
  v_type     text;
  v_n        bigint;
  v_total    bigint := 0;
  v_left     text;
  v_orphans  bigint;
begin
  if p_organisation_id is null then
    raise exception 'erase_organisation: a workspace is required' using errcode = '22023';
  end if;

  -- (0) NEVER UNDER `replica`. See the header. This is the control; the
  -- sentence in the brief is not.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'erase_organisation: refuses to run with session_replication_role = %, because the ON DELETE SET NULL that keeps a routed data subject request readable would not fire',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- (1) IDEMPOTENCE. Running it twice is not an error.
  select * into v_org from public.organisations o where o.id = p_organisation_id;
  if not found then
    return pg_catalog.jsonb_build_object('already_erased', true);
  end if;

  -- (2) A LIVE WORKSPACE IS NOT PURGED. Task 6's 60-day clock decides WHEN a
  -- closed workspace goes; this decides that an OPEN one never does. The one
  -- caller that passes false is Q131's empty-and-ownerless case, which checks
  -- emptiness itself.
  if p_require_closed and v_org.deleted_at is null then
    raise exception 'erase_organisation: a live workspace is not purged -- close it first'
      using errcode = '22023', hint = 'workspace_is_live';
  end if;

  -- (3) THE BYTES FIRST, ALWAYS. Q52: soft-deleting a document keeps its
  -- bytes, so the rows are NOT what makes a file unreachable. If the runner's
  -- storage sweep has not finished, this refuses -- deleting the rows now
  -- would leave objects in the bucket that nothing in the database names.
  select count(*) into v_n
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name like p_organisation_id::text || '/%';
  if v_n > 0 then
    raise exception 'erase_organisation: % document object(s) are still in the bucket', v_n
      using errcode = '55000', hint = 'bytes_not_purged';
  end if;

  -- (4) TRAP: THE POLYMORPHIC TABLE, SWEPT BEFORE ITS ENTITIES, FOR EVERY
  -- TYPE THE LIVE CHECK ALLOWS (seven, not the brief's six).
  for v_type in select t from private.custom_field_entity_types() t loop
    v_n := private.sweep_custom_field_values(p_organisation_id, v_type, null);
    v_total := v_total + v_n;
    v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values.' || v_type, v_n);
  end loop;
  v_counts := v_counts || pg_catalog.jsonb_build_object('custom_field_values', v_total);

  -- (5) TRAP: THE DISCARDED RECORD'S VALUES, VERBATIM. merges.field_resolution
  -- holds what the losing contact/company/artist actually said -- email,
  -- phone, address. Scrubbed before the delete rather than left to the
  -- cascade, so a backup taken in between already has nothing in it. The
  -- owner-id snapshots beside it have no foreign key and go with it.
  update public.merges m
     set field_resolution = '{}'::jsonb,
         winner_owner_user_id = null,
         loser_owner_user_id  = null
   where m.organisation_id = p_organisation_id
     and (m.field_resolution <> '{}'::jsonb
          or m.winner_owner_user_id is not null
          or m.loser_owner_user_id is not null);
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('merges.field_resolution', v_n);

  -- (6) THE DELETE. Every cascade runs, at `origin`, paying for the
  -- referential integrity that keeps a routed request readable.
  delete from public.organisations o where o.id = p_organisation_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('organisations', v_n);

  -- (7) ASSERT WHAT IS LEFT, DERIVED. Every foreign key in the database that
  -- points at public.organisations is asked directly whether it still names
  -- this workspace. A cascade that did not run -- because a later migration
  -- shipped a NO ACTION reference, or because somebody reached for `replica`
  -- despite (0) -- is a hard failure and the whole transaction rolls back.
  for v_type in
    select con.conrelid::pg_catalog.regclass::text || '|' || a.attname
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'public.organisations'::pg_catalog.regclass
       and c.relkind in ('r', 'p')
       and pg_catalog.array_length(con.conkey, 1) = 1
  loop
    execute pg_catalog.format('select count(*) from %s where %I = $1',
                              pg_catalog.split_part(v_type, '|', 1),
                              pg_catalog.split_part(v_type, '|', 2))
      into v_n using p_organisation_id;
    if v_n > 0 then
      raise exception 'erase_organisation: % still names the workspace after the delete (% row(s))',
        pg_catalog.replace(v_type, '|', '.'), v_n
        using errcode = '55000', hint = 'reference_survived_the_purge';
    end if;
  end loop;

  -- (8) AND THE ORPHAN CENSUS FOR THE ONE TABLE NO FOREIGN KEY PROTECTS.
  select count(*) into v_orphans
    from public.custom_field_values v
   where v.organisation_id = p_organisation_id;
  if v_orphans > 0 then
    raise exception 'erase_organisation: % custom field value(s) survived', v_orphans
      using errcode = '55000', hint = 'custom_field_values_orphaned';
  end if;

  if p_job_id is not null then
    v_counts := v_counts || pg_catalog.jsonb_build_object('workspace_purged', true);
  end if;

  return v_counts;
end;
$$;

comment on function private.erase_organisation(uuid, uuid, boolean) is
  'THE WORKSPACE PURGE PRIMITIVE (Phase 8 Task 5), which Task 6''s 60-day clock calls rather than reimplementing. One transaction, all-or-nothing, idempotent (a workspace that is already gone returns {"already_erased": true} rather than raising). It REFUSES to run unless session_replication_role is `origin` (55000, hint replication_role_must_be_origin) -- the shortcut a bulk purge reaches for, and the one that would delete an organisation WITHOUT running data_subject_requests.routed_to_organisation_id''s ON DELETE SET NULL and leave the routing evidence pointing at nothing. It refuses a LIVE workspace unless the caller says otherwise (Q131''s empty-and-ownerless case is the only one that does), refuses while any document byte is still in the bucket (Q52 -- the rows are not what makes a file unreachable), sweeps the polymorphic custom_field_values for all SEVEN live entity types before the cascade reaches them, scrubs merges.field_resolution and its two FK-less owner-id snapshots, and then ASSERTS, by walking pg_constraint, that not one foreign key anywhere still names the workspace.';

revoke all on function private.erase_organisation(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
