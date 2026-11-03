-- ===========================================================================
-- PHASE 8 TASK 7, FIX ROUND 1 -- M1 / M2: THE COVERAGE CENSUS COUNTED A
-- TRIGGER THAT DOES NOT FIRE, AND HAD THREE SHAPES IT COULD NOT SEE.
--
-- private.audit_coverage() is rebuilt from its LATEST (and only) definition,
-- 20261006000000. Four changes:
--
--   M1  `pg_trigger.tgenabled` is read in BOTH probes (the generic pair and
--       the dedicated writer). `alter table public.tasks disable trigger
--       audit_update` left every census test and PA2/PC1-PC5 green (measured
--       before this migration, task-7-report.md § Fix round 1, O2) -- "a
--       trigger exists" is not "a trigger fires". 'D' (disabled) and 'R'
--       (replica-only) no longer count; 'O' and 'A' do.
--   M2a rpc_only now requires `relrowsecurity`: a table whose every policy
--       carries the marker term but whose RLS is OFF ignores all of them.
--   M2b the denominator takes a table with an `organisation_id` column even
--       when its org path is not a direct single-column FK (a composite FK to
--       a parent, or none). Measured: adds no table today.
--   M2c the denominator takes a client-writable auto-updatable VIEW in
--       `public`, which can only read `unaudited` (a view carries no trigger
--       or policy of its own), so the first one is red by name. Measured:
--       network_directory and network_connected_profiles are auto-updatable
--       and hold no client write grant, so neither is in it today.
--
-- WHAT IT STILL CANNOT SEE, stated as the rule rather than per table:
--   * WHAT a trigger does. It sees that one FIRES on an operation; a writer
--     that returns early for some rows (the network_profiles finding) is the
--     behavioural suite's to catch, not this census's.
--   * A trigger's WHEN clause. feedback_audit_status_change and
--     incident_alerts_audit_resolution fire only when status changes, and are
--     counted as covering UPDATE; a WHEN clause that never holds would read
--     the same. Not closed: both are legitimate, so a rule would need a
--     per-trigger excusal list, which is the hand list this avoids.
--   * A table written ONLY by a SECURITY DEFINER function under a session
--     (event_status_changes, merges, impersonation_sessions, ...). The client
--     holds no write grant, so it is outside the denominator by construction;
--     an unaudited definer RPC is invisible here, and its own suite is where
--     that is caught.
--   * Any schema but `public`, and any client role but `authenticated` and
--     `anon` -- the two PostgREST hands to a caller.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.audit_coverage()
returns table (
  table_name    text,
  client_writes text[],
  uncovered_ops text[],
  coverage      text,
  target_type   text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tenant_tables as (
    select c.oid, c.relname, c.relrowsecurity
      from pg_catalog.pg_class c
     where c.relnamespace = 'public'::pg_catalog.regnamespace
       and ((c.relkind in ('r', 'p')
             and (c.relname = 'organisations'
                  or exists (select 1 from pg_catalog.pg_constraint k
                              where k.conrelid = c.oid and k.contype = 'f'
                                and k.confrelid = 'public.organisations'::pg_catalog.regclass)
                  -- (M2b) an org path that is not a DIRECT single-column FK
                  -- (a composite FK to a parent, or none at all) still has
                  -- the column the house convention names it by.
                  or exists (select 1 from pg_catalog.pg_attribute a
                              where a.attrelid = c.oid and a.attname = 'organisation_id'
                                and a.attnum > 0 and not a.attisdropped)))
            -- (M2c) a view a client can write through. It has no trigger and
            -- no policy of its own, so it can only ever read `unaudited`:
            -- the day one exists, it is red by name and needs a reason.
            or (c.relkind = 'v' and pg_catalog.pg_relation_is_updatable(c.oid, false) > 0))
  ),
  ops as (
    -- (table, op) for every client-writable operation. Column-level grants
    -- count: has_column_privilege() answers true for a table-level grant too.
    select t.oid, t.relname, t.relrowsecurity, op.op
      from tenant_tables t
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) op(op)
     where exists (select 1
                     from pg_catalog.pg_attribute a,
                          unnest(array['authenticated', 'anon']) r
                    where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
                      and ((op.op <> 'DELETE' and pg_catalog.has_column_privilege(r, t.oid, a.attname, op.op))
                           or (op.op = 'DELETE' and pg_catalog.has_table_privilege(r, t.oid, 'DELETE'))))
  ),
  generic as (
    select g.tgrelid,
           bool_or(g.tgname = 'audit_insert' and (g.tgtype & 4) <> 0) as has_insert,
           bool_or(g.tgname = 'audit_update' and (g.tgtype & 16) <> 0) as has_update,
           min(pg_catalog.replace(pg_catalog.encode(g.tgargs, 'escape'), '\000', '')) as target,
           count(distinct pg_catalog.replace(pg_catalog.encode(g.tgargs, 'escape'), '\000', '')) as targets
      from pg_catalog.pg_trigger g
      join pg_catalog.pg_proc p on p.oid = g.tgfoid
     where not g.tgisinternal
       -- (M1) a trigger that exists is not a trigger that fires: 'D' is
       -- disabled and 'R' fires only under session_replication_role =
       -- replica, which the product never runs a client write under.
       and g.tgenabled in ('O', 'A')
       and p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname = 'audit_crm_change'
     group by g.tgrelid
  ),
  covered as (
    select o.oid, o.relname, o.op,
           (g.tgrelid is not null and g.targets = 1
              and ((o.op = 'INSERT' and g.has_insert) or (o.op = 'UPDATE' and g.has_update))) as by_generic,
           exists (select 1 from pg_catalog.pg_trigger t
                     join pg_catalog.pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = o.oid and not t.tgisinternal
                      and t.tgenabled in ('O', 'A')    -- (M1), as above
                      and p.pronamespace = 'private'::pg_catalog.regnamespace
                      and p.proname like 'audit\_%'
                      and (t.tgtype & 1) <> 0          -- FOR EACH ROW
                      and (t.tgtype & 66) = 0          -- AFTER (not BEFORE, not INSTEAD OF)
                      and (t.tgtype & (case o.op when 'INSERT' then 4 when 'UPDATE' then 16 else 8 end)) <> 0)
             as by_dedicated,
           -- (M2a) policies are only a gate when row security is ON: with
           -- it off every policy is ignored and a direct write is unaudited.
           (o.relrowsecurity
            and exists (select 1 from pg_catalog.pg_policy pol
                     where pol.polrelid = o.oid and pol.polpermissive
                       and pol.polcmd in ((case o.op when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end), '*'))
            and not exists (select 1 from pg_catalog.pg_policy pol
                     where pol.polrelid = o.oid and pol.polpermissive
                       and pol.polcmd in ((case o.op when 'INSERT' then 'a' when 'UPDATE' then 'w' else 'd' end), '*')
                       and (coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                            || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''))
                           !~ '_in_progress\(\)'))
             as by_rpc_only,
           g.target
      from ops o
      left join generic g on g.tgrelid = o.oid
  )
  select c.relname::text,
         (select pg_catalog.array_agg(x.op order by x.op) from covered x where x.oid = c.oid)::text[],
         coalesce((select pg_catalog.array_agg(x.op order by x.op) from covered x
                    where x.oid = c.oid and not (x.by_generic or x.by_dedicated or x.by_rpc_only)),
                  '{}'::text[])::text[],
         (case
           when exists (select 1 from covered x where x.oid = c.oid
                         and not (x.by_generic or x.by_dedicated or x.by_rpc_only)) then 'unaudited'
           when bool_or(c.by_generic)   then 'generic'
           when bool_or(c.by_dedicated) then 'dedicated'
           else 'rpc_only'
         end)::text,
         (case when bool_or(c.by_generic) then min(c.target) end)::text
    from covered c
   group by c.oid, c.relname
   order by 1
