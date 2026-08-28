-- ===========================================================================
-- Phase 2 schema-invariant and tenant-boundary regression suite.
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   (runs this file FIRST, then rls_foundation.sql). Requires a freshly reset
--   local stack: the fixtures assume an empty public schema.
--
-- WHY THIS FILE EXISTS
--
-- Task 1 shipped twelve tables, a default-privileges baseline, and a set of
-- tenant-scoped composite foreign keys that are the ONLY thing preventing a
-- proven cross-tenant write -- and nothing tested any of it. A reviewer proved
-- the write end to end (a user in org A inserting a room into org B's venue,
-- which org B's own venue page then rendered). The constraints that close it
-- are load-bearing security controls, and a load-bearing control with no test
-- is one refactor away from being gone.
--
-- SECURITY.md § 10: "Tenant-breakout and network-leakage tests matter more than
-- anything else in this list -- they should exist before a feature ships, not
-- be added after."
--
-- WHAT IT ASSERTS, and the distinction that matters when one fails:
--
--   A. PERMANENT invariants. These must hold forever. A failure here is a
--      regression, full stop.
--   B. PHASE-GATED invariants -- section D. These are true only until Task 2
--      creates policies and grants. Task 2 is EXPECTED to make them fail, and
--      each one names what Task 2 should change it to. A failure there is a
--      prompt, not a bug.
--
-- It uses its own `invariants` schema rather than the `harness` one, because
-- rls_foundation.sql opens with `drop schema if exists harness cascade` and
-- would otherwise take these results with it. Fixtures are torn down at the
-- end so this file leaves the database exactly as it found it.
--
-- No auth.users rows are needed: none of the attacks below require a session,
-- because a foreign key is enforced against every writer regardless of role.
-- That is the whole point of fixing this at the constraint layer rather than in
-- a policy -- see 20260828001132's header.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists invariants cascade;
create schema invariants;

create table invariants.results (
  seq      serial primary key,
  label    text,
  expected text,
  actual   text,
  pass     boolean
);

create function invariants.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into invariants.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs a statement and records ok(<rows>) or denied(<sqlstate>). The sqlstate
-- is asserted, not just "it failed": 23503 (foreign key) and 23505 (unique) and
-- 23514 (check) are different controls, and a test that accepts any error would
-- pass if the table simply did not exist.
create function invariants.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform invariants.record(p_label, p_expected, v_actual);
end $$;

create function invariants.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform invariants.record(p_label, p_expected, v_actual);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants, one of every parent entity in each.
-- Slug prefix `inv-` so the teardown at the end is unambiguous.
-- ---------------------------------------------------------------------------
insert into public.organisations (id, name, slug) values
  ('11110000-0000-0000-0000-000000000001','Invariants Org A','inv-org-a'),
  ('22220000-0000-0000-0000-000000000002','Invariants Org B','inv-org-b');

insert into public.venues (id, organisation_id, name) values
  ('a0000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','A Venue'),
  ('b0000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002','B Venue');
insert into public.contacts (id, organisation_id, name) values
  ('a1000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','A Contact'),
  ('b1000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002','B Contact');
insert into public.companies (id, organisation_id, name) values
  ('a2000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','A Company'),
  ('b2000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002','B Company');
insert into public.artists (id, organisation_id, name) values
  ('a3000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','A Artist'),
  ('b3000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002','B Artist');
insert into public.agencies (id, organisation_id, name) values
  ('a4000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','A Agency'),
  ('b4000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002','B Agency');
insert into public.custom_field_definitions (id, organisation_id, entity_type, key, label, field_type) values
  ('a5000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001','contact','genre','Genre','text');

\o /dev/null

-- ===========================================================================
-- A. THE CROSS-TENANT WRITE. Every insert here was ACCEPTED before
--    20260828001132 and must now be refused with 23503 (foreign_key_violation).
--
--    These are the exact attacks an independent reviewer proved reachable
--    through the RLS shape Task 2 was told to write. If any of them goes green
--    as ok(1), a tenant boundary has been reopened -- treat it as a Sev1.
-- ===========================================================================
select invariants.try('A1  venue_rooms: room into ANOTHER tenant''s venue',
  $$insert into public.venue_rooms (organisation_id, venue_id, name)
    values ('11110000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-0000000000b1','pwn')$$,
  'denied(23503)');

select invariants.try('A2  contact_companies: link to ANOTHER tenant''s company',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id)
    values ('11110000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-0000000000a1',
            'b2000000-0000-0000-0000-0000000000b1')$$,
  'denied(23503)');

