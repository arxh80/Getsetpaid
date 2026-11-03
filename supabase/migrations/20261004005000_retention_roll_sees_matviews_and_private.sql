-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 1 -- REVIEW FINDING m1.
--
-- THE ROLL COULD NOT SEE A MATERIALIZED VIEW, OR ANYTHING OUTSIDE `public`.
--
-- private.unclassified_retention_subjects() filtered
-- `relnamespace = 'public'` and `relkind in ('r', 'p')`. Measured by the
-- reviewer against the live schema:
--
--   public.probe_part (partitioned) + its partition   RAISES, naming both
--   public.probe_unlogged                             RAISES
--   public.probe_mv   (materialized view)             passes silently
--   public.probe_v    (view)                          passes silently
--   probe_ns.secrets  (another schema)                passes silently
--   private.probe_private                             passes silently
--
-- A VIEW IS FINE: it stores nothing. A MATERIALIZED VIEW HOLDS A COPY OF THE
-- DATA and is exactly the "new retained thing with no declared period" that
-- requirement 1 asks a derivation to catch -- a purged workspace's rows would
-- live on in it until somebody happened to refresh it. Task 5's FK-less roll
-- had the same gap and closed it the same way (20261002000000, N1).
--
-- THE SCHEMA QUESTION, DECIDED THE WAY TASK 5 DECIDED IT. That roll covers
-- `public` AND `private` and states every other schema as a limit rather than
-- an oversight. The same here, for the same reason: those two are the schemas
-- this product's migrations own. `private` holds no table today (it is
-- functions only), so nothing is added to the roll -- but the first table or
-- materialized view somebody puts there is now a REFUSAL until it is
-- classified, under the name `private.<table>`.
--
-- EVERY OTHER SCHEMA IS A STATED LIMIT, not a gap somebody forgot:
--   * auth, storage, realtime, vault, cron, net, supabase_functions,
--     supabase_migrations, extensions... are the PLATFORM's. Their retention
--     is either the platform's or handled by name elsewhere: auth.users goes
--     through private.erase_account(), and storage.objects through
--     public.retention_object_manifest(), whose orphan half exists precisely
--     because no row of ours need name an object.
--   * a NEW schema created by a later migration is NOT seen. A schema
--     allowlist was considered and rejected for one measured reason: the psql
--     suites each create a results schema (`rt`, `lg`, `dsr`, ... twenty-one
--     of them), so "no table outside these schemas" is false on every
--     developer database the moment a suite has run, and an assertion that is
--     only true in production is one nobody can iterate on. The house rule
--     that a product table lives in `public` is what this rests on, and it is
--     written down here so that it is a decision rather than an assumption.
--
-- Fail-closed on partitioned and unlogged tables is kept exactly as it was.
--
-- REBUILT FROM THEIR LATEST DEFINITIONS: private.unclassified_retention_
-- subjects() (20261003000000) and private.assert_retention_roll()
-- (20261003002000).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. WHAT THE ROLL IS A CLAIM ABOUT -- one place, read by both functions
--    below and by the suite, so the three cannot disagree about it.
-- ---------------------------------------------------------------------------

create or replace function private.retention_roll_relations()
returns table (table_name text)
language sql
stable
set search_path = ''
as $$
  select case when n.nspname = 'public' then c.relname::text
              else n.nspname::text || '.' || c.relname::text end
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private')
     -- r ordinary, p partitioned, m MATERIALIZED VIEW. Not v: a view stores
     -- nothing. Not f: a foreign table's rows are somebody else's.
     and c.relkind in ('r', 'p', 'm')
   order by 1
$$;

comment on function private.retention_roll_relations() is
  'EVERY RELATION THE RETENTION ROLL IS A CLAIM ABOUT (Phase 8 Task 6 fix round 1, review finding m1): ordinary tables, partitioned tables AND MATERIALIZED VIEWS, in `public` and `private`. A `public` relation is named bare and a `private` one as `private.<name>`, which is how private.retention_subjects() must name it. As shipped the derivation saw only r and p in `public`, so a materialized view -- which holds a COPY of the data -- and any table in `private` passed silently. A view is excluded because it stores nothing. Every schema but these two is a STATED LIMIT (the platform''s own schemas, whose retention is the platform''s or is handled by name: auth.users by private.erase_account(), storage.objects by the object manifest), decided the way Task 5''s FK-less roll decided it.';

revoke all on function private.retention_roll_relations() from public, anon, authenticated, service_role;
-- The same grant its two callers carry (20261003000000): both are SECURITY
-- INVOKER, so whoever may run them must be able to run this.
grant execute on function private.retention_roll_relations() to authenticated;