$$;

comment on function private.audit_coverage() is
  'THE CRM WRITE-AUDIT COVERAGE CENSUS (Phase 8 Task 7, 20261006000000; fix round 1, 20261007001000): one row per client-writable relation in public that is tenant-owned (a foreign key to public.organisations, an organisation_id column, or organisations itself) or is an auto-updatable view, derived at call time from pg_constraint, pg_attribute, has_column_privilege, pg_trigger and pg_policy -- no hand list. Each operation is covered by the generic pair (audit_crm_change, target_type returned), by a dedicated AFTER ROW private.audit_* trigger firing on it, or by policies that all carry a transaction-marker term on a table WITH ROW SECURITY ENABLED. A trigger counts only when tgenabled is O or A: a disabled or replica-only trigger does not fire and is not coverage. uncovered_ops names the rest and coverage is unaudited when it is non-empty. Blind by construction to what a trigger does, to a trigger WHEN clause, and to tables only a SECURITY DEFINER function writes (see 20261007001000). tests/integration/admin/crm-audit-coverage-census.test.ts and rls_phase8_crm_audit_p3_6.sql section PC assert that no table is unaudited except the declared excusals, bind generic to CRM_AUDIT_TARGETS both ways, and plant a table -- and a disabled trigger, an RLS-off rpc_only table, a writable view and an FK-less organisation_id column -- this function must report.';

revoke all on function private.audit_coverage() from public, anon, authenticated, service_role;
