-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 2 -- RE-REVIEW FINDING m-N2.
--
-- TWO OF SIX CLOCK PROBES PASSED WITH THEIR NAMED GUARD DEAD, AND THE
-- EXISTENCE CHECK ACCEPTED A TRIGGER THAT COULD NOT FIRE.
--
-- The clock roll (20261004001000) names, for every client-writable clock, the
-- guard that pins it, and rls_phase8_retention.sql § RK requires a passing
-- behavioural probe for each. The re-review neutered each named guard in turn
-- and found two probes still green:
--
--   * organisations.deleted_at names trigger:private.organisation_lifecycle_guard.
--     With that function returning `new` unconditionally the probe still
--     read `denied(42501)` -- delivered by organisations_update_manage_
--     organisation's WITH CHECK (`deleted_at is null`), which raises the same
--     SQLSTATE. The probe asserted a bare code and could not tell them apart.
--   * storage.objects.created_at names the six RESTRICTIVE deny-all policies.
--     With the two `documents` ones rewritten to `true` the probe still read
--     `update=ok(0)/insert=denied(42501)`, because no PERMISSIVE policy
--     exists for a client role on storage.objects and RLS default-denies.
--
-- Neither clock was forgeable -- a second layer held both times -- but the
-- roll recorded one guard and the probe measured another, and the day
-- someone adds a permissive storage policy or loosens that WITH CHECK, the
-- probe was the thing that was supposed to notice.
--
-- Also: the existence check read tgtype alone, so a guard declared
-- `BEFORE UPDATE OF <some other column>` (tgattr) or `WHEN (false)` (tgqual)
-- counted as present.
--
-- THREE CHANGES:
--
--   1. private.organisation_lifecycle_guard(), rebuilt from its latest
--      definition (20260908040000): the refusal carries a HINT,
--      `organisation_lifecycle_is_the_rpcs`, so the probe can assert THAT
--      layer and not merely the SQLSTATE. (BEFORE ROW triggers run before a
--      policy's WITH CHECK is evaluated, so when the guard is present it is
--      the layer that answers.)
--
--   2. A third guard kind in the roll's grammar, `no_permissive_policy`: the
--      relation has no PERMISSIVE policy that could admit any client role
--      for the operations the client holds. That IS the layer that refuses a
--      client write to storage.objects today -- default deny -- and naming it
--      makes "someone adds a permissive storage policy" a
--      `forgeable_retention_clock` refusal rather than a silent widening.
--      The six restrictive policies stay named beside it: two layers, each
--      asserted to exist, the probe measuring their composite.
--
--   3. private.retention_clock_exposure(), rebuilt from 20261004001000: a
--      `trigger:` guard must have NO column list (tgattr empty) or one that
--      includes the clock column, and NO WHEN clause at all -- a WHEN clause
--      cannot be judged statically, so it is refused rather than trusted,
--      which forces a person to look.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE LIFECYCLE GUARD, with a hint. Byte-identical otherwise.
-- ---------------------------------------------------------------------------

create or replace function private.organisation_lifecycle_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- row_security_active() is FALSE exactly for the roles that bypass RLS --
  -- `postgres` and `service_role` -- so migrations, DBA repair, the psql
  -- fixtures and the e2e helpers are unaffected, and every path reachable from
  -- a browser is guarded. `is_superuser` would NOT work here: it is 'off' for
  -- `postgres` on this stack (Supabase's postgres is rolbypassrls, not
  -- rolsuper), so a guard keyed on it would refuse every migration.
  if not pg_catalog.row_security_active('public.organisations') then
    return new;
  end if;

  -- The three RPCs, and nothing else, open this.
  if private.lifecycle_transition_in_progress() then
    return new;
  end if;

  if new.deleted_at       is distinct from old.deleted_at
     or new.lifecycle_state  is distinct from old.lifecycle_state
     or new.lifecycle_reason is distinct from old.lifecycle_reason
  then
    raise exception
      'organisation lifecycle: deleted_at, lifecycle_state and lifecycle_reason are set only by the audited superuser lifecycle RPCs'
      using errcode = '42501', hint = 'organisation_lifecycle_is_the_rpcs';
  end if;

  return new;
end;
$$;

