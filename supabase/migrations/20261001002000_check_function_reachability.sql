-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- I2 AND I3: A FUNCTION A CHECK CALLS IS ONLY
-- AS REACHABLE AS THE SCHEMA IT LIVES IN.
--
-- I2. 20260930008000 fixed a real and serious defect -- a `private` helper
-- called by public.erasure_jobs' CHECK had been revoked from every client
-- role, so nobody could ask for their account to be deleted -- and then
-- claimed half a fix it did not make:
--
--     grant execute on function private.jsonb_is_count_map(jsonb)
--       to authenticated, service_role;
--
-- with a `comment on` stating the function "IS EXECUTABLE BY `authenticated`
-- AND `service_role` ... AND MUST STAY SO". Measured:
--
--     has_schema_privilege('authenticated','private','usage') --> t
--     has_schema_privilege('service_role','private','usage')  --> f
--     set role service_role; select private.jsonb_is_count_map('{"a":1}');
--     ERROR: permission denied for schema private
--
-- An EXECUTE grant without USAGE on the schema grants nothing. The
-- `authenticated` half is real and load-bearing; the `service_role` half is
-- dead, and the comment asserted something measurably false.
--
-- THE CHOICE, AND WHY. Granting `usage on schema private` to `service_role`
-- would make the comment true and is much wider than this fix should decide
-- alone -- it would expose every present and future `private` helper to a
-- role that bypasses RLS. So the dead half is REMOVED instead, the comment is
-- corrected to say why it is neither present nor needed (every writer of
-- public.erasure_jobs.summary is a `security definer` RPC, evaluated as the
-- definer), and the one path that could have turned "latent" into "live" is
-- closed: 20260930001000 granted `update (... summary ...)` on
-- public.erasure_jobs directly to `service_role`, so the first runner change
-- that wrote the summary over PostgREST instead of through the RPC would have
-- met `permission denied for schema private` -- the same defect the migration
-- exists to fix, in the same table, from the role it believed it had covered.
-- No code writes that column outside run_erasure_job(); the grant on the other
-- four outcome columns is untouched.
--
-- I3. The reviewer swept the whole catalogue -- every function reachable from
-- a CHECK, a column default, a generated column or an index predicate --
-- against each client role's EFFECTIVE privilege, and found the class is
-- bounded and has two more members, both pre-existing:
-- private.custom_field_options_valid and private.network_visibility_is_valid,
-- each unreachable by `service_role` for the same reason. Nothing in the
-- repository measured it, and `has_function_privilege` ALONE REPORTS ALL
-- THREE AS FINE -- `has_schema_privilege` is the column that shows the defect.
-- private.constraint_function_reachability() is that sweep, kept in the
-- database so the schema-invariants suite can pin it: a new CHECK calling a
-- `private` helper that `authenticated` cannot reach is now a red assertion
-- rather than a table nobody can write to.
--
-- ADDITIVE. No previously applied migration is edited; the comment is
-- reissued, which is how a header is corrected here.
-- ===========================================================================

revoke execute on function private.jsonb_is_count_map(jsonb) from service_role;
revoke update (summary) on public.erasure_jobs from service_role;

comment on function private.jsonb_is_count_map(jsonb) is
  'True when a jsonb value is a FLAT object of non-negative integers, plus the three boolean flags public.erasure_jobs.summary is allowed to carry. It is a function rather than an inline CHECK because a CHECK may not contain a subquery, and the rule is a walk over every value. IT IS EXECUTABLE BY `authenticated` (20260930008000) AND MUST STAY SO: a CHECK constraint is evaluated with the privileges of the role performing the write, so revoking it -- the house rule for a `private` helper -- made public.erasure_jobs unwritable by every client role and nobody could ask for their account to be deleted. IT IS NOT EXECUTABLE BY `service_role`, and 20261001002000 removed the grant that pretended it was: `service_role` has no USAGE on schema `private`, so the EXECUTE grant it was given in 20260930008000 granted nothing at all (has_function_privilege says yes and has_schema_privilege says no -- the second is the one that decides). It does not need to be: every writer of `summary` is a SECURITY DEFINER RPC evaluated as the definer, and the same migration removed `service_role`''s direct `update (summary)` grant on the table so that cannot quietly change. It reads no table, is IMMUTABLE and PARALLEL SAFE, and discloses nothing about anything the caller did not pass in.';


-- ---------------------------------------------------------------------------
-- THE SWEEP (I3). Kept in the database rather than in a test file, because
-- the schema-invariants suite is not the only thing that should be able to
-- ask it, and because a query pasted into a test is a query nobody re-reads.
-- ---------------------------------------------------------------------------

create or replace function private.constraint_function_reachability()
returns table (source_kind text, object_name text, source_name text,
               function_name text, role_name text,
               has_execute boolean, has_schema_usage boolean, reachable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with src as (
    select 'check'::text as kind,
           con.conrelid::pg_catalog.regclass::text as obj,
           con.conname::text as name,
           d.refobjid as fn
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_depend d
        on d.objid = con.oid
       and d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
       and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     where con.contype = 'c'
    union all
    select 'default',
           ad.adrelid::pg_catalog.regclass::text,
           a.attname::text,
           d.refobjid
      from pg_catalog.pg_attrdef ad
      join pg_catalog.pg_attribute a
        on a.attrelid = ad.adrelid and a.attnum = ad.adnum
      join pg_catalog.pg_depend d
        on d.objid = ad.oid
       and d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
       and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    union all
    select 'index',
           i.indrelid::pg_catalog.regclass::text,
           i.indexrelid::pg_catalog.regclass::text,
           d.refobjid
      from pg_catalog.pg_index i
      join pg_catalog.pg_depend d
        on d.objid = i.indexrelid
       and d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       and d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
  ), roles as (
    select pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) as r
  )
  select distinct
         src.kind, src.obj, src.name,
         n.nspname || '.' || p.proname,
         roles.r,
         pg_catalog.has_function_privilege(roles.r, p.oid, 'execute'),
         pg_catalog.has_schema_privilege(roles.r, n.oid, 'usage'),
         pg_catalog.has_function_privilege(roles.r, p.oid, 'execute')
           and pg_catalog.has_schema_privilege(roles.r, n.oid, 'usage')
    from src
    join pg_catalog.pg_proc p on p.oid = src.fn
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join roles
   where n.nspname not in ('pg_catalog', 'information_schema')
   order by 1, 2, 3, 4, 5
$$;

comment on function private.constraint_function_reachability() is
  'EVERY function a CHECK constraint, a column default, a generated column or an index predicate calls, against each client role''s EFFECTIVE privilege -- EXECUTE on the function AND USAGE on its schema, because the second is what an ACL-only check misses (I2/I3, Phase 8 Task 5 fix round 1). A CHECK is evaluated with the privileges of the role performing the write, so a client role that cannot reach the function cannot write the table: that is how public.erasure_jobs came to be unwritable by everybody, and it is a class rather than an incident -- private.custom_field_options_valid and private.network_visibility_is_valid are unreachable by `service_role` for the same reason. The schema-invariants suite pins the roll so a new member of the class is a red assertion instead of a table nobody can write to.';

revoke all on function private.constraint_function_reachability() from public, anon, authenticated, service_role;