select invariants.try('A3  contact_companies: organisation_id matching NEITHER parent',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id)
    values ('22220000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-0000000000a1',
            'a2000000-0000-0000-0000-0000000000a1')$$,
  'denied(23503)');

select invariants.try('A4  artist_representations: ANOTHER tenant''s artist',
  $$insert into public.artist_representations (organisation_id, artist_id, agency_id)
    values ('11110000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-0000000000b1',
            'a4000000-0000-0000-0000-0000000000a1')$$,
  'denied(23503)');

select invariants.try('A5  artist_representations: ANOTHER tenant''s agency',
  $$insert into public.artist_representations (organisation_id, artist_id, agency_id)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'b4000000-0000-0000-0000-0000000000b1')$$,
  'denied(23503)');

select invariants.try('A6  artist_representations: ANOTHER tenant''s contact',
  $$insert into public.artist_representations (organisation_id, artist_id, agency_id, contact_id)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a4000000-0000-0000-0000-0000000000a1','b1000000-0000-0000-0000-0000000000b1')$$,
  'denied(23503)');

select invariants.try('A7  artist_fee_history: fee against ANOTHER tenant''s artist',
  $$insert into public.artist_fee_history (organisation_id, artist_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-0000000000b1',
            date '2026-01-01', 50000)$$,
  'denied(23503)');

select invariants.try('A8  custom_field_values: value against ANOTHER tenant''s definition',
  $$insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
    values ('22220000-0000-0000-0000-000000000002','a5000000-0000-0000-0000-0000000000a1',
            'contact','b1000000-0000-0000-0000-0000000000b1','"x"'::jsonb)$$,
  'denied(23503)');

select invariants.try('A9  custom_field_values: wrong entity_type for its definition',
  $$insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
    values ('11110000-0000-0000-0000-000000000001','a5000000-0000-0000-0000-0000000000a1',
            'venue','a0000000-0000-0000-0000-0000000000a1','"x"'::jsonb)$$,
  'denied(23503)');

-- ===========================================================================
-- B. POSITIVE CONTROLS.
--
--    Without these, section A passes perfectly against a database in which
--    every insert fails for an unrelated reason -- a dropped table, a typo in a
--    fixture uuid, a missing grant. Each one is the same statement as its
--    section-A twin with the tenant corrected.
-- ===========================================================================
select invariants.try('B1  same-tenant venue_rooms row inserts',
  $$insert into public.venue_rooms (id, organisation_id, venue_id, name)
    values ('c0000000-0000-0000-0000-0000000000c1','11110000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-0000000000a1','Main Room')$$,
  'ok(1)');

select invariants.try('B2  same-tenant contact_companies row inserts',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id, is_primary)
    values ('11110000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-0000000000a1',
            'a2000000-0000-0000-0000-0000000000a1', true)$$,
  'ok(1)');

select invariants.try('B3  same-tenant artist_representations row inserts',
  $$insert into public.artist_representations (id, organisation_id, artist_id, agency_id, contact_id)
    values ('c9000000-0000-0000-0000-0000000000c1','11110000-0000-0000-0000-000000000001',
            'a3000000-0000-0000-0000-0000000000a1','a4000000-0000-0000-0000-0000000000a1',
            'a1000000-0000-0000-0000-0000000000a1')$$,
  'ok(1)');

select invariants.try('B4  same-tenant artist_fee_history row inserts',
  $$insert into public.artist_fee_history (organisation_id, artist_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            date '2026-01-01', 50000)$$,
  'ok(1)');

select invariants.try('B5  same-tenant custom_field_values row inserts',
  $$insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
    values ('11110000-0000-0000-0000-000000000001','a5000000-0000-0000-0000-0000000000a1',
            'contact','a1000000-0000-0000-0000-0000000000a1','"techno"'::jsonb)$$,
  'ok(1)');