comment on function private.organisation_lifecycle_guard() is
  'THE THREE LIFECYCLE COLUMNS ARE WRITABLE ONLY THROUGH THE AUDITED RPCS (Phase 7 Task 3 fix round 1, 20260908040000). BEFORE UPDATE on public.organisations, for every session RLS applies to: a change to deleted_at, lifecycle_state or lifecycle_reason outside private.lifecycle_transition_in_progress() is refused, 42501. Since Phase 8 Task 6 fix round 2 (m-N2) the refusal carries the hint `organisation_lifecycle_is_the_rpcs`, because organisations_update_manage_organisation''s WITH CHECK refuses the same write with the same SQLSTATE and the retention clock probe for organisations.deleted_at has to be able to tell which layer answered. Policy-independent on purpose: it survives a relaxation of that policy or a third one added beside it.';


-- ---------------------------------------------------------------------------
-- 2. THE EXPOSURE, with the stricter trigger test and the third guard kind.
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
    select c.schema_name, c.table_name, c.column_name, c.guard, k.oid as relid, a.attnum
      from private.retention_clock_columns() c
      join pg_catalog.pg_namespace n on n.nspname = c.schema_name
      join pg_catalog.pg_class k on k.relnamespace = n.oid and k.relname = c.table_name
      join pg_catalog.pg_attribute a
        on a.attrelid = k.oid and a.attname::text = c.column_name and not a.attisdropped
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
                     -- m-N2: a column list must include the clock column (an
                     -- empty tgattr fires on every column), and a WHEN clause
                     -- is refused outright rather than judged.
                     and (pg_catalog.cardinality(t.tgattr::pg_catalog.int2[]) = 0
                          or e.attnum = any (t.tgattr::pg_catalog.int2[]))
                     and t.tgqual is null
                     and t.tgfoid::pg_catalog.regproc::text = pg_catalog.substr(g, 9)))
               or
               (g like 'policy:%' and exists (
                  select 1 from pg_catalog.pg_policy p
                   where p.polrelid = e.relid
                     and not p.polpermissive
                     and p.polname::text = pg_catalog.substr(g, 8)))
               or
               -- m-N2: DEFAULT DENY, named as the layer it is. No PERMISSIVE
               -- policy on the relation can admit a client role for an
               -- operation the client holds -- `{0}` is PUBLIC.
               (g = 'no_permissive_policy' and not exists (
                  select 1 from pg_catalog.pg_policy p
                   where p.polrelid = e.relid
                     and p.polpermissive
                     and (p.polcmd = '*'
                          or (e.client_insert and p.polcmd = 'a')
                          or (e.client_update and p.polcmd = 'w'))
                     and (p.polroles = '{0}'::pg_catalog.oid[]
                          or exists (select 1 from private.retention_client_roles() r
                                      join pg_catalog.pg_roles pr on pr.rolname = r
                                     where pr.oid = any (p.polroles)))))
             )) as guard_missing
    from exposure e
   order by 1, 2, 3
$$;

comment on function private.retention_clock_exposure() is
  'For every `clock` on private.retention_clock_columns(): whether any client role (private.retention_client_roles()) holds INSERT or UPDATE on the column, and which of its named guards is NOT actually present. Three guard kinds (fix round 2, m-N2, added the third and tightened the first): `trigger:<schema.function>` -- an enabled BEFORE ROW trigger on that table calling that function, firing on each operation the client holds, with no column list or one that includes the clock column, and NO WHEN clause (which cannot be judged statically and is refused rather than trusted); `policy:<name>` -- a RESTRICTIVE policy of that name on that table; `no_permissive_policy` -- default deny, named as the layer it is: no PERMISSIVE policy on the relation can admit any client role (or PUBLIC) for an operation the client holds. Read by private.assert_retention_clocks() and by rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_exposure() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE ROLL, REBUILT FROM 20261005000000: the storage entry names default
--    deny beside the six restrictive policies. Every other row byte-identical.
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
  'THE ROLL of every column a retention cutoff reads (Phase 8 Task 6 fix round 1, review finding C1 generalised; fix round 2, I-N1 and m-N2). Each candidate private.retention_clock_candidates() derives is a `clock` or `not_a_clock` with the reason; a `clock` any client role can INSERT or UPDATE must name a guard that really exists, and private.assert_retention_clocks() REFUSES THE JOB otherwise. Guards are `trigger:<fn>`, `policy:<restrictive policy>` or `no_permissive_policy` (default deny, named as the layer it is). It also names the one clock the derivation cannot reach (organisations.lifecycle_changed_at, which a trigger turns into retention_expires_at), and since fix round 2 the PERIOD half of the document clock beside the timestamp half: documents.retention_class, frozen at deletion by the same guard. That a guard actually pins the value is behaviour, and is asserted by a probe per client-writable clock in rls_phase8_retention.sql § RK.';

revoke all on function private.retention_clock_columns() from public, anon, authenticated, service_role;
