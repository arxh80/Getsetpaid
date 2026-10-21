-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 2 -- N1: THE CLASSIFICATION ROLL COULD NOT SEE
-- THREE ORDINARY COLUMN SHAPES.
--
-- private.unclassified_fkless_identifiers() (20261001000000 section 2) is the
-- whole of what stands between a FUTURE uuid column and surviving an erasure:
-- a column no foreign key protects is invisible to every pg_constraint walk
-- in both erasure functions, so an unclassified one is a refusal rather than
-- a success that left a stable identifier behind. The scoped re-review
-- planted ten column shapes, one per rolled-back transaction, and called
-- private.erase_account(): THREE of them got past step 0 in silence.
--
--   E2  `user_id uuid primary key`          -- a NATURAL uuid primary key
--   E3  `primary key (user_id, k)`          -- a uuid inside a COMPOSITE key
--   E4  `whos uuid[]`                       -- a uuid ARRAY
--
-- plus two more this migration also closes because they are a line each:
--
--   E7  a MATERIALIZED VIEW with a uuid column (relkind 'm' -- real storage)
--   E8  a column of a DOMAIN over uuid
--
-- Why each one mattered:
--
--   * the primary-key exclusion exists to drop the surrogate
--     `id uuid primary key default gen_random_uuid()`, and for that it is
--     right. It was written as "is part of ANY primary key", which is
--     over-broad: `create table user_settings (user_id uuid primary key, ...)`
--     is ordinary schema design and would have carried a person's id past
--     every derivation in both erasure functions without a word. The
--     exclusion is narrowed here to what it was for -- a SINGLE-column
--     primary key whose column is literally named `id`.
--   * `uuid[]` CANNOT CARRY A FOREIGN KEY BY CONSTRUCTION (Postgres has no
--     array element FK), so it is the single most likely place for an
--     unprotected identifier to end up -- and `atttypid = 'uuid'` does not
--     match `_uuid`. Both are matched now. An array also cannot be handled by
--     the generic `set <col> = null where <col> = $1` / `delete ... where
--     <col> = $1` loops in private.erase_account() steps 6a/6d, so the roll
--     assertion additionally REFUSES an array column classified with either
--     of those treatments: an array identifier has to be handled by a named
--     step, which is a decision somebody writes down rather than a loop
--     silently doing the wrong thing.
--   * a matview is storage, so a uuid in one is a copy of an identifier that
--     an erasure does not refresh. Plain VIEWs are deliberately NOT included:
--     a view is a query, not a row, and every view in this schema would
--     otherwise have to be classified for nothing.
--
-- THREE SHAPES ARE LEFT OPEN, ON PURPOSE, and are stated here so that the
-- next reader finds the limit written down rather than discovering it:
--
--   E5  a uuid inside a `jsonb` document. Not a uuid column at all; found
--       only by a content scan. public.incident_alerts.details is the one
--       instance and private.erase_account() step 6c rewrites it whole, by
--       hand, for exactly this reason.
--   E6  a uuid column in a schema OTHER than public/private. Widening the
--       schema filter pulls in auth, storage, realtime, vault, extensions,
--       net and graphql -- schemas this product does not own and cannot
--       classify -- which would make every erasure refuse on somebody else's
--       catalogue. The roll is a roll of OUR tables and says so.
--   E9  an identifier stored as `text`. Same answer as E5: not findable
--       without a content scan, and nothing short of one would close it.
--
-- ADDITIVE. Two functions are rebuilt from their LATEST definition
-- (20261001000000 section 2). private.fkless_identifier_columns() does not
-- change -- the catalogue grew no column -- and neither erasure function is
-- touched: both call these by name.
-- ===========================================================================


