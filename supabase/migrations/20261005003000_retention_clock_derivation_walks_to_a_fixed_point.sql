-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 2 -- RE-REVIEW FINDING m-N1.
--
-- THE CLOCK DERIVATION WALKS TO A FIXED POINT, RESOLVES VIEWS, AND SEES
-- `private` -- AND STATES WHAT IT STILL CANNOT SEE.
--
-- private.assert_retention_clocks() refuses the job when a sweep reads a
-- timestamp column nobody classified, or one a client can write with no
-- guard. The re-review planted seven shapes of a sweep reading a
-- client-writable public.notes.deleted_at and measured which the derivation
-- (20261004001000, widened by 20261005000000) refused:
--
--   CONTROL  the column read directly                       REFUSED
--   A        through a VIEW with the column aliased          passed silently
--   B        through a HELPER FUNCTION                       passed silently (I-N1's shape)
--   C        a clock in a JSONB field                        passed silently
--   D        a clock in a BIGINT EPOCH / TEXT column         passed silently
--   E        a client-granted table in `private`             passed silently
--   G        a sweep reached through a WRAPPER               passed silently
--   F        a new client role holding UPDATE on a clock     REFUSED
--
-- CLOSED HERE, each with a standing mutation in rls_phase8_retention.sql
-- § RK31: A, B, E and G.
--   * B and G: the set of "retention functions" is now the transitive
--     closure -- every `private` function any function already in the set
--     names, to a fixed point (a recursive CTE whose `union` deduplicates,
--     which is what terminates a cycle). The two candidates it adds
--     (merge_candidates.deleted_at and notes.deleted_at, both read by
--     erase_account() as ORGANISATIONS' deleted_at) are classified
--     `not_a_clock` with the reason.
--   * A: a named VIEW is resolved to its base tables through pg_depend (a
--     view's rewrite rule depends on every relation it reads), to a fixed
--     point for a view over a view, and EVERY timestamp column of every base
--     table is a candidate -- the alias hides the name, so no name is asked.
--   * E: the relation regex names `private` beside `public` and `storage`.
--
-- STATED LIMITS, each with its reason, in the function's own comment:
--   * C and D -- a clock stored in jsonb, or as an epoch integer or text.
--     The derivation classifies by TYPE, and a column of those types can hold
--     anything; the only closure would be to make every column of every
--     named table a candidate, which is a roll nobody would maintain. A
--     sweep reading such a column is a design the review of that sweep has
--     to catch; C and D are also new TABLES, which assert_retention_roll()
--     refuses until somebody classifies them, so a person is at least made to
--     look.
--   * a helper or wrapper in a schema other than `private`. The walk stays
--     inside `private` ON PURPOSE: following `public.` too was measured and
--     pulls the erasure's permission machinery in (permitted_organisations,
--     effective_organisation_plan, active_billing_override, ...), and every
--     entitlement expiry they read -- eight columns -- would halt the
--     retention job as `undeclared_retention_clock` until classified. Every
--     sweep and helper in this feature is `private` by house convention.
--   * a relation reached through DYNAMIC SQL (`execute format(...)`), which
--     names no table in source -- private.erase_organisation() walks
--     private.organisation_data_tables() that way. Those tables are on the
--     RETENTION roll as `cascades`, deleted whole with their workspace and
--     never judged on a column, so nothing is lost today; a dynamic sweep
--     would be.
--   * a clock a TRIGGER computes from another column
--     (organisations.lifecycle_changed_at; the roll names it by hand), and
--     a period SELECTOR reached through a function call (the I-N1 shape,
--     which is why the class is frozen into a column).
--   * `service_role`, excluded as a server credential.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE DERIVATION, REBUILT FROM 20261005000000.
-- ---------------------------------------------------------------------------

create or replace function private.retention_clock_candidates()
returns table (schema_name text, table_name text, column_name text, read_by text)
language sql
stable
set search_path = ''
as $$
  with recursive retention_functions as (
    -- THE ROOTS: the manifest, and the sweep body.
    select p.oid, p.proname::text as fn, p.prosrc
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname = 'retention_object_manifest'
    union
    select p.oid, p.proname::text, p.prosrc
      from pg_catalog.pg_proc p
     where p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname = 'retention_sweep_body'
    union
    -- THE WALK, TO A FIXED POINT (fix round 2, m-N1): every `private`
    -- function any function already in the set names, however deep -- a
    -- helper, a wrapper, a helper's helper. `union` deduplicates, which is
    -- what terminates a cyclic graph. It stays inside `private` on purpose:
    -- following `public.` too pulls the erasure's permission machinery in
    -- (permitted_organisations, effective_organisation_plan, ...) and every
    -- entitlement expiry they read would halt the retention job until
    -- somebody classified it. A helper in another schema is a stated limit.
    select p.oid, p.proname::text, p.prosrc
      from retention_functions f
      cross join lateral pg_catalog.regexp_matches(f.prosrc, 'private\.([a-z_0-9]+)\s*\(', 'g') m
      join pg_catalog.pg_proc p
        on p.pronamespace = 'private'::pg_catalog.regnamespace and p.proname = m[1]
  ),
  named_relations as (
    -- Every table, partitioned table, materialized view OR VIEW in public,
    -- storage or private that a walked function's source names.
    select distinct f.fn, f.prosrc, k.oid as relid, k.relkind, m[1] as sch, m[2] as tbl
      from retention_functions f
      cross join lateral pg_catalog.regexp_matches(f.prosrc, '(public|storage|private)\.([a-z_0-9]+)', 'g') m
      join pg_catalog.pg_namespace n on n.nspname = m[1]
      join pg_catalog.pg_class k
        on k.relnamespace = n.oid and k.relname = m[2] and k.relkind in ('r', 'p', 'm', 'v')
  ),
  view_bases as (
    -- A VIEW RESOLVED TO ITS BASE TABLES through pg_depend (its rewrite rule
    -- depends on every relation it reads), to a fixed point for a view over a
    -- view. An alias in the view hides the column name, so EVERY timestamp
    -- column of every base table is a candidate -- over-approximation is the
    -- safe direction.
    select r.fn, r.relid as view_oid, r.relid as base_oid, r.relkind
      from named_relations r where r.relkind = 'v'
    union
    select vb.fn, vb.view_oid, d.refobjid, k.relkind
      from view_bases vb
      join pg_catalog.pg_rewrite rw on rw.ev_class = vb.base_oid
      join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
                                 and d.objid = rw.oid
                                 and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
                                 and d.refobjid <> vb.base_oid
      join pg_catalog.pg_class k on k.oid = d.refobjid and k.relkind in ('r', 'p', 'm', 'v')
     where vb.relkind = 'v'
  ),
  named_tables as (
    select r.fn, r.prosrc, r.relid, r.sch, r.tbl
      from named_relations r where r.relkind in ('r', 'p', 'm')
  ),
  -- ARM 1: every date/timestamp column of a named table whose NAME the
  -- function's source carries -- WHEN a clock started.
  timestamp_columns as (
    select t.sch, t.tbl, a.attname::text as col, t.fn
      from named_tables t
      join pg_catalog.pg_attribute a
        on a.attrelid = t.relid and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('timestamptz'::pg_catalog.regtype, 'timestamp'::pg_catalog.regtype,
                          'date'::pg_catalog.regtype)
     where t.prosrc ~ ('\m' || a.attname::text || '\M')
  ),
  -- ARM 1b (m-N1): every date/timestamp column of every base table of a
  -- named VIEW, name-matched or not.
  view_columns as (
    select n.nspname::text, k.relname::text, a.attname::text, vb.fn
      from view_bases vb
      join pg_catalog.pg_class k on k.oid = vb.base_oid and k.relkind in ('r', 'p', 'm')
      join pg_catalog.pg_namespace n on n.oid = k.relnamespace
      join pg_catalog.pg_attribute a
        on a.attrelid = k.oid and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('timestamptz'::pg_catalog.regtype, 'timestamp'::pg_catalog.regtype,
                          'date'::pg_catalog.regtype)
  ),
  -- ARM 2 (I-N1): every column of a named table that the source HANDS TO
  -- private.retention_period() -- WHICH PERIOD applies -- whatever its type.
  selector_columns as (
    select t.sch, t.tbl, a.attname::text as col, t.fn
      from named_tables t
      cross join lateral pg_catalog.regexp_matches(
        t.prosrc, 'retention_period\(\s*[a-z_0-9]+\.([a-z_0-9]+)\s*\)', 'g') m
      join pg_catalog.pg_attribute a
        on a.attrelid = t.relid and a.attnum > 0 and not a.attisdropped
       and a.attname::text = m[1]
  )
  select c.sch, c.tbl, c.col,
         pg_catalog.string_agg(distinct c.fn, ',' order by c.fn)
    from (select * from timestamp_columns
          union all select * from view_columns
          union all select * from selector_columns) c
   group by c.sch, c.tbl, c.col
   order by 1, 2, 3
$$;

comment on function private.retention_clock_candidates() is
  'THE DERIVATION behind private.assert_retention_clocks() (Phase 8 Task 6 fix round 1, C1; fix round 2, I-N1 and m-N1). "A retention function" is public.retention_object_manifest(), private.retention_sweep_body(), and -- to a FIXED POINT -- every `private` function any of them names, however deep, so a new sweep, a helper or a wrapper is in the set by construction. Over the tables in `public`, `storage` and `private` those functions name, and the base tables of any VIEW they name (resolved through pg_depend, to a fixed point): ARM 1, every date/timestamp column whose name the source carries (WHEN a clock started; for a view, every timestamp column of every base table, because an alias hides the name); ARM 2, every column the source hands to private.retention_period(), whatever its type (WHICH PERIOD applies -- documents.retention_class). OVER-APPROXIMATES ON PURPOSE: a false candidate costs one roll entry saying why, a missed one costs a forgeable deletion. STATED LIMITS, each measured: (1) a clock stored in jsonb, or as an epoch integer or text, is not a candidate by type -- the only closure would be every column of every named table, a roll nobody would maintain, and such a table is at least refused by assert_retention_roll() until classified; (2) a helper or wrapper in a schema other than `private` is not followed -- following `public.` pulls the erasure''s permission machinery in and every entitlement expiry it reads would halt the job; (3) a relation reached only through dynamic SQL (`execute format(...)`) names no table in source -- erase_organisation() walks organisation_data_tables() that way, and those tables are `cascades` on the retention roll, never judged on a column; (4) a clock a TRIGGER computes from another column (organisations.lifecycle_changed_at; named by hand) and a period selector reached through a function call (the I-N1 shape, which is why the class is frozen into a column); (5) service_role is excluded as a server credential.';

revoke all on function private.retention_clock_candidates() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE ROLL, REBUILT FROM 20261005002000: the two candidates the walk
--    adds, classified. Every other row byte-identical.
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
    ('public', 'documents', 'retention_class', 'clock',
     'trigger:private.guard_document_retention_columns',
     'THE PERIOD HALF OF THE SAME CLOCK (fix round 2, I-N1 / Q186): which of operational / financial applies, frozen by the guard when deleted_at is set, cleared on restore, immutable otherwise for every writer. No client grant at all; derived onto this roll as the column the sweep hands to retention_period().'),
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

    ('public', 'merge_candidates', 'deleted_at', 'not_a_clock', null,
     'A false candidate the fixed-point walk (m-N1) reaches through private.erase_account(): that function''s `deleted_at` is organisations'', read as a filter on which workspaces are live, never as a cutoff. No client role holds UPDATE on merge_candidates.deleted_at.'),
    ('public', 'notes', 'deleted_at', 'not_a_clock', null,
     'A false candidate reached the same way: erase_account() hard-deletes a private note by ownership, not by age. A client holds UPDATE on notes.deleted_at (soft-delete/restore are its own writes), which is harmless because nothing judges a note on it.'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC, with the hint organisation_lifecycle_is_the_rpcs (m-N2) so the probe can tell it from organisations_update_manage_organisation''s WITH CHECK, which carries `deleted_at is null` and refuses the same write with the same SQLSTATE -- a second layer, not the named one.'),
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
     'no_permissive_policy,policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies; the six named here are the INSERT and UPDATE halves of that fence. THE LAYER THAT ACTUALLY REFUSES TODAY IS DEFAULT DENY -- no permissive policy admits a client role at all (m-N2) -- so `no_permissive_policy` is named first: adding one is a forgeable_retention_clock refusal, and the restrictive six are the layer behind it. The probe measures their composite.')
$$;

comment on function private.retention_clock_columns() is
  'THE ROLL of every column a retention cutoff reads (Phase 8 Task 6 fix round 1, review finding C1 generalised; fix round 2, I-N1, m-N1 and m-N2). Each candidate private.retention_clock_candidates() derives -- now over the fixed-point walk of every private function the sweeps reach -- is a `clock` or `not_a_clock` with the reason; a `clock` any client role can INSERT or UPDATE must name a guard that really exists, and private.assert_retention_clocks() REFUSES THE JOB otherwise. Guards are `trigger:<fn>`, `policy:<restrictive policy>` or `no_permissive_policy` (default deny, named as the layer it is). It also names the one clock the derivation cannot reach (organisations.lifecycle_changed_at, which a trigger turns into retention_expires_at), and the PERIOD half of the document clock beside the timestamp half: documents.retention_class, frozen at deletion by the same guard. That a guard actually pins the value is behaviour, and is asserted by a probe per client-writable clock in rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_columns() from public, anon, authenticated, service_role;
