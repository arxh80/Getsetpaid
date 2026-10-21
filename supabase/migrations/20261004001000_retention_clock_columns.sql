-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDING C1, GENERALISED.
--
-- "WHO CAN WRITE A CLOCK?" -- ASKED OF EVERY SWEEP, AND OF THE NEXT ONE.
--
-- 20261004000000 closed the hole the reviewer found: public.documents
-- .deleted_at and .bytes_purged_at were writable by the tenant. The reviewer
-- then checked every OTHER clock column by hand and found them sound -- and
-- noted that nothing in 116 assertions asks the question at all. A hand check
-- is true on the day it is made. The next sweep somebody adds will read a
-- timestamp column, and if a client role can write that column the sweep is
-- a delete-on-demand button for whoever holds the grant.
--
-- So the question is DERIVED, the fkless-identifier roll's shape
-- (20261001000000) and the retention roll's (20261003000000):
--
--   private.retention_clock_candidates()
--       THE DERIVATION. Every date/timestamp column of every table that a
--       retention function's own SOURCE names. "A retention function" is
--       itself derived: public.retention_object_manifest() plus every
--       private function private.retention_sweep_body() calls -- a sweep
--       that is not called from there does not run, so a new sweep is in
--       this set by construction rather than by somebody remembering.
--       It OVER-approximates on purpose (a column NAME is matched, so
--       `created_at` in the manifest makes every named table's created_at a
--       candidate): a false candidate costs one roll entry saying why it is
--       not a clock, and a missed one costs a forgeable deletion.
--
--   private.retention_clock_columns()
--       THE ROLL. Each candidate is either a `clock`, or `not_a_clock` with
--       the reason. It may also name a column the derivation cannot reach --
--       organisations.lifecycle_changed_at is one: the sweep reads
--       retention_expires_at, and a TRIGGER computes that from
--       lifecycle_changed_at, so the real clock is one hop outside any
--       function source.
--
--   private.assert_retention_clocks()
--       THE REFUSAL. A candidate the roll does not classify, a roll entry
--       naming a column that does not exist, or a `clock` that a CLIENT ROLE
--       can INSERT or UPDATE without a named guard that really exists on that
--       table -- each raises, and since 20261004002000 it is asserted before
--       a run starts, before the object manifest names a key, and at step 0.
--       A retention job whose clock can be set by the people whose data it
--       deletes does not run.
--
-- "A CLIENT ROLE" IS DERIVED TOO, and is an OPEN list: every role the
-- PostgREST `authenticator` can become that does not carry BYPASSRLS. Today
-- that is `anon` and `authenticated` (and `authenticator` itself); a client
-- role a later phase adds is covered by omission rather than by an edit here.
-- `service_role` is excluded because it is a server credential, not because
-- it is trusted with a clock -- it holds UPDATE on the job tables' outcome
-- columns for the runners, and the guards on those tables are asserted by
-- their own suites.
--
-- WHAT THE DATABASE CANNOT ASSERT, AND WHERE IT IS ASSERTED INSTEAD. That a
-- named guard EXISTS is a catalogue fact. That it actually PINS THE VALUE is
-- behaviour, and only a probe can measure it. rls_phase8_retention.sql § RK
-- requires a passing behavioural probe, recorded by that same run, for every
-- clock column a client role can write -- so a new guarded column with no
-- probe is red there, and a new unguarded one is a refusal here.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. WHO IS A CLIENT.
-- ---------------------------------------------------------------------------

create or replace function private.retention_client_roles()
returns setof name
language sql
stable
set search_path = ''
as $$
  select r.rolname
    from pg_catalog.pg_roles r
   where pg_catalog.pg_has_role('authenticator', r.oid, 'MEMBER')
     and not r.rolbypassrls
     and not r.rolsuper
   order by 1
$$;

comment on function private.retention_client_roles() is
  'Every role the PostgREST `authenticator` can become that does not carry BYPASSRLS -- the OPEN list of client roles private.assert_retention_clocks() asks about (Phase 8 Task 6 fix round 1, C1). Derived from pg_roles, so a client role a later phase adds is covered by omission rather than by an edit.';