create or replace function private.unclassified_fkless_identifiers()
returns table (table_name text, column_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.oid::pg_catalog.regclass::text, a.attname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where c.relkind in ('r', 'p', 'm')     -- tables, partitioned tables, MATVIEWS
     and n.nspname in ('public', 'private')
     -- uuid, uuid[], or a DOMAIN over either (N1: E4, E8)
     and (case when t.typbasetype <> 0 then t.typbasetype else t.oid end)
           in ('pg_catalog.uuid'::pg_catalog.regtype, 'pg_catalog.uuid[]'::pg_catalog.regtype)
     -- not part of a foreign key
     and not exists (
       select 1 from pg_catalog.pg_constraint fk
        where fk.contype = 'f' and fk.conrelid = c.oid
          and a.attnum = any (fk.conkey))
     -- not THE SURROGATE primary key. Narrowed in fix round 2 (N1: E2, E3)
     -- from "part of any primary key": a natural `user_id uuid primary key`
     -- and a composite `primary key (user_id, k)` are both a person's id and
     -- both used to be exempt.
     and not exists (
       select 1 from pg_catalog.pg_index i
        where i.indrelid = c.oid and i.indisprimary
          and i.indnatts = 1
          and a.attnum = i.indkey[0]
          and a.attname = 'id')
     -- and not on the roll
     and not exists (
       select 1 from private.fkless_identifier_columns() r
        where r.table_name = c.oid::pg_catalog.regclass::text
          and r.column_name = a.attname::text)
   order by 1, 2
$$;

comment on function private.unclassified_fkless_identifiers() is
  'Every uuid-shaped column in public/private that no foreign key protects, that is not the table''s own surrogate `id` primary key, and that private.fkless_identifier_columns() does not classify. It should always be empty; private.assert_fkless_identifier_roll() is what makes an erasure refuse when it is not. Since fix round 2 (N1) "uuid-shaped" means uuid, uuid[] and a domain over either, "column" includes a materialized view''s (storage, unlike a plain view), and the primary-key exemption is only the SINGLE-column key named `id` -- a natural `user_id uuid primary key` and a uuid inside a composite key are a person''s identifier and used to pass this in silence. Still out of scope, deliberately: a uuid inside jsonb or text (a content scan), and any schema but public/private (auth, storage, realtime and the rest are not ours to classify).';

create or replace function private.assert_fkless_identifier_roll()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing text;
  v_arrays  text;
begin
  select pg_catalog.string_agg(u.table_name || '.' || u.column_name, ', '
                               order by u.table_name, u.column_name)
    into v_missing
    from private.unclassified_fkless_identifiers() u;

  if v_missing is not null then
    raise exception 'erasure: uuid column(s) with no foreign key are not classified on private.fkless_identifier_columns() (%) -- an erasure cannot see them and will not guess', v_missing
      using errcode = '55000', hint = 'unclassified_fkless_identifier';
  end if;

  -- AND A ROLL ENTRY MUST BE ONE THE LOOPS CAN ACTUALLY RUN (N1). Steps 6a
  -- and 6d are `set %I = null where %I = $1` and `delete ... where %I = $1`;
  -- neither means anything over a uuid[]. An array identifier is real work
  -- for a named step, so classifying one as a loop treatment is refused here
  -- rather than quietly matching nothing.
  select pg_catalog.string_agg(r.table_name || '.' || r.column_name, ', '
                               order by r.table_name, r.column_name)
    into v_arrays
    from private.fkless_identifier_columns() r
    join pg_catalog.pg_attribute a
      on a.attrelid = r.table_name::pg_catalog.regclass
     and a.attname = r.column_name
     and a.attnum > 0 and not a.attisdropped
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where r.treatment in ('null_on_match', 'delete_row')
     and (case when t.typbasetype <> 0 then t.typbasetype else t.oid end)
           = 'pg_catalog.uuid[]'::pg_catalog.regtype;

  if v_arrays is not null then
    raise exception 'erasure: uuid[] column(s) (%) are classified with a treatment the generic loops cannot run -- an array identifier needs a named step in the function', v_arrays
      using errcode = '55000', hint = 'array_identifier_needs_a_named_step';
  end if;
end;
$$;

comment on function private.assert_fkless_identifier_roll() is
  'Raises 55000 / unclassified_fkless_identifier when the catalogue has grown a uuid-shaped column no foreign key protects that the roll does not classify, and 55000 / array_identifier_needs_a_named_step when the roll classifies a uuid[] with a treatment private.erase_account()''s generic loops cannot express. Called FIRST by private.erase_account() and private.erase_organisation(), before either touches a row: a column the erasure cannot see is one it cannot promise anything about, so the erasure refuses rather than reporting a success that left an identifier behind. That is C1''s failure mode, made impossible rather than fixed four columns at a time -- and since fix round 2 (N1) a natural uuid primary key, a uuid inside a composite key, a uuid[], a domain over uuid and a materialized view''s column are all shapes it can see.';

revoke all on function private.unclassified_fkless_identifiers() from public, anon, authenticated, service_role;
revoke all on function private.assert_fkless_identifier_roll() from public, anon, authenticated, service_role;
