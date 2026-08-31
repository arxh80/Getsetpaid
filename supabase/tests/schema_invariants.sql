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

-- PHASE 3 FIXTURES.
--
-- A SECOND VENUE AND A ROOM IN EACH, in org A, because A13 needs a room that
-- belongs to a DIFFERENT venue of the SAME tenant -- the attack the
-- three-column events_venue_room_fkey exists to refuse, and the one no
-- two-column tenant-scoped FK can see. Section B's own room (B1) is created
-- too late for section A to use.
insert into public.venues (id, organisation_id, name) values
  ('a0000000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-000000000001','A Venue 2');
insert into public.venue_rooms (id, organisation_id, venue_id, name) values
  ('a6000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000a1','A Venue 1 Room'),
  ('a6000000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000a2','A Venue 2 Room');

insert into public.events (id, organisation_id, name, starts_at) values
  ('a7000000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-000000000001',
   'A Event', timestamptz '2026-09-01 20:00+00'),
  ('a7000000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-000000000001',
   'A Event 2', timestamptz '2026-09-02 20:00+00'),
  ('b7000000-0000-0000-0000-0000000000b1','22220000-0000-0000-0000-000000000002',
   'B Event', timestamptz '2026-09-03 20:00+00');

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

-- PHASE 3. The same class of attack, aimed at the two tables Phase 3 Task 1
-- adds and at the column Phase 2 held NULL until public.events existed. A10-A12
-- and A14 are the ordinary two-column tenant scoping; A13 is the one that only
-- the THREE-column events_venue_room_fkey can refuse, and it is the reason that
-- FK departs from the two-column norm.
select invariants.try('A10 event_lineup: slot on ANOTHER tenant''s event',
  $$insert into public.event_lineup (organisation_id, event_id, artist_id)
    values ('11110000-0000-0000-0000-000000000001','b7000000-0000-0000-0000-0000000000b1',
            'a3000000-0000-0000-0000-0000000000a1')$$,
  'denied(23503)');

select invariants.try('A11 event_lineup: slot naming ANOTHER tenant''s artist',
  $$insert into public.event_lineup (organisation_id, event_id, artist_id)
    values ('11110000-0000-0000-0000-000000000001','a7000000-0000-0000-0000-0000000000a1',
            'b3000000-0000-0000-0000-0000000000b1')$$,
  'denied(23503)');

select invariants.try('A12 events: event naming ANOTHER tenant''s venue',
  $$insert into public.events (organisation_id, name, starts_at, venue_id)
    values ('11110000-0000-0000-0000-000000000001','pwn', now(),
            'b0000000-0000-0000-0000-0000000000b1')$$,
  'denied(23503)');

-- NOT a tenant boundary -- both rows are in org A. It is the INTERNAL
-- consistency the third column buys: the room named belongs to a different
-- venue than the one named. A two-column (venue_room_id, organisation_id) FK
-- would accept this, and the event page would then render a room the venue
-- does not have.
select invariants.try('A13 events: a room of a DIFFERENT venue in the same tenant',
  $$insert into public.events (organisation_id, name, starts_at, venue_id, venue_room_id)
    values ('11110000-0000-0000-0000-000000000001','mismatched room', now(),
            'a0000000-0000-0000-0000-0000000000a1',
            'a6000000-0000-0000-0000-0000000000a2')$$,
  'denied(23503)');