revoke all on function private.retention_client_roles() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE DERIVATION.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_candidates()
returns table (schema_name text, table_name text, column_name text, read_by text)
language sql
stable
set search_path = ''
as $$
  with retention_functions as (
    select p.proname::text as fn, p.prosrc
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname = 'retention_object_manifest'
    union
    select p.proname::text, p.prosrc
      from pg_catalog.pg_proc b
      cross join lateral pg_catalog.regexp_matches(b.prosrc, 'private\.([a-z_0-9]+)\s*\(', 'g') m
      join pg_catalog.pg_proc p
        on p.pronamespace = 'private'::pg_catalog.regnamespace and p.proname = m[1]
     where b.pronamespace = 'private'::pg_catalog.regnamespace
       and b.proname = 'retention_sweep_body'
  ),
  named_tables as (
    select distinct f.fn, f.prosrc, k.oid as relid, m[1] as sch, m[2] as tbl
      from retention_functions f
      cross join lateral pg_catalog.regexp_matches(f.prosrc, '(public|storage)\.([a-z_0-9]+)', 'g') m
      join pg_catalog.pg_namespace n on n.nspname = m[1]
      join pg_catalog.pg_class k
        on k.relnamespace = n.oid and k.relname = m[2] and k.relkind in ('r', 'p', 'm')
  )
  select t.sch, t.tbl, a.attname::text,
         pg_catalog.string_agg(distinct t.fn, ',' order by t.fn)
    from named_tables t
    join pg_catalog.pg_attribute a
      on a.attrelid = t.relid and a.attnum > 0 and not a.attisdropped
     and a.atttypid in ('timestamptz'::pg_catalog.regtype, 'timestamp'::pg_catalog.regtype,
                        'date'::pg_catalog.regtype)
   where t.prosrc ~ ('\m' || a.attname::text || '\M')
   group by t.sch, t.tbl, a.attname
   order by 1, 2, 3
$$;

comment on function private.retention_clock_candidates() is
  'THE DERIVATION behind private.assert_retention_clocks() (Phase 8 Task 6 fix round 1, C1). Every date/timestamp column of every table in `public` or `storage` that a retention function''s own source names, where "a retention function" is public.retention_object_manifest() plus every private function private.retention_sweep_body() calls -- so a new sweep is in the set by construction, because a sweep not called from there does not run. OVER-APPROXIMATES ON PURPOSE: a column NAME is matched, so a false candidate costs one roll entry saying why it is not a clock, and a missed one costs a forgeable deletion. It cannot see a clock computed by a TRIGGER from another column (organisations.lifecycle_changed_at); the roll names that one by hand and says so.';