create or replace function private.unclassified_retention_subjects()
returns setof text
language sql
stable
set search_path = ''
as $$
  select r.table_name
    from private.retention_roll_relations() r
   where not exists (
     select 1 from private.retention_subjects() s where s.table_name = r.table_name)
   order by 1
$$;

comment on function private.unclassified_retention_subjects() is
  'Every relation private.retention_roll_relations() names that private.retention_subjects() does not classify. Since 20261004005000 (review finding m1) that includes MATERIALIZED VIEWS and anything in `private`, not only ordinary and partitioned tables in `public`.';

revoke all on function private.unclassified_retention_subjects() from public, anon, authenticated, service_role;
grant execute on function private.unclassified_retention_subjects() to authenticated;


create or replace function private.assert_retention_roll()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_missing text;
  v_stale   text;
  v_badclass text;
  v_dupe    text;
  v_seen    bigint;
begin
  -- THE DENOMINATOR FIRST (standing lesson 1). If the catalogue query
  -- resolves nothing, every assertion below passes perfectly while seeing
  -- nothing at all. Fifty-four tables exist in `public` today; a floor of
  -- forty is loose enough never to need touching and tight enough that a
  -- derivation which resolved nothing cannot get past it.
  select pg_catalog.count(*) into v_seen from private.retention_roll_relations();
  if v_seen < 40 then
    raise exception 'assert_retention_roll: only % relation(s) found -- the derivation is not seeing the schema', v_seen
      using errcode = '55000', hint = 'retention_roll_saw_nothing';
  end if;

  select pg_catalog.string_agg(t, ', ' order by t) into v_missing
    from private.unclassified_retention_subjects() t;
  if v_missing is not null then
    raise exception 'assert_retention_roll: % is not classified by private.retention_subjects()', v_missing
      using errcode = '55000', hint = 'unclassified_retention_subject';
  end if;

  select pg_catalog.string_agg(s.table_name, ', ' order by s.table_name) into v_stale
    from private.retention_subjects() s
   where not exists (
     select 1 from private.retention_roll_relations() r where r.table_name = s.table_name);
  if v_stale is not null then
    raise exception 'assert_retention_roll: the roll names %, which does not exist', v_stale
      using errcode = '55000', hint = 'stale_retention_subject';
  end if;

  -- THE THIRD CHECK (20261003002000). Without it the first two can both pass
  -- on a roll that classifies one table twice, under two different
  -- treatments, one of which is wrong.
  select pg_catalog.string_agg(d.table_name, ', ' order by d.table_name) into v_dupe
    from (select s.table_name from private.retention_subjects() s
           group by s.table_name having pg_catalog.count(*) > 1) d;
  if v_dupe is not null then
    raise exception 'assert_retention_roll: % is classified more than once', v_dupe
      using errcode = '55000', hint = 'duplicate_retention_subject';
  end if;

  select pg_catalog.string_agg(s.table_name || '/' || coalesce(s.class, '<null>'), ', ' order by s.table_name)
    into v_badclass
    from private.retention_subjects() s
   where s.treatment = 'swept'
     and (s.class is null
          or not exists (select 1 from private.retention_periods() p where p.class = s.class));
  if v_badclass is not null then
    raise exception 'assert_retention_roll: % is swept under a class that is not declared', v_badclass
      using errcode = '55000', hint = 'unknown_retention_class';
  end if;
end;
$$;

comment on function private.assert_retention_roll() is
  'THE DERIVATION BESIDE THE ROLL (Phase 8 Task 6; the private.assert_fkless_identifier_roll() contract, for tables instead of columns). Run before a retention run is opened, before the object manifest names a key, and at step 0 of the sweep. Five refusals, each with its own hint: `retention_roll_saw_nothing` (its own denominator -- fewer than forty relations means the catalogue query is not seeing the schema), `unclassified_retention_subject` (a relation private.retention_subjects() does not classify), `stale_retention_subject` (a roll entry naming a relation that does not exist), `duplicate_retention_subject` and `unknown_retention_class`. SINCE 20261004005000 (review finding m1) "a relation" is what private.retention_roll_relations() says it is: ordinary tables, partitioned tables AND MATERIALIZED VIEWS in `public` and `private`. It could not previously see a materialized view, which holds a copy of the data, or anything in `private`. Every other schema is a stated limit, decided the way Task 5''s FK-less roll decided it.';

revoke all on function private.assert_retention_roll() from public, anon, authenticated, service_role;
grant execute on function private.assert_retention_roll() to authenticated;
