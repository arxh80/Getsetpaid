-- ===========================================================================
-- THE SOUNDNESS ORACLE MUST NOT ANSWER `sound` OVER AN EMPTY CATALOGUE.
--
-- Census audit (2026-09-21), finding 15, and RR3 from Task 4's scoped
-- re-review, in one additive re-issue of the ONE function both are about.
-- Committed migrations are immutable, so this rebuilds
-- private.export_catalogue_is_sound() from its LATEST definition
-- (20260928001000 section 2) with two changes and nothing else:
--
--  1. NON-EMPTINESS. Every one of its eleven detectors is
--     `select ... from private.export_catalogue() c where <bad>`, joined by
--     `union all` and wrapped in `coalesce(string_agg(...), 'sound')`. An
--     empty catalogue therefore produces zero problem rows and the function
--     answers `sound`. Three terms now say otherwise: the catalogue is not
--     empty, it holds rows of BOTH export kinds, and it has not fallen below
--     a floor of 60 rows (71 at 163 migrations: 31 account, 40 workspace).
--
--  2. `relkind in ('r', 'p')` in the "no such relation" check, where it read
--     `relkind = 'r'`. A PARTITIONED table would have been reported as "no
--     such relation" although it exists -- and partitioning audit_events for
--     the hot/cold retention split (SECURITY.md section 7) is a named future
--     task. The completeness census's two walks were widened the same way in
--     the same change.
--
-- No behaviour outside this function changes, and it still answers `sound`
-- against the live schema.
-- ===========================================================================

create or replace function private.export_catalogue_is_sound()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.string_agg(problem, '; ' order by problem)
       from (
         select 'unknown export_kind: ' || c.export_kind as problem
           from private.export_catalogue() c where c.export_kind not in ('account','workspace')
         union all
         select 'unknown disposition: ' || c.table_name
           from private.export_catalogue() c where c.disposition not in ('exported','excused')
         union all
         select 'excused without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'excused'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without an authorisation: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.authorisation is null or c.authorisation not in ('requester_rls','elevated'))
         union all
         select 'elevated without a reason: ' || c.table_name
           from private.export_catalogue() c
          where c.authorisation = 'elevated'
            and (c.reason is null or pg_catalog.btrim(c.reason) = '')
         union all
         select 'exported without scope columns: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and (c.scope_columns is null or pg_catalog.array_length(c.scope_columns, 1) is null)
         union all
         select 'exported without a key column: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported' and c.key_column is null
         union all
         -- NEW IN 20260927002000.
         select 'the key column is projected away: ' || c.table_name
           from private.export_catalogue() c
          where c.disposition = 'exported'
            and c.projection is not null
            and not (c.key_column = any (c.projection))
         union all
         -- NEW IN 20260928001000 (review finding M2). EVERY elevated row
         -- carries a projection. The catalogue's own stated rule was
         -- "elevated ... where the table holds more than the requester's own
         -- data, an explicit column PROJECTION", and that clause was prose in
         -- three places and machinery in none: impersonation_sessions shipped
         -- elevated with projection = null and therefore `select *`, handing
         -- the requester the operator's free-text reason and a staff user id.
         --
         -- The rule is written TOTAL rather than conditional, because "does
         -- this table hold more than the requester's own data" is a judgement
         -- no query can make. A table whose every column really is theirs
         -- (platform_admins) names its columns and withholds nothing; the
         -- cost of that is one line per elevated table and the benefit is
         -- that the next one cannot ship bare.
         select 'elevated without a projection: ' || c.table_name
           from private.export_catalogue() c
          where c.authorisation = 'elevated'
            and (c.projection is null
                 or pg_catalog.array_length(c.projection, 1) is null)
         union all
         select 'a workspace export table is elevated: ' || c.table_name
           from private.export_catalogue() c
          where c.export_kind = 'workspace' and c.authorisation = 'elevated'
         union all
         select 'no such relation: ' || c.table_name
           from private.export_catalogue() c
          where not exists (select 1 from pg_catalog.pg_class k
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name
                               and k.relkind in ('r', 'p'))
         union all
         select 'no such column ' || col || ' on ' || c.table_name
           from private.export_catalogue() c
           cross join lateral pg_catalog.unnest(
             coalesce(c.scope_columns, '{}'::text[])
             || coalesce(c.projection, '{}'::text[])
             || (case when c.key_column is null then '{}'::text[] else array[c.key_column] end)) as col
          where not exists (select 1 from pg_catalog.pg_attribute a
                              join pg_catalog.pg_class k on k.oid = a.attrelid
                              join pg_catalog.pg_namespace n on n.oid = k.relnamespace
                             where n.nspname = 'public' and k.relname = c.table_name
                               and a.attname = col and a.attnum > 0 and not a.attisdropped)
         union all
         -- NEW IN 20260929000000 (census audit, finding 15). EVERY detector
         -- above is `select ... from private.export_catalogue() where <bad>`,
         -- so an EMPTY catalogue produces zero problem rows and this function
         -- answers `sound`. There was no non-emptiness term and no pinned
         -- count anywhere inside it. That is caught today by the pinned rolls
         -- in tests/integration/export/completeness-census.test.ts -- but this
         -- function is presented by its own comment, and by the test named
         -- "answers `sound` against the live schema", as a SELF-CONTAINED
         -- soundness oracle, and it was not one: any future caller without
         -- those rolls beside it (a migration-time assertion, a psql suite, an
         -- ops check) would have got a green light over nothing.
         --
         -- The floor is deliberately a floor and not an exact count: exact
         -- membership belongs in the TypeScript rolls, which derive it from
         -- pg_constraint. What belongs HERE is the one thing a query over the
         -- catalogue can never otherwise notice, which is that there is no
         -- catalogue.
         select 'the catalogue is EMPTY -- every check above is vacuous'
           where not exists (select 1 from private.export_catalogue())
         union all
         select 'the catalogue has no ' || k.kind || ' rows'
           from (values ('account'), ('workspace')) as k(kind)
          where not exists (select 1 from private.export_catalogue() c
                             where c.export_kind = k.kind)
         union all
         select 'the catalogue has shrunk to ' || pg_catalog.count(*)::text
                || ' rows, below the floor of 60'
           from private.export_catalogue() having pg_catalog.count(*) < 60
         union all
         select 'duplicate catalogue row: ' || c.export_kind || '.' || c.table_name
           from private.export_catalogue() c
          group by c.export_kind, c.table_name having pg_catalog.count(*) > 1
       ) problems),
    'sound');
$$;

comment on function private.export_catalogue_is_sound() is
  'Answers `sound`, or a semicolon-joined list of everything wrong with private.export_catalogue(): an EMPTY catalogue, a catalogue missing either export kind, a catalogue below its 60-row floor (20260929000000 -- without these three every other check here is vacuous over an empty list, and this function is cited as a self-contained oracle), an unknown kind or disposition, an excused row with no reason, an exported row with no authorisation / scope column / key column, a PROJECTION that drops the key column, an ELEVATED row with NO projection, an ELEVATED row in the workspace export, a table or column that does not exist (partitioned tables included since 20260929000000), or a duplicate row. Re-issued in 20260927002000, 20260928001000 and 20260929000000.';

revoke all on function private.export_catalogue_is_sound() from public, anon, authenticated, service_role;