-- MATCH SIMPLE: a NULL contact_id must skip the composite check entirely, or
-- "represented by the agency, no named agent" becomes unexpressible.
select invariants.try('B6  artist_representations with NULL contact_id is allowed',
  $$insert into public.artist_representations (organisation_id, artist_id, agency_id, contact_id)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a4000000-0000-0000-0000-0000000000a1', null)$$,
  'ok(1)');

-- ===========================================================================
-- C. OTHER SCHEMA-LEVEL CONTROLS shipped by Task 1 and its fix round.
--
--    ORDER MATTERS IN THIS SECTION and the first draft of this file got it
--    wrong, which is worth recording because the failure was misleading rather
--    than obvious. C1-C3 re-home a parent, and a parent with NO children can be
--    re-homed freely -- correctly, since there is nothing left to break. Run
--    before section B they returned ok(1), which reads exactly like a reopened
--    tenant boundary and is not one. They have to run after B has created the
--    children whose references are the thing being protected.
--
--    The same trap applies to the destructive tests, which is why the delete in
--    section E runs last: it removes the contact that C7's uniqueness check
--    depends on.
-- ===========================================================================

-- RE-HOMING. The composite FKs specify no ON UPDATE action, so NO ACTION
-- applies: once a child references a parent, neither can be moved to another
-- tenant. A record does not change tenant; that is an export and a re-import.
--
-- NOTE THE LIMIT, so nobody reads more into a pass here than is there: this
-- protects a parent that HAS children. Moving a childless venue between
-- organisations is still possible at the constraint layer, and making
-- organisation_id immutable outright is Task 2's WITH CHECK, not a foreign key.
select invariants.try('C1  re-home a PARENT that has children is refused',
  $$update public.venues set organisation_id='22220000-0000-0000-0000-000000000002'
     where id='a0000000-0000-0000-0000-0000000000a1'$$,
  'denied(23503)');

select invariants.try('C2  re-home a CHILD into another tenant is refused',
  $$update public.venue_rooms set organisation_id='22220000-0000-0000-0000-000000000002'
     where id='c0000000-0000-0000-0000-0000000000c1'$$,
  'denied(23503)');

select invariants.try('C3  re-home a custom field DEFINITION with values is refused',
  $$update public.custom_field_definitions set organisation_id='22220000-0000-0000-0000-000000000002'
     where id='a5000000-0000-0000-0000-0000000000a1'$$,
  'denied(23503)');

-- event_id is held NULL until Phase 3 can foreign-key it. If this assertion
-- starts failing, Phase 3 has dropped the constraint -- which is correct, and
-- the FK it replaced it with must be COMPOSITE.
select invariants.try('C4  artist_fee_history.event_id cannot be written before Phase 3',
  $$insert into public.artist_fee_history
      (organisation_id, artist_id, event_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            '99999999-9999-9999-9999-999999999999', date '2026-01-01', 1)$$,
  'denied(23514)');

-- is_primary: DECISIONS-QUEUE Q4. B2 already inserted one primary company for
-- this contact; a second must be refused by the partial unique index. A second
-- company row is created here so the attempt is a genuine uniqueness collision
-- rather than a collision with contact_companies_contact_company_unique.
select invariants.try('C5  set up a second company in the same tenant',
  $$insert into public.companies (id, organisation_id, name)
    values ('a2000000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-000000000001','A Company 2')$$,
  'ok(1)');

select invariants.try('C6  a SECOND primary company for one contact is refused',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id, is_primary)
    values ('11110000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-0000000000a1',
            'a2000000-0000-0000-0000-0000000000a2', true)$$,
  'denied(23505)');

select invariants.try('C6b ...but a second NON-primary company is fine',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id, is_primary)
    values ('11110000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-0000000000a1',
            'a2000000-0000-0000-0000-0000000000a2', false)$$,
  'ok(1)');

