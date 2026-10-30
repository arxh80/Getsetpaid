-- ============================================================================
-- PHASE 10 TASK 16 (G29): EVERY HOT LIST READ IS INDEX-BACKED AT VOLUME.
--
-- After seed-volume.sql, each hot list's default page and its search page is
-- EXPLAINed as the perf-volume member -- role `authenticated`, real claims,
-- the server request mark on -- so RLS is in the plan exactly as it is for
-- the app. The queries are the shape lib/list/query.ts sends through
-- PostgREST: tenant filter, live rows, the spec's default sort with `id` as
-- the tiebreak, pageSize + 1 rows, and `ilike '%term%'` on the spec's
-- searchColumn.
--
-- A DEFAULT PAGE must not Seq Scan the seeded table: it walks its keyset
-- index (each spec's `backedBy`) and stops after 26 rows. The network
-- directory is the one exception, explained at its check.
--
-- A SEARCH PAGE scans the tenant's live rows, and that is measured, not a
-- gap this file can close: under RLS a non-LEAKPROOF qual such as ILIKE is
-- evaluated after the policies, so it can never be an index condition, and
-- the directory views are security_barrier for the same reason. A trigram
-- index cannot serve any app search; marking ILIKE leakproof needs a
-- superuser, which hosted Supabase does not give. So search rows are pinned
-- by cost alone, and docs/launch-gates.md records the measured time.
--
-- CEILINGS are the planner's total cost on this seed, pinned at roughly twice
-- the measurement: a plan that doubles in cost, or a default page that falls
-- back to a scan, is red. A null ceiling MEASURES instead (the row fails with
-- the number), the same convention as run-rls-tests.sh's `-` pin.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off
\o /dev/null

drop schema if exists perf cascade;
create schema perf;

create table perf.results (
  seq     serial primary key,
  label   text not null,
  verdict text not null,
  cost    numeric,
  pass    boolean not null
);

create function perf.record(p_label text, p_verdict text, p_cost numeric, p_pass boolean)
returns void language sql security definer set search_path = '' as $$
  insert into perf.results (label, verdict, cost, pass) values (p_label, p_verdict, p_cost, p_pass);
$$;

-- Runs under the CALLER's rights (security invoker), so the plan is the
-- authenticated member's, RLS included.
create function perf.check(p_label text, p_table text, p_sql text, p_ceiling numeric, p_scan_by_design boolean)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare
  v_plan jsonb;
  v_cost numeric;
  v_seq  boolean;
begin
  execute 'explain (format json) ' || p_sql into v_plan;
  v_cost := (v_plan -> 0 -> 'Plan' ->> 'Total Cost')::numeric;
  v_seq := jsonb_path_exists(
    v_plan,
    '$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == $t)',
    jsonb_build_object('t', p_table));
  perform perf.record(
    p_label,
    case
      when v_seq and not p_scan_by_design then 'Seq Scan on ' || p_table
      when p_ceiling is null then 'unpinned: measured ' || v_cost
      when v_cost > p_ceiling then 'cost ' || v_cost || ' > ceiling ' || p_ceiling
      when v_seq then 'ok (scan by design)'
      else 'ok'
    end,
    v_cost,
    (p_scan_by_design or not v_seq) and p_ceiling is not null and v_cost <= p_ceiling);
end $$;

grant usage on schema perf to authenticated;
grant execute on function perf.check(text, text, text, numeric, boolean) to authenticated;
grant execute on function perf.record(text, text, numeric, boolean) to authenticated;

select id as org from public.organisations where slug = 'perf-volume' \gset
-- A substring of one seeded row's hash: the search matches a handful of rows.
select substr(md5('4242'), 3, 6) as term \gset

-- table, search column, default sort, ceilings, and why a search column has
-- no trigram index (null: it must have one -- private.duplicate_probe()
-- screens these names by similarity, through SECURITY DEFINER, where the
-- index IS usable).
create temp table hot (
  t text, search text, sort text, list_ceiling numeric, search_ceiling numeric, no_trgm text);
insert into hot values
  ('contacts',  'name',     'name asc',        50  , 4500, null),
  ('companies', 'name',     'name asc',        50  , 4100, null),
  ('artists',   'name',     'name asc',        50  , 4400, null),
  ('venues',    'name',     'name asc',        50  , 4100, null),
  ('agencies',  'name',     'name asc',        50  , 4000, null),
  ('events',    'name',     'starts_at desc',  45  , 4400, 'searched only through RLS; not dedup-screened'),
  ('tasks',     'title',    'created_at desc', 50  , 4200, 'searched only through RLS; not dedup-screened'),
  ('meetings',  'title',    'starts_at desc',  45  , 4400, 'searched only through RLS; not dedup-screened'),
  ('notes',     'body',     'created_at desc', 35  , 4400, 'searched only through RLS; not dedup-screened'),
  ('documents', 'filename', 'created_at desc', 50  , 5400, 'searched only through RLS; not dedup-screened');
grant select on hot to authenticated;

-- The server request mark, as run-rls-tests.sh sets it for every suite.
set getsetpaid.from_server = 'on';
set role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-00000000f001',
                    'role', 'authenticated', 'aal', 'aal2')::text, false);