revoke all on function private.retention_clock_candidates() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE ROLL.
--
--    `guard` is a comma-separated list, each entry one of
--      trigger:<schema.function>   an ENABLED BEFORE ROW trigger on that table
--                                  calling that function, firing on every
--                                  operation a client role holds on the column
--      policy:<policy name>        a RESTRICTIVE policy of that name on that
--                                  table
--    and is REQUIRED for a `clock` a client role can INSERT or UPDATE. A
--    `clock` no client role can write needs none: it is non-forgeable by
--    construction, which is the better answer wherever it is available.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_columns()
returns table (schema_name text, table_name text, column_name text, role text, guard text, note text)
language sql
immutable
set search_path = ''
as $$
  values
    ('public', 'audit_events', 'created_at', 'clock', null,
     'audit_total. No client role holds INSERT or UPDATE on the table; rows are written by definer functions and triggers.'),

    ('public', 'documents', 'deleted_at', 'clock',
     'trigger:private.guard_document_retention_columns',
     'operational / financial. THE COLUMN REVIEW FINDING C1 WAS ABOUT. A client holds UPDATE on it because soft-delete and restore are its own writes; the guard overwrites a null -> value transition with now() and refuses a re-date (20261004000000). Not in the INSERT grant.'),
    ('public', 'documents', 'bytes_purged_at', 'clock', null,
     'The record that the sweep ran, and the term that takes a document OUT of every future sweep. No client grant at all since 20261004000000; the guard refuses it too if one is ever added.'),
    ('public', 'documents', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s. No client grant since 20261004000000 either.'),

    ('public', 'erasure_jobs', 'completed_at', 'clock', null,
     'erasure_job_failed. No client write path: the table''s outcome columns are server-only (20260930001000).'),
    ('public', 'erasure_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_jobs', 'completed_at', 'clock', null,
     'Written by the reaper, read by nothing as a cutoff; classified `clock` rather than excused because no client can write it and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC; organisations_update_manage_organisation also carries `deleted_at is null` in USING, so a closed workspace admits no tenant UPDATE at all.'),
    ('public', 'organisations', 'retention_expires_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace. RECOMPUTED on every write by the sync trigger from lifecycle_changed_at, and nulled whenever the workspace is live -- so a written value never survives the statement that wrote it.'),
    ('public', 'organisations', 'lifecycle_changed_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace -- THE REAL CLOCK, and one the derivation cannot reach: no retention function names it, the sync trigger computes retention_expires_at from it. Nulled on a live workspace; on a closed one it is writable only by a session the UPDATE policies admit, which is the audited lifecycle RPCs and nobody else.'),
    ('public', 'organisations', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s.'),

    ('public', 'rate_limit_counters', 'window_start', 'clock', null,
     'rate_limit_counter. No client role can write or read a counter (20260909020000).'),

    ('storage', 'objects', 'created_at', 'clock',
     'policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies instead; the six named here are the INSERT and UPDATE halves of that fence.')
$$;

comment on function private.retention_clock_columns() is
  'THE ROLL of every column a retention cutoff reads (Phase 8 Task 6 fix round 1, review finding C1 generalised). Each candidate private.retention_clock_candidates() derives is a `clock` or `not_a_clock` with the reason; a `clock` any client role can INSERT or UPDATE must name a guard that really exists, and private.assert_retention_clocks() REFUSES THE JOB otherwise. It also names the one clock the derivation cannot reach (organisations.lifecycle_changed_at, which a trigger turns into retention_expires_at). That a guard actually pins the value is behaviour, and is asserted by a probe per client-writable clock in rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_columns() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. WHAT A CLIENT CAN WRITE, AND WHETHER THE NAMED GUARD IS REALLY THERE.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_exposure()
returns table (schema_name text, table_name text, column_name text,
               client_insert boolean, client_update boolean,
               guard text, guard_missing text)
language sql
stable
set search_path = ''
as $$
  with clocks as (
    select c.schema_name, c.table_name, c.column_name, c.guard, k.oid as relid
      from private.retention_clock_columns() c
      join pg_catalog.pg_namespace n on n.nspname = c.schema_name
      join pg_catalog.pg_class k on k.relnamespace = n.oid and k.relname = c.table_name
     where c.role = 'clock'
  ),
  exposure as (
    select c.*,
           exists (select 1 from private.retention_client_roles() r
                    where pg_catalog.has_column_privilege(r, c.relid, c.column_name, 'INSERT')) as client_insert,
           exists (select 1 from private.retention_client_roles() r
                    where pg_catalog.has_column_privilege(r, c.relid, c.column_name, 'UPDATE')) as client_update
      from clocks c
  )
  select e.schema_name, e.table_name, e.column_name, e.client_insert, e.client_update, e.guard,
         (select pg_catalog.string_agg(g, ',' order by g)
            from pg_catalog.unnest(pg_catalog.string_to_array(coalesce(e.guard, ''), ',')) g
           where g <> ''
             and not (
               (g like 'trigger:%' and exists (
                  select 1 from pg_catalog.pg_trigger t
                   where t.tgrelid = e.relid
                     and not t.tgisinternal
                     and t.tgenabled in ('O', 'A')
                     and (t.tgtype::integer & 1) <> 0            -- FOR EACH ROW
                     and (t.tgtype::integer & 2) <> 0            -- BEFORE
                     and (not e.client_update or (t.tgtype::integer & 16) <> 0)
                     and (not e.client_insert or (t.tgtype::integer & 4) <> 0)
                     and t.tgfoid::pg_catalog.regproc::text = pg_catalog.substr(g, 9)))
               or
               (g like 'policy:%' and exists (
                  select 1 from pg_catalog.pg_policy p
                   where p.polrelid = e.relid
                     and not p.polpermissive
                     and p.polname::text = pg_catalog.substr(g, 8)))
             )) as guard_missing
    from exposure e
   order by 1, 2, 3
$$;

comment on function private.retention_clock_exposure() is
  'For every `clock` on private.retention_clock_columns(): whether any client role (private.retention_client_roles()) holds INSERT or UPDATE on the column, and which of its named guards is NOT actually present -- an enabled BEFORE ROW trigger on that table calling that function and firing on each operation the client holds, or a RESTRICTIVE policy of that name. Read by private.assert_retention_clocks() and by rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_exposure() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. THE REFUSAL.
-- ---------------------------------------------------------------------------

create or replace function private.assert_retention_clocks()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_seen      bigint;
  v_missing   text;
  v_stale     text;
  v_dupe      text;
  v_forgeable text;
begin
  -- THE DENOMINATOR FIRST (standing lesson 1). Sixteen candidates exist today;
  -- a derivation that resolved nothing would pass every check below.
  select pg_catalog.count(*) into v_seen from private.retention_clock_candidates();
  if v_seen < 10 then
    raise exception 'assert_retention_clocks: only % clock candidate(s) derived -- the derivation is not seeing the retention functions', v_seen
      using errcode = '55000', hint = 'retention_clocks_saw_nothing';
  end if;

  select pg_catalog.string_agg(c.schema_name || '.' || c.table_name || '.' || c.column_name
                               || ' (read by ' || c.read_by || ')', ', '
                               order by c.schema_name, c.table_name, c.column_name)
    into v_missing
    from private.retention_clock_candidates() c
   where not exists (
     select 1 from private.retention_clock_columns() d
      where d.schema_name = c.schema_name and d.table_name = c.table_name
        and d.column_name = c.column_name);
  if v_missing is not null then
    raise exception 'assert_retention_clocks: % is read by a retention function and is not classified by private.retention_clock_columns()', v_missing
      using errcode = '55000', hint = 'undeclared_retention_clock';
  end if;

  select pg_catalog.string_agg(d.schema_name || '.' || d.table_name || '.' || d.column_name, ', '
                               order by d.schema_name, d.table_name, d.column_name)
    into v_stale
    from private.retention_clock_columns() d
   where d.role not in ('clock', 'not_a_clock')
      or not exists (
        select 1
          from pg_catalog.pg_namespace n
          join pg_catalog.pg_class k on k.relnamespace = n.oid
          join pg_catalog.pg_attribute a on a.attrelid = k.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = d.schema_name and k.relname = d.table_name
           and a.attname::text = d.column_name);
  if v_stale is not null then
    raise exception 'assert_retention_clocks: the clock roll names %, which does not exist or carries an unknown role', v_stale
      using errcode = '55000', hint = 'stale_retention_clock';
  end if;

  select pg_catalog.string_agg(x.c, ', ' order by x.c) into v_dupe
    from (select d.schema_name || '.' || d.table_name || '.' || d.column_name as c
            from private.retention_clock_columns() d
           group by 1 having pg_catalog.count(*) > 1) x;
  if v_dupe is not null then
    raise exception 'assert_retention_clocks: % is classified more than once', v_dupe
      using errcode = '55000', hint = 'duplicate_retention_clock';
  end if;

  -- THE ONE THAT MATTERS. A clock a client role can write, with no guard
  -- named or with a named guard that is not really there.
  select pg_catalog.string_agg(
           e.schema_name || '.' || e.table_name || '.' || e.column_name
           || case when e.guard is null then ' (no guard named)'
                   else ' (missing: ' || e.guard_missing || ')' end, ', '
           order by e.schema_name, e.table_name, e.column_name)
    into v_forgeable
    from private.retention_clock_exposure() e
   where (e.client_insert or e.client_update)
     and (e.guard is null or e.guard_missing is not null);
  if v_forgeable is not null then
    raise exception 'assert_retention_clocks: a client role can write the retention clock % and nothing pins it', v_forgeable
      using errcode = '55000', hint = 'forgeable_retention_clock';
  end if;
end;
$$;

comment on function private.assert_retention_clocks() is
  'REFUSES THE RETENTION JOB when a clock can be set by the people whose data it deletes (Phase 8 Task 6 fix round 1, review finding C1 generalised). Four refusals, each with its own hint: `undeclared_retention_clock` -- a date/timestamp column a retention function reads that private.retention_clock_columns() does not classify, which is what a NEW SWEEP trips; `stale_retention_clock`; `duplicate_retention_clock`; and `forgeable_retention_clock` -- a clock some client role holds INSERT or UPDATE on with no guard named, or with a named guard that does not exist as an enabled BEFORE ROW trigger (or RESTRICTIVE policy) on that table. It asserts its own denominator first. That a guard PINS THE VALUE is behaviour and is proved per column by rls_phase8_retention.sql § RK, which also requires a recorded passing probe for every client-writable clock.';

revoke all on function private.assert_retention_clocks() from public, anon, authenticated, service_role;