-- The temporal form: an ENDED primary representation must not block a new one,
-- or the table cannot record ordinary industry history.
select invariants.try('C7  set up an ENDED primary representation',
  $$insert into public.artist_representations
      (organisation_id, artist_id, agency_id, is_primary, started_at, ended_at)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a4000000-0000-0000-0000-0000000000a1', true, date '2020-01-01', date '2023-01-01')$$,
  'ok(1)');

select invariants.try('C8  a NEW current primary is allowed alongside the ended one',
  $$insert into public.artist_representations
      (organisation_id, artist_id, agency_id, is_primary, started_at)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a4000000-0000-0000-0000-0000000000a1', true, date '2024-01-01')$$,
  'ok(1)');

select invariants.try('C9  ...but a SECOND current primary is refused',
  $$insert into public.artist_representations
      (organisation_id, artist_id, agency_id, is_primary, started_at)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a4000000-0000-0000-0000-0000000000a1', true, date '2025-01-01')$$,
  'denied(23505)');

-- owner_user_id defaults to auth.uid(), which is NULL for postgres. Asserted so
-- that if the default is ever changed to something that RAISES for a
-- sessionless writer, every migration and seed in the project breaks loudly
-- here rather than at deploy time.
select invariants.val('C10 owner_user_id default is NULL for a sessionless writer',
  $$select coalesce((select owner_user_id::text from public.venues
                      where id='a0000000-0000-0000-0000-0000000000a1'), '<null>')$$,
  '<null>');

select invariants.val('C11 ...and the default expression really is auth.uid()',
  $$select pg_catalog.pg_get_expr(d.adbin, d.adrelid)
      from pg_catalog.pg_attrdef d
      join pg_catalog.pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
     where d.adrelid='public.venues'::regclass and a.attname='owner_user_id'$$,
  'auth.uid()');

-- ===========================================================================
-- E. DESTRUCTIVE BEHAVIOUR. Runs after every assertion that needs the fixture
--    rows intact, because it removes them.
-- ===========================================================================

-- The ON DELETE SET NULL column list. A bare SET NULL on the composite would
-- try to null organisation_id too (it is NOT NULL) and the delete would FAIL --
-- so E1 asserts the delete SUCCEEDS, and E2 that the tenant column survived it.
-- E1 failing with 23502 (not_null_violation) is the specific regression this
-- pair exists to catch.
select invariants.try('E1  deleting a referenced contact succeeds (SET NULL column list)',
  $$delete from public.contacts where id='a1000000-0000-0000-0000-0000000000a1'$$,
  'ok(1)');

select invariants.val('E2  ...and it nulled contact_id WITHOUT nulling organisation_id',
  $$select (contact_id is null)::text || '/' || (organisation_id is not null)::text
     from public.artist_representations where id='c9000000-0000-0000-0000-0000000000c1'$$,
  'true/true');

select invariants.val('E3  ...and contact_companies cascaded away with the contact',
  $$select count(*)::text from public.contact_companies$$, '0');

-- ===========================================================================
-- D. STRUCTURAL INVARIANTS over the twelve Phase 2 tables.
--
--    D1-D3 are PERMANENT. D4 and D5 are PHASE-GATED: Task 2 is expected to
--    break them, and each says what to change it to.
-- ===========================================================================

-- The list is written out once, as a VALUES set, so that adding a Phase 3 table
-- without adding it here is visible rather than silent.
create view invariants.phase2_tables as
  select unnest(array[
    'companies','contacts','contact_companies','agencies','artists',
    'artist_representations','artist_fee_history','venues','venue_rooms',
    'custom_field_definitions','custom_field_values','merges'
  ]) as relname;

select invariants.val('D1  all 12 Phase 2 tables exist',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace and c.relkind='r'$$,
  '12');

-- RLS on EVERY table in public, not just the twelve: the cheapest possible
-- guard against the next entity table shipping without it.
select invariants.val('D2  every table in public has RLS enabled',
  $$select count(*)::text from pg_catalog.pg_class c
     where c.relnamespace='public'::regnamespace and c.relkind='r'
       and not c.relrowsecurity$$,
  '0');