select perf.check(
  t || ' list', t,
  format('select * from public.%I where organisation_id = %L and deleted_at is null order by %s, id %s limit 26',
         t, :'org', sort, split_part(sort, ' ', 2)),
  list_ceiling, false)
from hot;

select perf.check(
  t || ' search', t,
  format('select * from public.%I where organisation_id = %L and deleted_at is null and %I ilike %L order by %s, id %s limit 26',
         t, :'org', search, '%' || :'term' || '%', sort, split_part(sort, ' ', 2)),
  search_ceiling, true)
from hot;

-- THE DIRECTORY'S DEFAULT PAGE SCANS TOO, and the reason is the view, not an
-- index: a security_barrier view is planned as a subquery before the caller's
-- ORDER BY and LIMIT reach it, so it cannot stop after 26 rows of
-- network_profiles_directory_idx. 20261108003000 took the page from 4,013 ms
-- to ~105 ms on this seed by asking the reach rule once per query; the
-- barrier stays, because it is what keeps a caller's filter behind the gate.
select perf.check('network directory', 'network_profiles',
  'select * from public.network_directory order by display_name asc, id asc limit 26', 3000, true);
select perf.check('network directory search', 'network_profiles',
  format('select * from public.network_directory where display_name ilike %L order by display_name asc, id asc limit 26',
         '%' || :'term' || '%'), 2700, true);

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- TRIGRAM CENSUS: a hot searchColumn has a gin_trgm_ops index, or says why not.
-- ---------------------------------------------------------------------------
select perf.record(
  'trgm index on ' || h.t || '.' || h.search,
  case when found.indexname is not null then 'ok'
       when h.no_trgm is not null then 'exempt: ' || h.no_trgm
       else 'no gin_trgm_ops index' end,
  null,
  found.indexname is not null or h.no_trgm is not null)
from hot h
left join lateral (
  select i.indexname from pg_indexes i
  where i.schemaname = 'public' and i.tablename = h.t
    and i.indexdef ~ ('USING gin \(' || h.search || ' gin_trgm_ops\)')
  limit 1
) found on true;

-- ---------------------------------------------------------------------------
-- MUTANT CONTROL: without contacts_org_name_id_live_idx the contacts list is
-- red, so a default page that loses its keyset index cannot pass.
-- ---------------------------------------------------------------------------
begin;
drop index public.contacts_org_name_id_live_idx;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-00000000f001',
                    'role', 'authenticated', 'aal', 'aal2')::text, true);
select perf.check('MUTANT contacts list without its keyset index', 'contacts',
  format('select * from public.contacts where organisation_id = %L and deleted_at is null order by name asc, id asc limit 26',
         :'org'),
  (select list_ceiling from hot where t = 'contacts'), false);
-- Its row dies with the rollback, so it is carried out in psql variables.
reset role;
select label as m_label, verdict as m_verdict, cost as m_cost, pass as m_pass
from perf.results where label like 'MUTANT%' \gset
rollback;
select perf.record(:'m_label', :'m_verdict', :'m_cost'::numeric, :'m_pass'::boolean);

\o
\pset footer off
select label, verdict, cost from perf.results order by seq;

-- The mutant's row is EXPECTED to fail; every other row must pass.
do $$
declare v_bad int; v_mutant boolean;
begin
  select count(*) into v_bad from perf.results where not pass and label not like 'MUTANT%';
  select pass into v_mutant from perf.results where label like 'MUTANT%';
  if v_mutant is distinct from false then
    raise exception 'list-plans: the mutant control passed, so the check cannot see a lost index';
  end if;
  if v_bad > 0 then
    raise exception 'list-plans: % row(s) failed', v_bad;
  end if;
  raise notice 'list-plans: every plan within its ceiling, and the mutant is red';
end $$;