select invariants.try('A14 artist_fee_history: fee against ANOTHER tenant''s event',
  $$insert into public.artist_fee_history
      (organisation_id, artist_id, event_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'b7000000-0000-0000-0000-0000000000b1', date '2026-01-01', 1)$$,
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

-- PHASE 3's five, one per section-A attack above. Each is the same statement
-- with the tenant (or, for B10, the venue) corrected.
select invariants.try('B7  same-tenant event_lineup slot inserts',
  $$insert into public.event_lineup (organisation_id, event_id, artist_id)
    values ('11110000-0000-0000-0000-000000000001','a7000000-0000-0000-0000-0000000000a1',
            'a3000000-0000-0000-0000-0000000000a1')$$,
  'ok(1)');

-- A SECOND EVENT, not the same one: event_lineup_event_artist_live_unique
-- would refuse a duplicate (event, artist) pair, and a 23505 here would read
-- as a failed positive control rather than as the working uniqueness rule it
-- is. B7 covers A10, this covers A11.
select invariants.try('B8  ...and the same artist on a SECOND event of the same tenant',
  $$insert into public.event_lineup (organisation_id, event_id, artist_id)
    values ('11110000-0000-0000-0000-000000000001','a7000000-0000-0000-0000-0000000000a2',
            'a3000000-0000-0000-0000-0000000000a1')$$,
  'ok(1)');

select invariants.try('B9  same-tenant event naming its own venue inserts',
  $$insert into public.events (id, organisation_id, name, starts_at, venue_id)
    values ('a7000000-0000-0000-0000-0000000000a4','11110000-0000-0000-0000-000000000001',
            'A Venue 2 Event', now(), 'a0000000-0000-0000-0000-0000000000a2')$$,
  'ok(1)');

select invariants.try('B10 ...and an event naming a room OF THAT venue inserts',
  $$insert into public.events (organisation_id, name, starts_at, venue_id, venue_room_id)
    values ('11110000-0000-0000-0000-000000000001','A Room Event', now(),
            'a0000000-0000-0000-0000-0000000000a1',
            'a6000000-0000-0000-0000-0000000000a1')$$,
  'ok(1)');

select invariants.try('B11 same-tenant artist_fee_history naming an event inserts',
  $$insert into public.artist_fee_history
      (organisation_id, artist_id, event_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            'a7000000-0000-0000-0000-0000000000a1', date '2026-03-01', 25000)$$,
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

-- REWRITTEN BY PHASE 3 TASK 1, AND THE OLD TEXT IS WORTH KEEPING IN VIEW.
-- It used to read "artist_fee_history.event_id cannot be written before Phase
-- 3" and expect denied(23514), because 20260828001134 held the column NULL
-- with a CHECK rather than leave an unvalidated uuid lying around.
-- 20260901001000 dropped that CHECK and replaced it with the composite
-- artist_fee_history_event_fkey, exactly as FOLLOW-UPS.md required. So the
-- SQLSTATE moves 23514 -> 23503 and the control changes from "the column is
-- unwritable" to "the column is writable, and only with a real event of this
-- tenant". A14 above is the cross-tenant half; this is the dangling-uuid half.
select invariants.try('C4  artist_fee_history.event_id refuses an event that does not exist',
  $$insert into public.artist_fee_history
      (organisation_id, artist_id, event_id, occurred_on, amount_minor)
    values ('11110000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-0000000000a1',
            '99999999-9999-9999-9999-999999999999', date '2026-01-01', 1)$$,
  'denied(23503)');

-- ...and the Phase 2 CHECK really is gone, not merely shadowed by the FK. If
-- it were still there B11 above would have been denied(23514) rather than
-- ok(1) -- but B11 could also be satisfied by a database where BOTH are
-- absent, so the constraint's absence is asserted directly.
select invariants.val('C4b ...and the Phase 2 "unwritable until Phase 3" CHECK is gone',
  $$select count(*)::text from pg_catalog.pg_constraint
     where conname='artist_fee_history_event_id_unwritable_until_phase_3'
       and connamespace='public'::regnamespace$$,
  '0');

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

-- PHASE 3: THE SAME COLUMN-LIST TRAP, ON events_venue_fkey.
--
-- `on delete set null (venue_id)` restricts the SET NULL to the nullable
-- column. WITHOUT the column list Postgres nulls EVERY referencing column,
-- organisation_id included, and organisation_id is NOT NULL -- so E4 would be
-- denied(23502) and deleting any venue an event names would be impossible.
-- Measured in Phase 3 Task 1 by dropping the column list and running exactly
-- this delete:
--
--   ERROR: null value in column "organisation_id" of relation "events"
--          violates not-null constraint
--   CONTEXT: UPDATE ONLY "public"."events"
--            SET "venue_id" = NULL, "organisation_id" = NULL ...
--
-- E4 asserting ok(1) is what catches the regression; E5 is what proves the
-- delete succeeded for the right reason rather than by cascading the event
-- away with the venue.
select invariants.try('E4  deleting a venue an EVENT names succeeds (SET NULL column list)',
  $$delete from public.venues where id='a0000000-0000-0000-0000-0000000000a2'$$,
  'ok(1)');

select invariants.val('E5  ...and it nulled venue_id WITHOUT nulling organisation_id',
  $$select (venue_id is null)::text || '/' || (organisation_id is not null)::text
     from public.events where id='a7000000-0000-0000-0000-0000000000a4'$$,
  'true/true');

-- ---------------------------------------------------------------------------
-- E6-E9. THE SAME DELETE, BUT THE EVENT NAMES A ROOM TOO (fix round 1, I-1).
--
-- E4's fixture event names a venue and NO room, so it never exercised the one
-- combination where two correct constraints fight. MEASURED before the fix:
--
--   ERROR:  new row for relation "events" violates check constraint
--           "events_room_needs_a_venue"
--   CONTEXT: SQL statement "UPDATE ONLY "public"."events"
--            SET "venue_id" = NULL WHERE $1 = "venue_id" AND ..."
--
-- events_venue_fkey's `on delete set null (venue_id)` nulls venue_id while
-- venue_room_id is still set, and a row-level CHECK is evaluated immediately
-- rather than at end of statement, so it fires on the intermediate row. Such a
-- venue could not be hard-deleted at all. The two-column SET NULL list that
-- would fix it inside the constraint is refused by Postgres -- "column
-- venue_room_id referenced in ON DELETE SET action must be part of foreign
-- key", also measured -- so 20260901002000 clears the room in a BEFORE DELETE
-- trigger on public.venues instead, which is the one place the executor
-- guarantees runs before any referential action the delete causes.
--
-- Self-contained fixtures rather than reusing section B's, because this pair
-- of assertions destroys what it plants and the B rows are load-bearing for
-- section D.
-- ---------------------------------------------------------------------------
insert into public.venues (id, organisation_id, name) values
  ('a0000000-0000-0000-0000-0000000000a3','11110000-0000-0000-0000-000000000001','A Venue 3'),
  ('a0000000-0000-0000-0000-0000000000a4','11110000-0000-0000-0000-000000000001','A Venue 4');
insert into public.venue_rooms (id, organisation_id, venue_id, name) values
  ('a6000000-0000-0000-0000-0000000000a3','11110000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000a3','A Venue 3 Room'),
  ('a6000000-0000-0000-0000-0000000000a4','11110000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000a4','A Venue 4 Room');
insert into public.events (id, organisation_id, name, starts_at, venue_id, venue_room_id) values
  ('a7000000-0000-0000-0000-0000000000a5','11110000-0000-0000-0000-000000000001',
   'A Room-Bearing Event', timestamptz '2026-09-04 20:00+00',
   'a0000000-0000-0000-0000-0000000000a3','a6000000-0000-0000-0000-0000000000a3'),
  ('a7000000-0000-0000-0000-0000000000a6','11110000-0000-0000-0000-000000000001',
   'A Room-Bearing Event 2', timestamptz '2026-09-05 20:00+00',
   'a0000000-0000-0000-0000-0000000000a4','a6000000-0000-0000-0000-0000000000a4');

-- THE REGRESSION. Without the trigger this is denied(23514), not ok(1).
select invariants.try('E6  deleting a venue an event names WITH ONE OF ITS ROOMS succeeds',
  $$delete from public.venues where id='a0000000-0000-0000-0000-0000000000a3'$$,
  'ok(1)');

select invariants.val('E7  ...and BOTH columns are null, with organisation_id intact',
  $$select (venue_id is null)::text || '/' || (venue_room_id is null)::text || '/' ||
           (organisation_id is not null)::text
     from public.events where id='a7000000-0000-0000-0000-0000000000a5'$$,
  'true/true/true');

-- THE PAIRED POSITIVE CONTROL, and it is not decoration: a trigger that nulled
-- venue_id as well, or one that fired on the wrong table, would satisfy E6 and
-- E7 while silently unbooking every event whose ROOM was removed. Deleting the
-- room alone must still touch venue_room_id and nothing else.
select invariants.try('E8  CONTROL: deleting the ROOM alone still succeeds',
  $$delete from public.venue_rooms where id='a6000000-0000-0000-0000-0000000000a4'$$,
  'ok(1)');

select invariants.val('E9  ...and nulled ONLY venue_room_id -- the venue survives',
  $$select (venue_id is null)::text || '/' || (venue_room_id is null)::text
     from public.events where id='a7000000-0000-0000-0000-0000000000a6'$$,
  'false/true');

-- ===========================================================================
-- D. STRUCTURAL INVARIANTS over the twelve Phase 2 tables.
--
--    D1-D3 are PERMANENT. D4 and D5 are PHASE-GATED: Task 2 is expected to
--    break them, and each says what to change it to.
-- ===========================================================================

-- The list is written out once, as a VALUES set, so that adding a table
-- without adding it here is visible rather than silent.
-- THIRTEEN SINCE PHASE 2 TASK 6. merge_candidates is the review queue, and it
-- is in this list rather than beside it because D4 and D5 are the assertions
-- that would have caught its two most likely mistakes: a FOR ALL policy, and a
-- grant with no policy behind it (or, in its case, the reverse -- it has no
-- INSERT grant and must therefore have no INSERT policy, because
-- public.screen_for_duplicates() is its only writer).
--
-- SIXTEEN SINCE PHASE 3 TASK 6: `event_status_changes` joins it too, and it is
-- the FIRST member of this list that is READ-ONLY to the application -- SELECT
-- and nothing else, written only by private.record_event_status_change().
-- That is exactly the shape D5 exists to police in its second direction: a
-- write policy added here "for completeness" would have no grant behind it and
-- would be red.
--
-- FIFTEEN SINCE PHASE 3 TASK 1: `events` and `event_lineup` join it, and the
-- view keeps its name because renaming it would touch eight assertions to say
-- nothing new. THEY ARRIVE WITH NO POLICIES, ON PURPOSE -- 20260901000000
-- creates the tables and enables RLS, and 20260901010000 (Task 2) writes the
-- policies. SO D4, D5 AND D11b FAIL FOR EXACTLY ONE TASK, and that is stated
-- on each of them below with the number to expect. A reviewer of Task 2 should
-- check they went GREEN rather than that they were silenced.
create view invariants.phase2_tables as
  select unnest(array[
    'companies','contacts','contact_companies','agencies','artists',
    'artist_representations','artist_fee_history','venues','venue_rooms',
    'custom_field_definitions','custom_field_values','merges',
    'merge_candidates','events','event_lineup','event_status_changes'
  ]) as relname;

select invariants.val('D1  all 16 CRM/events tables exist',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace and c.relkind='r'$$,
  '16');

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

-- WAS PHASE-GATED, NOW LIVE. Task 2 (20260828121000) created the policies, so
-- this flipped from "zero policies" to the invariant that survives: every one
-- of the twelve is reachable, and none of them is reachable through a `for
-- all` policy. A `for all` policy silently applies its USING expression as the
-- WITH CHECK for INSERT, which is how a read predicate ends up governing a
-- write -- CLAUDE.md § Non-negotiable rules and SECURITY.md § 2 both require
-- separate policies per operation.
-- EXPECTED RED BETWEEN PHASE 3 TASK 1 AND TASK 2: actual '2', because
-- public.events and public.event_lineup have zero policies until 20260901010000.
-- Task 2's reviewer checks this is back to '0'.
select invariants.val('D4  all 16 tables have policies, and none is FOR ALL',
  $$select count(*)::text from (
      select c.relname,
             count(p.oid)                                  as npol,
             count(*) filter (where p.polcmd = '*')        as nall
        from invariants.phase2_tables t
        join pg_catalog.pg_class c on c.relname=t.relname
         and c.relnamespace='public'::regnamespace
        left join pg_catalog.pg_policy p on p.polrelid=c.oid
       group by c.relname) s
     where s.npol = 0 or s.nall > 0$$,
  '0');

-- WAS PHASE-GATED, NOW LIVE, and this is the form the original note asked for:
-- "no table holds a grant its policies do not justify". Foundation's design
-- note (e) says a table gets an INSERT grant only if it has an INSERT policy;
-- this asserts the biconditional in BOTH directions, so it also catches the
-- opposite mistake -- a policy written for an operation that was never granted,
-- which reads as a working control and is dead code.
--
-- GRANTS AND POLICIES ARE INDEPENDENT CONTROLS (SECURITY.md § 2): the grant
-- decides whether the table is reachable at all, the policy decides which rows.
-- A mismatch is not cosmetic in either direction.
-- EXPECTED RED BETWEEN PHASE 3 TASK 1 AND TASK 2: actual '6' -- the SELECT,
-- INSERT and UPDATE grants on each of the two new tables, none of which has a
-- policy behind it yet. That is the SAFE direction (a grant with no policy
-- reaches no rows), and it is exactly what this assertion is for.
select invariants.val('D5  every grant on the 16 is justified by a policy, and vice versa',
  $$with granted as (
      select distinct c.relname, g.privilege_type::text as op
        from invariants.phase2_tables t
        join pg_catalog.pg_class c on c.relname=t.relname
         and c.relnamespace='public'::regnamespace
        join information_schema.role_table_grants g
          on g.table_schema='public' and g.table_name=t.relname
         and g.grantee='authenticated'
       where g.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
    ), policed as (
      select distinct c.relname,
             case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                           when 'w' then 'UPDATE' when 'd' then 'DELETE'
                           else 'ALL' end as op
        from invariants.phase2_tables t
        join pg_catalog.pg_class c on c.relname=t.relname
         and c.relnamespace='public'::regnamespace
        join pg_catalog.pg_policy p on p.polrelid=c.oid
    )
    select count(*)::text from (
      (select relname, op from granted except select relname, op from policed)
      union all
      (select relname, op from policed except select relname, op from granted)
    ) d$$,
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
-- TWELVE SINCE PHASE 3 TASK 6. event_status_changes_event_fkey is the
-- twelfth: (event_id, organisation_id) -> public.events, which is what makes a
-- status row filed against another tenant's event refusable at the constraint
-- layer rather than only at the policy one. It is also the only backstop for
-- the tenant-correlation term in that table's SELECT policy, and vice versa --
-- see D11.
-- ELEVEN SINCE PHASE 3 TASK 1. The label used to say "all six" while the list
-- held seven names and the expected value was '7'; the count is now written in
-- the label as well, so the two cannot drift again. The four added are
-- events_venue_fkey, event_lineup_event_fkey, event_lineup_artist_fkey and
-- artist_fee_history_event_fkey -- the last of which is the Phase 2 debt
-- FOLLOW-UPS.md § "Phase 3 -- events" required to be composite.
select invariants.val('D8  all 12 two-column tenant-scoped FKs span exactly 2 columns',
  $$select count(*)::text from pg_catalog.pg_constraint
     where contype='f' and connamespace='public'::regnamespace
       and conname in ('venue_rooms_venue_fkey','contact_companies_contact_fkey',
                       'contact_companies_company_fkey','artist_representations_artist_fkey',
                       'artist_representations_agency_fkey','artist_representations_contact_fkey',
                       'artist_fee_history_artist_fkey',
                       'events_venue_fkey','event_lineup_event_fkey',
                       'event_lineup_artist_fkey','artist_fee_history_event_fkey',
                       'event_status_changes_event_fkey')
       and array_length(conkey,1)=2$$,
  '12');

-- THE NON-VACUITY CONTROL FOR D8, and it earned its place the moment the count
-- moved: D8 counts constraints that are BOTH named and two-column, so a
-- constraint that was dropped or renamed lowers the count in exactly the same
-- way as one that was narrowed to a single column -- and a reader correcting
-- the expected number would silence both. This counts the names that exist at
-- all, whatever their width.
select invariants.val('D8b CONTROL: all 12 of those constraint names still exist',
  $$select count(*)::text from pg_catalog.pg_constraint
     where contype='f' and connamespace='public'::regnamespace
       and conname in ('venue_rooms_venue_fkey','contact_companies_contact_fkey',
                       'contact_companies_company_fkey','artist_representations_artist_fkey',
                       'artist_representations_agency_fkey','artist_representations_contact_fkey',
                       'artist_fee_history_artist_fkey',
                       'events_venue_fkey','event_lineup_event_fkey',
                       'event_lineup_artist_fkey','artist_fee_history_event_fkey',
                       'event_status_changes_event_fkey')$$,
  '12');

-- TWO THREE-COLUMN FKs SINCE PHASE 3 TASK 1. custom_field_values' definition
-- FK pins (field_id, organisation_id, entity_type); events_venue_room_fkey
-- pins (venue_room_id, venue_id, organisation_id), which is what makes A13 --
-- a room of a DIFFERENT venue in the SAME tenant -- refusable at all. Written
-- as a set with its own count rather than two lookups, so narrowing either to
-- two columns is red and dropping either is red for a different reason (D9b).
select invariants.val('D9  the two three-column FKs both span 3 columns',
  $$select count(*)::text from pg_catalog.pg_constraint
     where contype='f' and connamespace='public'::regnamespace
       and conname in ('custom_field_values_definition_fkey','events_venue_room_fkey')
       and array_length(conkey,1)=3$$,
  '2');

select invariants.val('D9b CONTROL: both of those constraint names still exist',
  $$select count(*)::text from pg_catalog.pg_constraint
     where contype='f' and connamespace='public'::regnamespace
       and conname in ('custom_field_values_definition_fkey','events_venue_room_fkey')$$,
  '2');

-- Every Phase 2 table must have a row -> organisation path. CLAUDE.md
-- § Tenancy model makes this a requirement, and every RLS policy Task 2 writes
-- depends on it.
select invariants.val('D10 all 16 tables carry a NOT NULL organisation_id',
  $$select count(*)::text from invariants.phase2_tables t
     join pg_catalog.pg_class c on c.relname=t.relname
      and c.relnamespace='public'::regnamespace
     join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='organisation_id'
     where a.attnotnull$$,
  '16');

-- ---------------------------------------------------------------------------
-- D11. THE CHILD POLICIES' OWN TENANT CORRELATION.
--
-- ADDED BY TASK 8 (the phase exit gate) BECAUSE A MUTATION PROVED THE GAP.
-- `venue_rooms_select_via_venue` was rewritten with its
-- `p.organisation_id = venue_rooms.organisation_id` term removed, and the whole
-- suite stayed green: 843 psql assertions and 174 HTTP checks, zero failures.
--
-- It stayed green for a real reason. The composite FK
-- `venue_rooms_venue_fkey (venue_id, organisation_id)` makes those two columns
-- agree by construction, so while the FK holds the policy term cannot change an
-- answer. Measured on this stack, four ways, with the cross-tenant row planted
-- as `postgres` and read back as an ALPHA manager:
--
--   composite FK + correlation      plant refused (23503)
--   composite FK, NO correlation    plant refused (23503)
--   single-column FK + correlation  planted, ALPHA reads 0  -- policy holds
--   single-column FK, NO correlation planted, ALPHA reads 1  -- BREAKOUT
--
-- So the FK and the policy term are each other's ONLY backstop. D8 asserts the
-- FK is still composite. Until this assertion, nothing asserted the policy was
-- still correlated -- and C1, the proven cross-tenant read this whole file
-- exists for, was one ordinary-looking policy edit plus one ordinary-looking
-- `alter table` away from being reachable again.
--
-- READ BACK THROUGH THE PARSER, NOT OFF THE SOURCE TEXT. `pg_get_expr` deparses
-- the stored node tree, so dollar quotes, comments, casing and whitespace are
-- all normalised before the comparison sees them -- the same technique the
-- permission-catalogue guards M1c/M1d settled on after three source-text
-- regexes were evaded. What it does NOT prove is semantics: a policy could
-- carry the correlation and still be wrong some other way. That is section Y of
-- rls_phase2_crm.sql's job, which asks the policy behaviourally with the FK
-- lifted.
-- ---------------------------------------------------------------------------
--
-- PHASE 3 ADDS ('event_lineup','events'). Its policies land in Task 2's
-- 20260901010000, so D11 counts zero violations out of zero expressions until
-- then and D11b -- the control that exists precisely to catch that state --
-- is RED for one task, at 17 against an expected 21. See D11b.
create view invariants.child_parent as
  select * from (values
    ('venue_rooms',            'venues'),
    ('contact_companies',      'contacts'),
    ('artist_representations', 'artists'),
    ('artist_fee_history',     'artists'),
    ('event_lineup',           'events'),
    ('event_status_changes',   'events')
  ) as v(child, parent);

select invariants.val('D11 every via-parent policy correlates parent.organisation_id with the child''s',
  $$select count(*)::text
      from invariants.child_parent cp
      join pg_catalog.pg_class c on c.relname = cp.child
       and c.relnamespace='public'::regnamespace
      join pg_catalog.pg_policy p on p.polrelid = c.oid
      cross join lateral (values
        (coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '')),
        (coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''))
      ) as e(expr)
     where e.expr ~ ('FROM (public\.)?' || cp.parent || ' ')
       and e.expr not like '%.organisation_id = ' || cp.child || '.organisation_id%'$$,
  '0');

-- NON-VACUITY CONTROL. D11 counts violations, so it also passes against a
-- database in which no policy joins to a parent at all -- a `FROM` that got
-- renamed, a view that replaced a table, a typo in the pair list above. This
-- counts the expressions D11 actually inspected. Seventeen: four on
-- venue_rooms (select, insert, update x2), five on contact_companies (the same
-- plus delete), and four each on artist_representations and artist_fee_history.
--
-- IT EARNED ITS KEEP ON THE FIRST RUN. D11's predicate was originally
-- `like '%FROM ' || parent || ' %'`, written against the deparse psql shows
-- you. Inside `invariants.val` the search_path is pinned to
-- 'pg_catalog, public', so `public` is not the first schema and the deparser
-- SCHEMA-QUALIFIES the relation -- `FROM public.venues p`, not `FROM venues p`.
-- The pattern matched nothing, D11 counted zero violations out of zero
-- expressions, and it PASSED. Only this control failed. The predicate is now a
-- regex that accepts either form, because which one you get depends on a GUC
-- and not on anything about the policy.
--
-- TWENTY-TWO SINCE PHASE 3 TASK 6: the twenty-one below plus ONE on
-- event_status_changes. One, not four, because that table has a single policy
-- and it is a SELECT -- there are no write policies, because there are no
-- write grants (the trigger is the only writer). So it contributes one
-- `polqual` expression and no `polwithcheck` at all.
--
-- TWENTY-ONE SINCE PHASE 3 TASK 1: the seventeen below plus four on
-- event_lineup (select, insert, update x2), matching venue_rooms' shape.
-- EXPECTED RED BETWEEN TASK 1 AND TASK 2: actual '17', because event_lineup
-- has no policies yet. This is the assertion the interval is MOST worth
-- stating on -- D11 itself stays green through the interval, because zero
-- violations out of zero expressions is a pass, and that is the exact vacuity
-- this control was added to catch.
select invariants.val('D11b CONTROL: D11 inspected 22 policy expressions, not zero',
  $$select count(*)::text
      from invariants.child_parent cp
      join pg_catalog.pg_class c on c.relname = cp.child
       and c.relnamespace='public'::regnamespace
      join pg_catalog.pg_policy p on p.polrelid = c.oid
      cross join lateral (values
        (coalesce(pg_catalog.pg_get_expr(p.polqual,      p.polrelid), '')),
        (coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''))
      ) as e(expr)
     where e.expr ~ ('FROM (public\.)?' || cp.parent || ' ')$$,
  '22');

-- ---------------------------------------------------------------------------
-- Teardown. Cascades through every fixture row; rls_foundation.sql runs next
-- and assumes an empty public schema.
-- ---------------------------------------------------------------------------
delete from public.organisations where slug in ('inv-org-a','inv-org-b');

-- event_status_changes IS IN THE COUNT SINCE PHASE 3 TASK 6, and it is the
-- one table here nothing in this file inserts into by hand: every `events`
-- fixture above writes one through the trigger. So it is also the check that
-- the table's ON DELETE CASCADE really reaches the organisation delete below.
select invariants.val('Z1  teardown left no fixture rows behind',
  $$select (select count(*) from public.venues)::text || '/' ||
           (select count(*) from public.contacts)::text || '/' ||
           (select count(*) from public.artist_representations)::text || '/' ||
           (select count(*) from public.custom_field_values)::text || '/' ||
           (select count(*) from public.events)::text || '/' ||
           (select count(*) from public.event_lineup)::text || '/' ||
           (select count(*) from public.event_status_changes)::text$$,
  '0/0/0/0/0/0/0');

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