-- Every foreign key's LEADING column is indexed (CLAUDE.md "Index every foreign
-- key", with the brief's leading-column exemption -- which review finding M2
-- established is the correct reading, and which the composite FKs rely on).
select invariants.val('D3  every FK in public has its leading column indexed',
  $$select count(*)::text
      from pg_catalog.pg_constraint con
     where con.contype='f' and con.connamespace='public'::regnamespace
       and not exists (
         select 1 from pg_catalog.pg_index i
          where i.indrelid=con.conrelid
            and i.indkey[0] = con.conkey[1])$$,
  '0');

-- PHASE-GATED. Task 2 creates the policies; when it does, change '0' to the
-- number it creates, or replace this with a per-table assertion.
select invariants.val('D4  [UNTIL TASK 2] the 12 tables have zero policies',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace
     join pg_catalog.pg_policy p on p.polrelid=c.oid$$,
  '0');

-- PHASE-GATED. Task 2 grants DML back one grant per policy. When it does, this
-- becomes "no table holds a grant its policies do not justify" -- and `anon`
-- should still hold nothing on any of the twelve.
select invariants.val('D5  [UNTIL TASK 2] no client role holds any privilege on the 12',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace
     where c.relacl is not null$$,
  '0');

-- PERMANENT even after Task 2: anon is never granted anything on a tenant
-- table. The default-privileges baseline (20260827232507) is what makes this
-- true by default; this asserts nothing has granted it back by hand.
select invariants.val('D6  anon holds no privilege on any Phase 2 table, ever',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace
     where c.relacl::text like '%anon=%'$$,
  '0');

-- The default-privileges baseline itself. If a future migration or a hosted
-- dashboard action re-grants the stock defaults, new tables silently start
-- arriving with anon privileges again and nothing else would notice.
select invariants.val('D7  the default-privileges baseline is still in place',
  $$select coalesce((select d.defaclacl::text from pg_catalog.pg_default_acl d
      join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
     where n.nspname='public' and d.defaclobjtype='r'
       and d.defaclrole='postgres'::regrole), '<absent>')$$,
  '{postgres=arwdDxtm/postgres}');

-- The composite FKs, asserted structurally as well as behaviourally. Section A
-- proves they WORK; this proves they are still COMPOSITE -- a future migration
-- that "simplified" one back to a single column would leave section A passing
-- only until someone reordered the fixtures.
select invariants.val('D8  all six tenant-scoped FKs span exactly 2 columns',
  $$select count(*)::text from pg_catalog.pg_constraint
     where contype='f' and connamespace='public'::regnamespace
       and conname in ('venue_rooms_venue_fkey','contact_companies_contact_fkey',
                       'contact_companies_company_fkey','artist_representations_artist_fkey',
                       'artist_representations_agency_fkey','artist_representations_contact_fkey',
                       'artist_fee_history_artist_fkey')
       and array_length(conkey,1)=2$$,
  '7');

select invariants.val('D9  custom_field_values'' definition FK spans 3 columns',
  $$select coalesce((select array_length(conkey,1)::text from pg_catalog.pg_constraint
     where conname='custom_field_values_definition_fkey'
       and connamespace='public'::regnamespace), '<absent>')$$,
  '3');

-- Every Phase 2 table must have a row -> organisation path. CLAUDE.md
-- § Tenancy model makes this a requirement, and every RLS policy Task 2 writes
-- depends on it.
select invariants.val('D10 all 12 tables carry a NOT NULL organisation_id',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace
     join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='organisation_id'
     where a.attnotnull$$,
  '12');

-- ---------------------------------------------------------------------------
-- Teardown. Cascades through every fixture row; rls_foundation.sql runs next
-- and assumes an empty public schema.
-- ---------------------------------------------------------------------------
delete from public.organisations where slug in ('inv-org-a','inv-org-b');

select invariants.val('Z1  teardown left no Phase 2 fixture rows behind',
  $$select (select count(*) from public.venues)::text || '/' ||
           (select count(*) from public.contacts)::text || '/' ||
           (select count(*) from public.artist_representations)::text || '/' ||
           (select count(*) from public.custom_field_values)::text$$,
  '0/0/0/0');

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== SCHEMA INVARIANTS / TENANT BOUNDARY =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from invariants.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from invariants.results;
