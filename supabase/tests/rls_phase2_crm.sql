-- ===========================================================================
-- Phase 2 (Core CRM) RLS / permission / record-scope test suite.
--
-- Covers everything created by
--   20260828120000_crm_permission_catalogue.sql
--   20260828120500_crm_policy_helpers.sql
--   20260828121000_crm_rls_policies.sql
--   20260828121500_updated_at_triggers.sql
--   20260828122000_policy_initplan_retrofit.sql
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   That script creates the twelve auth.users rows this file needs (AFTER the
--   Foundation suite has run, so its own global assertions are undisturbed)
--   and passes their UUIDs and JWT claim sets in as psql variables.
--
-- CAST OF CHARACTERS -- one per role in the DECISIONS-QUEUE § Q2 matrix, so
-- every row of that matrix has a test and every negative cell has one too.
--
--   Org ALPHA (slug org-alpha)                     Org BETA (slug org-beta)
--   ---------------------------------------------  -------------------------
--   powner      owner            aal2              pbowner  owner      aal2
--   padmin      admin            aal2
--   pmanager    manager          aal1              pmulti   admin in BOTH,
--   pbooker     booker           aal1                       aal2 -- the
--   pvenuemgr   venue_manager    aal1                       multi-org case
--   pfinance    finance          aal2                       CLAUDE.md ships
--   pmarketing  marketing        aal1                       at MVP
--   pstd1       standard_user    aal1
--   pstd2       standard_user    aal1
--   pro         read_only        aal1
--
-- THE ASSURANCE LEVELS ARE NOT DECORATION. public.has_permission() has been
-- MFA-gated since 20260827210000: owner, admin and finance hold no permission
-- at all below aal2. Their fixtures therefore run at aal2, which is the
-- realistic steady state for a role CLAUDE.md § Session security requires MFA
-- for, and section J asserts the aal1 case explicitly rather than leaving it
-- as an accident of the fixture.
--
-- HOW THE IMPERSONATION WORKS -- identical to rls_foundation.sql: switch to
-- the `authenticated` Postgres role and set the request.jwt.claims GUC, which
-- is what auth.uid() reads. That is exactly what PostgREST does per request,
-- so the policies are exercised through the real mechanism.
--
-- READ THE EXPECTATION VOCABULARY BEFORE READING THE ASSERTIONS:
--   denied(42501)  the statement was REJECTED -- no grant, or a WITH CHECK /
--                  INSERT policy violation.
--   denied(23503)  rejected by a FOREIGN KEY -- the constraint layer, not RLS.
--                  Task 1's tenant-scoped composite FKs produce this, and the
--                  distinction matters: a 23503 holds for every writer in
--                  every role, including one with no session at all.
--   denied(23505)  rejected by a UNIQUE constraint.
--   ok(0)          the statement was ACCEPTED and matched no rows, because the
--                  USING clause filtered the target out first. Secure, but a
--                  DIFFERENT mechanism from denied(42501), and the tests
--                  assert which one is expected rather than accepting either.
--                  On UPDATE, ok(0) is the signature of "you cannot see it";
--                  denied(42501) is the signature of "you can see it and may
--                  not do that to it".
--
-- POSITIVE CONTROLS ARE MANDATORY HERE. A suite of "expect 0 rows" assertions
-- passes perfectly against a database where every policy denies everything.
-- Every negative below is paired with the positive that proves the path works
-- for somebody.
--
-- psql vars required: powner padmin pmanager pbooker pvenuemgr pfinance
--   pmarketing pstd1 pstd2 pro pbowner pmulti          (uuids)
--   ..._c   claims at that user's realistic assurance level
--   ..._c1  the same user forced to aal1 (the stolen-password session)
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists crm cascade;
create schema crm;

create table crm.results (
  seq      serial primary key,
  label    text,
  expected text,
  actual   text,
  pass     boolean
);

-- SECURITY DEFINER for the same reason harness.record is: the assertions are
-- recorded while the session is switched to `authenticated`, which has no
-- privileges on crm.results.
create function crm.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into crm.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function crm.try(p_label text, p_sql text, p_expected text)
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
  perform crm.record(p_label, p_expected, v_actual);
end $$;

create function crm.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform crm.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema crm to authenticated, anon, service_role;
grant execute on function crm.record(text,text,text) to authenticated, anon, service_role;
grant execute on function crm.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function crm.val(text,text,text)    to authenticated, anon, service_role;

-- Everything from here to the results block is fixture setup and assertion
-- calls, all of which return void or a uuid nobody needs to read. Same idiom
-- as schema_invariants.sql: silence it so the only output is the PASS/FAIL
-- table.
\o /dev/null

-- ===========================================================================
-- Fixtures
-- ===========================================================================
-- The two organisations are created through the sanctioned RPC, impersonated,
-- exactly as rls_foundation.sql does -- so create_organisation() and the owner
-- membership it mints are themselves part of the fixture's correctness.

insert into public.profiles (id, full_name) values
  (:'powner','P Owner'), (:'padmin','P Admin'), (:'pmanager','P Manager'),
  (:'pbooker','P Booker'), (:'pvenuemgr','P VenueMgr'), (:'pfinance','P Finance'),
  (:'pmarketing','P Marketing'), (:'pstd1','P Std One'), (:'pstd2','P Std Two'),
  (:'pro','P ReadOnly'), (:'pbowner','P Beta Owner'), (:'pmulti','P Multi')
on conflict (id) do update set full_name = excluded.full_name;

set role authenticated;
set request.jwt.claims = :'powner_c';
select public.create_organisation('Org Alpha','org-alpha');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select public.create_organisation('Org Beta','org-beta');
reset role; reset request.jwt.claims;

-- Both organisation ids are captured here, as postgres, and referenced by
-- literal from every assertion that needs one.
--
-- THIS IS NOT A CONVENIENCE. The first draft of section B wrote the natural
-- thing -- `insert ... select id from public.organisations where slug =
-- 'org-beta'` -- while impersonating an ALPHA member, and it PASSED for the
-- wrong reason: organisations has its own RLS, the subquery returned no rows,
-- and the insert affected zero rows without the CRM policy ever being
-- consulted. `ok(0)` looked like a denial and was an empty statement. Any
-- cross-tenant assertion that reaches its target organisation through a
-- SELECT the attacker cannot perform is testing nothing.
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- Memberships are inserted as postgres rather than through invite+accept.
-- rls_foundation.sql already tests that path end to end (its whole section on
-- the consent invariant); repeating it here would add eighteen statements and
-- test nothing this suite is about.
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
select o.id, v.uid::uuid, v.rk, 'active', now()
from public.organisations o
cross join (values
  (:'padmin','admin'), (:'pmanager','manager'), (:'pbooker','booker'),
  (:'pvenuemgr','venue_manager'), (:'pfinance','finance'),
  (:'pmarketing','marketing'), (:'pstd1','standard_user'),
  (:'pstd2','standard_user'), (:'pro','read_only'), (:'pmulti','admin')
) as v(uid, rk)
where o.slug = 'org-alpha';

-- pmulti is an admin of BOTH organisations. This is the fixture section H
-- exists for: multi-org membership ships at MVP, so "holds the manage key in
-- two tenants" is an ordinary user, not a contrived one.
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
select o.id, :'pmulti', 'admin', 'active', now()
from public.organisations o where o.slug = 'org-beta';

-- --------------------------------------------------------------------------
-- CRM rows, inserted as postgres so ownership is exactly what the tests need.
-- Fixed uuids so assertions can name them.
--   ...0001 owned by pstd1     ...0002 owned by pmanager     ...0003 unowned
--   ...000b lives in org BETA  ...0004 soft-deleted
-- --------------------------------------------------------------------------
insert into public.companies (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, nullif(v.owner,'')::uuid, v.nm
from public.organisations o, (values
  ('11110000-0000-0000-0000-000000000001', :'pstd1',    'Std1 Co'),
  ('11110000-0000-0000-0000-000000000002', :'pmanager', 'Manager Co'),
  ('11110000-0000-0000-0000-000000000003', '',          'Unowned Co')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.contacts (id, organisation_id, owner_user_id, name, email)
select v.id::uuid, o.id, nullif(v.owner,'')::uuid, v.nm, v.em
from public.organisations o, (values
  ('22220000-0000-0000-0000-000000000001', :'pstd1',    'Std1 Contact',   'std1@example.test'),
  ('22220000-0000-0000-0000-000000000002', :'pmanager', 'Manager Contact','mgr@example.test'),
  ('22220000-0000-0000-0000-000000000003', '',          'Unowned Contact','uno@example.test')
) as v(id, owner, nm, em) where o.slug='org-alpha';

-- A SOFT-DELETED contact owned by pmanager. Design note (g): RLS does not hide
-- it, the application does. Section K asserts that, because "hide it in the
-- policy" is the tempting alternative and it would make restore impossible.
insert into public.contacts (id, organisation_id, owner_user_id, name, deleted_at)
select '22220000-0000-0000-0000-000000000004', o.id, :'pmanager', 'Deleted Contact', now()
from public.organisations o where o.slug='org-alpha';

insert into public.agencies (id, organisation_id, owner_user_id, name)
select '33330000-0000-0000-0000-000000000002', o.id, :'pmanager', 'Manager Agency'
from public.organisations o where o.slug='org-alpha';

insert into public.artists (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, v.owner::uuid, v.nm
from public.organisations o, (values
  ('44440000-0000-0000-0000-000000000001', :'pstd1',    'Std1 Artist'),
  ('44440000-0000-0000-0000-000000000002', :'pmanager', 'Manager Artist')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.venues (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, v.owner::uuid, v.nm
from public.organisations o, (values
  ('55550000-0000-0000-0000-000000000001', :'pstd1',    'Std1 Venue'),
  ('55550000-0000-0000-0000-000000000002', :'pmanager', 'Manager Venue')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.venue_rooms (id, organisation_id, venue_id, name)
select v.id::uuid, o.id, v.venue::uuid, v.nm
from public.organisations o, (values
  ('66660000-0000-0000-0000-000000000001','55550000-0000-0000-0000-000000000001','Std1 Room'),
  ('66660000-0000-0000-0000-000000000002','55550000-0000-0000-0000-000000000002','Manager Room')
) as v(id, venue, nm) where o.slug='org-alpha';

-- THE Q5 FIXTURE. pstd1 owns the CONTACT and does NOT own the COMPANY. The
-- link is scoped by the contact, so pstd1 must see it; if it were scoped by
-- the company (or by both) this row would vanish from their contact page.
insert into public.contact_companies (id, organisation_id, contact_id, company_id, is_primary)
select v.id::uuid, o.id, v.ct::uuid, v.co::uuid, v.pri
from public.organisations o, (values
  ('77770000-0000-0000-0000-000000000001',
   '22220000-0000-0000-0000-000000000001','11110000-0000-0000-0000-000000000002', true),
  ('77770000-0000-0000-0000-000000000002',
   '22220000-0000-0000-0000-000000000002','11110000-0000-0000-0000-000000000002', true)
) as v(id, ct, co, pri) where o.slug='org-alpha';

insert into public.artist_representations
  (id, organisation_id, artist_id, agency_id, is_primary)
select '88880000-0000-0000-0000-000000000002', o.id,
       '44440000-0000-0000-0000-000000000002',
       '33330000-0000-0000-0000-000000000002', true
from public.organisations o where o.slug='org-alpha';

insert into public.artist_fee_history
  (id, organisation_id, artist_id, occurred_on, amount_minor)
select '99990000-0000-0000-0000-000000000002', o.id,
       '44440000-0000-0000-0000-000000000002', date '2026-01-01', 150000
from public.organisations o where o.slug='org-alpha';

insert into public.custom_field_definitions
  (id, organisation_id, entity_type, key, label, field_type)
select v.id::uuid, o.id, v.et, v.k, v.l, 'text'
from public.organisations o, (values
  ('aaaa0000-0000-0000-0000-000000000001','artist', 'rider_notes','Rider notes'),
  ('aaaa0000-0000-0000-0000-000000000002','contact','nickname',   'Nickname'),
  ('aaaa0000-0000-0000-0000-000000000003','venue',  'load_in',    'Load-in')
) as v(id, et, k, l) where o.slug='org-alpha';

insert into public.custom_field_values
  (id, organisation_id, field_id, entity_type, entity_id, value)
select v.id::uuid, o.id, v.fid::uuid, v.et, v.eid::uuid, v.val::jsonb
from public.organisations o, (values
  ('bbbb0000-0000-0000-0000-000000000002','aaaa0000-0000-0000-0000-000000000001',
   'artist','44440000-0000-0000-0000-000000000002','"manager artist rider"'),
  ('bbbb0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000002',
   'contact','22220000-0000-0000-0000-000000000001','"std1 contact nickname"')
) as v(id, fid, et, eid, val) where o.slug='org-alpha';

-- A completed merge on TWO CONTACTS pmanager owns. Section E asserts pstd1
-- cannot read it: field_resolution is a verbatim copy of both records' field
-- values, so an org-wide read policy here would defeat record scope.
insert into public.contacts (id, organisation_id, owner_user_id, name, deleted_at)
select '22220000-0000-0000-0000-000000000005', o.id, :'pmanager', 'Merged Loser', now()
from public.organisations o where o.slug='org-alpha';

insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
select 'cccc0000-0000-0000-0000-000000000002', o.id, 'contact',
       '22220000-0000-0000-0000-000000000002',
       '22220000-0000-0000-0000-000000000005', :'pmanager',
       '{"email":{"kept":"mgr@example.test","discarded":"secret@example.test"}}'::jsonb
from public.organisations o where o.slug='org-alpha';

-- Org BETA: one row per entity type, the other side of every tenant-breakout
-- assertion.
insert into public.companies (id, organisation_id, owner_user_id, name)
select '1111000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Co'
from public.organisations o where o.slug='org-beta';
insert into public.contacts (id, organisation_id, owner_user_id, name)
select '2222000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Contact'
from public.organisations o where o.slug='org-beta';
insert into public.agencies (id, organisation_id, owner_user_id, name)
select '3333000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Agency'
from public.organisations o where o.slug='org-beta';
insert into public.artists (id, organisation_id, owner_user_id, name)
select '4444000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Artist'
from public.organisations o where o.slug='org-beta';
insert into public.venues (id, organisation_id, owner_user_id, name)
select '5555000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Venue'
from public.organisations o where o.slug='org-beta';
insert into public.venue_rooms (id, organisation_id, venue_id, name)
select '6666000b-0000-0000-0000-00000000000b', o.id,
       '5555000b-0000-0000-0000-00000000000b', 'Beta Room'
from public.organisations o where o.slug='org-beta';
insert into public.contact_companies (id, organisation_id, contact_id, company_id)
select '7777000b-0000-0000-0000-00000000000b', o.id,
       '2222000b-0000-0000-0000-00000000000b','1111000b-0000-0000-0000-00000000000b'
from public.organisations o where o.slug='org-beta';
insert into public.artist_representations (id, organisation_id, artist_id, agency_id)
select '8888000b-0000-0000-0000-00000000000b', o.id,
       '4444000b-0000-0000-0000-00000000000b','3333000b-0000-0000-0000-00000000000b'
from public.organisations o where o.slug='org-beta';
insert into public.artist_fee_history
  (id, organisation_id, artist_id, occurred_on, amount_minor)
select '9999000b-0000-0000-0000-00000000000b', o.id,
       '4444000b-0000-0000-0000-00000000000b', date '2026-02-02', 999
from public.organisations o where o.slug='org-beta';
insert into public.custom_field_definitions
  (id, organisation_id, entity_type, key, label, field_type)
select 'aaaa000b-0000-0000-0000-00000000000b', o.id, 'artist','beta_key','Beta','text'
from public.organisations o where o.slug='org-beta';
insert into public.custom_field_values
  (id, organisation_id, field_id, entity_type, entity_id, value)
select 'bbbb000b-0000-0000-0000-00000000000b', o.id,
       'aaaa000b-0000-0000-0000-00000000000b','artist',
       '4444000b-0000-0000-0000-00000000000b','"beta secret"'::jsonb
from public.organisations o where o.slug='org-beta';
insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by)
select 'cccc000b-0000-0000-0000-00000000000b', o.id, 'artist',
       '4444000b-0000-0000-0000-00000000000b',
       'dddd000b-0000-0000-0000-00000000000b', :'pbowner'
from public.organisations o where o.slug='org-beta';

-- ===========================================================================
-- A. The permission catalogue is what DECISIONS-QUEUE § Q2 says it is
-- ===========================================================================
-- Read out of role_permissions, not out of the migration text. A matrix that
-- was seeded wrong makes every policy assertion below meaningless in a way
-- that still shows as green.
select crm.val('A1  owner holds all six CRM keys',
  $$select count(*)::text from public.role_permissions
    where role_key='owner' and permission_key in
    ('view_crm','manage_contacts','manage_artists','manage_venues','manage_custom_fields','merge_records')$$, '6');
select crm.val('A2  admin holds all six CRM keys',
  $$select count(*)::text from public.role_permissions
    where role_key='admin' and permission_key in
    ('view_crm','manage_contacts','manage_artists','manage_venues','manage_custom_fields','merge_records')$$, '6');
select crm.val('A3  manager holds five, NOT manage_custom_fields',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='manager'$$,
  'manage_artists,manage_contacts,manage_venues,merge_records,view_crm');
select crm.val('A4  booker: no venue key, no merge key',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='booker'$$,
  'manage_artists,manage_contacts,view_crm');
select crm.val('A5  venue_manager: no artist key',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='venue_manager'$$,
  'manage_contacts,manage_venues,view_crm');
select crm.val('A6  finance is read-only over the CRM',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='finance'$$, 'view_crm');
select crm.val('A7  marketing: contacts, not artists',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='marketing'$$,
  'manage_contacts,view_crm');
select crm.val('A8  standard_user holds the manage keys (scope is the policy''s job)',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='standard_user'$$,
  'manage_artists,manage_contacts,manage_venues,view_crm');
select crm.val('A9  read_only holds view_crm and nothing else',
  $$select string_agg(permission_key,',' order by permission_key)
    from public.role_permissions where role_key='read_only'$$, 'view_crm');
select crm.val('A10 no platform_superuser row exists anywhere',
  $$select count(*)::text from public.role_permissions where role_key='platform_superuser'$$, '0');

-- ===========================================================================
-- B. Tenant breakout -- every table, both directions
-- ===========================================================================
-- pmanager holds every CRM key in ALPHA except manage_custom_fields, so if any
-- table leaks across the boundary they are the user it leaks to.
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select crm.val('B1  companies: org BETA rows visible to ALPHA',
  $$select count(*)::text from public.companies where name='Beta Co'$$, '0');
select crm.val('B2  contacts: org BETA rows visible',
  $$select count(*)::text from public.contacts where name='Beta Contact'$$, '0');
select crm.val('B3  agencies: org BETA rows visible',
  $$select count(*)::text from public.agencies where name='Beta Agency'$$, '0');
select crm.val('B4  artists: org BETA rows visible',
  $$select count(*)::text from public.artists where name='Beta Artist'$$, '0');
select crm.val('B5  venues: org BETA rows visible',
  $$select count(*)::text from public.venues where name='Beta Venue'$$, '0');
select crm.val('B6  venue_rooms: org BETA rows visible',
  $$select count(*)::text from public.venue_rooms where name='Beta Room'$$, '0');
select crm.val('B7  contact_companies: org BETA rows visible',
  $$select count(*)::text from public.contact_companies
    where id='7777000b-0000-0000-0000-00000000000b'$$, '0');
select crm.val('B8  artist_representations: org BETA rows visible',
  $$select count(*)::text from public.artist_representations
    where id='8888000b-0000-0000-0000-00000000000b'$$, '0');
select crm.val('B9  artist_fee_history: org BETA rows visible',
  $$select count(*)::text from public.artist_fee_history
    where id='9999000b-0000-0000-0000-00000000000b'$$, '0');
select crm.val('B10 custom_field_definitions: org BETA rows visible',
  $$select count(*)::text from public.custom_field_definitions where key='beta_key'$$, '0');
select crm.val('B11 custom_field_values: org BETA rows visible',
  $$select count(*)::text from public.custom_field_values
    where id='bbbb000b-0000-0000-0000-00000000000b'$$, '0');
select crm.val('B12 merges: org BETA rows visible',
  $$select count(*)::text from public.merges
    where id='cccc000b-0000-0000-0000-00000000000b'$$, '0');

-- POSITIVE CONTROLS. Without these, B1-B12 pass against a database in which
-- every policy denies everything.
select crm.val('B13 POSITIVE: pmanager sees ALPHA companies',
  $$select count(*)::text from public.companies$$, '3');
select crm.val('B14 POSITIVE: pmanager sees ALPHA venue_rooms',
  $$select count(*)::text from public.venue_rooms$$, '2');
select crm.val('B15 POSITIVE: pmanager sees ALPHA custom_field_values',
  $$select count(*)::text from public.custom_field_values$$, '2');
select crm.val('B16 POSITIVE: pmanager sees the ALPHA merge',
  $$select count(*)::text from public.merges$$, '1');

-- Cross-tenant WRITES, from the side that can see nothing.
select crm.try('B17 ALPHA manager UPDATEs a BETA contact',
  $$update public.contacts set name='pwned'
    where id='2222000b-0000-0000-0000-00000000000b'$$, 'ok(0)');
select crm.try('B18 ALPHA manager INSERTs into org BETA',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'planted')$$, :'beta_org'), 'denied(42501)');
-- B19/B20 are the exact attack the original Task 1 review proved end to end.
-- NOTE THE SQLSTATE, because it changed when the policies landed and the
-- change is informative: RLS's WITH CHECK is evaluated BEFORE the foreign key,
-- so an `authenticated` caller now gets 42501 where Task 1's constraint-only
-- schema gave 23503. The composite FK has not stopped mattering -- it is what
-- covers every writer RLS does not apply to (postgres, a future SECURITY
-- DEFINER function, a DBA repair script), and schema_invariants.sql § A proves
-- it there, as postgres, where no policy is in the way.
select crm.try('B19 ALPHA manager INSERTs a room into a BETA venue, tagged ALPHA',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
    values (%L,'5555000b-0000-0000-0000-00000000000b','planted')$$, :'alpha_org'),
  'denied(42501)');
select crm.try('B20 ALPHA manager INSERTs a room into a BETA venue, tagged BETA',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
    values (%L,'5555000b-0000-0000-0000-00000000000b','planted')$$, :'beta_org'),
  'denied(42501)');

reset role; reset request.jwt.claims;

-- The other direction: BETA's owner sees nothing of ALPHA.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select crm.val('B21 BETA owner sees zero ALPHA contacts',
  $$select count(*)::text from public.contacts where organisation_id
    = (select id from public.organisations where slug='org-alpha')$$, '0');
select crm.val('B22 POSITIVE: BETA owner sees their own contact',
  $$select count(*)::text from public.contacts$$, '1');
select crm.val('B23 BETA owner sees zero ALPHA custom_field_values',
  $$select count(*)::text from public.custom_field_values
    where id='bbbb0000-0000-0000-0000-000000000001'$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- C. The role matrix, cell by cell -- every negative in DECISIONS-QUEUE § Q2
-- ===========================================================================

-- ---- Booker: artists yes, venues no --------------------------------------
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select crm.try('C1  booker INSERTs an artist (matrix: yes)',
  $$insert into public.artists (organisation_id, name)
    select id,'Booker Artist' from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('C2  booker INSERTs a venue (matrix: NO)',
  $$insert into public.venues (organisation_id, name)
    select id,'Booker Venue' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C3  booker UPDATEs a venue (matrix: NO)',
  $$update public.venues set name='pwned'
    where id='55550000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.val('C4  booker still READS venues (view_crm)',
  $$select count(*)::text from public.venues where id='55550000-0000-0000-0000-000000000002'$$, '1');
select crm.try('C5  booker INSERTs a venue_room (needs manage_venues)',
  $$insert into public.venue_rooms (organisation_id, venue_id, name)
    select id,'55550000-0000-0000-0000-000000000002','Booker Room'
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C6  booker INSERTs an artist_representation (via manage_artists)',
  $$insert into public.artist_representations (organisation_id, artist_id, agency_id)
    select id,'44440000-0000-0000-0000-000000000002','33330000-0000-0000-0000-000000000002'
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('C7  booker INSERTs a merges row (matrix: NO merge_records)',
  $$insert into public.merges (organisation_id, entity_type, winner_id, loser_id, merged_by)
    select id,'artist','44440000-0000-0000-0000-000000000001',
           '44440000-0000-0000-0000-000000000002', (select auth.uid())
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---- Venue Manager: the mirror image -------------------------------------
set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('C8  venue_manager INSERTs a venue (matrix: yes)',
  $$insert into public.venues (organisation_id, name)
    select id,'VM Venue' from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('C9  venue_manager INSERTs an artist (matrix: NO)',
  $$insert into public.artists (organisation_id, name)
    select id,'VM Artist' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C10 venue_manager INSERTs artist_fee_history (needs manage_artists)',
  $$insert into public.artist_fee_history (organisation_id, artist_id, occurred_on, amount_minor)
    select id,'44440000-0000-0000-0000-000000000002',date '2026-03-03',1
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C11 venue_manager INSERTs a venue_room (via manage_venues)',
  $$insert into public.venue_rooms (organisation_id, venue_id, name)
    select id,'55550000-0000-0000-0000-000000000002','VM Room'
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---- Finance: read the CRM, write none of it -----------------------------
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select crm.val('C12 finance READS contacts (view_crm)',
  $$select count(*)::text from public.contacts$$, '5');
select crm.try('C13 finance INSERTs a contact (matrix: NO)',
  $$insert into public.contacts (organisation_id, name)
    select id,'Finance Contact' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C14 finance UPDATEs a contact (matrix: NO)',
  $$update public.contacts set name='pwned'
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('C15 finance INSERTs artist_fee_history -- the tempting cell',
  $$insert into public.artist_fee_history (organisation_id, artist_id, occurred_on, amount_minor)
    select id,'44440000-0000-0000-0000-000000000002',date '2026-03-03',1
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---- Marketing: contacts, not artists ------------------------------------
set role authenticated;
set request.jwt.claims = :'pmarketing_c';
select crm.try('C16 marketing INSERTs a contact (matrix: yes)',
  $$insert into public.contacts (organisation_id, name)
    select id,'Marketing Contact' from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('C17 marketing INSERTs an artist (matrix: NO)',
  $$insert into public.artists (organisation_id, name)
    select id,'Marketing Artist' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---- Manager: everything but manage_custom_fields ------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('C18 manager DEFINEs a custom field (matrix: NO)',
  $$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select id,'contact','mgr_key','Mgr','text'
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C19 manager EDITs a custom field definition (matrix: NO)',
  $$update public.custom_field_definitions set label='pwned'
    where id='aaaa0000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.val('C20 manager still READS definitions (view_crm)',
  $$select count(*)::text from public.custom_field_definitions$$, '3');
select crm.try('C21 manager INSERTs a merges row (matrix: yes)',
  $$insert into public.merges (organisation_id, entity_type, winner_id, loser_id, merged_by)
    select id,'contact','22220000-0000-0000-0000-000000000002',
           '22220000-0000-0000-0000-000000000003',(select auth.uid())
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---- Admin: the only role that may define custom fields ------------------
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.try('C22 admin DEFINEs a custom field (matrix: yes)',
  $$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select id,'contact','admin_key','Admin','text'
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---- Read Only: sees its own records, writes nothing anywhere ------------
set role authenticated;
set request.jwt.claims = :'pro_c';
select crm.val('C23 read_only owns nothing, so sees no contacts',
  $$select count(*)::text from public.contacts$$, '0');
select crm.val('C24 read_only sees no companies / artists / venues',
  $$select (
      (select count(*) from public.companies)
    + (select count(*) from public.artists)
    + (select count(*) from public.venues))::text$$, '0');
select crm.val('C25 read_only DOES see custom field DEFINITIONS (org config)',
  $$select count(*)::text from public.custom_field_definitions$$, '4');
select crm.try('C26 read_only INSERTs a contact',
  $$insert into public.contacts (organisation_id, name)
    select id,'RO Contact' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C27 read_only INSERTs a company',
  $$insert into public.companies (organisation_id, name)
    select id,'RO Co' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C28 read_only INSERTs a venue',
  $$insert into public.venues (organisation_id, name)
    select id,'RO Venue' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C29 read_only INSERTs an artist',
  $$insert into public.artists (organisation_id, name)
    select id,'RO Artist' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C30 read_only INSERTs a custom_field_value',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000002','contact',
           '22220000-0000-0000-0000-000000000002','"x"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('C31 read_only DELETEs a contact_companies link',
  $$delete from public.contact_companies
    where id='77770000-0000-0000-0000-000000000001'$$, 'ok(0)');
select crm.try('C32 read_only UPDATEs a contact',
  $$update public.contacts set name='pwned'
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(0)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- D. Record scope -- the Standard User boundary (DECISIONS-QUEUE Q3)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd1_c';

select crm.val('D1  pstd1 sees ONLY their own contact',
  $$select string_agg(name,',' order by name) from public.contacts$$, 'Std1 Contact');
select crm.val('D2  pstd1 sees ONLY their own company',
  $$select string_agg(name,',' order by name) from public.companies$$, 'Std1 Co');
select crm.val('D3  pstd1 sees ONLY their own artist and venue',
  $$select ((select count(*) from public.artists)
          + (select count(*) from public.venues))::text$$, '2');
select crm.val('D4  the UNOWNED company is invisible to a scoped role',
  $$select count(*)::text from public.companies where name='Unowned Co'$$, '0');
select crm.try('D5  pstd1 UPDATEs someone else''s contact -> filtered, not denied',
  $$update public.contacts set name='pwned'
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('D6  pstd1 CLAIMS someone else''s contact by rewriting the owner',
  $$update public.contacts set owner_user_id=(select auth.uid())
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('D7  pstd1 GIVES AWAY their own contact (pushes it out of scope)',
  format($$update public.contacts set owner_user_id=%L
    where id='22220000-0000-0000-0000-000000000001'$$, :'pstd2'), 'denied(42501)');
select crm.try('D8  pstd1 NULLs the owner of their own contact',
  $$update public.contacts set owner_user_id=null
    where id='22220000-0000-0000-0000-000000000001'$$, 'denied(42501)');
select crm.try('D9  pstd1 INSERTs a contact owned by a colleague',
  format($$insert into public.contacts (organisation_id, owner_user_id, name)
    select id,%L,'planted' from public.organisations where slug='org-alpha'$$,
    :'pstd2'), 'denied(42501)');
select crm.try('D10 pstd1 INSERTs an UNOWNED contact',
  $$insert into public.contacts (organisation_id, owner_user_id, name)
    select id,null,'orphan' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('D11 POSITIVE: pstd1 INSERTs a contact, owner defaults to them',
  $$insert into public.contacts (organisation_id, name)
    select id,'Std1 New' from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('D12 POSITIVE: pstd1 EDITs their own contact',
  $$update public.contacts set title='Promoter'
    where id='22220000-0000-0000-0000-000000000001'$$, 'ok(1)');
select crm.try('D13 POSITIVE: pstd1 SOFT-DELETEs their own contact',
  $$update public.contacts set deleted_at=now()
    where id='22220000-0000-0000-0000-000000000001'$$, 'ok(1)');
select crm.try('D14 pstd1 HARD-deletes their own contact (no DELETE grant)',
  $$delete from public.contacts where id='22220000-0000-0000-0000-000000000001'$$,
  'denied(42501)');
select crm.try('D15 POSITIVE: pstd1 restores it (soft delete is not hidden)',
  $$update public.contacts set deleted_at=null
    where id='22220000-0000-0000-0000-000000000001'$$, 'ok(1)');

-- Child tables inherit the parent's scope, and the venue_rooms case is the
-- one to check: pstd1 owns venue ...0001 and not ...0002.
select crm.val('D16 pstd1 sees only the room of the venue they own',
  $$select string_agg(name,',' order by name) from public.venue_rooms$$, 'Std1 Room');
select crm.try('D17 pstd1 INSERTs a room into a venue they do not own',
  $$insert into public.venue_rooms (organisation_id, venue_id, name)
    select id,'55550000-0000-0000-0000-000000000002','planted'
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('D18 POSITIVE: pstd1 INSERTs a room into their OWN venue',
  $$insert into public.venue_rooms (organisation_id, venue_id, name)
    select id,'55550000-0000-0000-0000-000000000001','Std1 Room 2'
    from public.organisations where slug='org-alpha'$$, 'ok(1)');

-- Q5: contact_companies is scoped by the CONTACT. pstd1 owns the contact and
-- does NOT own the company, and must still see and manage the link.
select crm.val('D19 Q5: pstd1 sees the link on their own contact (not the company''s)',
  $$select count(*)::text from public.contact_companies
    where id='77770000-0000-0000-0000-000000000001'$$, '1');
select crm.val('D20 Q5: pstd1 does NOT see the link on someone else''s contact',
  $$select count(*)::text from public.contact_companies
    where id='77770000-0000-0000-0000-000000000002'$$, '0');
select crm.try('D21 Q5: pstd1 links their contact to a company they do not own',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id)
    select id,'22220000-0000-0000-0000-000000000001',
           '11110000-0000-0000-0000-000000000003'
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('D22 pstd1 links someone ELSE''s contact to a company',
  $$insert into public.contact_companies (organisation_id, contact_id, company_id)
    select id,'22220000-0000-0000-0000-000000000002',
           '11110000-0000-0000-0000-000000000001'
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('D23 POSITIVE: pstd1 DELETEs the link on their own contact',
  $$delete from public.contact_companies
    where id='77770000-0000-0000-0000-000000000001'$$, 'ok(1)');
select crm.try('D24 pstd1 DELETEs the link on someone else''s contact',
  $$delete from public.contact_companies
    where id='77770000-0000-0000-0000-000000000002'$$, 'ok(0)');

-- pstd1 sees only their own custom field values, through the entity dispatch.
select crm.val('D25 pstd1 sees only the value on their OWN contact',
  $$select count(*)::text from public.custom_field_values$$, '1');
select crm.val('D26 the value on pmanager''s artist is invisible',
  $$select count(*)::text from public.custom_field_values
    where id='bbbb0000-0000-0000-0000-000000000002'$$, '0');
select crm.val('D27 pstd1 cannot read the merge on pmanager''s contacts',
  $$select count(*)::text from public.merges$$, '0');
reset role; reset request.jwt.claims;

-- pstd2 owns nothing: the second Standard User proves D1-D3 are scope and not
-- a coincidence of the fixture.
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select crm.val('D28 pstd2 owns nothing and sees nothing',
  $$select ((select count(*) from public.contacts)
          + (select count(*) from public.companies)
          + (select count(*) from public.artists)
          + (select count(*) from public.venues))::text$$, '0');
select crm.val('D29 pstd2 sees no venue_rooms and no custom_field_values',
  $$select ((select count(*) from public.venue_rooms)
          + (select count(*) from public.custom_field_values))::text$$, '0');
reset role; reset request.jwt.claims;

-- pmanager, a full-scope role, sees the unowned row pstd1 could not.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('D30 POSITIVE: a full-scope role DOES see the unowned company',
  $$select count(*)::text from public.companies where name='Unowned Co'$$, '1');
select crm.try('D31 POSITIVE: a full-scope role may REASSIGN an owner',
  format($$update public.companies set owner_user_id=%L
    where id='11110000-0000-0000-0000-000000000003'$$, :'pstd2'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- E. The polymorphic hole -- custom_field_values.entity_id, merges.winner/loser
-- ===========================================================================
-- SECURITY.md § 10 sends a pentester straight here. Task 1's re-review proved
-- both columns accept a uuid in ANY tenant at the constraint layer (A5b/A6,
-- `ok(1)`), and that no foreign key can close it. These are the assertions
-- that the policy does.
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select crm.try('E1  cfv: ALPHA row naming a BETA contact as its entity',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000002','contact',
           '2222000b-0000-0000-0000-00000000000b','"planted by ALPHA"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('E2  cfv: entity_type says contact, entity_id is an ARTIST',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000002','contact',
           '44440000-0000-0000-0000-000000000002','"type confusion"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('E3  cfv: entity_id names nothing at all',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000002','contact',
           'deadbeef-0000-0000-0000-000000000000','"dangling"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('E4  POSITIVE: cfv against an ALPHA contact is accepted',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000002','contact',
           '22220000-0000-0000-0000-000000000003','"legitimate"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('E5  cfv: REPOINT an existing value at a BETA entity',
  $$update public.custom_field_values
    set entity_id='2222000b-0000-0000-0000-00000000000b'
    where id='bbbb0000-0000-0000-0000-000000000001'$$, 'denied(42501)');

select crm.try('E6  merges: winner in ALPHA, loser in BETA',
  $$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    select id,'contact','22220000-0000-0000-0000-000000000002',
           '2222000b-0000-0000-0000-00000000000b',(select auth.uid())
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('E7  merges: BOTH sides in BETA, row tagged ALPHA',
  $$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    select id,'contact','2222000b-0000-0000-0000-00000000000b',
           '1111000b-0000-0000-0000-00000000000b',(select auth.uid())
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('E8  merges: attributed to ANOTHER user',
  format($$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    select id,'contact','22220000-0000-0000-0000-000000000002',
           '22220000-0000-0000-0000-000000000003',%L
    from public.organisations where slug='org-alpha'$$, :'padmin'), 'denied(42501)');
select crm.try('E9  merges: UPDATE is unreachable (append-only)',
  $$update public.merges set field_resolution='{}'::jsonb
    where id='cccc0000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('E10 merges: DELETE is unreachable (append-only)',
  $$delete from public.merges where id='cccc0000-0000-0000-0000-000000000002'$$,
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- F. custom_field_values follows the PARENT ENTITY's permission
-- ===========================================================================
-- The subtlest requirement in the brief: a Booker editing an artist must be
-- able to fill in that artist's custom fields without being able to define
-- new ones. Asserted in BOTH directions, because either half alone is
-- satisfied by a wrong implementation.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select crm.try('F1  booker WRITES a value on an artist (manage_artists)',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000001','artist',
           '44440000-0000-0000-0000-000000000001','"booker filled this"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('F2  booker DEFINEs a custom field (manage_custom_fields: NO)',
  $$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select id,'artist','booker_key','Booker','text'
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('F3  booker WRITES a value on a VENUE (needs manage_venues)',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000003','venue',
           '55550000-0000-0000-0000-000000000002','"nope"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.try('F4  booker DELETEs the value they just wrote',
  $$delete from public.custom_field_values
    where entity_id='44440000-0000-0000-0000-000000000001'
      and field_id='aaaa0000-0000-0000-0000-000000000001'$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('F5  venue_manager WRITES a value on a VENUE (manage_venues)',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000003','venue',
           '55550000-0000-0000-0000-000000000002','"load in at 14:00"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'ok(1)');
select crm.try('F6  venue_manager WRITES a value on an ARTIST (NO)',
  $$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    select id,'aaaa0000-0000-0000-0000-000000000001','artist',
           '44440000-0000-0000-0000-000000000001','"nope"'::jsonb
    from public.organisations where slug='org-alpha'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- G. organisation_id and id immutability through the UPDATE policies
-- ===========================================================================
-- pmulti is an admin of BOTH organisations, so every other control in the
-- schema permits this write: they hold manage_contacts in the source AND the
-- destination. private.entity_org_unchanged() is the only thing that refuses.
set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.try('G1  pmulti moves an ALPHA contact into org BETA',
  $$update public.contacts set organisation_id=
      (select id from public.organisations where slug='org-beta')
    where id='22220000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('G2  pmulti moves an ALPHA venue into org BETA',
  $$update public.venues set organisation_id=
      (select id from public.organisations where slug='org-beta')
    where id='55550000-0000-0000-0000-000000000001'$$, 'denied(42501)');
select crm.try('G3  pmulti moves a custom field DEFINITION into org BETA',
  $$update public.custom_field_definitions set organisation_id=
      (select id from public.organisations where slug='org-beta')
    where id='aaaa0000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('G4  pmulti rewrites a contact''s PRIMARY KEY',
  $$update public.contacts set id='eeee0000-0000-0000-0000-00000000000e'
    where id='22220000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('G5  POSITIVE: pmulti edits the same contact normally',
  $$update public.contacts set location='London'
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(1)');
-- venue_rooms carries no entity_org_unchanged() call, because Task 1's
-- tenant-scoped composite FK already refuses a re-home. What this asserts is
-- that the RLS layer refuses it FIRST (42501, not 23503): the WITH CHECK
-- resolves the NEW organisation_id against the room's venue, and the venue is
-- in ALPHA. The two controls are not redundant -- see B19's note.
select crm.try('G6  pmulti re-homes a venue_room -- RLS refuses before the FK',
  format($$update public.venue_rooms set organisation_id=%L
    where id='66660000-0000-0000-0000-000000000002'$$, :'beta_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ...and the FK really is still there, proven where RLS is not in the way.
-- postgres owns these tables and RLS is not FORCED, so this statement sees no
-- policy at all and hits the constraint.
select crm.try('G7  the same re-home as postgres hits the composite FK (23503)',
  format($$update public.venue_rooms set organisation_id=%L
    where id='66660000-0000-0000-0000-000000000002'$$, :'beta_org'),
  'denied(23503)');

-- ===========================================================================
-- H. Grants -- the outer gate, independent of every policy above
-- ===========================================================================
select crm.val('H1  anon holds no privilege on any Phase 2 table',
  $$select coalesce(sum(n),0)::text from (
      select count(*) n from information_schema.role_table_grants
      where grantee='anon' and table_schema='public' and table_name in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')) s$$, '0');
select crm.val('H2  service_role holds no privilege on any Phase 2 table',
  $$select coalesce(sum(n),0)::text from (
      select count(*) n from information_schema.role_table_grants
      where grantee='service_role' and table_schema='public' and table_name in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')) s$$, '0');
select crm.val('H3  the nine soft-deleted / config tables have NO delete grant',
  $$select count(*)::text from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public'
      and privilege_type='DELETE' and table_name in
      ('companies','contacts','agencies','artists','venues','venue_rooms',
       'artist_representations','artist_fee_history','custom_field_definitions',
       'merges')$$, '0');
select crm.val('H4  exactly two tables carry a DELETE grant',
  $$select string_agg(table_name,',' order by table_name)
    from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public'
      and privilege_type='DELETE' and table_name in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')$$,
  'contact_companies,custom_field_values');
select crm.val('H5  merges has SELECT+INSERT and nothing else',
  $$select string_agg(privilege_type,',' order by privilege_type)
    from information_schema.role_table_grants
    where grantee='authenticated' and table_schema='public' and table_name='merges'$$,
  'INSERT,SELECT');
select crm.val('H6  every Phase 2 table still has RLS enabled',
  $$select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relrowsecurity and c.relname in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')$$, '12');
select crm.val('H7  no FOR ALL policy exists on any Phase 2 table',
  $$select count(*)::text from pg_policies
    where schemaname='public' and cmd='ALL' and tablename in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')$$, '0');
select crm.val('H8  every INSERT and UPDATE policy carries a WITH CHECK',
  $$select count(*)::text from pg_policies
    where schemaname='public' and cmd in ('INSERT','UPDATE')
      and with_check is null and tablename in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')$$, '0');
select crm.val('H9  the five policy helpers are all in `private`, none in public',
  $$select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('permitted_organisations','full_scope_organisations','entity_is_visible',
       'entity_is_manageable','entity_org_unchanged')$$, '0');
select crm.val('H10 all five helpers exist in `private` and are SECURITY DEFINER',
  $$select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.prosecdef and p.proname in
      ('permitted_organisations','full_scope_organisations','entity_is_visible',
       'entity_is_manageable','entity_org_unchanged')$$, '5');
select crm.val('H11 all five helpers have search_path locked',
  $$select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname in
      ('permitted_organisations','full_scope_organisations','entity_is_visible',
       'entity_is_manageable','entity_org_unchanged')
      and p.proconfig @> array['search_path=""']$$, '5');

-- SHAPE GUARDS for the InitPlan form. Not style: the per-row form was measured
-- at 5210 ms for a fifty-row page where the set form takes 23 ms
-- (20260828120500's header), and the difference is invisible to every
-- behavioural assertion in this file -- both forms return identical rows for
-- every user. A refactor back to `has_permission(organisation_id, ...)` would
-- therefore be a 200x regression that the rest of this suite passes cleanly.
-- These are what catch it.
select crm.val('H12 no Phase 2 policy calls has_permission per row',
  $$select count(*)::text from pg_policies
    where schemaname='public'
      and tablename in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')
      and (coalesce(qual,'') like '%has_permission(%'
        or coalesce(with_check,'') like '%has_permission(%')$$, '0');
select crm.val('H13 every Phase 2 policy is built on the hoistable set form',
  $$select count(*)::text from pg_policies
    where schemaname='public'
      and tablename in
      ('companies','contacts','contact_companies','agencies','artists',
       'artist_representations','artist_fee_history','venues','venue_rooms',
       'custom_field_definitions','custom_field_values','merges')
      and coalesce(qual,'') || coalesce(with_check,'')
          not like '%permitted_organisations%'$$, '0');
-- H15 -- the third shape guard, added in fix round 3 for the reason H12/H13
-- exist and did not cover: they forbid `has_permission(` and require
-- `permitted_organisations`, so a per-row POLYMORPHIC dispatch walks straight
-- past them. merges is the one CRM SELECT policy that calls a function with
-- column arguments, and it was measured at 12308 ms for a 50-row page over 20k
-- rows until the hoistable full-scope term was put in front of it.
--
-- THE `position(...) > 0` CHECK IS NOT REDUNDANT, and leaving it out was the
-- first draft's bug. `position()` returns 0 when the substring is ABSENT, so
-- `position(full_scope) < position(entity_is_visible)` is trivially true for a
-- policy that dropped the full-scope term entirely -- which is exactly the
-- mutation this guard exists to catch, and it sailed through. Same failure
-- shape as New-3: a guard written without being made to fail first.
select crm.val('H15 the merges read path leads with the hoistable full-scope term',
  $$select (position('full_scope_organisations' in qual) > 0
            and position('entity_is_visible' in qual) > 0
            and position('full_scope_organisations' in qual)
                < position('entity_is_visible' in qual))::text
    from pg_policies
    where schemaname='public' and tablename='merges' and cmd='SELECT'$$, 'true');
select crm.val('H14 Foundation''s four constant-argument policies are wrapped',
  $$select count(*)::text from pg_policies
    where schemaname='public'
      and (coalesce(qual,'') like 'private.has_platform_permission%'
        or coalesce(with_check,'') like 'private.has_platform_permission%')$$, '0');

-- ===========================================================================
-- I. anon reaches nothing
-- ===========================================================================
set role anon;
select crm.val('I1  anon SELECTs contacts',
  $$select count(*)::text from public.contacts$$, 'denied(42501)');
select crm.val('I2  anon SELECTs custom_field_values',
  $$select count(*)::text from public.custom_field_values$$, 'denied(42501)');
select crm.val('I3  anon SELECTs merges',
  $$select count(*)::text from public.merges$$, 'denied(42501)');
select crm.try('I4  anon INSERTs a contact',
  $$insert into public.contacts (organisation_id, name)
    select id,'anon' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
select crm.val('I5  POSITIVE CONTROL: anon still reads subscription_plans',
  $$select count(*)::text from public.subscription_plans$$, '3');
reset role;

-- ===========================================================================
-- J. MFA / assurance level -- the change of posture in 20260828121000 note (h)
-- ===========================================================================
-- An owner on an aal1 session (the stolen-password case) holds no permission,
-- so the CRM read policies close for them. This is the half of SECURITY.md
-- § 4's known limitation that Phase 2 moves.
set role authenticated;
set request.jwt.claims = :'powner_c1';
select crm.val('J1  aal1 OWNER reads zero contacts',
  $$select count(*)::text from public.contacts$$, '0');
select crm.val('J2  aal1 OWNER reads zero custom_field_definitions',
  $$select count(*)::text from public.custom_field_definitions$$, '0');
select crm.try('J3  aal1 OWNER cannot write a contact',
  $$insert into public.contacts (organisation_id, name)
    select id,'aal1' from public.organisations where slug='org-alpha'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.val('J4  POSITIVE: the SAME owner at aal2 reads the CRM',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
reset role; reset request.jwt.claims;

-- The lockout guard, restated for Phase 2: an un-enrolled Owner must still be
-- able to reach the enrolment screen, which needs organisations and
-- memberships and NO CRM row. Those policies are untouched by this phase.
set role authenticated;
set request.jwt.claims = :'powner_c1';
select crm.val('J5  LOCKOUT GUARD: aal1 owner still sees their organisation',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '1');
select crm.val('J6  LOCKOUT GUARD: aal1 owner still sees their memberships',
  $$select (count(*) > 0)::text from public.organisation_memberships$$, 'true');
reset role; reset request.jwt.claims;

-- MFA is OPTIONAL for booker, so an aal1 booker is a fully working user. This
-- is the assertion that proves the gate is role-scoped and not a blanket
-- "aal2 to read anything", which would lock out most of the product.
set role authenticated;
set request.jwt.claims = :'pbooker_c1';
select crm.val('J7  aal1 BOOKER reads the CRM normally (MFA optional for them)',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- K. Soft delete is NOT hidden by RLS -- design note (g)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('K1  a soft-deleted contact is still VISIBLE (the app filters)',
  $$select count(*)::text from public.contacts where name='Deleted Contact'$$, '1');
select crm.try('K2  and can therefore be RESTORED',
  $$update public.contacts set deleted_at=null
    where id='22220000-0000-0000-0000-000000000004'$$, 'ok(1)');
select crm.val('K3  the merge''s soft-deleted LOSER is readable (Task 6 needs it)',
  $$select count(*)::text from public.contacts where name='Merged Loser'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- L. updated_at is maintained by the database
-- ===========================================================================
-- 20260828121500's decision. Asserted as a client would experience it: an
-- UPDATE through a policy, not a DBA write.
insert into public.contacts (id, organisation_id, owner_user_id, name)
select 'ffff0000-0000-0000-0000-00000000000f', o.id, :'pmanager', 'Timestamp Probe'
from public.organisations o where o.slug='org-alpha';
update public.contacts set updated_at = created_at
  where id='ffff0000-0000-0000-0000-00000000000f';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('L1  a policy-mediated UPDATE succeeds',
  $$update public.contacts set title='moved'
    where id='ffff0000-0000-0000-0000-00000000000f'$$, 'ok(1)');
select crm.val('L2  ...and updated_at moved past created_at',
  $$select (updated_at > created_at)::text from public.contacts
    where id='ffff0000-0000-0000-0000-00000000000f'$$, 'true');
-- The trigger overwrites whatever the client sent, so a forged timestamp
-- cannot be stored. A PostgREST PATCH can set any column it has a grant on.
select crm.try('L3  a client FORGES updated_at into the future',
  $$update public.contacts set updated_at = now() + interval '10 years'
    where id='ffff0000-0000-0000-0000-00000000000f'$$, 'ok(1)');
select crm.val('L4  ...and the forged value was discarded',
  $$select (updated_at < now() + interval '1 minute')::text from public.contacts
    where id='ffff0000-0000-0000-0000-00000000000f'$$, 'true');
reset role; reset request.jwt.claims;

select crm.val('L5  every table carrying updated_at has the trigger',
  $$select count(*)::text from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and exists (select 1 from pg_attribute a
                  where a.attrelid=c.oid and a.attname='updated_at' and not a.attisdropped)
      and not exists (select 1 from pg_trigger t
                      where t.tgrelid=c.oid and not t.tgisinternal
                        and t.tgname='set_updated_at')$$, '0');
select crm.val('L6  ...and that is 17 tables',
  $$select count(*)::text from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and t.tgname='set_updated_at'$$, '17');

-- ===========================================================================
-- M. THE MIRROR TEST -- one rule, two representations, bound together
-- ===========================================================================
-- private.permitted_organisations(k) restates public.has_permission(org, k)'s
-- body with the organisation pin removed, INCLUDING the MFA/aal2 clause
-- 20260827210000 added. Two copies of a security rule is exactly the drift risk
-- that migration's own header warns about for role_requires_mfa() and
-- lib/auth/mfa-gate.ts's MFA_REQUIRED_ROLES, and it is handled the same way: a
-- live equality test rather than a comment saying "keep these in step".
--
-- Every auth.users row in the database x {aal1, aal2} x every organisation x
-- the six CRM keys, the two Foundation keys, and one key that does not exist.
-- The last two groups matter. The Foundation keys exercise roles holding a
-- permission this phase never seeds. The nonexistent key is the fail-closed
-- case, and it is the one a wrong implementation of the set form is most likely
-- to get wrong in the dangerous direction -- a missing `rp.permission_key = $1`
-- would return every organisation for every key, and nothing else in this suite
-- would notice, because the roles that hold view_crm hold it anyway.
--
-- Run as postgres with request.jwt.claims set, which is legitimate here: the
-- thing under test is whether two expressions AGREE over the same auth.uid(),
-- not the row visibility of either. Both pin the caller in their own WHERE
-- clause, so RLS changes neither answer.
do $$
declare
  u record; o record; a text; k text;
  v_scalar boolean; v_set boolean; n int := 0; bad int := 0;
begin
  for u in select id from auth.users loop
    foreach a in array array['aal1','aal2'] loop
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', u.id, 'role', 'authenticated', 'aal', a)::text,
        true);
      for o in select id from public.organisations loop
        foreach k in array array[
          'view_crm','manage_contacts','manage_artists','manage_venues',
          'manage_custom_fields','merge_records',
          'manage_members','manage_organisation','no_such_permission'] loop
          v_scalar := public.has_permission(o.id, k);
          v_set    := exists (select 1 from private.permitted_organisations(k) x where x = o.id);
          n := n + 1;
          if v_scalar is distinct from v_set then bad := bad + 1; end if;
        end loop;
      end loop;
    end loop;
  end loop;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform crm.record(
    'M1  has_permission(org,k) == org IN permitted_organisations(k), ' || n || ' triples',
    '0 mismatches', bad || ' mismatches');
end $$;

-- ---------------------------------------------------------------------------
-- M1b -- THE SAME SWEEP AGAINST A GENUINELY SUSPENDED ORGANISATION.
--
-- TASK 3a. M1 above could not see the clause this task changed. No organisation
-- is soft-deleted at the point M1 runs -- section P sets and clears deleted_at
-- 400 lines later -- so `o.deleted_at is null` was TRUE for every one of M1's
-- 1224 triples, and the join degenerated to a plain membership join. A mirror
-- test that cannot distinguish the two functions on the exact clause under
-- change is not doing its job: the whole Q6 rewrite could have been applied to
-- one body and not the other and M1 would have stayed green.
--
-- So the sweep runs twice. org-alpha is soft-deleted for the second pass and
-- restored immediately, inside the same DO block, so nothing downstream sees it
-- -- section P does its own suspend/restore and is unaffected.
--
-- This pass is also the one that would notice the OTHER wrong implementation:
-- if the catalogue join were dropped from one body and replaced by
-- `or p_permission = 'view_crm'`, the two would still agree here -- which is
-- why M1c below guards the shape as well as the behaviour.
do $$
declare
  u record; o record; a text; k text;
  v_scalar boolean; v_set boolean; n int := 0; bad int := 0;
  v_alpha uuid;
  v_readable int := 0;   -- positive control: the suspended org must appear
begin
  select id into v_alpha from public.organisations where slug = 'org-alpha';
  update public.organisations set deleted_at = pg_catalog.now() where id = v_alpha;

  for u in select id from auth.users loop
    foreach a in array array['aal1','aal2'] loop
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', u.id, 'role', 'authenticated', 'aal', a)::text,
        true);
      for o in select id from public.organisations loop
        foreach k in array array[
          'view_crm','manage_contacts','manage_artists','manage_venues',
          'manage_custom_fields','merge_records',
          'manage_members','manage_organisation','no_such_permission'] loop
          v_scalar := public.has_permission(o.id, k);
          v_set    := exists (select 1 from private.permitted_organisations(k) x where x = o.id);
          n := n + 1;
          if v_scalar is distinct from v_set then bad := bad + 1; end if;
          -- The positive control. Without it this sweep passes perfectly in a
          -- world where suspension closed EVERYTHING again, because false ==
          -- false is still agreement -- exactly the shape of the bug Q6 exists
          -- to reverse.
          if o.id = v_alpha and k = 'view_crm' and v_scalar then
            v_readable := v_readable + 1;
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  perform pg_catalog.set_config('request.jwt.claims', '', true);
  update public.organisations set deleted_at = null where id = v_alpha;

  perform crm.record(
    'M1b SUSPENDED org: the two forms still agree, ' || n || ' triples',
    '0 mismatches', bad || ' mismatches');
  perform crm.record(
    'M1b+ POSITIVE CONTROL: view_crm IS held in the suspended org by somebody',
    'at least 1 holder', case when v_readable > 0 then 'at least 1 holder'
                              else 'nobody -- suspension is a lockout again' end);
end $$;

-- M1c/M1d/M1d2 -- THE SHAPE GUARD BEHIND THE CATALOGUE, READ THROUGH THE
-- POSTGRES PARSER RATHER THAN OFF THE RAW SOURCE TEXT.
--
-- M1 and M1b are behavioural and cannot tell a catalogue lookup from a string
-- literal that happens to produce the same answers today. The catalogue is the
-- decision (task-3a-brief § 2): a literal is a line someone must remember to
-- edit in two function bodies every time a later phase adds a read key, and the
-- failure is silent and points at a suspended customer losing access.
--
-- ===========================================================================
-- REWRITTEN AGAIN IN TASK 3a FIX ROUND 2 (re-review finding I-B).
-- THIS IS THE THIRD VERSION OF THIS GUARD. THE FIRST TWO WERE BOTH DEFEATED,
-- AND THEY WERE DEFEATED THE SAME WAY: THEY READ prosrc AS TEXT.
-- ===========================================================================
-- Version 1 (Task 3a): `survives_suspension` and `deleted_at` both appear in
--   both bodies, and the literal 'view_crm' appears in neither. Defeated by a
--   one-sided disjunct naming a key that does not exist yet, and by a
--   concatenated literal.
-- Version 2 (fix round 1): an anchored-substring guard plus a body-shape guard,
--   both run over prosrc with `--` line comments stripped. Defeated three ways:
--     * `/* ... */` and nested block comments -- the strip only handled `--`,
--       so the real clause could be deleted from a body and left behind as a
--       block comment, and both guards read the comment as the clause.
--     * `$q$view_events$q$` -- Postgres's OTHER literal syntax. The literal
--       enumerator matched `'([^']*)'`, single quotes only, and walked past it.
--     * `E'view\137events'` and `U&'view\005fevents'` reach the guard as their
--       ESCAPE spelling, so the value it reports is not the value the database
--       will compare against.
--   All three shipped 492/492 psql and 58/58 HTTP green.
--
-- THE LESSON, AND WHY THIS VERSION IS DIFFERENT IN KIND. The space of ways to
-- spell one string in Postgres is unbounded: two quoting syntaxes, two escape
-- syntaxes, concatenation, two comment syntaxes (one of them nestable),
-- arbitrary whitespace. A guard that matches the source text of a function will
-- keep losing to whoever writes the next function, and each loss looks like a
-- fully green suite. So this version does not read the source text.
--
-- IT ASKS POSTGRES. crm.canon() below feeds each function body back through the
-- server's own parser (as a view) and reads out the DEPARSED form. The parser
-- has already resolved every one of those spellings by the time the deparser
-- prints it:
--       $q$view_events$q$     -> 'view_events'::text
--       E'view\137events'     -> 'view_events'::text
--       U&'view\005fevents'   -> 'view_events'::text
--       /* anything */        -> gone
--       -- anything           -> gone
--       ragged whitespace     -> normalised
--       ((a or b) or c)       -> flattened to (a OR b OR c)
-- Measured, all of them, in task-3a-fix-2-report.md.
--
-- crm.canon() returns a marker string instead of raising if a body cannot be
-- made into a view, so a mutation that mangles the syntax fails this assertion
-- loudly rather than aborting the run under ON_ERROR_STOP.
create function crm.canon(p_nsp text, p_proname text)
returns text language plpgsql security definer set search_path = 'pg_catalog, public' as $fn$
declare v_src text; v_view text := 'crm.canon_' || p_proname;
begin
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_nsp and p.proname = p_proname;
  if v_src is null then return '<no such function>'; end if;
  -- The parameters become typed NULLs so the body stands alone as a query.
  -- Nothing about the suspension rule depends on their values -- what is under
  -- test is the SHAPE of the body, and the behavioural guards below are what
  -- test the values.
  v_src := replace(v_src, 'p_org_id',     'null::uuid');
  v_src := replace(v_src, 'p_permission', 'null::text');
  execute 'create or replace view ' || v_view || ' as ' || v_src;
  return pg_get_viewdef(v_view::regclass, true);
exception when others then
  return '<could not canonicalise: ' || sqlstate || '>';
end $fn$;

-- The other half of "ask Postgres": what the body actually READS. Taken from
-- pg_depend on the canonical view, so it is the parser's answer and not a
-- regex's. This is what closes the one evasion a literal check cannot see --
-- a disjunct with no literal in it at all, reading the key from somewhere else
-- (another table, or a helper function that holds the literal instead).
create function crm.canon_deps(p_proname text)
returns text language plpgsql security definer set search_path = 'pg_catalog, public' as $fn$
declare v_oid oid; v_rw oid; v_tables text; v_funcs text;
begin
  v_oid := ('crm.canon_' || p_proname)::regclass;
  select oid into v_rw from pg_rewrite where ev_class = v_oid;
  select string_agg(distinct c.relname, ',' order by c.relname) into v_tables
    from pg_depend d join pg_class c on c.oid = d.refobjid
   where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
     and d.objid = v_rw and c.oid <> v_oid and c.relkind in ('r','v','m','p','f');
  select string_agg(distinct n.nspname||'.'||p.proname, ',' order by n.nspname||'.'||p.proname)
    into v_funcs
    from pg_depend d join pg_proc p on p.oid = d.refobjid
    join pg_namespace n on n.oid = p.pronamespace
   where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass
     and d.objid = v_rw;
  return coalesce(v_tables,'<none>') || ' | ' || coalesce(v_funcs,'<none>');
exception when others then
  return '<no canonical view: ' || sqlstate || '>';
end $fn$;

-- M1c: the suspension clause, in the PARSER's spelling, in both bodies.
-- `(o.deleted_at IS NULL OR perm.survives_suspension)` is what the deparser
-- prints for the shipped clause. Note that the deparser FLATTENS nested ORs, so
-- the round-1 hole -- leaving the clause intact and wrapping a second disjunct
-- around it -- now removes the substring instead of nesting it, and this
-- assertion goes red on its own.
select crm.val('M1c the suspension clause is EXACTLY the catalogue form, in both PARSED bodies',
  $$select ( (crm.canon('public','has_permission')
                like '%(o.deleted_at IS NULL OR perm.survives_suspension)%')::int
           + (crm.canon('private','permitted_organisations')
                like '%(o.deleted_at IS NULL OR perm.survives_suspension)%')::int )::text$$,
  '2');

-- M1d: the whole shape of each PARSED body -- `deleted_at` once,
-- `survives_suspension` once, and the only string constant in either body being
-- 'active' (the membership status). Any permission-key literal, IN ANY OF THE
-- SPELLINGS ABOVE, arrives here as 'view_events' and changes this value.
--
-- IT IS DELIBERATELY BRITTLE. If a later phase legitimately needs a second
-- literal in one of these bodies, this assertion goes red and someone updates
-- the expected string in the same diff that adds it. That is the point: the
-- suspension rule is not a thing to edit without a reviewer seeing it.
select crm.val('M1d the ONLY suspension term and the ONLY literal, per PARSED body',
  $$select string_agg(x.label || '=' ||
             ((length(x.src)-length(replace(x.src,'deleted_at','')))/10)::text || '/' ||
             ((length(x.src)-length(replace(x.src,'survives_suspension','')))/19)::text || '/' ||
             coalesce((select string_agg(distinct m[1], '+' order by m[1])
                         from regexp_matches(x.src, '''([^'']*)''', 'g') m), '<none>'),
             ' ' order by x.label)
      from (values
        ('private.permitted_organisations', crm.canon('private','permitted_organisations')),
        ('public.has_permission',           crm.canon('public','has_permission'))
      ) x(label, src)$$,
  'private.permitted_organisations=1/1/active public.has_permission=1/1/active');

-- M1d2: and nothing else feeds either body. A disjunct can name a key without
-- ever writing it down -- `or exists (select 1 from public.some_table b where
-- b.key = rp.permission_key)`, or `or rp.permission_key = private.some_fn()`.
-- Neither adds a literal, so M1d stays green; both add a dependency, and the
-- parser records it.
select crm.val('M1d2 the two PARSED bodies read exactly the four tables and three functions the rule is made of',
  $$select crm.canon_deps('has_permission') || '  ||  '
        || crm.canon_deps('permitted_organisations')$$,
  'organisation_memberships,organisations,permissions,role_permissions | auth.uid,private.role_requires_mfa,private.session_is_aal2  ||  organisation_memberships,organisations,permissions,role_permissions | auth.uid,private.role_requires_mfa,private.session_is_aal2');
-- The catalogue is only trustworthy if nothing can grant a key that is not in
-- it -- otherwise an uncatalogued key silently inherits "no row, no join, no
-- permission" for reads AND the wrong suspension answer.
select crm.val('M1e role_permissions.permission_key is FK-bound to the catalogue',
  $$select count(*)::text from pg_constraint
     where conname = 'role_permissions_permission_key_fkey'
       and contype = 'f'
       and confrelid = 'public.permissions'::regclass$$, '1');
select crm.val('M1f every permission key in use has a catalogue row',
  $$select count(*)::text from public.role_permissions rp
     where not exists (select 1 from public.permissions p where p.key = rp.permission_key)$$,
  '0');
select crm.val('M1g exactly one key survives suspension today, and it is view_crm',
  $$select coalesce(string_agg(key, ',' order by key), '<none>')
      from public.permissions where survives_suspension$$, 'view_crm');
-- The default is the control that protects Phase 5's author from themselves.
select crm.val('M1h survives_suspension DEFAULTS to false (a new key arrives closed)',
  $$select column_default from information_schema.columns
     where table_schema='public' and table_name='permissions'
       and column_name='survives_suspension'$$, 'false');

-- ---------------------------------------------------------------------------
-- M1i / M1j / M1k -- THE BEHAVIOURAL GUARD, AND THE ONE THAT IS LOAD-BEARING.
--
-- TASK 3a FIX ROUND 2, re-review finding I-B. Everything above this point that
-- concerns the suspension rule reads the FUNCTION BODIES. M1 and M1b test
-- behaviour, but only over the nine keys that exist today -- and every evasion
-- found in this guard so far has worked by naming a key that does not exist
-- yet, precisely because nothing behavioural could see it.
--
-- So: invent one. A throwaway catalogue key is inserted here, granted to every
-- role, and swept through BOTH function forms across
--     {survives_suspension false, true}
--   x {organisation live, organisation suspended}
--   x every auth.users row
--   x {aal1, aal2}
--   x every organisation
-- and removed again. That is the "Phase 5 adds a key" case, made real, in a
-- database where the key genuinely did not exist when either body was written.
--
-- TWO SEPARATE PROPERTIES ARE ASSERTED, AND THE SECOND IS THE IMPORTANT ONE:
--   M1i  the two forms AGREE with each other. Catches one-sided drift.
--   M1j  both forms agree with the rule computed INDEPENDENTLY here, straight
--        out of organisation_memberships x role_permissions x permissions x
--        organisations. Catches two-sided drift, which M1i cannot: if both
--        bodies are wrong in the same way they still agree.
-- M1k is the positive control. M1i and M1j both pass perfectly in a world where
-- the catalogue is inert and the probe key is simply never held, so the control
-- asserts that flipping survives_suspension on the probe key really does change
-- the suspended answer -- in BOTH forms.
--
-- WHAT THIS CATCHES THAT THE SHAPE GUARDS CANNOT: any future respelling,
-- because it never looks at the text. WHAT IT DOES NOT CATCH, stated plainly
-- rather than left to be rediscovered: a disjunct naming a SPECIFIC key that
-- does not exist -- `or rp.permission_key = 'view_events'` -- is dormant by
-- construction and cannot be observed behaviourally until someone adds
-- view_events. Measured: all three of MUT-1b, MUT-5 and MUT-7 pass this sweep.
-- That case is M1c/M1d/M1d2's job, and it is why the shape guards are still
-- here rather than deleted. The two halves cover different failures and neither
-- is redundant.
-- ---------------------------------------------------------------------------
do $$
declare
  k        constant text := 'zz_task3a_probe_key';
  u record; o record; a text; surv boolean; susp boolean;
  v_alpha  uuid;
  v_scalar boolean; v_set boolean; v_expect boolean;
  n int := 0; disagree int := 0; wrong int := 0;
  v_owner uuid;
  f_scalar boolean; f_set boolean; t_scalar boolean; t_set boolean;
begin
  select id into v_alpha from public.organisations where slug = 'org-alpha';
  select id into v_owner from auth.users where email = 'powner@test.local';

  insert into public.permissions (key, survives_suspension, description)
  values (k, false,
    'Throwaway probe key inserted by rls_phase2_crm.sql § M (M1i-M1k) and deleted again in the same block. If you are reading this in a live database, that block did not finish.');
  insert into public.role_permissions (role_key, permission_key)
    select r.key, k from public.roles r;

  foreach surv in array array[false, true] loop
    update public.permissions set survives_suspension = surv where key = k;
    foreach susp in array array[false, true] loop
      update public.organisations
         set deleted_at = case when susp then pg_catalog.now() else null end
       where id = v_alpha;

      for u in select id from auth.users loop
        foreach a in array array['aal1','aal2'] loop
          perform pg_catalog.set_config('request.jwt.claims',
            pg_catalog.json_build_object('sub', u.id, 'role', 'authenticated', 'aal', a)::text,
            true);
          for o in select id from public.organisations loop
            v_scalar := public.has_permission(o.id, k);
            v_set    := exists (select 1 from private.permitted_organisations(k) x
                                 where x = o.id);
            -- The rule, restated from the tables rather than from either
            -- function. This is the only place in the suite that says what the
            -- answer OUGHT to be without asking the code under test.
            v_expect := exists (
              select 1
              from public.organisation_memberships m
              join public.role_permissions rp
                on rp.role_key = m.role and rp.permission_key = k
              join public.permissions perm on perm.key = rp.permission_key
              join public.organisations org on org.id = m.organisation_id
              where m.user_id = u.id
                and m.organisation_id = o.id
                and m.status = 'active'
                and (org.deleted_at is null or perm.survives_suspension)
                and (not private.role_requires_mfa(m.role) or a = 'aal2'));
            n := n + 1;
            if v_scalar is distinct from v_set    then disagree := disagree + 1; end if;
            if v_scalar is distinct from v_expect then wrong    := wrong + 1;    end if;
            if v_set    is distinct from v_expect then wrong    := wrong + 1;    end if;

            -- The control's one cell: the aal2 Owner of the SUSPENDED org-alpha.
            if o.id = v_alpha and susp and a = 'aal2' and u.id = v_owner then
              if surv then t_scalar := v_scalar; t_set := v_set;
              else         f_scalar := v_scalar; f_set := v_set; end if;
            end if;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;

  perform pg_catalog.set_config('request.jwt.claims', '', true);
  update public.organisations set deleted_at = null where id = v_alpha;
  delete from public.role_permissions where permission_key = k;
  delete from public.permissions       where key = k;

  perform crm.record(
    'M1i FUTURE KEY: the two forms agree on a key neither body has ever seen, '
      || n || ' cases',
    '0 mismatches', disagree || ' mismatches');
  perform crm.record(
    'M1j FUTURE KEY: ...and both forms match the catalogue, live AND suspended',
    '0 wrong answers', wrong || ' wrong answers');
  perform crm.record(
    'M1k CONTROL: flipping survives_suspension on the probe key changes the SUSPENDED answer in both forms',
    'scalar false->true set false->true',
    'scalar ' || f_scalar || '->' || t_scalar
      || ' set ' || f_set || '->' || t_set);
  perform crm.record(
    'M1l the probe key and its grants are gone again',
    '0 rows',
    ((select count(*) from public.permissions where key = k)
     + (select count(*) from public.role_permissions where permission_key = k))::text || ' rows');
end $$;

-- MIN-4: M1 sweeps only non-NULL organisations, and a NULL organisation is the
-- ONE input on which the two forms genuinely disagree -- which makes it the one
-- input the equivalence test most needed to state.
--
--   public.has_permission(NULL, k)                    -> false
--   NULL in (select permitted_organisations(k))       -> SQL NULL, when the set
--                                                        is non-empty
--
-- Both DENY inside a policy (a policy treats NULL as not-true), and
-- organisation_id is NOT NULL on all twelve tables, so nothing is reachable
-- today. It is asserted rather than left to be rediscovered because the day
-- someone reuses permitted_organisations() in a context where NULL is possible
-- -- a nullable column, an unset route parameter -- the two forms stop agreeing
-- and M1 would not have noticed. Foundation's design note (b) is the same
-- argument: "a security predicate that turns an accidental NULL into a grant is
-- failing open on exactly the input most likely to arrive by mistake."
do $$
declare
  u record; k text; n int := 0; bad int := 0;
  v_scalar boolean; v_set boolean;
begin
  for u in select id from auth.users limit 6 loop
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.json_build_object('sub', u.id, 'role', 'authenticated', 'aal', 'aal2')::text,
      true);
    foreach k in array array['view_crm','manage_contacts','no_such_permission'] loop
      v_scalar := public.has_permission(null, k);
      v_set    := (null::uuid in (select private.permitted_organisations(k)));
      n := n + 1;
      -- The scalar form must be exactly false, and the set form must be
      -- NOT TRUE -- false or NULL, both of which a policy denies.
      if v_scalar is not false or v_set is true then bad := bad + 1; end if;
    end loop;
  end loop;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform crm.record(
    'M3  NULL org: has_permission is false and the set form is never true, '
      || n || ' cases',
    '0 failures', bad || ' failures');
end $$;

-- full_scope_organisations() has no scalar twin to mirror, so it gets the
-- property that matters instead, read out of the live membership table rather
-- than out of the function's source: no active membership in a record-scoped
-- role ever appears in it.
select crm.val('M2  full_scope_organisations excludes exactly the scoped roles',
  $$select count(*)::text from public.organisation_memberships m
     where m.status='active'
       and m.role in ('standard_user','read_only')
       and exists (
         select 1 from private.full_scope_organisations() f where f = m.organisation_id
       )$$, '0');

-- ===========================================================================
-- N. SUBSCRIPTION ENTITLEMENT (IMP-1) -- the gate that is inert today
-- ===========================================================================
-- private.crm_write_organisations() ships with the `s.organisation_id is null`
-- escape, because create_organisation() writes no subscription row and a gate
-- without it would deny every CRM write in the product. So in normal operation
-- this control does nothing, and NOTHING ELSE IN THIS SUITE WOULD NOTICE IF IT
-- WERE DELETED. This section is the only thing that will.
--
-- It drives the gate directly: insert a real `free` subscription row for org
-- ALPHA, watch every write close for every role while reads keep working,
-- upgrade the row to `starter`, watch writes come back, and restore the
-- no-row state so the rest of the fixture is untouched.
--
-- Phase 7 removes the escape and backfills. When it does, N1 and N16 are the
-- assertions that will change; everything between them is the behaviour Phase 7
-- is switching on and must keep.

-- N1: the baseline. No subscription row = not yet billed = not yet gated.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N1  BASELINE: no subscription row, a write is allowed',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'Entitlement Baseline')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- Free tier, active. CLAUDE.md § Subscription tiers: crm_writes = No.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org'::uuid, 'free', 'monthly', 1, 'active', now() + interval '30 days');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('N2  FREE: reads still work (Free is a read tier)',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
select crm.try('N3  FREE: manager INSERTs a contact',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'free tier')$$, :'alpha_org'), 'denied(42501)');
select crm.try('N4  FREE: manager UPDATEs a contact',
  $$update public.contacts set title='free'
    where id='22220000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('N5  FREE: manager INSERTs a merges row',
  format($$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    values (%L,'contact','22220000-0000-0000-0000-000000000002',
            '22220000-0000-0000-0000-000000000003',(select auth.uid()))$$,
    :'alpha_org'), 'denied(42501)');
-- A DELETE policy has no WITH CHECK, so the entitlement term lives in USING and
-- the refusal is a zero-row result rather than a 42501. Secure, and asserted as
-- the DIFFERENT mechanism it is -- see 20260828140500's header and MIN-5.
select crm.try('N6  FREE: manager DELETEs a link -> filtered, not denied',
  $$delete from public.contact_companies
    where id='77770000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('N7  FREE: manager DELETEs a custom field value -> filtered',
  $$delete from public.custom_field_values
    where id='bbbb0000-0000-0000-0000-000000000002'$$, 'ok(0)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbooker_c';
select crm.try('N8  FREE: booker INSERTs an artist',
  format($$insert into public.artists (organisation_id, name)
    values (%L,'free artist')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.try('N9  FREE: standard_user INSERTs a venue',
  format($$insert into public.venues (organisation_id, name)
    values (%L,'free venue')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.try('N10 FREE: admin DEFINEs a custom field',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','free_key','Free','text')$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('N11 FREE: venue_manager INSERTs a venue_room',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
    values (%L,'55550000-0000-0000-0000-000000000002','free room')$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- Upgrade. Starter and Pro both carry crm_writes = true.
update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'alpha_org'::uuid;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N12 STARTER: the same write is now allowed',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'starter tier')$$, :'alpha_org'), 'ok(1)');
select crm.try('N13 STARTER: the DELETE comes back too',
  $$delete from public.contact_companies
    where id='77770000-0000-0000-0000-000000000002'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- THE past_due GRACE WINDOW. Founder decision, 2026-08-28, recorded in
-- lib/entitlements/policy.ts: 'past_due' keeps the plan's entitlements for
-- three days measured from current_period_end, then falls back to Free;
-- 'cancelled' falls back at once, with no grace.
--
-- Fix round 1 shipped `status = 'active'` only and called past_due "the
-- conservative reading" of an open question. The question was not open, and
-- the effect was that the app layer granted three days while the database
-- refused them -- so the decision was, at the layer that enforces anything,
-- not implemented. 20260828150000 fixes it and these are the assertions.
--
-- The boundary is asserted from BOTH sides, because a grace window that is
-- never open and a grace window that never closes both pass a single-sided
-- test, and they are opposite bugs.
-- ---------------------------------------------------------------------------
update public.organisation_subscriptions
   set status='past_due', current_period_end = now() - interval '1 day'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N14 PAST_DUE inside the 3-day grace window: writes are KEPT',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'past due, in grace')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- One second before the window closes.
--
-- THE COMMENT THAT USED TO BE HERE CLAIMED THIS WAS WHERE `<` AND `<=` DIFFER.
-- It is not, and the claim was false in the same way three other comments in
-- this round were: asserted rather than run. N14b and N14c straddle the
-- boundary and AGREE under both operators, so neither catches an operator
-- change -- the re-reviewer flipped `<` to `<=` inside
-- private.crm_write_organisations() and got 212/212 psql, 39/39 HTTP and 5/5
-- vitest, fully green. The boundary instant itself is N14f, below.
update public.organisation_subscriptions
   set current_period_end = now() - (interval '3 days' - interval '1 second')
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N14b PAST_DUE one second before the window closes: still KEPT',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'past due, edge of grace')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

update public.organisation_subscriptions
   set current_period_end = now() - (interval '3 days' + interval '1 second')
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N14c PAST_DUE one second AFTER it closes: writes fall to Free',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'past due, grace expired')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

update public.organisation_subscriptions
   set current_period_end = now() - interval '400 days'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N14d PAST_DUE, long lapsed: writes stay closed',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'past due, long lapsed')$$, :'alpha_org'), 'denied(42501)');
select crm.val('N14e ...and reads were never affected by any of it',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
reset role; reset request.jwt.claims;

-- EXACTLY ON THE BOUNDARY -- the assertion this suite claimed to have and did
-- not. `now() < current_period_end + 3 days` is STRICT, so at the instant the
-- window closes the write must be DENIED. Flip that `<` to `<=` inside
-- private.crm_write_organisations() and this is the only assertion in the whole
-- project that goes red.
--
-- THE EXPLICIT TRANSACTION IS LOAD-BEARING, and the first draft of this
-- assertion got it wrong in a way that would have re-created the very gap it is
-- closing. `now()` is transaction_timestamp(), so it only holds still WITHIN one
-- transaction. Under psql's autocommit the UPDATE and the INSERT are two
-- transactions, the INSERT's `now()` is strictly later, and
-- `now_insert < (now_update - 3d) + 3d` is false under `<` AND under `<=` --
-- so the assertion would pass either way and prove nothing, exactly like N14b
-- and N14c. Inside one transaction both statements read the same instant, the
-- comparison lands precisely on the edge, and the two operators disagree.
begin;
update public.organisation_subscriptions
   set current_period_end = pg_catalog.now() - interval '3 days'
 where organisation_id = :'alpha_org'::uuid;
set local role authenticated;
set local request.jwt.claims = :'pmanager_c';
select crm.try('N14f PAST_DUE EXACTLY on the boundary: strict `<`, so DENIED',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'past due, exactly at the edge')$$, :'alpha_org'), 'denied(42501)');
commit;
reset role; reset request.jwt.claims;

-- 'cancelled' gets NO grace: the customer chose it, so honouring it at once is
-- respecting a decision. Set INSIDE what would be a past_due grace window, so
-- the only thing that can deny it is the status itself.
update public.organisation_subscriptions
   set status='cancelled', plan_id='pro', current_period_end = now() - interval '1 day'
 where organisation_id = :'alpha_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N15 CANCELLED on a paid plan, inside the grace window: closed at once',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'cancelled')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- The SQL half of the constant. The TypeScript half, and the proof that the
-- two agree at every boundary, is
-- tests/integration/entitlements/past-due-grace-matches-db.test.ts -- this
-- assertion only catches the number being changed here in isolation.
select crm.val('N15b the grace window is private.past_due_grace_days() days',
  $$select private.past_due_grace_days()::text$$, '3');
-- Fail-closed on an unreadable period end, by three-valued logic rather than
-- by a guard clause: `now() < NULL + interval` is NULL, a NULL conjunct is not
-- true, and a row whose predicate is not true is not in the set. Asserted
-- rather than reasoned about, because reasoning about SQL semantics instead of
-- measuring them is a mistake this task has already made twice. The column is
-- NOT NULL, so the expression is probed directly.
select crm.val('N15c a NULL period end denies (fails closed, not open)',
  $$select coalesce(
      (now() < null::timestamptz
        + make_interval(days => private.past_due_grace_days()))::text,
      'null-not-true')$$, 'null-not-true');

-- Restore the shipped state: no subscription row anywhere.
delete from public.organisation_subscriptions where organisation_id = :'alpha_org'::uuid;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('N16 RESTORED: back to the inert state, writes allowed again',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'inert again')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- O. organisation_id IMMUTABILITY ON THE CHILD TABLES (IMP-3)
-- ===========================================================================
-- 20260828121000 design note (e) claimed these five inherited immutability from
-- their tenant-scoped composite FK. They did not: the FK constrains the NEW
-- pair, so a caller authorised in both tenants moves the child AND its parent
-- reference in one statement and the constraint is satisfied. The reviewer
-- reproduced it on custom_field_values -- which has no composite FK to its
-- entity at all -- moving a row and its value from ALPHA into BETA.
--
-- Every probe below moves EVERY column the FK looks at, together, which is what
-- makes it the real attack rather than the weaker "change organisation_id
-- alone" that section G already covered.
--
-- A DEDICATED link row, because the fixture's two have been consumed by now --
-- D23 deleted one and N13 the other, and the first draft of O5 aimed at a row
-- that no longer existed and reported `ok(0)`, which reads exactly like a
-- refusal and is an empty statement. Same class of mistake as the org-id one in
-- section B: an assertion whose target is absent proves nothing and looks green.
insert into public.contact_companies (id, organisation_id, contact_id, company_id)
select '77770000-0000-0000-0000-00000000000d', o.id,
       '22220000-0000-0000-0000-000000000002','11110000-0000-0000-0000-000000000002'
from public.organisations o where o.slug='org-alpha';

-- NEW-4: FRESH, UNOCCUPIED TARGETS IN ORG BETA, so O1 and O5 discriminate on
-- the PIN rather than on a unique constraint.
--
-- Under the IMP-3 mutation those two failed as denied(23505), not ok(1),
-- because they aimed at BETA rows that already had a matching
-- custom_field_values_field_entity_unique / contact_companies_contact_company_unique
-- partner -- so the re-home was refused by a uniqueness rule before the policy
-- was ever consulted, and the assertions went red on the wrong control. The
-- pin IS load-bearing (O3/O6/O7 fail as ok(1) without it), but these two were
-- not proving it. With unoccupied targets they now fail the same way.
insert into public.contacts (id, organisation_id, owner_user_id, name)
select '2222000c-0000-0000-0000-00000000000c', o.id, :'pbowner', 'Beta Contact Two'
from public.organisations o where o.slug='org-beta';
insert into public.companies (id, organisation_id, owner_user_id, name)
select '1111000c-0000-0000-0000-00000000000c', o.id, :'pbowner', 'Beta Co Two'
from public.organisations o where o.slug='org-beta';
insert into public.custom_field_definitions
  (id, organisation_id, entity_type, key, label, field_type)
select 'aaaa000c-0000-0000-0000-00000000000c', o.id, 'contact','beta_nickname','Beta Nickname','text'
from public.organisations o where o.slug='org-beta';

set role authenticated;
set request.jwt.claims = :'pmulti_c';

select crm.try('O1  cfv: move the row AND its definition AND its entity into BETA',
  format($$update public.custom_field_values
      set organisation_id=%L,
          field_id='aaaa000c-0000-0000-0000-00000000000c',
          entity_type='contact',
          entity_id='2222000c-0000-0000-0000-00000000000c'
    where id='bbbb0000-0000-0000-0000-000000000001'$$, :'beta_org'),
  'denied(42501)');
select crm.try('O2  POSITIVE: the same row edits normally',
  $$update public.custom_field_values set value='"edited in place"'::jsonb
    where id='bbbb0000-0000-0000-0000-000000000001'$$, 'ok(1)');

select crm.try('O3  venue_rooms: move the room AND its venue into BETA',
  format($$update public.venue_rooms
      set organisation_id=%L, venue_id='5555000b-0000-0000-0000-00000000000b'
    where id='66660000-0000-0000-0000-000000000002'$$, :'beta_org'),
  'denied(42501)');
select crm.try('O4  POSITIVE: the same room renames normally',
  $$update public.venue_rooms set name='Manager Room II'
    where id='66660000-0000-0000-0000-000000000002'$$, 'ok(1)');

select crm.try('O5  contact_companies: move the link AND both its parents into BETA',
  format($$update public.contact_companies
      set organisation_id=%L,
          contact_id='2222000c-0000-0000-0000-00000000000c',
          company_id='1111000c-0000-0000-0000-00000000000c'
    where id='77770000-0000-0000-0000-00000000000d'$$, :'beta_org'),
  'denied(42501)');

select crm.try('O6  artist_fee_history: move the fee AND its artist into BETA',
  format($$update public.artist_fee_history
      set organisation_id=%L, artist_id='4444000b-0000-0000-0000-00000000000b'
    where id='99990000-0000-0000-0000-000000000002'$$, :'beta_org'),
  'denied(42501)');

select crm.try('O7  artist_representations: move the row AND all its parents into BETA',
  format($$update public.artist_representations
      set organisation_id=%L,
          artist_id='4444000b-0000-0000-0000-00000000000b',
          agency_id='3333000b-0000-0000-0000-00000000000b'
    where id='88880000-0000-0000-0000-000000000002'$$, :'beta_org'),
  'denied(42501)');

select crm.val('O8  ...and nothing actually moved',
  $$select count(*)::text from public.custom_field_values
     where id='bbbb0000-0000-0000-0000-000000000001'
       and organisation_id = (select id from public.organisations where slug='org-alpha')$$,
  '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- P. A SOFT-DELETED (SUSPENDED) ORGANISATION -- READ-ONLY, NOT A LOCKOUT
-- ===========================================================================
-- CLAUDE.md § Superuser dashboard ships suspend/reinstate as soft delete.
--
-- THIS SECTION INVERTED IN TASK 3a. DECISIONS-QUEUE § Q6, ANSWERED 2026-08-28:
-- **READ-ONLY. THE DEFAULT WAS OVERRULED.** Task 2's fix round 1 (IMP-4) shipped
-- the opposite reading -- a suspended organisation granted NOTHING, so a
-- suspended customer saw an empty application -- and P1/P3/P4 asserted exactly
-- that. The founder overruled it: suspension stops WORK, it does not hide a
-- customer's own records from them.
--
-- The assertions below are the SAME assertions with the expectation inverted,
-- not new ones replacing deleted ones, so the diff shows what the decision
-- changed:
--   P1  'the CRM is unreadable'          0     -> the real row count
--   P3  has_permission(view_crm)         false -> true
--   P4  permitted_organisations(view_crm) false -> true
-- P2 (writes closed), P5, P6, P7 and P8 are unchanged: the write half of the
-- rule did not move, and neither did the workspace-switcher exception.
--
-- WHAT P1 NOW PROVES THAT IT DID NOT BEFORE. '0 rows' passes against a database
-- where every policy denies everything -- it could not tell "suspension closed
-- the read" from "the fixture was empty" or "the role holds nothing". An exact
-- non-zero count can only pass if the suspended organisation's rows are
-- genuinely reachable through the real SELECT policy, by a real role, at the
-- real assurance level. Every count below is the count the SAME user sees when
-- the organisation is live (P20-P27 re-assert them after reinstatement), so
-- these are equalities against a measured baseline, not floors.
--
-- Restores the organisation at the end so the rest of the fixture is untouched.
update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';

-- ---- 1. READS SURVIVE, on every entity surface (§ 7.1) --------------------
-- pmanager is a manager: full record scope, aal1, no MFA requirement. The
-- counts are exact. RLS does not hide soft-deleted ROWS (design note (g)), so
-- these include the fixture's soft-deleted contacts -- that is the pre-existing
-- rule and it is unrelated to organisation suspension.
select crm.val('P1  SUSPENDED: contacts are still readable (was: expect 0)',
  $$select count(*)::text from public.contacts$$, '13');
select crm.val('P1a SUSPENDED: companies still readable',
  $$select count(*)::text from public.companies$$, '3');
select crm.val('P1b SUSPENDED: agencies still readable',
  $$select count(*)::text from public.agencies$$, '1');
select crm.val('P1c SUSPENDED: artists still readable',
  $$select count(*)::text from public.artists$$, '3');
select crm.val('P1d SUSPENDED: venues still readable',
  $$select count(*)::text from public.venues$$, '3');
select crm.val('P1e SUSPENDED: venue_rooms still readable (child, via parent)',
  $$select count(*)::text from public.venue_rooms$$, '4');
select crm.val('P1f SUSPENDED: custom_field_values still readable (polymorphic)',
  $$select count(*)::text from public.custom_field_values$$, '4');
select crm.val('P1g SUSPENDED: merges still readable',
  $$select count(*)::text from public.merges$$, '2');
-- M-2 (Task 3a fix round 1). FOUR MORE TABLES CARRY WRITE POLICIES AND WERE
-- NEVER DRIVEN AGAINST SUSPENSION. The Task 3a brief named eight surfaces and
-- the implementer tested exactly those eight; the brief was incomplete.
-- custom_field_definitions, contact_companies, artist_representations and
-- artist_fee_history all have INSERT/UPDATE (and two of them DELETE) policies
-- naming permitted_organisations()/crm_write_organisations(), so all four are
-- on the path this task changed. The reviewer measured them and they behave
-- correctly -- this is the coverage that makes that a standing guarantee rather
-- than a one-off measurement. Reads here, writes at P12* (as the Owner, who is
-- the only role holding manage_custom_fields).
select crm.val('P1h SUSPENDED: custom_field_definitions still readable',
  $$select count(*)::text from public.custom_field_definitions$$, '4');
select crm.val('P1i SUSPENDED: contact_companies still readable',
  $$select count(*)::text from public.contact_companies$$, '2');
select crm.val('P1j SUSPENDED: artist_representations still readable',
  $$select count(*)::text from public.artist_representations$$, '2');
select crm.val('P1k SUSPENDED: artist_fee_history still readable',
  $$select count(*)::text from public.artist_fee_history$$, '1');

-- ---- 2. EVERY WRITE CLOSES (§ 7.2) ----------------------------------------
-- The mechanism is asserted, not left open. Two DIFFERENT refusals appear here
-- and the difference is real:
--
--   INSERT -> denied(42501). WITH CHECK names
--             permitted_organisations('manage_*'), which no longer contains a
--             suspended organisation, so the new row is rejected outright.
--   UPDATE/DELETE -> ok(0). USING names the same empty set, so the target row
--             is not visible to the statement and it matches nothing. This is
--             a DIFFERENT mechanism from the Free-tier refusal in § N, which is
--             denied(42501) on UPDATE because crm_write_organisations() lives
--             in WITH CHECK only and the row stays visible. Suspension closes
--             the USING side; entitlement closes the WITH CHECK side.
--   ...except where `authenticated` holds no table grant at all, which is
--             DELETE on everything but contact_companies and
--             custom_field_values, and UPDATE on merges (append-only). Those
--             are denied(42501) from the grant layer, before RLS is consulted,
--             and would be denied for a live organisation too -- asserted so
--             the section does not silently credit suspension for a refusal
--             that has nothing to do with it.
select crm.try('P2  SUSPENDED: contacts INSERT refused',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P2a SUSPENDED: companies INSERT refused',
  format($$insert into public.companies (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P2b SUSPENDED: agencies INSERT refused',
  format($$insert into public.agencies (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P2c SUSPENDED: artists INSERT refused',
  format($$insert into public.artists (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P2d SUSPENDED: venues INSERT refused',
  format($$insert into public.venues (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P2e SUSPENDED: venue_rooms INSERT refused',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
    values (%L,'55550000-0000-0000-0000-000000000002','suspended')$$,
    :'alpha_org'), 'denied(42501)');
select crm.try('P2f SUSPENDED: custom_field_values INSERT refused',
  format($$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    values (%L,'aaaa0000-0000-0000-0000-000000000001','artist',
            '44440000-0000-0000-0000-000000000001','"suspended"'::jsonb)$$,
    :'alpha_org'), 'denied(42501)');
select crm.try('P2g SUSPENDED: merges INSERT refused',
  format($$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    values (%L,'contact','22220000-0000-0000-0000-000000000002',
            '22220000-0000-0000-0000-000000000003',(select auth.uid()))$$,
    :'alpha_org'), 'denied(42501)');

select crm.try('P2h SUSPENDED: contacts UPDATE matches nothing (USING is empty)',
  $$update public.contacts set title='suspended'
    where id='22220000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2i SUSPENDED: companies UPDATE matches nothing',
  $$update public.companies set name='suspended'
    where id='11110000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2j SUSPENDED: agencies UPDATE matches nothing',
  $$update public.agencies set name='suspended'
    where id='33330000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2k SUSPENDED: artists UPDATE matches nothing',
  $$update public.artists set name='suspended'
    where id='44440000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2l SUSPENDED: venues UPDATE matches nothing',
  $$update public.venues set name='suspended'
    where id='55550000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2m SUSPENDED: venue_rooms UPDATE matches nothing',
  $$update public.venue_rooms set name='suspended'
    where id='66660000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2n SUSPENDED: custom_field_values UPDATE matches nothing',
  $$update public.custom_field_values set value='"suspended"'::jsonb
    where id='bbbb0000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2o SUSPENDED: merges UPDATE -- no grant, append-only',
  $$update public.merges set field_resolution='{}'::jsonb
    where id='cccc0000-0000-0000-0000-000000000002'$$, 'denied(42501)');

select crm.try('P2p SUSPENDED: custom_field_values DELETE matches nothing',
  $$delete from public.custom_field_values
    where id='bbbb0000-0000-0000-0000-000000000002'$$, 'ok(0)');
select crm.try('P2q SUSPENDED: contacts DELETE -- no grant (true when live too)',
  $$delete from public.contacts
    where id='22220000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.try('P2r SUSPENDED: venues DELETE -- no grant (true when live too)',
  $$delete from public.venues
    where id='55550000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select crm.val('P2s SUSPENDED: ...and nothing above actually changed anything',
  $$select count(*)::text from public.contacts
     where id='22220000-0000-0000-0000-000000000002' and title is null$$, '1');

-- ---- The permission engine's own answer, both representations ------------
select crm.val('P3  SUSPENDED: has_permission(view_crm) is TRUE (was: false)',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'true');
select crm.val('P4  SUSPENDED: so is the set form (the two must not drift)',
  format($$select exists (select 1 from private.permitted_organisations('view_crm') x
                          where x = %L)::text$$, :'alpha_org'), 'true');
-- M-1 (Task 3a fix round 1): THESE TWO RUN AS pmanager AND THE LABEL USED TO
-- SAY "every WRITE key", WHICH OVERSTATED THEM. Measured with the organisation
-- LIVE, a manager holds manage_contacts/manage_artists/manage_venues/
-- merge_records and does NOT hold manage_members, manage_organisation or
-- manage_custom_fields -- so three of the disjuncts were false when live too and
-- contributed nothing. They are KEPT (a manager losing their four keys under
-- suspension is worth asserting) with an honest label, and the Owner sweep that
-- actually covers all seven write keys is P4d/P4e below, run at aal2 by a user
-- who holds every one of them when live (P4f/P4g are that live control).
select crm.val('P4a SUSPENDED: the four write keys a MANAGER holds are false -- has_permission',
  format($$select (public.has_permission(%1$L,'manage_contacts')
                or public.has_permission(%1$L,'manage_artists')
                or public.has_permission(%1$L,'manage_venues')
                or public.has_permission(%1$L,'merge_records'))::text$$,
    :'alpha_org'), 'false');
select crm.val('P4b SUSPENDED: ...and false in the set form too',
  format($$select exists (
      select 1 from unnest(array['manage_contacts','manage_artists','manage_venues',
                                 'merge_records']) k
      where %L in (select private.permitted_organisations(k))
    )::text$$, :'alpha_org'), 'false');
-- The entitlement gate keeps its OWN unconditional deleted_at clause, so the
-- write half is closed twice over. Asserted rather than assumed, because "the
-- other term also denies" is the kind of claim this phase has been wrong about.
select crm.val('P4c SUSPENDED: crm_write_organisations() also excludes it',
  format($$select exists (select 1 from private.crm_write_organisations() x
                          where x = %L)::text$$, :'alpha_org'), 'false');

-- ---- 4. THE WORKSPACE MUST STAY REACHABLE (§ 7.4) ------------------------
-- is_active_member is UNCHANGED, so the organisation row, the caller's own
-- membership and the subscription row stay visible. Without these the switcher
-- breaks, getCurrentOrg() cannot resolve the slug, and the read-only state is
-- unreachable in practice even though the CRM policies now permit it.
select crm.val('P5  SUSPENDED: the organisation row is still visible (suspension notice)',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '1');
select crm.val('P6  SUSPENDED: memberships still readable (workspace switcher)',
  $$select (count(*) > 0)::text from public.organisation_memberships$$, 'true');
select crm.val('P6a SUSPENDED: specifically the caller''s OWN membership row',
  format($$select count(*)::text from public.organisation_memberships
     where organisation_id=%L and user_id=(select auth.uid()) and status='active'$$,
    :'alpha_org'), '1');
reset role; reset request.jwt.claims;

-- ---- 5. THE NEGATIVE CONTROL (§ 7.5) -------------------------------------
-- Suspension becoming read-only must not widen anything for a NON-member.
-- pbowner owns org BETA and has never been a member of ALPHA; ALPHA is
-- suspended right now, which is the state a naive `or true` would open up.
--
-- THE TASK 3a BRIEF CALLED THIS "the test that would catch the change being
-- implemented as 'drop the clause'". IT IS NOT, AND THAT WAS MEASURED RATHER
-- THAN ARGUED. Mutation 3 of task-3a-report -- both function bodies with the
-- deleted_at clause removed outright -- leaves P9..P9f entirely GREEN, because
-- dropping the clause restores permissions to MEMBERS of a suspended
-- organisation and grants nothing at all to a non-member: the membership join
-- is a separate term and it never moved. What actually catches that mutation is
-- P4a/P4b (a write key becomes true), P2h-P2n (the UPDATE refusal changes
-- mechanism from ok(0) to denied(42501), because the entitlement gate's own
-- unconditional clause is still holding the line underneath) and, most
-- visibly, P7/P7a -- the Owner un-suspends their own organisation and
-- deleted_at really is cleared.
--
-- P9 is kept anyway, and it is not redundant: it is the guard for the OTHER
-- direction, a clause rewritten in a way that admits an organisation the caller
-- has no membership in at all. It just is not the guard the brief claimed.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select crm.val('P9  NEGATIVE CONTROL: a non-member reads 0 rows of the suspended org',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$,
    :'alpha_org'), '0');
select crm.val('P9a NEGATIVE CONTROL: ...on every other surface too',
  format($$select (count(*))::text from (
      select 1 from public.companies where organisation_id=%1$L
      union all select 1 from public.agencies where organisation_id=%1$L
      union all select 1 from public.artists where organisation_id=%1$L
      union all select 1 from public.venues where organisation_id=%1$L
      union all select 1 from public.venue_rooms where organisation_id=%1$L
      union all select 1 from public.custom_field_values where organisation_id=%1$L
      union all select 1 from public.merges where organisation_id=%1$L) s$$,
    :'alpha_org'), '0');
select crm.val('P9b NEGATIVE CONTROL: has_permission(suspended org, view_crm) is false',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select crm.val('P9c NEGATIVE CONTROL: the suspended org is not in their permitted set',
  format($$select exists (select 1 from private.permitted_organisations('view_crm') x
                          where x = %L)::text$$, :'alpha_org'), 'false');
select crm.val('P9d NEGATIVE CONTROL: the org row itself is still invisible to them',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '0');
select crm.try('P9e NEGATIVE CONTROL: and they still cannot write into it',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'breakout')$$, :'alpha_org'), 'denied(42501)');
-- POSITIVE CONTROL for the four above: pbowner is not blind, they simply
-- cannot see ALPHA. Without this, P9-P9e would pass against a broken session.
select crm.val('P9f POSITIVE CONTROL: pbowner does see their OWN organisation''s rows',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$,
    :'beta_org'), '2');
reset role; reset request.jwt.claims;

-- ---- 6. MFA COMPOSES WITH SUSPENSION, IT IS NOT REPLACED BY IT (§ 7.6) ----
-- powner is an Owner, which private.role_requires_mfa() covers. On an aal1
-- session they hold nothing anywhere -- and opening READS for a suspended
-- organisation must not have created a back door around that. The aal2 half is
-- the positive control: the same user, the same suspended organisation, one
-- claim different.
set role authenticated;
set request.jwt.claims = :'powner_c1';
select crm.val('P10 SUSPENDED + aal1 owner: still zero CRM rows (MFA composes)',
  $$select count(*)::text from public.contacts$$, '0');
select crm.val('P10a SUSPENDED + aal1 owner: has_permission(view_crm) still false',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.val('P10b POSITIVE CONTROL: the same owner at aal2 DOES read the suspended org',
  $$select count(*)::text from public.contacts$$, '13');
select crm.try('P10c ...and still cannot write to it',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'suspended-owner')$$, :'alpha_org'), 'denied(42501)');

-- ---- M-1: the WRITE-KEY sweep, run by somebody who actually holds them all --
-- P4a/P4b run as a manager, who holds four of the seven write keys when live,
-- so three of their disjuncts were vacuous -- and the two vacuous ones were
-- manage_members and manage_organisation, which are exactly the two keys with
-- no second gate before 20260828220000. Nothing in the suite proved an Owner of
-- a suspended organisation loses manage_members. This does, at aal2, over all
-- seven, with P4f/P4g as the live control that the same expression is TRUE
-- before suspension. manage_custom_fields is included; P4a omitted it entirely.
select crm.val('P4d SUSPENDED: all SEVEN write keys false for the aal2 OWNER -- has_permission',
  format($$select (public.has_permission(%1$L,'manage_contacts')
                or public.has_permission(%1$L,'manage_artists')
                or public.has_permission(%1$L,'manage_venues')
                or public.has_permission(%1$L,'manage_custom_fields')
                or public.has_permission(%1$L,'merge_records')
                or public.has_permission(%1$L,'manage_members')
                or public.has_permission(%1$L,'manage_organisation'))::text$$,
    :'alpha_org'), 'false');
select crm.val('P4e SUSPENDED: ...and none of the seven in the set form either',
  format($$select exists (
      select 1 from unnest(array['manage_contacts','manage_artists','manage_venues',
                                 'manage_custom_fields','merge_records',
                                 'manage_members','manage_organisation']) k
      where %L in (select private.permitted_organisations(k))
    )::text$$, :'alpha_org'), 'false');

-- ---- M-2: the four write-carrying tables the brief never named -------------
-- Driven as the aal2 Owner, the strongest possible caller: if these close for
-- an Owner they close for everyone. Same mechanism discipline as P2* -- INSERT
-- is denied(42501) because WITH CHECK rejects the new row; UPDATE is ok(0)
-- because USING matches nothing. Asserting WHICH refusal happens is what made
-- mutation 3 fully visible rather than half-caught.
select crm.try('P12  SUSPENDED: custom_field_definitions INSERT refused',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'artist','susp_key','Susp','text')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P12a SUSPENDED: contact_companies INSERT refused',
  format($$insert into public.contact_companies (organisation_id, contact_id, company_id)
    values (%L,'22220000-0000-0000-0000-000000000003',
               '11110000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P12b SUSPENDED: artist_representations INSERT refused',
  format($$insert into public.artist_representations
      (organisation_id, artist_id, agency_id)
    values (%L,'44440000-0000-0000-0000-000000000003',
               '33330000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'denied(42501)');
select crm.try('P12c SUSPENDED: artist_fee_history INSERT refused',
  format($$insert into public.artist_fee_history
      (organisation_id, artist_id, occurred_on, amount_minor, currency)
    values (%L,'44440000-0000-0000-0000-000000000002',
            date '2026-01-01',999900,'GBP')$$,
    :'alpha_org'), 'denied(42501)');
select crm.try('P12d SUSPENDED: custom_field_definitions UPDATE matches nothing',
  $$update public.custom_field_definitions set label='suspended'
    where id='aaaa0000-0000-0000-0000-000000000001'$$, 'ok(0)');
select crm.try('P12e SUSPENDED: artist_fee_history UPDATE matches nothing',
  $$update public.artist_fee_history set amount_minor=1
    where organisation_id is not null$$, 'ok(0)');
-- The two FOUNDATION write surfaces, as the Owner. These are the keys I-3 is
-- about: before 20260828220000 they were held closed by ONE catalogue boolean.
select crm.try('P12f SUSPENDED: organisation_memberships INSERT refused (no new members)',
  format($$insert into public.organisation_memberships
      (organisation_id, user_id, role, status, invited_by)
    values (%L,'%s','admin','invited',(select auth.uid()))$$,
    :'alpha_org', :'pbowner'), 'denied(42501)');
select crm.try('P12g SUSPENDED: organisation_memberships UPDATE matches nothing',
  format($$update public.organisation_memberships set role='booker'
    where organisation_id=%L and role='marketing'$$, :'alpha_org'), 'ok(0)');
reset role; reset request.jwt.claims;

-- ---- 3. THE OWNER CANNOT UN-SUSPEND (§ 7.3) ------------------------------
-- DECISIONS-QUEUE consequence P7, and it SURVIVES the Q6 reversal intact:
-- manage_organisation is a write, so it is false in a suspended organisation.
-- Suspension is a superuser action under CLAUDE.md § Superuser dashboard, with
-- step-up re-auth and admin notification; a self-service undo would make the
-- control meaningless. Reinstatement is a privileged path Phase 7 must ship in
-- the same change as the suspend button or it ships a one-way door.
set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.try('P7  SUSPENDED: even the Owner cannot un-suspend (Phase 7 owns this)',
  $$update public.organisations set deleted_at=null where slug='org-alpha'$$, 'ok(0)');
select crm.val('P7a ...and deleted_at really is still set',
  $$select (deleted_at is not null)::text from public.organisations
     where slug='org-alpha'$$, 'true');
select crm.try('P7b SUSPENDED: nor can the Owner rename the organisation',
  $$update public.organisations set name='Renamed While Suspended'
    where slug='org-alpha'$$, 'ok(0)');
reset role; reset request.jwt.claims;

-- ---- 7. THE SECOND GATE, PROVEN BY TURNING THE FIRST ONE OFF -------------
-- TASK 3a FIX ROUND 1, review finding I-3. THREE DOCUMENTS SAID THE WRITE HALF
-- WAS "closed twice over" AND FOR THESE TWO KEYS IT WAS NOT.
--
-- private.crm_write_organisations() carries its own unconditional deleted_at
-- clause and is named by 25 CRM write policies, so a wrong catalogue boolean on
-- a CRM key changes nothing (the reviewer flipped manage_contacts and the
-- INSERT was still refused). But the FOUR Foundation write policies --
-- organisation_memberships INSERT/UPDATE/DELETE and organisations UPDATE --
-- consulted public.has_permission() and NOTHING ELSE. The reviewer flipped one
-- boolean and an aal2 Owner UN-SUSPENDED THEIR OWN ORGANISATION and INVITED A
-- NEW ADMIN INTO A SUSPENDED ONE. Consequence P7, which the brief calls the
-- thing that would "make the control meaningless" if broken, rested on one row
-- of one table.
--
-- 20260828220000 adds the second gate: an unconditional `deleted_at is null` in
-- organisations_update_manage_organisation's USING, and
-- private.organisation_is_live() in the three membership policies. This block
-- is what proves it, and it can only be proved by DISABLING THE FIRST GATE --
-- a defence-in-depth term whose value is never measured with the term beside it
-- removed is an assumption, not a control. P11 is the positive control that the
-- first gate really is open while P11a-P11d run.
--
-- The flip is made and restored inside one DO block; nothing downstream sees it.
do $$
declare
  v_alpha uuid; v_owner uuid; v_guest uuid; n int;
  r_unsuspend text; r_rename text; r_invite text; r_demote text; r_remove text;
  v_first_gate text;
  -- The catalogue values as this block FOUND them. Re-review finding M-B: the
  -- previous version restored a hardcoded `false`, which is an assignment and
  -- not a restore. It happened to be right today, but it meant the suite wrote
  -- a value of its own choosing into the very table it exists to assert, so a
  -- catalogue mistake introduced before this point would be silently corrected
  -- here instead of surviving to be caught by anything that runs after it.
  v_saved record;
begin
  select id into v_alpha from public.organisations where slug = 'org-alpha';
  select id into v_owner from auth.users where email = 'powner@test.local';
  select id into v_guest from auth.users where email = 'pbowner@test.local';

  select
    (select survives_suspension from public.permissions where key = 'manage_organisation')
      as manage_organisation,
    (select survives_suspension from public.permissions where key = 'manage_members')
      as manage_members
    into v_saved;

  -- The exact one-row mistake the new design makes possible.
  update public.permissions set survives_suspension = true
   where key in ('manage_organisation','manage_members');

  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_owner, 'role','authenticated', 'aal','aal2')::text,
    true);
  v_first_gate := (public.has_permission(v_alpha,'manage_organisation')
               and public.has_permission(v_alpha,'manage_members'))::text;

  set local role authenticated;
  begin
    update public.organisations set deleted_at = null where id = v_alpha;
    get diagnostics n = row_count; r_unsuspend := 'ok(' || n || ')';
  exception when others then r_unsuspend := 'denied(' || sqlstate || ')'; end;
  begin
    update public.organisations set name = 'Flipped While Suspended' where id = v_alpha;
    get diagnostics n = row_count; r_rename := 'ok(' || n || ')';
  exception when others then r_rename := 'denied(' || sqlstate || ')'; end;
  begin
    insert into public.organisation_memberships
      (organisation_id, user_id, role, status, invited_by)
    values (v_alpha, v_guest, 'admin', 'invited', v_owner);
    get diagnostics n = row_count; r_invite := 'ok(' || n || ')';
  exception when others then r_invite := 'denied(' || sqlstate || ')'; end;
  begin
    update public.organisation_memberships set role = 'booker'
     where organisation_id = v_alpha and role = 'marketing';
    get diagnostics n = row_count; r_demote := 'ok(' || n || ')';
  exception when others then r_demote := 'denied(' || sqlstate || ')'; end;
  begin
    delete from public.organisation_memberships
     where organisation_id = v_alpha and role = 'marketing';
    get diagnostics n = row_count; r_remove := 'ok(' || n || ')';
  exception when others then r_remove := 'denied(' || sqlstate || ')'; end;
  reset role;

  perform pg_catalog.set_config('request.jwt.claims', '', true);
  -- Put back exactly what was there, per key, rather than assigning a constant.
  update public.permissions set survives_suspension = v_saved.manage_organisation
   where key = 'manage_organisation';
  update public.permissions set survives_suspension = v_saved.manage_members
   where key = 'manage_members';

  perform crm.record(
    'P11  CONTROL: the catalogue flip really DOES open the first gate',
    'true', v_first_gate);
  perform crm.record(
    'P11a FIRST GATE OFF: the Owner still cannot un-suspend (second gate)',
    'ok(0)', r_unsuspend);
  perform crm.record(
    'P11b FIRST GATE OFF: ...and deleted_at really is still set',
    'true',
    (select (deleted_at is not null)::text from public.organisations where id = v_alpha));
  perform crm.record(
    'P11c FIRST GATE OFF: nor rename, nor invite an admin into a suspended org',
    'ok(0)/denied(42501)', r_rename || '/' || r_invite);
  perform crm.record(
    'P11d FIRST GATE OFF: nor promote/demote nor remove a member',
    'ok(0)/ok(0)', r_demote || '/' || r_remove);
  -- Re-review M-B. The restore above puts back v_saved, so a catalogue change
  -- made before this point is no longer overwritten -- it survives, and this
  -- line is where it becomes visible. M1g asserts the whole catalogue; this
  -- asserts the two keys THIS block borrows, in the block that borrows them.
  perform crm.record(
    'P11f the two keys this block borrows were found -- and restored -- FALSE',
    'manage_organisation=false manage_members=false',
    'manage_organisation=' || v_saved.manage_organisation
      || ' manage_members=' || v_saved.manage_members);
end $$;

-- The shape guard beside it: a policy can be reverted by a later migration and
-- P11a-P11d would go on passing on the strength of the FIRST gate alone, which
-- is precisely the state this fix round was opened to end. So the second gate's
-- presence is asserted structurally too, read out of pg_policies rather than
-- out of the migration file.
select crm.val('P11e all four Foundation write policies carry the SECOND gate',
  $$select count(*)::text from pg_policies
     where schemaname='public'
       and policyname in ('organisations_update_manage_organisation',
                          'organisation_memberships_insert_manage_members',
                          'organisation_memberships_update_manage_members',
                          'organisation_memberships_delete_manage_members')
       and (coalesce(qual,'') || coalesce(with_check,''))
           ~ '(organisation_is_live|deleted_at IS NULL)'$$, '4');

update public.organisations set deleted_at = null where slug = 'org-alpha';

-- ---- THE BASELINE THE P1* COUNTS ARE MEASURED AGAINST --------------------
-- Every count asserted while suspended is re-asserted here with the
-- organisation LIVE, by the same user, with the same statement. If suspension
-- narrowed a read anywhere, one of these pairs disagrees. If a fixture change
-- moves a count, BOTH halves go red together and the failure is obviously a
-- fixture change rather than a policy regression.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('P8  REINSTATED: the CRM comes back',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
select crm.val('P20 LIVE baseline: contacts',            $$select count(*)::text from public.contacts$$, '13');
select crm.val('P21 LIVE baseline: companies',           $$select count(*)::text from public.companies$$, '3');
select crm.val('P22 LIVE baseline: agencies',            $$select count(*)::text from public.agencies$$, '1');
select crm.val('P23 LIVE baseline: artists',             $$select count(*)::text from public.artists$$, '3');
select crm.val('P24 LIVE baseline: venues',              $$select count(*)::text from public.venues$$, '3');
select crm.val('P25 LIVE baseline: venue_rooms',         $$select count(*)::text from public.venue_rooms$$, '4');
select crm.val('P26 LIVE baseline: custom_field_values', $$select count(*)::text from public.custom_field_values$$, '4');
select crm.val('P27 LIVE baseline: merges',              $$select count(*)::text from public.merges$$, '2');
-- M-2's four tables get the same paired baseline as the original eight.
select crm.val('P29 LIVE baseline: custom_field_definitions', $$select count(*)::text from public.custom_field_definitions$$, '4');
select crm.val('P30 LIVE baseline: contact_companies',        $$select count(*)::text from public.contact_companies$$, '2');
select crm.val('P31 LIVE baseline: artist_representations',   $$select count(*)::text from public.artist_representations$$, '2');
select crm.val('P32 LIVE baseline: artist_fee_history',       $$select count(*)::text from public.artist_fee_history$$, '1');
-- ...and the write that was refused throughout section P is accepted again, so
-- the refusals above were suspension and not some unrelated breakage.
select crm.try('P28 REINSTATED: the same INSERT that was refused now succeeds',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'reinstated')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
delete from public.contacts where name='reinstated';

-- THE LIVE CONTROL FOR P4d/P4e (M-1). Without it, "all seven write keys are
-- false under suspension" passes for an Owner who never held them -- which is
-- exactly the trap P4a/P4b fell into for three of their six disjuncts. Same
-- user, same organisation, one thing different: it is not suspended.
set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.val('P4f LIVE CONTROL: the same aal2 OWNER holds all seven write keys',
  format($$select (public.has_permission(%1$L,'manage_contacts')
                and public.has_permission(%1$L,'manage_artists')
                and public.has_permission(%1$L,'manage_venues')
                and public.has_permission(%1$L,'manage_custom_fields')
                and public.has_permission(%1$L,'merge_records')
                and public.has_permission(%1$L,'manage_members')
                and public.has_permission(%1$L,'manage_organisation'))::text$$,
    :'alpha_org'), 'true');
select crm.val('P4g LIVE CONTROL: ...and all seven in the set form too',
  format($$select (not exists (
      select 1 from unnest(array['manage_contacts','manage_artists','manage_venues',
                                 'manage_custom_fields','merge_records',
                                 'manage_members','manage_organisation']) k
      where %L not in (select private.permitted_organisations(k))
    ))::text$$, :'alpha_org'), 'true');
-- ...and the write surfaces P12* found closed are open again, so those refusals
-- were suspension and not a missing grant.
select crm.try('P33 REINSTATED: custom_field_definitions INSERT succeeds again',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'artist','reinstated_key','Reinstated','text')$$,
    :'alpha_org'), 'ok(1)');
select crm.try('P34 REINSTATED: organisation_memberships UPDATE matches again',
  format($$update public.organisation_memberships set role='marketing'
    where organisation_id=%L and role='marketing'$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
delete from public.custom_field_definitions where key='reinstated_key';

-- ===========================================================================
-- Q. merges LEAKED THE LOSER'S DISCARDED VALUES (IMP-2)
-- ===========================================================================
-- Scoping the SELECT by the winner alone left field_resolution -- a verbatim
-- copy of BOTH records' fields, including the values the merge DISCARDED --
-- readable by anyone who could see the winner. The reviewer had a Manager merge
-- a contact pstd1 could not see into one pstd1 owned, and pstd1 read the
-- discarded email and phone.
--
-- Two merges are planted: a mixed one (winner pstd1's, loser pmanager's) and a
-- clean one (both pstd1's), because closing the leak by making merges invisible
-- to record-scoped users altogether would also pass the first assertion.
insert into public.contacts (id, organisation_id, owner_user_id, name, deleted_at)
select '22220000-0000-0000-0000-00000000000a', o.id, :'pstd1', 'Std1 Own Loser', now()
from public.organisations o where o.slug='org-alpha';

insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
select 'cccc0000-0000-0000-0000-00000000000a', o.id, 'contact',
       '22220000-0000-0000-0000-000000000001',
       '22220000-0000-0000-0000-000000000002', :'pmanager',
       '{"email":{"kept":"std1@example.test","discarded":"MANAGER-ONLY-SECRET@example.test"}}'::jsonb
from public.organisations o where o.slug='org-alpha';

insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
select 'cccc0000-0000-0000-0000-00000000000c', o.id, 'contact',
       '22220000-0000-0000-0000-000000000001',
       '22220000-0000-0000-0000-00000000000a', :'pstd1',
       '{"email":{"kept":"std1@example.test","discarded":"std1-old@example.test"}}'::jsonb
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('Q1  CONTROL: pstd1 CAN see the winner of both merges',
  $$select count(*)::text from public.contacts
     where id='22220000-0000-0000-0000-000000000001'$$, '1');
select crm.val('Q2  CONTROL: pstd1 CANNOT see the mixed merge''s loser',
  $$select count(*)::text from public.contacts
     where id='22220000-0000-0000-0000-000000000002'$$, '0');
select crm.val('Q3  THE FIX: the mixed merge is invisible, so its secret is too',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-00000000000a'$$, '0');
select crm.val('Q4  ...and no discarded value leaks by any path',
  $$select count(*)::text from public.merges
     where field_resolution::text like '%MANAGER-ONLY-SECRET%'$$, '0');
select crm.val('Q5  NOT OVER-CLOSED: a merge of two records pstd1 owns IS visible',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-00000000000c'$$, '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('Q6  POSITIVE: a full-scope role sees both merges',
  $$select count(*)::text from public.merges
     where id in ('cccc0000-0000-0000-0000-00000000000a',
                  'cccc0000-0000-0000-0000-00000000000c')$$, '2');
reset role; reset request.jwt.claims;

-- Q7/Q8 -- THE DELIBERATE BEHAVIOUR CHANGE FROM NEW-2, asserted so it is a
-- decision rather than a side effect.
--
-- 20260828160000 reorders this policy so the hoistable full_scope_organisations()
-- term leads: a full-scope role never evaluates the per-row polymorphic
-- dispatch, which took a 50-row page over 20k merges from 12308 ms to 6.083 ms.
-- The consequence is that a full-scope role can now see a merge whose winner or
-- loser has been HARD-deleted, where previously the dispatch could not resolve
-- the missing row and the record was invisible to everyone.
--
-- Taken as a correction: a history table that loses rows when its subject is
-- erased is the wrong failure direction, and a full-scope role is entitled to
-- every record in that organisation anyway. The record-scoped guarantee IMP-2
-- exists for is untouched -- Q8 proves it.
--
-- These are also the only BEHAVIOURAL assertions that go red if the reordering
-- is reverted. The speed itself is invisible to every other test in this file,
-- which is exactly the lesson task-2-report § 3.1 drew and H12/H13 exist for.
insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
select 'cccc0000-0000-0000-0000-00000000000e', o.id, 'contact',
       '22220000-0000-0000-0000-000000000002',
       -- Names no contact row at all: the loser was hard-deleted. entity_id is
       -- polymorphic and unvalidated at the constraint layer, so this is
       -- exactly the state a GDPR erasure or a Phase 7 purge leaves behind.
       'dddddddd-dead-dead-dead-dddddddddddd', :'pmanager',
       '{"email":{"kept":"mgr@example.test","discarded":"erased@example.test"}}'::jsonb
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('Q7  NEW-2: a full-scope role sees a merge whose loser was HARD-deleted',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-00000000000e'$$, '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('Q8  ...and a record-scoped role still cannot -- IMP-2 is intact',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-00000000000e'$$, '0');
select crm.val('Q9  ...nor reach its discarded value by any path',
  $$select count(*)::text from public.merges
     where field_resolution::text like '%erased@example.test%'$$, '0');
reset role; reset request.jwt.claims;

-- Q10/Q11 -- the PRECISE invariant behind Q7 (fix-round-2 re-review, NR2-1).
--
-- Q7 asserts one reachable cause of the reordering's consequence: a subject
-- that was hard-deleted. That wording is narrower than the code. For a
-- full-scope reader the winner and loser identifiers are not validated at all,
-- so a merge naming a row in ANOTHER organisation is equally visible -- and
-- nothing above would have caught it.
--
-- Not a tenant leak: the merges INSERT policy checks both sides with
-- entity_is_manageable(), so no client can create this row. It is planted as
-- postgres precisely because only a privileged write or a later hard delete
-- can produce the state. What is under test is that the record-scoped
-- guarantee still holds even when the full-scope one does not (Q11).
insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
select 'cccc0000-0000-0000-0000-0000000000f2', o.id, 'contact',
       '22220000-0000-0000-0000-000000000002',
       -- A BETA contact id: the loser is a real row, in the wrong tenant.
       '2222000b-0000-0000-0000-00000000000b', :'pmanager', '{}'::jsonb
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('Q10 NEW-2: winner/loser ids are unvalidated for a full-scope reader',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-0000000000f2'$$, '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('Q11 ...and a record-scoped reader still cannot see it',
  $$select count(*)::text from public.merges
     where id='cccc0000-0000-0000-0000-0000000000f2'$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- R. THE IRREVERSIBLE WRITES ARE AUDITED (IMP-5)
-- ===========================================================================
-- audit_events is readable only by the platform superuser, so these assertions
-- run as postgres. What is under test is that the TRIGGER fires on a write made
-- through a policy by a real impersonated session -- which is the path a direct
-- PostgREST call takes, and the one an application-side audit misses entirely.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('R1  a hard DELETE of a link succeeds',
  format($$delete from public.contact_companies
    where contact_id='22220000-0000-0000-0000-000000000001'
      and company_id='11110000-0000-0000-0000-000000000003'$$), 'ok(1)');
select crm.try('R2  a hard DELETE of a custom field value succeeds',
  $$delete from public.custom_field_values
    where id='bbbb0000-0000-0000-0000-000000000002'$$, 'ok(1)');
select crm.try('R3  a merge row is inserted',
  format($$insert into public.merges
      (organisation_id, entity_type, winner_id, loser_id, merged_by)
    values (%L,'contact','22220000-0000-0000-0000-000000000002',
            '22220000-0000-0000-0000-000000000003',(select auth.uid()))$$,
    :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- DISTINCT, because by this point earlier sections have legitimately produced
-- more of these events -- C21 inserted a merge and N13 deleted a link, both as
-- real sessions, and both were audited. That is the trigger working; the first
-- draft of this assertion listed every row and failed on the duplicates.
select crm.val('R4  ...and all three are in the audit trail, attributed to the actor',
  format($$select string_agg(distinct action,',' order by action)
     from public.audit_events
     where actor_user_id=%L
       and action in ('contact_company.deleted','custom_field_value.deleted','records.merged')$$,
    :'pmanager'),
  'contact_company.deleted,custom_field_value.deleted,records.merged');
select crm.val('R5  the audit row carries the organisation and the target id',
  $$select (organisation_id is not null and target_id is not null
            and correlation_id is not null)::text
     from public.audit_events where action='custom_field_value.deleted' limit 1$$, 'true');
-- The allowlist. audit_events is superuser-readable, and CLAUDE.md
-- § Superuser dashboard keeps tenant record CONTENT off that surface -- the
-- feedback screenshot is described there as the ONE deliberate exception. So
-- the payload carries identifiers and never the user-entered value.
select crm.val('R6  ...and NOT the user-entered value (identifiers only)',
  $$select (before ? 'field_id' and before ? 'entity_id'
            and not (before ? 'value'))::text
     from public.audit_events where action='custom_field_value.deleted' limit 1$$, 'true');
select crm.val('R7  ...nor the merge''s field_resolution',
  $$select (after ? 'winner_id' and after ? 'loser_id'
            and not (after ? 'field_resolution'))::text
     from public.audit_events where action='records.merged' limit 1$$, 'true');

-- THE NULL-ACTOR GUARD, which is what stops the trigger breaking organisation
-- deletion. A sessionless writer -- a migration, a seed, a DBA repair, or an FK
-- cascade started by one -- has no auth.uid(), and private.log_audit_event()
-- RAISES on a null actor. Without the early return, the cascade below would
-- abort.
-- On a throwaway organisation, so the probe can name the exact target_id and
-- assert on THAT rather than on a global count, which earlier sections have
-- legitimately added to. `actor_user_id is null` would also have been a hollow
-- assertion: that column is NOT NULL, so it can never match.
insert into public.organisations (id, name, slug)
values ('eeee0000-0000-0000-0000-0000000000ee','Org Zed','org-zed');
insert into public.contacts (id, organisation_id, name)
values ('eeee0000-0000-0000-0000-0000000000c1','eeee0000-0000-0000-0000-0000000000ee','Zed Contact');
-- Two DISTINCT companies: contact_companies_contact_company_unique forbids two
-- links between the same pair, and the first draft of this fixture tripped it.
insert into public.companies (id, organisation_id, name)
values ('eeee0000-0000-0000-0000-0000000000c2','eeee0000-0000-0000-0000-0000000000ee','Zed Co'),
       ('eeee0000-0000-0000-0000-0000000000c5','eeee0000-0000-0000-0000-0000000000ee','Zed Co II');
insert into public.contact_companies (id, organisation_id, contact_id, company_id)
values ('eeee0000-0000-0000-0000-0000000000c3','eeee0000-0000-0000-0000-0000000000ee',
        'eeee0000-0000-0000-0000-0000000000c1','eeee0000-0000-0000-0000-0000000000c2'),
       ('eeee0000-0000-0000-0000-0000000000c4','eeee0000-0000-0000-0000-0000000000ee',
        'eeee0000-0000-0000-0000-0000000000c1','eeee0000-0000-0000-0000-0000000000c5');

select crm.try('R8  a SESSIONLESS delete succeeds instead of raising 28000',
  $$delete from public.contact_companies
     where id='eeee0000-0000-0000-0000-0000000000c4'$$, 'ok(1)');
select crm.val('R9  ...and emitted no audit row for it (no actor to attribute)',
  $$select count(*)::text from public.audit_events
     where target_id='eeee0000-0000-0000-0000-0000000000c4'$$, '0');

-- The cascade itself, because this is the behaviour Task 1 measured
-- ("organisation delete cascades cleanly, no error") and an unconditional
-- trigger would have destroyed: DELETE FROM organisations cascades into
-- contact_companies with no session, log_audit_event() raises 28000 on a null
-- actor, and the whole statement aborts.
select crm.try('R10 organisation delete still cascades through an audited table',
  $$delete from public.organisations where slug='org-zed'$$, 'ok(1)');
select crm.val('R11 ...and took the remaining link row with it',
  $$select count(*)::text from public.contact_companies
     where id='eeee0000-0000-0000-0000-0000000000c3'$$, '0');

-- R12/R13 -- THE BRANCH R10/R11 NEVER TESTED, AND THE ONE PHASE 7 WILL USE.
--
-- R10 above deletes SESSIONLESS, which is the branch the null-actor guard
-- already made safe -- the trigger returns before it inserts anything. WITH a
-- session set, fix round 1's trigger aborted the whole statement:
--
--   ERROR: insert or update on table "audit_events" violates foreign key
--          constraint "audit_events_organisation_id_fkey"
--   DETAIL: Key (organisation_id)=(...) is not present in table "organisations".
--
-- because the cascade removes the organisation first and each child's AFTER
-- DELETE trigger then names a parent that is already gone. The header called
-- that a VOLUME problem ("will write one row per cascaded row"); it was an
-- abort. 20260828160000 resolves the organisation through a live lookup so a
-- vanished parent degrades to NULL instead.
--
-- This matters beyond tidiness: it is the path Phase 7's superuser organisation
-- deletion takes, and the path a GDPR erasure runs on -- a legal obligation
-- with a 30-day statutory clock.
insert into public.organisations (id, name, slug)
values ('eeee0000-0000-0000-0000-0000000000ef','Org Zed Two','org-zed-two');
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values ('eeee0000-0000-0000-0000-0000000000ef', :'pmanager', 'manager', 'active', now());
insert into public.contacts (id, organisation_id, name)
values ('eeee0000-0000-0000-0000-0000000000d1','eeee0000-0000-0000-0000-0000000000ef','Zed2 Contact');
insert into public.companies (id, organisation_id, name)
values ('eeee0000-0000-0000-0000-0000000000d2','eeee0000-0000-0000-0000-0000000000ef','Zed2 Co');
insert into public.contact_companies (id, organisation_id, contact_id, company_id)
values ('eeee0000-0000-0000-0000-0000000000d3','eeee0000-0000-0000-0000-0000000000ef',
        'eeee0000-0000-0000-0000-0000000000d1','eeee0000-0000-0000-0000-0000000000d2');

-- `set role authenticated` is NOT used here: the point is an auth.uid() being
-- present during the cascade, which is what makes the trigger fire, and the
-- DELETE itself has to run as an owner of the table because no client role has
-- DELETE on public.organisations at all. This is the DBA/superuser shape.
set request.jwt.claims = :'pmanager_c';
select crm.try('R12 organisation delete cascades WITH a session set',
  $$delete from public.organisations where slug='org-zed-two'$$, 'ok(1)');
reset request.jwt.claims;

select crm.val('R13 ...and the cascaded audit row carries a NULL organisation, not an error',
  $$select (count(*) = 1 and bool_and(organisation_id is null))::text
     from public.audit_events
     where target_id='eeee0000-0000-0000-0000-0000000000d3'$$, 'true');
select crm.val('R14 ...while an ordinary delete still records the organisation',
  $$select (count(*) > 0 and bool_and(organisation_id is not null))::text
     from public.audit_events
     where action='custom_field_value.deleted'$$, 'true');

-- ===========================================================================
-- S. TASK 4's WRITE PATH: is_primary, soft delete, restore
-- ===========================================================================
-- ITS OWN FIXTURE, with its own ids. Sections A-R have already deleted and
-- re-inserted link rows, and a test that depends on what they left behind is a
-- test whose meaning changes when they do.
--
--   contacts    ...00a1 owned by pstd1      ...00a2 owned by pmanager
--   companies   ...00a1, ...00a2, ...00a3   all unowned (record scope on a
--               link row derives from the CONTACT -- Q5 -- so the company's
--               owner is deliberately not the variable under test here)
--   links       a1->a1 primary, a1->a2, a1->a3   on pstd1's contact
--               a2->a1 primary                   on pmanager's contact
insert into public.companies (id, organisation_id, name)
select v.id::uuid, o.id, v.nm
from public.organisations o, (values
  ('11110000-0000-0000-0000-0000000000a1', 'S Co One'),
  ('11110000-0000-0000-0000-0000000000a2', 'S Co Two'),
  ('11110000-0000-0000-0000-0000000000a3', 'S Co Three')
) as v(id, nm) where o.slug='org-alpha';

insert into public.contacts (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, v.owner::uuid, v.nm
from public.organisations o, (values
  ('22220000-0000-0000-0000-0000000000a1', :'pstd1',    'S Std1 Contact'),
  ('22220000-0000-0000-0000-0000000000a2', :'pmanager', 'S Manager Contact')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.contact_companies (organisation_id, contact_id, company_id, is_primary)
select o.id, v.ct::uuid, v.co::uuid, v.pri
from public.organisations o, (values
  ('22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a1', true),
  ('22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a2', false),
  ('22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a3', false),
  ('22220000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-0000000000a1', true)
) as v(ct, co, pri) where o.slug='org-alpha';

-- --------------------------------------------------------------------------
-- S1-S3. THE MEASUREMENT THE is_primary DECISION RESTS ON.
--
-- 20260828230000's header says a single UPDATE that demotes one row and
-- promotes another is checked PER ROW against the non-deferrable partial
-- unique index, so it succeeds or raises 23505 depending on the order the
-- executor happens to visit the rows in. That is a claim about behaviour, and
-- a claim about behaviour that nothing runs is this phase's named failure
-- mode -- so it runs here, as postgres, with no RLS in the way, so the only
-- thing under test is the index.
-- --------------------------------------------------------------------------
select crm.try('S1  a single UPDATE promoting BEFORE demoting raises 23505',
  $$update public.contact_companies set is_primary = true
     where contact_id='22220000-0000-0000-0000-0000000000a1'
       and company_id='11110000-0000-0000-0000-0000000000a2'$$, 'denied(23505)');

-- The outer quote is $s2$ and not $$ because the payload is itself a
-- dollar-quoted DO block; `$do$$$` is a syntax error, not a nesting.
select crm.try('S2  demote-then-promote, two statements, is accepted',
  $s2$do $do$
    begin
      update public.contact_companies set is_primary = false
       where contact_id='22220000-0000-0000-0000-0000000000a1' and is_primary;
      update public.contact_companies set is_primary = true
       where contact_id='22220000-0000-0000-0000-0000000000a1'
         and company_id='11110000-0000-0000-0000-0000000000a2';
    end
    $do$$s2$, 'ok(0)');

select crm.val('S3  ...leaving exactly one primary, and it is the new one',
  $$select count(*)::text from public.contact_companies
     where contact_id='22220000-0000-0000-0000-0000000000a1'
       and is_primary
       and company_id='11110000-0000-0000-0000-0000000000a2'$$, '1');
select crm.val('S3a ...and no second primary survived',
  $$select count(*)::text from public.contact_companies
     where contact_id='22220000-0000-0000-0000-0000000000a1' and is_primary$$, '1');

-- --------------------------------------------------------------------------
-- S4-S10. set_contact_primary_company() across every role that matters.
--
-- The function is SECURITY INVOKER, so what is under test is that it adds no
-- privilege: every refusal the RLS policies make against a direct PATCH they
-- make against this, and the MECHANISM is asserted rather than "it failed".
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('S4  a manager moves the primary back, and gets the count',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a1',%L)::text$$, :'alpha_org'),
  '1');
select crm.val('S5  ...exactly one primary, and it moved',
  $$select company_id::text from public.contact_companies
     where contact_id='22220000-0000-0000-0000-0000000000a1' and is_primary$$,
  '11110000-0000-0000-0000-0000000000a1');
select crm.val('S6  re-nominating the CURRENT primary is a no-op that still reports 1',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a1',%L)::text$$, :'alpha_org'),
  '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('S7  a standard_user may set the primary on a contact THEY OWN',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a3',%L)::text$$, :'alpha_org'),
  '1');
-- The record-scope half. pstd1 does not own contact ...a2, so both statements
-- inside the function match nothing -- and the function RAISES rather than
-- returning 0, which is the whole reason it raises: a returned 0 would arrive
-- at the application as a 200 with no error, the same trap as a 204 one layer
-- down.
select crm.val('S8  ...and NOT on a contact they do not own -- 42501, not 0',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a2','11110000-0000-0000-0000-0000000000a2',%L)::text$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;
-- THE OUTCOME CHECK RUNS AS postgres, NOT AS THE ATTACKER, and the first draft
-- got this wrong in a way worth recording: written inside pstd1's session it
-- returned 0 and looked like the primary had been destroyed. It had not --
-- pstd1 cannot READ a link row on a contact they do not own (record scope,
-- Q5), so the assertion was measuring visibility while claiming to measure
-- state. Any "and the row is untouched" check has to be taken by a principal
-- that could see the row either way.
select crm.val('S8a ...and that contact still has its original primary',
  $$select count(*)::text from public.contact_companies
     where contact_id='22220000-0000-0000-0000-0000000000a2'
       and is_primary and company_id='11110000-0000-0000-0000-0000000000a1'$$, '1');

set role authenticated;
set request.jwt.claims = :'pro_c';
select crm.val('S9  a read_only user is refused, with the mechanism 42501',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a2',%L)::text$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select crm.val('S10 a NON-MEMBER of the organisation is refused the same way',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a2',%L)::text$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- S10a-S10d. THE WORKSPACE TERM, which is what 20260828234500 exists for.
--
-- RLS answers "may this caller write this row". The URL asks "is this row the
-- one this workspace's page is about". For a member of ONE organisation those
-- coincide, and every assertion above passes either way. pmulti is an admin of
-- BOTH -- an ordinary user at MVP, not a contrived one -- and is where they
-- diverge: the 2-arg version promoted a company on org-beta's contact when
-- called with org-beta's ids from org-alpha's URL, returning 1.
--
-- The refusal has to be the ORGANISATION and not pmulti's access, which is
-- what S10c is for: the same caller, the same rows, org-beta's id, accepted.
-- Without that control S10a would pass just as well if the function had
-- stopped working.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.val('S10a pmulti, from ALPHA, cannot promote a BETA contact''s company',
  format($$select public.set_contact_primary_company(
      '2222000b-0000-0000-0000-00000000000b','1111000b-0000-0000-0000-00000000000b',%L)::text$$,
    :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;
-- As postgres, for the reason S8a gives: the outcome check must be taken by a
-- principal that could see the row either way.
select crm.val('S10b ...and the BETA link row is untouched -- 0 rows changed',
  $$select count(*)::text from public.contact_companies
     where id='7777000b-0000-0000-0000-00000000000b' and is_primary$$, '0');

set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.val('S10c POSITIVE CONTROL: the same caller and rows, with BETA''s org id',
  format($$select public.set_contact_primary_company(
      '2222000b-0000-0000-0000-00000000000b','1111000b-0000-0000-0000-00000000000b',%L)::text$$,
    :'beta_org'),
  '1');
reset role; reset request.jwt.claims;
select crm.val('S10d ...so S10a''s refusal is the WORKSPACE, not the caller',
  $$select count(*)::text from public.contact_companies
     where id='7777000b-0000-0000-0000-00000000000b' and is_primary$$, '1');
-- Put the beta fixture back the way section B left it.
update public.contact_companies set is_primary = false
 where id='7777000b-0000-0000-0000-00000000000b';

-- --------------------------------------------------------------------------
-- S11-S16. Soft delete and restore, and the MECHANISM of each refusal.
--
-- Task 3a's lesson: accepting "refused" without asserting HOW hides a real
-- difference. Here the two mechanisms are the point of the whole task --
-- ok(0) is the silent 204 the application must read a row count to detect,
-- and denied(42501) is the loud one it can read from the error.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('S11 a manager soft-deletes a contact',
  $$update public.contacts set deleted_at = pg_catalog.now()
     where id='22220000-0000-0000-0000-0000000000a2' and deleted_at is null$$, 'ok(1)');
select crm.try('S12 ...and deleting it again matches nothing, so the timestamp is not restamped',
  $$update public.contacts set deleted_at = pg_catalog.now()
     where id='22220000-0000-0000-0000-0000000000a2' and deleted_at is null$$, 'ok(0)');
select crm.val('S13 ...the soft-deleted row is still READABLE -- design note (g)',
  $$select count(*)::text from public.contacts
     where id='22220000-0000-0000-0000-0000000000a2'$$, '1');
select crm.try('S14 ...and it restores',
  $$update public.contacts set deleted_at = null
     where id='22220000-0000-0000-0000-0000000000a2' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pro_c';
-- THE 204. read_only holds view_crm but not manage_contacts, so the UPDATE
-- policy's USING clause filters the row out and the statement matches nothing.
-- Over PostgREST that is 204 No Content with `Content-Range: */0` -- byte
-- identical in the status line to a write that changed fifteen rows. This is
-- the exact response lib/crm/write.ts exists to classify.
select crm.try('S15 a read_only soft delete matches NOTHING -- ok(0), the silent 204',
  $$update public.contacts set deleted_at = pg_catalog.now()
     where id='22220000-0000-0000-0000-0000000000a1'$$, 'ok(0)');
-- The INSERT half, for contrast, on the same session: a refused INSERT is a
-- LOUD 42501, which is why lib/crm/contacts.ts reads the error on create and
-- the row count on update.
select crm.try('S16 ...while a read_only INSERT is loud: 42501, not ok(0)',
  format($$insert into public.contacts (organisation_id, name)
           values (%L,'read only should not be here')$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;
-- As postgres, for the reason S8a gives: a read_only user is record-scoped and
-- cannot see this contact at all, so asking them whether it changed measures
-- their visibility rather than the row.
select crm.val('S15a ...and the contact really is untouched',
  $$select (deleted_at is null)::text from public.contacts
     where id='22220000-0000-0000-0000-0000000000a1'$$, 'true');
select crm.val('S16a ...and no row was inserted by the refused INSERT',
  $$select count(*)::text from public.contacts
     where name='read only should not be here'$$, '0');

-- --------------------------------------------------------------------------
-- S17-S20. A SUSPENDED workspace. DECISIONS-QUEUE Q6: read-only, not a
-- lockout -- and the UI half of that is what Task 4 shipped.
-- --------------------------------------------------------------------------
update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('S17 SUSPENDED: a manager still READS the contact',
  $$select count(*)::text from public.contacts
     where id='22220000-0000-0000-0000-0000000000a1'$$, '1');
select crm.try('S18 SUSPENDED: ...and their soft delete matches NOTHING -- ok(0)',
  $$update public.contacts set deleted_at = pg_catalog.now()
     where id='22220000-0000-0000-0000-0000000000a1'$$, 'ok(0)');
select crm.val('S19 SUSPENDED: ...and the RPC raises 42501 rather than half-applying',
  format($$select public.set_contact_primary_company(
      '22220000-0000-0000-0000-0000000000a1','11110000-0000-0000-0000-0000000000a2',%L)::text$$, :'alpha_org'),
  'denied(42501)');
-- The half that makes S19 worth asserting: the demote statement inside the
-- function must not have committed on its own. If it had, a suspended
-- workspace could strip a contact's primary company through a call that
-- reports an error.
select crm.val('S20 SUSPENDED: ...and the demote half did NOT commit',
  $$select count(*)::text from public.contact_companies
     where contact_id='22220000-0000-0000-0000-0000000000a1' and is_primary$$, '1');
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = null where slug = 'org-alpha';

-- --------------------------------------------------------------------------
-- S21-S23. The restore view's query shape, which is a route rather than a
-- filter (app/(app)/[orgSlug]/contacts/deleted/page.tsx) and therefore needs
-- its own index and its own predicate to be right.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('S21 a manager soft-deletes, so the restore view has something in it',
  $$update public.contacts set deleted_at = pg_catalog.now()
     where id='22220000-0000-0000-0000-0000000000a2' and deleted_at is null$$, 'ok(1)');
select crm.val('S22 the LIVE list predicate excludes it',
  format($$select count(*)::text from public.contacts
     where organisation_id=%L and deleted_at is null
       and id='22220000-0000-0000-0000-0000000000a2'$$, :'alpha_org'), '0');
select crm.val('S23 ...and the DELETED list predicate includes exactly it',
  format($$select count(*)::text from public.contacts
     where organisation_id=%L and deleted_at is not null
       and id='22220000-0000-0000-0000-0000000000a2'$$, :'alpha_org'), '1');
reset role; reset request.jwt.claims;

-- The two indexes 20260828230000 adds for that route, asserted to EXIST with
-- the predicate the sort option's `notNull: true` leans on. lib/crm/*-list.ts
-- names them in `backedBy`, which is a string; this is what makes the string
-- true.
select crm.val('S24 contacts_org_deleted_at_id_idx exists, partial on deleted_at not null',
  $$select (indexdef like '%WHERE (deleted_at IS NOT NULL)')::text
     from pg_indexes where indexname='contacts_org_deleted_at_id_idx'$$, 'true');
select crm.val('S25 companies_org_deleted_at_id_idx likewise',
  $$select (indexdef like '%WHERE (deleted_at IS NOT NULL)')::text
     from pg_indexes where indexname='companies_org_deleted_at_id_idx'$$, 'true');
select crm.val('S26 the companies list indexes named by backedBy exist',
  $$select count(*)::text from pg_indexes
     where indexname in ('companies_org_name_id_live_idx',
                         'companies_org_updated_at_id_live_idx')$$, '2');

-- --------------------------------------------------------------------------
-- S28 / S28b. WHERE THE SOFT-DELETE CHECK ON THE JOIN ACTUALLY LIVES.
--
-- IT MOVED. Until 20260828235000 this assertion read "the DATABASE still
-- permits a link write on a DELETED contact -- app-side only", expecting
-- ok(1), and the comment above it argued that design note (g) made a policy
-- term impossible. Note (g) is about SELECT on the row being restored; the
-- rule needed here is a WRITE predicate on a different table, and restoring a
-- contact never touches contact_companies. So the predicate went in.
--
-- S28: the CONTACT end is now enforced BY THE POLICY. This is the assertion a
-- reader should reach for before deciding lib/crm/contacts.ts's `liveInOrg` is
-- the only thing standing between a soft-deleted record and its links -- it is
-- not, for the contact. The contact is soft-deleted here (S21 set it, S27
-- below restores it), and the same statement returned ok(1) before the
-- migration.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('S28 the DATABASE REFUSES a link write on a DELETED contact',
  $$update public.contact_companies set is_primary = is_primary
     where contact_id='22220000-0000-0000-0000-0000000000a2'$$, 'ok(0)');
reset role; reset request.jwt.claims;

-- S28b. THE OTHER END, AND WHY IT IS DELIBERATELY STILL OPEN.
--
-- The product rule (lib/crm/contacts.ts) is BOTH ENDS LIVE. The policy
-- enforces the contact half only. A `companies.deleted_at is null` term would
-- have to READ THE COMPANY ROW as the caller, and under Q5 a record-scoped
-- user may legitimately link their own contact to a company they cannot see --
-- so "deleted" and "invisible" would collapse into one refusal and break the
-- case the schema deliberately permits. The company end therefore stays
-- application-only, and this assertion is what stops that being an assumption:
-- it measures the database SAYING YES so nobody deletes the application check
-- thinking a policy will catch it.
--
-- Contact a1 is LIVE and owned by pstd1; company a3 is soft-deleted here and
-- restored two statements later, so the fixture is left exactly as found.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('S28b setup: a manager soft-deletes S Co Three',
  $$update public.companies set deleted_at = pg_catalog.now()
     where id='11110000-0000-0000-0000-0000000000a3' and deleted_at is null$$, 'ok(1)');
select crm.try('S28b the DATABASE still PERMITS a link write whose only deleted end is the COMPANY -- app-side only, by Q5',
  $$update public.contact_companies set is_primary = is_primary
     where contact_id='22220000-0000-0000-0000-0000000000a1'
       and company_id='11110000-0000-0000-0000-0000000000a3'$$, 'ok(1)');
select crm.try('S28b teardown: ...and restoring the company puts it back',
  $$update public.companies set deleted_at = null
     where id='11110000-0000-0000-0000-0000000000a3' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- Leave the fixture as section R left it, so a later section (there is none
-- today, and there will be) does not inherit a deleted contact.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('S27 ...and restoring puts it back',
  $$update public.contacts set deleted_at = null
     where id='22220000-0000-0000-0000-0000000000a2' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- T. TASK 4b's WRITE PATH: artists, agencies, venues, rooms, representations
-- ===========================================================================
-- ITS OWN FIXTURE, with its own ids, for the reason section S gives: sections
-- A-S have already inserted, deleted and re-inserted rows on these tables, and
-- a test that depends on what they left behind is a test whose meaning changes
-- when they do.
--
--   artists     ...00b1 owned by pstd1        ...00b2 owned by pmanager
--   agencies    ...00b1 ...00b2 ...00b3       all unowned (a representation's
--               record scope derives from the ARTIST -- Q3a -- so the agency's
--               owner is deliberately not the variable under test here)
--   venues      ...00b1 owned by pstd1        ...00b2 owned by pmanager
--   reps        (id prefix 888800b0-, suffix shown; "r1" below is a LABEL for
--                888800b0-0000-0000-0000-0000000000a1 and so on -- the ids are
--                hex because a uuid column is, which the first draft of this
--                fixture found out with `invalid input syntax for type uuid:
--                "…0000000000r1"`)
--               r1 = …a1  artist b1 -> agency b1, PRIMARY, open-ended
--               r2 = …a2  artist b1 -> agency b2, open-ended
--               r3 = …a3  artist b1 -> agency b3, open-ended
--               r4 = …a4  artist b2 -> agency b1, PRIMARY, open-ended
--               r5 = …a5  artist b1 -> agency b2, PRIMARY, 2020-01-01 → 2023-01-01
--
-- r5 IS THE POINT OF THE WHOLE FIXTURE. It is a HISTORICAL primary: is_primary
-- is true and ended_at is set, so it sits outside
-- artist_representations_one_current_primary_per_artist's predicate and
-- coexists legally with r1. Every temporal assertion below is about whether
-- the write path leaves it alone.
insert into public.agencies (id, organisation_id, name)
select v.id::uuid, o.id, v.nm
from public.organisations o, (values
  ('333300b0-0000-0000-0000-0000000000b1', 'T Agency One'),
  ('333300b0-0000-0000-0000-0000000000b2', 'T Agency Two'),
  ('333300b0-0000-0000-0000-0000000000b3', 'T Agency Three')
) as v(id, nm) where o.slug='org-alpha';

insert into public.artists (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, v.owner::uuid, v.nm
from public.organisations o, (values
  ('444400b0-0000-0000-0000-0000000000b1', :'pstd1',    'T Std1 Artist'),
  ('444400b0-0000-0000-0000-0000000000b2', :'pmanager', 'T Manager Artist')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.venues (id, organisation_id, owner_user_id, name)
select v.id::uuid, o.id, v.owner::uuid, v.nm
from public.organisations o, (values
  ('555500b0-0000-0000-0000-0000000000b1', :'pstd1',    'T Std1 Venue'),
  ('555500b0-0000-0000-0000-0000000000b2', :'pmanager', 'T Manager Venue')
) as v(id, owner, nm) where o.slug='org-alpha';

insert into public.artist_representations
  (id, organisation_id, artist_id, agency_id, is_primary, started_at, ended_at)
select v.id::uuid, o.id, v.ar::uuid, v.ag::uuid, v.pri,
       nullif(v.st,'')::date, nullif(v.en,'')::date
from public.organisations o, (values
  ('888800b0-0000-0000-0000-0000000000a1','444400b0-0000-0000-0000-0000000000b1',
   '333300b0-0000-0000-0000-0000000000b1', true,  '', ''),
  ('888800b0-0000-0000-0000-0000000000a2','444400b0-0000-0000-0000-0000000000b1',
   '333300b0-0000-0000-0000-0000000000b2', false, '', ''),
  ('888800b0-0000-0000-0000-0000000000a3','444400b0-0000-0000-0000-0000000000b1',
   '333300b0-0000-0000-0000-0000000000b3', false, '', ''),
  ('888800b0-0000-0000-0000-0000000000a4','444400b0-0000-0000-0000-0000000000b2',
   '333300b0-0000-0000-0000-0000000000b1', true,  '', ''),
  ('888800b0-0000-0000-0000-0000000000a5','444400b0-0000-0000-0000-0000000000b1',
   '333300b0-0000-0000-0000-0000000000b2', true,  '2020-01-01', '2023-01-01')
) as v(id, ar, ag, pri, st, en) where o.slug='org-alpha';

insert into public.artist_fee_history
  (id, organisation_id, artist_id, occurred_on, amount_minor, note)
select v.id::uuid, o.id, '444400b0-0000-0000-0000-0000000000b1',
       v.d::date, v.amt::bigint, v.nt
from public.organisations o, (values
  ('999900b0-0000-0000-0000-0000000000f1','2024-06-01', '250000','Warehouse, June'),
  ('999900b0-0000-0000-0000-0000000000f2','2025-02-14', '400000','Valentine''s')
) as v(id, d, amt, nt) where o.slug='org-alpha';

-- --------------------------------------------------------------------------
-- T0. THE FIXTURE IS THE MEASUREMENT. Four is_primary rows would be a bug on
-- most schemas; here two is a legal state, and the suite has to say so out
-- loud before anything is asserted about the write path.
-- --------------------------------------------------------------------------
select crm.val('T0  artist b1 legally holds TWO is_primary rows (one has ended)',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1' and is_primary$$, '2');
select crm.val('T0a ...and exactly ONE of them is open-ended, which is what the index enforces',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$, '1');

-- --------------------------------------------------------------------------
-- T1-T3. THE MEASUREMENT set_artist_primary_representation() RESTS ON.
--
-- 20260828230000's header says a single UPDATE that demotes one row and
-- promotes another is checked PER ROW against the non-deferrable partial
-- unique index, so it succeeds or raises 23505 depending on the order the
-- executor happens to visit the rows in. S1/S2/S3 pin that for
-- contact_companies; this pins it for artist_representations, whose index has
-- a DIFFERENT predicate. Run as postgres, with no RLS in the way, so the only
-- thing under test is the index.
-- --------------------------------------------------------------------------
select crm.try('T1  a single UPDATE promoting BEFORE demoting raises 23505',
  $$update public.artist_representations set is_primary = true
     where id='888800b0-0000-0000-0000-0000000000a2'$$, 'denied(23505)');

-- $t2$ and not $$ because the payload is itself a dollar-quoted DO block.
select crm.try('T2  demote-then-promote, SCOPED to the index predicate, is accepted',
  $t2$do $do$
    begin
      update public.artist_representations set is_primary = false
       where artist_id='444400b0-0000-0000-0000-0000000000b1'
         and is_primary and ended_at is null and deleted_at is null;
      update public.artist_representations set is_primary = true
       where id='888800b0-0000-0000-0000-0000000000a2';
    end
    $do$$t2$, 'ok(0)');

select crm.val('T3  ...leaving exactly one OPEN-ENDED primary, and it is r2',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null
       and id='888800b0-0000-0000-0000-0000000000a2'$$, '1');
select crm.val('T3a THE TEMPORAL HALF: the HISTORICAL primary r5 is untouched',
  $$select is_primary::text from public.artist_representations
     where id='888800b0-0000-0000-0000-0000000000a5'$$, 'true');

-- --------------------------------------------------------------------------
-- T4-T10. set_artist_primary_representation() across every role that matters.
--
-- SECURITY INVOKER, so what is under test is that it adds no privilege: every
-- refusal the RLS policies make against a direct PATCH they make against this,
-- and the MECHANISM is asserted rather than "it failed".
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T4  a manager moves the primary back to r1, and gets the count',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), '1');
select crm.val('T5  ...exactly one open-ended primary, and it moved',
  $$select id::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null$$,
  '888800b0-0000-0000-0000-0000000000a1');
select crm.val('T5a THE FUNCTION''s temporal half: r5 is STILL is_primary',
  $$select is_primary::text from public.artist_representations
     where id='888800b0-0000-0000-0000-0000000000a5'$$, 'true');
select crm.val('T6  re-nominating the CURRENT primary is a no-op that still reports 1',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('T7  a standard_user may set the primary on an artist THEY OWN',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a3',%L)::text$$,
    :'alpha_org'), '1');
-- The record-scope half. pstd1 does not own artist b2, so both statements
-- inside the function match nothing -- and the function RAISES rather than
-- returning 0, which is the whole reason it raises: a returned 0 would arrive
-- at the application as a 200 with no error, the same trap as a 204 one layer
-- down.
select crm.val('T8  ...and NOT on an artist they do not own -- 42501, not 0',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b2','888800b0-0000-0000-0000-0000000000a4',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
-- THE OUTCOME CHECK RUNS AS postgres, for the reason S8a records: written
-- inside the attacker's session it would measure their VISIBILITY while
-- claiming to measure state.
select crm.val('T8a ...and that artist still has its original primary',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b2'
       and is_primary and id='888800b0-0000-0000-0000-0000000000a4'$$, '1');

set role authenticated;
set request.jwt.claims = :'pro_c';
select crm.val('T9  a read_only user is refused, with the mechanism 42501',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
-- THE KEY IS `manage_artists`, NOT "any CRM key". A Venue Manager can write
-- venues and rooms all day and must not touch representation.
select crm.val('T9a a venue_manager holds no manage_artists, so this is 42501 too',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select crm.val('T10 a NON-MEMBER of the organisation is refused the same way',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- T10a-T10d. THE WORKSPACE TERM, copied from 20260828234500 because that
-- migration's header instructs Task 4b to copy it and NOT to ship a 2-arg
-- overload.
--
-- RLS answers "may this caller write this row". The URL asks "is this row the
-- one this workspace's page is about". For a member of ONE organisation those
-- coincide and every assertion above passes either way. pmulti is an admin of
-- BOTH -- an ordinary user at MVP -- and is where they diverge.
--
-- The refusal has to be the ORGANISATION and not pmulti's access, which is
-- what T10c is for: the same caller, the same rows, org-beta's id, accepted.
-- Without that control T10a would pass just as well if the function had simply
-- stopped working.
-- --------------------------------------------------------------------------
insert into public.artist_representations (id, organisation_id, artist_id, agency_id, is_primary)
select '888800bb-0000-0000-0000-0000000000bb', o.id,
       '4444000b-0000-0000-0000-00000000000b','3333000b-0000-0000-0000-00000000000b', false
from public.organisations o where o.slug='org-beta';

set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.val('T10a pmulti, from ALPHA, cannot promote a BETA artist''s representation',
  format($$select public.set_artist_primary_representation(
      '4444000b-0000-0000-0000-00000000000b','888800bb-0000-0000-0000-0000000000bb',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
select crm.val('T10b ...and the BETA representation row is untouched -- 0 rows changed',
  $$select count(*)::text from public.artist_representations
     where id='888800bb-0000-0000-0000-0000000000bb' and is_primary$$, '0');

set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.val('T10c POSITIVE CONTROL: the same caller and rows, with BETA''s org id',
  format($$select public.set_artist_primary_representation(
      '4444000b-0000-0000-0000-00000000000b','888800bb-0000-0000-0000-0000000000bb',%L)::text$$,
    :'beta_org'), '1');
reset role; reset request.jwt.claims;
select crm.val('T10d ...so T10a''s refusal is the WORKSPACE, not the caller',
  $$select count(*)::text from public.artist_representations
     where id='888800bb-0000-0000-0000-0000000000bb' and is_primary$$, '1');

-- --------------------------------------------------------------------------
-- T11-T12. THE PROMOTE'S OWN SCOPE, which the contact version has no analogue
-- for. Without `ended_at is null and deleted_at is null` on the promote, this
-- function could demote the live open-ended primary and promote an ENDED or
-- REMOVED row in its place -- leaving the artist with no current primary at
-- all and one marked on a row the product does not show as current.
--
-- The second assertion of each pair is the one that matters: the demote must
-- have ROLLED BACK with the raise.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T11 promoting an ENDED representation is refused -- 42501',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a5',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
select crm.val('T11a ...and the demote did NOT commit -- r3 is still the primary',
  $$select id::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null$$,
  '888800b0-0000-0000-0000-0000000000a3');

update public.artist_representations set deleted_at = now()
 where id='888800b0-0000-0000-0000-0000000000a2';
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T12 promoting a REMOVED representation is refused -- 42501',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a2',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
select crm.val('T12a ...and the demote did NOT commit either',
  $$select id::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$,
  '888800b0-0000-0000-0000-0000000000a3');
update public.artist_representations set deleted_at = null
 where id='888800b0-0000-0000-0000-0000000000a2';

-- --------------------------------------------------------------------------
-- T13-T14. CLEARING, and the one branch that costs the caller something.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T13 clearing the primary returns 0 rows promoted',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1',null,%L)::text$$, :'alpha_org'), '0');
select crm.val('T14 ...and clearing again RAISES, because 0 demoted cannot be told from a refusal',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1',null,%L)::text$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;
select crm.val('T13a no OPEN-ENDED primary remains',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$, '0');
select crm.val('T13b ...and CLEARING did not rewrite history either -- r5 is still primary',
  $$select is_primary::text from public.artist_representations
     where id='888800b0-0000-0000-0000-0000000000a5'$$, 'true');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T14a put it back, so the rest of the section has a primary',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a1',%L)::text$$,
    :'alpha_org'), '1');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- T15. THE FUTURE-DATED `ended_at` GAP -- FOLLOW-UPS.md's open item, and the
-- § 3(b) decision, as assertions rather than as a paragraph.
--
-- The index enforces one OPEN-ENDED primary, not one CURRENT one, because
-- `current_date` is not IMMUTABLE and cannot appear in a partial index
-- predicate (nor in a CHECK constraint). Task 4b ACCEPTED that rather than
-- forbidding a future-dated end date: a representation that ends on a known
-- date is an ordinary industry fact, and rejecting it would forbid a true
-- statement to protect an index name.
--
-- The price of accepting it is a display rule (lib/crm/queries.ts,
-- `PrimaryState`) and the guarantee below: THE WRITE PATH CANNOT CREATE THE
-- AMBIGUOUS STATE. T15d is that guarantee.
-- --------------------------------------------------------------------------
insert into public.artist_representations
  (id, organisation_id, artist_id, agency_id, is_primary, ended_at)
select '888800b0-0000-0000-0000-0000000000f9', o.id,
       '444400b0-0000-0000-0000-0000000000b1',
       '333300b0-0000-0000-0000-0000000000b2', true, date '2099-01-01'
from public.organisations o where o.slug='org-alpha';

select crm.val('T15 THE GAP IS REAL: a FUTURE-dated primary coexists with the open-ended one',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and deleted_at is null$$, '3');
select crm.try('T15a but a SECOND OPEN-ENDED primary is still refused -- the index does bite',
  $$insert into public.artist_representations
      (organisation_id, artist_id, agency_id, is_primary)
    select id,'444400b0-0000-0000-0000-0000000000b1',
           '333300b0-0000-0000-0000-0000000000b3', true
    from public.organisations where slug='org-alpha'$$, 'denied(23505)');
select crm.val('T15b the DISPLAY RULE''s input: exactly one row is primary AND open-ended',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$, '1');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T15c THE WRITE PATH CANNOT CREATE IT: promoting the 2099 row is 42501',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000f9',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;
select crm.val('T15d ...and that refusal rolled the demote back, so r1 is still primary',
  $$select id::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$,
  '888800b0-0000-0000-0000-0000000000a1');
-- The 2099 row is left in place deliberately: T28/T28b below write against
-- this artist and the gap must not be a fixture that quietly disappears.

-- --------------------------------------------------------------------------
-- T16-T23. SOFT DELETE AND RESTORE ON THE THREE NEW ENTITIES, and the
-- MECHANISM of each refusal.
--
-- ok(0) is the silent 204 the application must read a row count to detect;
-- denied(42501) is the loud one it can read from the error. Asserting which is
-- the point (Task 3a's lesson), not accepting either.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('T16 a manager soft-deletes an artist',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(1)');
select crm.try('T17 ...and deleting it again matches nothing, so the timestamp is not restamped',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(0)');
select crm.val('T18 ...the soft-deleted row is still READABLE -- design note (g)',
  $$select count(*)::text from public.artists
     where id='444400b0-0000-0000-0000-0000000000b2'$$, '1');
select crm.val('T18a ...and so are its representations, so restore can show what comes back',
  $$select count(*)::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b2'$$, '1');
select crm.try('T19 ...and it restores',
  $$update public.artists set deleted_at = null
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pro_c';
-- THE 204. read_only holds view_crm but not manage_artists, so the UPDATE
-- policy's USING clause filters the row out and the statement matches nothing.
-- Over PostgREST that is 204 No Content with `Content-Range: */0` -- byte
-- identical in the status line to a write that changed fifteen rows.
select crm.try('T20 a read_only soft delete of an ARTIST matches NOTHING -- ok(0)',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
select crm.try('T20a a read_only soft delete of a VENUE matches NOTHING -- ok(0)',
  $$update public.venues set deleted_at = pg_catalog.now()
     where id='555500b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
select crm.try('T20b a read_only soft delete of an AGENCY matches NOTHING -- ok(0)',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
-- The INSERT half, for contrast, on the same session: a refused INSERT is a
-- LOUD 42501, which is why the create paths read the error and the update
-- paths read the row count.
select crm.try('T21 ...while a read_only INSERT is loud: 42501, not ok(0)',
  format($$insert into public.artists (organisation_id, name)
           values (%L,'read only should not be here')$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;
-- As postgres, for the reason S8a gives.
select crm.val('T20c ...and none of the three really changed',
  $$select (count(*) filter (where deleted_at is null))::text from (
      select deleted_at from public.artists  where id='444400b0-0000-0000-0000-0000000000b1'
      union all
      select deleted_at from public.venues   where id='555500b0-0000-0000-0000-0000000000b1'
      union all
      select deleted_at from public.agencies where id='333300b0-0000-0000-0000-0000000000b1') s$$,
  '3');
select crm.val('T21a ...and no artist was inserted by the refused INSERT',
  $$select count(*)::text from public.artists
     where name='read only should not be here'$$, '0');

-- THE SIX KEYS ARE NOT ONE KEY. A Booker writes artists and not venues; a
-- Venue Manager is the mirror image; an agency is on `manage_contacts`, which
-- neither of them holds. Every one of these is a soft DELETE -- the verb Task
-- 4b added -- rather than the INSERT section C already covers.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select crm.try('T22 a booker soft-deletes an ARTIST (manage_artists: yes)',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(1)');
select crm.try('T22a ...and restores it',
  $$update public.artists set deleted_at = null
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is not null$$, 'ok(1)');
select crm.try('T22b a booker soft-deletes a VENUE (manage_venues: NO) -- ok(0)',
  $$update public.venues set deleted_at = pg_catalog.now()
     where id='555500b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(0)');
-- T22c CORRECTS AN ASSUMPTION THIS SUITE'S AUTHOR MADE AND DID NOT RUN.
-- The first version expected ok(0) here, on the reasoning that a Booker is an
-- artist role. Read out of role_permissions rather than out of a mental model:
--
--   booker        manage_artists, manage_contacts, view_crm
--   venue_manager manage_contacts, manage_venues, view_crm
--   marketing     manage_contacts, view_crm
--   finance       view_crm
--   read_only     view_crm
--
-- `manage_contacts` is the widest CRM key in the matrix -- every role except
-- finance and read_only holds it -- because it covers contacts, companies AND
-- agencies, which is the relationship layer everybody in a booking business
-- works in. The roles that DIVERGE on an agency page are therefore
-- venue_manager and marketing (agency yes, representation no), NOT booker.
-- Two comments in the application said otherwise and were corrected with this.
select crm.try('T22c a booker soft-deletes an AGENCY -- manage_contacts: YES, and it is the widest key',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
select crm.try('T22d ...and restores it',
  $$update public.agencies set deleted_at = null
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- The roles that really cannot. Finance is the interesting one: it is the role
-- whose name suggests the most access to a table called artist_fee_history and
-- has the least (C15, T32b).
set role authenticated;
set request.jwt.claims = :'pfinance_c';
select crm.try('T22e finance soft-deletes an AGENCY (view_crm only) -- ok(0)',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(0)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmarketing_c';
select crm.try('T22f marketing soft-deletes an AGENCY (manage_contacts: yes)',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
select crm.try('T22g ...and restores it',
  $$update public.agencies set deleted_at = null
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is not null$$, 'ok(1)');
-- THE DIVERGENCE THE AGENCY DETAIL PAGE IS BUILT ON: the same user, the same
-- page, and the representation panel is refused. This is why that page asks
-- for TWO keys.
select crm.try('T22h ...but marketing cannot touch a REPRESENTATION on that page -- ok(0)',
  $$update public.artist_representations set territory='pwned'
     where id='888800b0-0000-0000-0000-0000000000a1'$$, 'ok(0)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('T22i a venue_manager edits an AGENCY (manage_contacts: yes)',
  $$update public.agencies set name='T Agency One (vm edit)'
     where id='333300b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
select crm.try('T22j ...and is refused the representation panel on the same page -- ok(0)',
  $$update public.artist_representations set territory='pwned'
     where id='888800b0-0000-0000-0000-0000000000a1'$$, 'ok(0)');
reset role; reset request.jwt.claims;
select crm.val('T22k ...and the representation really is untouched',
  $$select coalesce(territory,'<null>') from public.artist_representations
     where id='888800b0-0000-0000-0000-0000000000a1'$$, '<null>');

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('T23 a venue_manager soft-deletes a VENUE (manage_venues: yes)',
  $$update public.venues set deleted_at = pg_catalog.now()
     where id='555500b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(1)');
select crm.try('T23a ...and restores it',
  $$update public.venues set deleted_at = null
     where id='555500b0-0000-0000-0000-0000000000b2' and deleted_at is not null$$, 'ok(1)');
select crm.try('T23b a venue_manager soft-deletes an ARTIST (manage_artists: NO) -- ok(0)',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(0)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('T23c a manager soft-deletes an AGENCY (manage_contacts: yes)',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b3' and deleted_at is null$$, 'ok(1)');
select crm.val('T23d ...and the representation naming it SURVIVES -- the whole reason agencies.deleted_at exists',
  $$select count(*)::text from public.artist_representations
     where agency_id='333300b0-0000-0000-0000-0000000000b3' and deleted_at is null$$, '1');
select crm.try('T23e ...and it restores',
  $$update public.agencies set deleted_at = null
     where id='333300b0-0000-0000-0000-0000000000b3' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- T24-T26. venue_rooms: the full inline lifecycle, on the right key.
-- --------------------------------------------------------------------------
insert into public.venue_rooms (id, organisation_id, venue_id, name)
select '666600b0-0000-0000-0000-0000000000b1', o.id,
       '555500b0-0000-0000-0000-0000000000b2', 'T Main Room'
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('T24 a venue_manager renames a room',
  $$update public.venue_rooms set name='T Main Room (renamed)'
     where id='666600b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
select crm.try('T24a ...closes it (a soft delete -- Phase 3 events may reference it)',
  $$update public.venue_rooms set deleted_at = pg_catalog.now()
     where id='666600b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
select crm.val('T24b ...the closed room is still READABLE, so reopen is reachable',
  $$select count(*)::text from public.venue_rooms
     where id='666600b0-0000-0000-0000-0000000000b1'$$, '1');
select crm.try('T24c ...and reopens it',
  $$update public.venue_rooms set deleted_at = null
     where id='666600b0-0000-0000-0000-0000000000b1' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbooker_c';
select crm.try('T25 a booker cannot rename a room (manage_venues: NO) -- ok(0)',
  $$update public.venue_rooms set name='pwned'
     where id='666600b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pro_c';
select crm.try('T26 a read_only user cannot close a room -- ok(0)',
  $$update public.venue_rooms set deleted_at = pg_catalog.now()
     where id='666600b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
reset role; reset request.jwt.claims;
select crm.val('T26a ...and the room really is untouched',
  $$select name from public.venue_rooms
     where id='666600b0-0000-0000-0000-0000000000b1' and deleted_at is null$$,
  'T Main Room (renamed)');

-- --------------------------------------------------------------------------
-- T27. TENANT BREAKOUT ON THE NEW ENDPOINTS -- THE MISMATCHED PAIR.
--
-- Section B already covers a foreign organisation_id in the body and a foreign
-- row id in the URL. The pair the brief names is the third one: THIS
-- workspace's organisation_id with THAT workspace's parent id. It is the shape
-- that looks legitimate to a naive check ("the org matches my session") and it
-- is what the composite tenant-scoped foreign keys from 20260828001132 exist
-- for.
--
-- BOTH LAYERS, IN ORDER, because they are different controls with different
-- reach:
--   * as `authenticated`, the POLICY refuses first, 42501 -- it requires
--     `p.organisation_id = <row>.organisation_id` on the parent lookup;
--   * as `postgres`, with no policy in the way, the FOREIGN KEY refuses,
--     23503 -- which holds for EVERY writer in every role, including a
--     SECURITY DEFINER function or a DBA repair script.
-- Proven, not cited.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('T27 ALPHA org id + BETA artist id in artist_representations -- policy, 42501',
  format($$insert into public.artist_representations
             (organisation_id, artist_id, agency_id)
           values (%L,'4444000b-0000-0000-0000-00000000000b',
                      '333300b0-0000-0000-0000-0000000000b1')$$, :'alpha_org'),
  'denied(42501)');
select crm.try('T27a ALPHA org id + BETA agency id -- also 42501 (the FK would too)',
  format($$insert into public.artist_representations
             (organisation_id, artist_id, agency_id)
           values (%L,'444400b0-0000-0000-0000-0000000000b1',
                      '3333000b-0000-0000-0000-00000000000b')$$, :'alpha_org'),
  'denied(23503)');
select crm.try('T27b ALPHA org id + BETA venue id in venue_rooms -- policy, 42501',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
           values (%L,'5555000b-0000-0000-0000-00000000000b','planted')$$, :'alpha_org'),
  'denied(42501)');
select crm.try('T27c POSITIVE CONTROL: the same statement with THIS workspace''s parent',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
           values (%L,'555500b0-0000-0000-0000-0000000000b2','T Control Room')$$,
    :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- The constraint layer, with no policy in the way. This is the half that holds
-- for a writer RLS does not apply to.
select crm.try('T27d as postgres, the COMPOSITE FK refuses the same artist mismatch -- 23503',
  format($$insert into public.artist_representations
             (organisation_id, artist_id, agency_id)
           values (%L,'4444000b-0000-0000-0000-00000000000b',
                      '333300b0-0000-0000-0000-0000000000b1')$$, :'alpha_org'),
  'denied(23503)');
select crm.try('T27e as postgres, likewise for the venue mismatch -- 23503',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
           values (%L,'5555000b-0000-0000-0000-00000000000b','planted by postgres')$$,
    :'alpha_org'), 'denied(23503)');
select crm.val('T27f ...and nothing was planted in BETA',
  $$select count(*)::text from public.venue_rooms
     where venue_id='5555000b-0000-0000-0000-00000000000b'$$, '1');

-- --------------------------------------------------------------------------
-- T28 / T28b / T29. WHERE THE SOFT-DELETE CHECK ON A CHILD ACTUALLY LIVES.
--
-- 20260829001000 copies the split 20260828235000 made for contact_companies:
-- the PARENT end goes into the policy, the OTHER ends stay application-only.
-- T28 is the assertion a reader should reach for before deciding
-- lib/crm/actions.ts's `liveInOrg` is the only thing standing between a
-- soft-deleted record and its children -- it is not, for the parent.
-- T28b is what stops the other half being an assumption: it measures the
-- database SAYING YES, so nobody deletes the application check thinking a
-- policy will catch it.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('T28 setup: a manager soft-deletes T Manager Artist',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(1)');
select crm.try('T28 the DATABASE REFUSES a representation write on a DELETED artist',
  $$update public.artist_representations set territory = 'UK'
     where artist_id='444400b0-0000-0000-0000-0000000000b2'$$, 'ok(0)');
select crm.try('T28a ...including soft-deleting the representation itself',
  $$update public.artist_representations set deleted_at = pg_catalog.now()
     where artist_id='444400b0-0000-0000-0000-0000000000b2'$$, 'ok(0)');
select crm.try('T28 teardown: restoring the artist puts it back',
  $$update public.artists set deleted_at = null
     where id='444400b0-0000-0000-0000-0000000000b2' and deleted_at is not null$$, 'ok(1)');

-- T28b. THE OTHER END, AND WHY IT IS DELIBERATELY STILL OPEN.
--
-- The product rule (lib/crm/artists.ts) is BOTH ENDS LIVE. The policy enforces
-- the ARTIST half only. An `agencies.deleted_at is null` term would have to
-- READ THE AGENCY ROW as the caller, and under Q3a a record-scoped user may
-- legitimately record a representation naming an agency they cannot see -- so
-- "deleted" and "invisible" would collapse into one refusal and break the case
-- the schema deliberately permits.
select crm.try('T28b setup: a manager soft-deletes T Agency Three',
  $$update public.agencies set deleted_at = pg_catalog.now()
     where id='333300b0-0000-0000-0000-0000000000b3' and deleted_at is null$$, 'ok(1)');
select crm.try('T28b the DATABASE still PERMITS a write whose only deleted end is the AGENCY -- app-side only, by Q3a',
  $$update public.artist_representations set territory = 'UK'
     where agency_id='333300b0-0000-0000-0000-0000000000b3'$$, 'ok(1)');
select crm.try('T28b teardown: ...and restoring the agency puts it back',
  $$update public.agencies set deleted_at = null
     where id='333300b0-0000-0000-0000-0000000000b3' and deleted_at is not null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- T29. venue_rooms has ONE parent and no other end, so its half of the split
-- is one-sided: nothing is left application-only.
set role authenticated;
set request.jwt.claims = :'pvenuemgr_c';
select crm.try('T29 setup: a venue_manager soft-deletes T Manager Venue',
  $$update public.venues set deleted_at = pg_catalog.now()
     where id='555500b0-0000-0000-0000-0000000000b2' and deleted_at is null$$, 'ok(1)');
select crm.try('T29 the DATABASE REFUSES a room rename on a DELETED venue',
  $$update public.venue_rooms set name='renamed while deleted'
     where id='666600b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
select crm.try('T29a ...and refuses a NEW room on it -- a loud 42501, because INSERT is',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
           values (%L,'555500b0-0000-0000-0000-0000000000b2','room on a deleted venue')$$,
    :'alpha_org'), 'denied(42501)');
select crm.val('T29b ...while the rooms stay READABLE, so restore can show what comes back',
  $$select count(*)::text from public.venue_rooms
     where venue_id='555500b0-0000-0000-0000-0000000000b2'$$, '2');
select crm.try('T29 teardown: restoring the venue makes the rooms writable again',
  $$update public.venues set deleted_at = null
     where id='555500b0-0000-0000-0000-0000000000b2' and deleted_at is not null$$, 'ok(1)');
select crm.try('T29c POSITIVE CONTROL: the same rename now applies',
  $$update public.venue_rooms set name='T Main Room (renamed)'
     where id='666600b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- T30. A SUSPENDED WORKSPACE. Q6: read-only, not a lockout.
-- --------------------------------------------------------------------------
update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('T30 SUSPENDED: a manager still READS the artist',
  $$select count(*)::text from public.artists
     where id='444400b0-0000-0000-0000-0000000000b1'$$, '1');
select crm.try('T30a SUSPENDED: ...and their soft delete matches NOTHING -- ok(0)',
  $$update public.artists set deleted_at = pg_catalog.now()
     where id='444400b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
select crm.try('T30b SUSPENDED: ...nor can they rename a room -- ok(0)',
  $$update public.venue_rooms set name='suspended rename'
     where id='666600b0-0000-0000-0000-0000000000b1'$$, 'ok(0)');
select crm.val('T30c SUSPENDED: ...and the RPC raises 42501 rather than half-applying',
  format($$select public.set_artist_primary_representation(
      '444400b0-0000-0000-0000-0000000000b1','888800b0-0000-0000-0000-0000000000a3',%L)::text$$,
    :'alpha_org'), 'denied(42501)');
-- The half that makes T30c worth asserting: the demote statement inside the
-- function must not have committed on its own. If it had, a suspended
-- workspace could strip an artist's primary representation through a call that
-- reports an error.
select crm.val('T30d SUSPENDED: ...and the demote half did NOT commit',
  $$select id::text from public.artist_representations
     where artist_id='444400b0-0000-0000-0000-0000000000b1'
       and is_primary and ended_at is null and deleted_at is null$$,
  '888800b0-0000-0000-0000-0000000000a1');
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = null where slug = 'org-alpha';

-- --------------------------------------------------------------------------
-- T31. THE INDEXES `backedBy` NAMES. lib/crm/*-list.ts names them in a STRING;
-- this is what makes the string true. Adding a sort without an index is the
-- one move that makes that required field pointless, and it is invisible to
-- every test that checks which rows come back.
-- --------------------------------------------------------------------------
select crm.val('T31 the six live-list indexes named by backedBy exist',
  $$select count(*)::text from pg_indexes
     where indexname in ('artists_org_name_id_live_idx',
                         'artists_org_updated_at_id_live_idx',
                         'agencies_org_name_id_live_idx',
                         'agencies_org_updated_at_id_live_idx',
                         'venues_org_name_id_live_idx',
                         'venues_org_updated_at_id_live_idx')$$, '6');
select crm.val('T31a ...and all six are PARTIAL on deleted_at is null, which is what the list writes',
  $$select count(*)::text from pg_indexes
     where indexname in ('artists_org_name_id_live_idx',
                         'artists_org_updated_at_id_live_idx',
                         'agencies_org_name_id_live_idx',
                         'agencies_org_updated_at_id_live_idx',
                         'venues_org_name_id_live_idx',
                         'venues_org_updated_at_id_live_idx')
       and indexdef like '%WHERE (deleted_at IS NULL)'$$, '6');
select crm.val('T31b the three restore-view indexes exist, partial the other way',
  $$select count(*)::text from pg_indexes
     where indexname in ('artists_org_deleted_at_id_idx',
                         'agencies_org_deleted_at_id_idx',
                         'venues_org_deleted_at_id_idx')
       and indexdef like '%WHERE (deleted_at IS NOT NULL)'$$, '3');
select crm.val('T31c the fee-history index pins BOTH equality columns before the sort',
  $$select (indexdef like '%(organisation_id, artist_id, occurred_on, id)%')::text
     from pg_indexes
     where indexname='artist_fee_history_org_artist_occurred_on_id_live_idx'$$, 'true');

-- --------------------------------------------------------------------------
-- T32. THE FEE-HISTORY READ, which is the only new list Task 4b ships that is
-- not a top-level entity.
--
-- IT IS READ-ONLY IN THE PRODUCT AND THE DATABASE DOES NOT SAY SO. There is a
-- write policy (`manage_artists`), and T32c asserts it -- so nobody reads "no
-- form exists" as "no write path exists". The decision not to build the form is
-- Task 4b's, recorded in the report, not a constraint.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select crm.val('T32 a standard_user reads the fee history of an artist THEY OWN',
  $$select count(*)::text from public.artist_fee_history
     where artist_id='444400b0-0000-0000-0000-0000000000b1' and deleted_at is null$$, '2');
select crm.val('T32a ...and NOT of an artist they do not own -- record scope, via the artist',
  $$select count(*)::text from public.artist_fee_history
     where artist_id='444400b0-0000-0000-0000-0000000000b2'$$, '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pfinance_c';
-- The tempting cell, restated for the READ direction: Finance holds view_crm
-- and no write key here (C15 asserts the write half).
select crm.val('T32b finance READS fee history (view_crm) even though it cannot write it',
  $$select count(*)::text from public.artist_fee_history
     where artist_id='444400b0-0000-0000-0000-0000000000b1'$$, '2');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.try('T32c THE WRITE PATH EXISTS IN THE DATABASE -- the form''s absence is a product decision',
  $$update public.artist_fee_history set note = 'edited'
     where id='999900b0-0000-0000-0000-0000000000f1'$$, 'ok(1)');
select crm.try('T32d ...and event_id is still held NULL until Phase 3 adds the FK',
  $$update public.artist_fee_history
      set event_id = '00000000-0000-0000-0000-0000000000ee'
     where id='999900b0-0000-0000-0000-0000000000f1'$$, 'denied(23514)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- T33-T38a. THE OWNER, THE ROLE THIS SUITE NEVER EXERCISED (fix round 1,
-- I-3). Every write path above ran as Manager, Standard User, Read Only, a
-- Venue Manager, a non-member and a multi-org Admin -- never as Owner. Owner
-- is a superset role and "the superset behaves like the subset" is precisely
-- the kind of assumption T22c already proved this suite should not make
-- without running it.
--
-- Fresh fixture rows (id suffix c1), so these six writes do not depend on --
-- or disturb -- the state T0-T32 already measured, and can run at the very
-- end of the file with nothing downstream to break.
-- --------------------------------------------------------------------------
insert into public.venues (id, organisation_id, owner_user_id, name)
select '555500b0-0000-0000-0000-0000000000c1', o.id, :'pstd1'::uuid, 'T Owner Venue'
from public.organisations o where o.slug='org-alpha';

set role authenticated;
set request.jwt.claims = :'powner_c';

select crm.try('T33 OWNER creates an artist -- not their own, and it is full-scope not record-scope',
  format($$insert into public.artists (organisation_id, owner_user_id, name)
    values (%L,%L,'T Owner-Created Artist')$$, :'alpha_org', :'pstd1'), 'ok(1)');
select crm.try('T34 OWNER creates an agency',
  format($$insert into public.agencies (organisation_id, name)
    values (%L,'T Owner-Created Agency')$$, :'alpha_org'), 'ok(1)');
select crm.try('T35 OWNER creates a venue',
  format($$insert into public.venues (organisation_id, owner_user_id, name)
    values (%L,%L,'T Owner-Created Venue')$$, :'alpha_org', :'pstd1'), 'ok(1)');
select crm.try('T36 OWNER adds a room to a venue THEY DO NOT OWN',
  format($$insert into public.venue_rooms (organisation_id, venue_id, name)
    values (%L,'555500b0-0000-0000-0000-0000000000c1','T Owner Room')$$,
    :'alpha_org'), 'ok(1)');
select crm.try('T37 OWNER creates a representation on an artist and agency they do not own',
  format($$insert into public.artist_representations (organisation_id, artist_id, agency_id)
    select %L, a.id, ag.id
      from public.artists a, public.agencies ag
     where a.name='T Owner-Created Artist' and ag.name='T Owner-Created Agency'$$,
    :'alpha_org'), 'ok(1)');
select crm.val('T38 OWNER promotes it primary through the RPC, and gets the count',
  format($$select public.set_artist_primary_representation(
      (select id from public.artists where name='T Owner-Created Artist'),
      (select id from public.artist_representations
        where artist_id=(select id from public.artists where name='T Owner-Created Artist')),
      %L)::text$$, :'alpha_org'), '1');
reset role; reset request.jwt.claims;

-- NEGATIVE CONTROL, so T33-T38 are not "everything succeeds because these
-- tables have no RLS at all": the SAME Owner, from ALPHA, against BETA's org.
set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.try('T38a OWNER NEGATIVE CONTROL: cannot create an artist in BETA''s workspace',
  format($$insert into public.artists (organisation_id, name)
    values (%L,'Owner Cannot Write Here')$$, :'beta_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- U. THE CUSTOM FIELD DEFINITION: soft delete, and the tier limit (Task 5)
-- ===========================================================================
-- Three things are being measured and they are independent:
--
--   1. The SOFT DELETE 20260828121000 design note (f) deferred to this task.
--      There is still no DELETE policy and no DELETE grant -- removing a field
--      is an UPDATE that sets `deleted_at` -- so the composite FK's cascade
--      remains unreachable from every client role and the VALUES survive.
--   2. The TIER LIMIT, in the database, because the anon key ships in the
--      browser and a Server Action is not on an attacker's path. It is a
--      BEFORE trigger rather than a WITH CHECK because it has to gate the
--      RESTORE of a soft-deleted definition too, which needs OLD.
--   3. The ORACLE GUARD that trigger needs. A BEFORE ROW trigger fires before
--      the RLS WITH CHECK, so without a guard a stranger could POST a
--      definition naming any organisation and read that organisation's limit
--      state out of which refusal came back. U12/U12b measure the guard by the
--      MESSAGE, because both refusals are 42501 and a sqlstate cannot tell
--      them apart.
--
-- A FRESH ORGANISATION, on purpose. Sections C, F, N and O all add and remove
-- definitions in org-alpha, so a count-based assertion there would depend on
-- everything above it. org-limit has exactly the rows this section puts in it.
-- ---------------------------------------------------------------------------

-- The message-shape helper. crm.try records only the sqlstate, which is 42501
-- for both a policy refusal and a limit refusal -- and telling those apart is
-- the whole of U12.
create function crm.errkind(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql;
    v_actual := 'no error';
  exception when others then
    v_actual := case
      when sqlerrm like '%custom field limit%' then 'limit message'
      else 'policy refusal'
    end;
  end;
  perform crm.record(p_label, p_expected, v_actual);
end $$;
grant execute on function crm.errkind(text,text,text) to authenticated, anon, service_role;

insert into public.organisations (id, name, slug)
values ('0000000c-5000-0000-0000-00000000c500', 'Org Limit', 'org-limit');
select id as limit_org from public.organisations where slug='org-limit' \gset

insert into public.organisation_memberships
  (organisation_id, user_id, role, status, joined_at)
values (:'limit_org'::uuid, :'padmin', 'admin', 'active', now()),
       (:'limit_org'::uuid, :'pmanager', 'manager', 'active', now());

-- Starter: custom_field_limit = 5, PER ENTITY TYPE.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'limit_org'::uuid, 'starter', 'monthly', 1, 'active', now() + interval '30 days');

set role authenticated;
set request.jwt.claims = :'padmin_c';

select crm.try('U1  admin fills the Starter allowance: five contact fields',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select %L,'contact','u'||g,'U'||g,'text' from generate_series(1,5) g$$,
    :'limit_org'), 'ok(5)');
-- THE ASSERTION THIS SECTION EXISTS FOR. A Server Action alone would not be
-- enforcement; this is the statement PostgREST would run.
select crm.try('U2  ...and the SIXTH is refused by the database',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','u6','U6','text')$$, :'limit_org'), 'denied(42501)');
-- PER ENTITY TYPE, not per organisation (CLAUDE.md § Subscription tiers:
-- "Starter gets 5 on contacts AND 5 on companies"). Without this, U2 is
-- satisfied by a limit that is simply wrong.
select crm.try('U3  POSITIVE CONTROL: a VENUE field still fits -- the limit is per entity type',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'venue','u_venue','U Venue','text')$$, :'limit_org'), 'ok(1)');
-- A MULTI-ROW INSERT IS ONE STATEMENT, and a BEFORE ROW trigger counting its
-- own table could plausibly not see the rows the same statement has already
-- inserted -- which would make an array the bypass, and PostgREST accepts a
-- JSON array. MEASURED rather than reasoned about, here and over HTTP.
select crm.try('U3a a SIX-ROW insert in ONE statement is refused too (no bulk bypass)',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select %L,'agency','bulk'||g,'Bulk'||g,'text' from generate_series(1,6) g$$,
    :'limit_org'), 'denied(42501)');
select crm.val('U3b ...and it rolled back whole -- no partial five',
  format($$select count(*)::text from public.custom_field_definitions
     where organisation_id=%L and entity_type='agency'$$, :'limit_org'), '0');

-- The soft delete, and founder decision Q12: it FREES the slot.
select crm.try('U4  admin REMOVES a field -- an UPDATE, because there is no DELETE grant',
  format($$update public.custom_field_definitions set deleted_at = now()
     where organisation_id=%L and key='u5'$$, :'limit_org'), 'ok(1)');
select crm.try('U5  a hard DELETE is still unreachable (no grant, no policy)',
  format($$delete from public.custom_field_definitions
     where organisation_id=%L and key='u5'$$, :'limit_org'), 'denied(42501)');
select crm.val('U6  ...so the removed definition is still THERE, and still readable',
  format($$select (deleted_at is not null)::text
     from public.custom_field_definitions
    where organisation_id=%L and key='u5'$$, :'limit_org'), 'true');
-- The other half of Q12, and the reason the unique constraint was deliberately
-- NOT made partial: the removed field's KEY stays reserved, so restoring it can
-- never collide with a field created in its place.
--
-- IT RUNS BEFORE U8 ON PURPOSE. The BEFORE trigger fires ahead of the unique
-- index, so with the freed slot already taken this statement would answer
-- 42501 (the limit) and never reach the constraint -- and the assertion would
-- silently stop measuring the reservation. Measured, not reasoned about: the
-- first draft had these two the other way round and U7 came back
-- denied(42501).
select crm.try('U7  the removed field''s KEY is still reserved -- 23505, not a second u5',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','u5','U5 again','text')$$, :'limit_org'), 'denied(23505)');
select crm.try('U8  Q12: the removed field FREED its slot, so a sixth now fits',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','u6','U6','text')$$, :'limit_org'), 'ok(1)');

-- RESTORE IS A SLOT-CONSUMING WRITE, which is why the limit is a trigger and
-- not a WITH CHECK: a WITH CHECK cannot see OLD and so cannot tell a restore
-- from an ordinary edit.
select crm.try('U9  restoring the removed field is refused -- the slot it freed is taken',
  format($$update public.custom_field_definitions set deleted_at = null
     where organisation_id=%L and key='u5'$$, :'limit_org'), 'denied(42501)');
-- AND THE STATE NOBODY BUILDS A FIXTURE FOR: at the limit, everything that is
-- not a count increase still works. CLAUDE.md: a downgrade "makes features
-- read-only or limited; it must never silently delete data".
select crm.try('U10 AT THE LIMIT: an ordinary label edit still applies',
  format($$update public.custom_field_definitions set label='Renamed at the limit'
     where organisation_id=%L and key='u1'$$, :'limit_org'), 'ok(1)');
select crm.try('U11 AT THE LIMIT: retyping a field still applies',
  format($$update public.custom_field_definitions set field_type='number'
     where organisation_id=%L and key='u1'$$, :'limit_org'), 'ok(1)');

-- ---- I-1: entity_type IS IMMUTABLE, SO A RE-TYPE CANNOT MULTIPLY THE LIMIT --
-- The trigger returns early on every UPDATE of a live row, which is what keeps
-- an over-limit organisation editable after a downgrade. Before 20260829012000
-- that also let an UPDATE change entity_type, and an entity_type change
-- increases the TARGET type's live count -- so five definitions on each of five
-- types could be PATCHed into one bucket, 25 live on a plan allowing 5, with no
-- INSERT anywhere. Measured on this stack before the fix: `UPDATE 5`, then
-- `contact | 10`.
--
-- The fix is IMMUTABILITY rather than a second count, so what is asserted here
-- is that the re-type is refused REGARDLESS of whether the target has room --
-- which is what tells a later reader this is not the limit talking.
--
-- State at this point: 5 live 'contact' (u1-u4, u6), 1 live 'venue' (u_venue),
-- Starter, limit 5 per type.
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.val('U21 the fixture is what these assertions assume: 5 contact, 1 venue',
  format($$select string_agg(entity_type||'='||n, ',' order by entity_type)
     from (select entity_type, count(*) n from public.custom_field_definitions
            where organisation_id=%L and deleted_at is null
            group by entity_type) s$$, :'limit_org'), 'contact=5,venue=1');
-- TARGET HAS ROOM (venue: 1 of 5). A count-based fix would ALLOW this.
select crm.try('U21a re-typing contact -> venue is refused even though venue has room',
  format($$update public.custom_field_definitions set entity_type='venue'
     where organisation_id=%L and key='u1'$$, :'limit_org'), 'denied(42501)');
-- TARGET IS FULL (contact: 5 of 5). Same operation, same answer.
select crm.try('U21b re-typing venue -> contact is refused too, target full',
  format($$update public.custom_field_definitions set entity_type='contact'
     where organisation_id=%L and key='u_venue'$$, :'limit_org'), 'denied(42501)');
-- ONE ANSWER, NOT TWO. If the TRIGGER were doing this the at-limit case would
-- carry 'custom field limit reached' and the under-limit case would not, so the
-- sentence a user sees would depend on how full the target bucket is. The
-- policy gives both the same refusal, and crm.errkind reads the message
-- because both are 42501 and a sqlstate cannot tell them apart.
select crm.errkind('U21c ...and BOTH are the POLICY''s refusal, not the limit''s',
  format($$update public.custom_field_definitions set entity_type='contact'
     where organisation_id=%L and key='u_venue'$$, :'limit_org'), 'policy refusal');
-- THE ATTACK AS WRITTEN, not one row of it.
select crm.try('U21d the whole-bucket re-type -- the reproduction -- is refused',
  format($$update public.custom_field_definitions set entity_type='contact'
     where organisation_id=%L and entity_type='venue' and deleted_at is null$$,
    :'limit_org'), 'denied(42501)');
select crm.val('U21e ...and nothing moved',
  format($$select string_agg(entity_type||'='||n, ',' order by entity_type)
     from (select entity_type, count(*) n from public.custom_field_definitions
            where organisation_id=%L and deleted_at is null
            group by entity_type) s$$, :'limit_org'), 'contact=5,venue=1');
-- POSITIVE CONTROL. Without it, "the UPDATE is refused" is satisfied by a
-- policy that refuses every UPDATE -- which would have broken the downgrade
-- rule U10/U15 exist for. Same row, same verb, only entity_type left alone.
select crm.try('U21f POSITIVE CONTROL: the same row''s label still updates',
  format($$update public.custom_field_definitions set label='Still editable after I-1'
     where organisation_id=%L and key='u_venue'$$, :'limit_org'), 'ok(1)');
-- ...and so does the soft delete, which is also an UPDATE that leaves
-- entity_type alone. U22 restores it so the counts U19/§ V assume still hold.
select crm.try('U21g POSITIVE CONTROL: removing a field is still an UPDATE that applies',
  format($$update public.custom_field_definitions set deleted_at = now()
     where organisation_id=%L and key='u_venue'$$, :'limit_org'), 'ok(1)');
select crm.try('U21h POSITIVE CONTROL: and restoring it applies (venue has room)',
  format($$update public.custom_field_definitions set deleted_at = null
     where organisation_id=%L and key='u_venue'$$, :'limit_org'), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'padmin_c';

-- ---- THE `options` ELEMENT SHAPE, AS AN AUTHENTICATED CALLER ---------------
-- 20260829010000 pins options to [{key,label}] with a CHECK backed by an
-- IMMUTABLE helper, because a CHECK may not contain a subquery. A CHECK
-- expression is evaluated as the INSERTING role, so the helper is granted to
-- `authenticated` -- and the sqlstate is what proves the grant is there: 23514
-- is the constraint refusing the value, 42501 would be the constraint being
-- unable to run at all. That distinction is the whole point of U20, and the
-- comment in 20260829010000 cited a test for it that was never written (see
-- 20260829011500). This is the test.
select crm.try('U20 malformed select options are refused -- 23514, a CHECK violation',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type, options)
    values (%L,'venue','bad_opts','Bad','single_select','[1,2,3]'::jsonb)$$,
    :'limit_org'), 'denied(23514)');
select crm.try('U20a ...and NOT 42501, so the helper really is executable by the caller',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type, options)
    values (%L,'venue','good_opts','Good','single_select',
            '[{"key":"a","label":"Alpha"}]'::jsonb)$$, :'limit_org'), 'ok(1)');
select crm.try('U20b duplicate option keys are refused too -- they resolve non-deterministically',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type, options)
    values (%L,'venue','dup_opts','Dup','single_select',
            '[{"key":"a","label":"Alpha"},{"key":"a","label":"Beta"}]'::jsonb)$$,
    :'limit_org'), 'denied(23514)');
reset role; reset request.jwt.claims;

-- ---- THE ORACLE GUARD ------------------------------------------------------
-- Both of these are 42501, so crm.try cannot separate them. crm.errkind reads
-- the MESSAGE: the guard's job is that a caller with no manage_custom_fields in
-- the TARGET organisation learns nothing about its limit state.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select crm.errkind('U12 a NON-MEMBER at the limit gets the POLICY''s refusal, not the limit''s',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','probe','Probe','text')$$, :'limit_org'), 'policy refusal');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
-- A MEMBER without manage_custom_fields is the same case: the guard keys on the
-- permission, not on membership.
select crm.errkind('U12a a member WITHOUT manage_custom_fields likewise learns nothing',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','probe2','Probe','text')$$, :'limit_org'), 'policy refusal');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
-- POSITIVE CONTROL. Without it "policy refusal" above is satisfied by a
-- trigger that never speaks to anyone.
select crm.errkind('U12b POSITIVE CONTROL: the ADMIN at the limit does get the limit''s message',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','probe3','Probe','text')$$, :'limit_org'), 'limit message');
reset role; reset request.jwt.claims;

-- ---- PRO IS UNLIMITED, FREE IS ZERO ---------------------------------------
update public.organisation_subscriptions set plan_id='pro'
 where organisation_id = :'limit_org'::uuid;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.try('U13 PRO: custom_field_limit is NULL, so the sixth, seventh and eighth fit',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    select %L,'contact','p'||g,'P'||g,'text' from generate_series(1,3) g$$,
    :'limit_org'), 'ok(3)');
reset role; reset request.jwt.claims;

-- THE DOWNGRADE. Pro at 8 contact fields moves to Starter, whose limit is 5.
-- Nothing is deleted, everything stays readable, values stay editable, and only
-- a NEW definition is refused. This is the over-limit state § 3 of the brief
-- names as the one nobody builds a fixture for.
update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'limit_org'::uuid;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.val('U14 DOWNGRADED to Starter: all EIGHT contact fields are still there',
  format($$select count(*)::text from public.custom_field_definitions
     where organisation_id=%L and entity_type='contact' and deleted_at is null$$,
    :'limit_org'), '8');
select crm.try('U15 DOWNGRADED: editing one of them still works',
  format($$update public.custom_field_definitions set label='Still editable'
     where organisation_id=%L and key='p1'$$, :'limit_org'), 'ok(1)');
select crm.try('U16 DOWNGRADED: creating a ninth is refused',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','p9','P9','text')$$, :'limit_org'), 'denied(42501)');
select crm.try('U17 DOWNGRADED: removing one still works -- a downgrade is not a lock',
  format($$update public.custom_field_definitions set deleted_at = now()
     where organisation_id=%L and key='p3'$$, :'limit_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- FREE. Its limit is 0, and CLAUDE.md gives it crm_writes = No as well -- so
-- BOTH controls refuse, and this pair records WHICH one speaks. It matters
-- because § N's N10 ("FREE: admin DEFINEs a custom field -> denied(42501)")
-- was written when the entitlement policy was the only control; as of
-- 20260829010500 the trigger now answers first, and N10 stays green for a
-- reason its own comment does not name. Recorded rather than left to be
-- rediscovered.
update public.organisation_subscriptions set plan_id='free'
 where organisation_id = :'limit_org'::uuid;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.errkind('U18 FREE: the LIMIT answers first (the trigger runs before WITH CHECK)',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','free_probe','Free','text')$$, :'limit_org'), 'limit message');
select crm.val('U19 FREE: a downgrade to Free deletes nothing -- the seven live fields remain',
  format($$select count(*)::text from public.custom_field_definitions
     where organisation_id=%L and entity_type='contact' and deleted_at is null$$,
    :'limit_org'), '7');
reset role; reset request.jwt.claims;

-- Leave the probe organisation on Starter, which is what section V writes in.
update public.organisation_subscriptions set plan_id='starter'
 where organisation_id = :'limit_org'::uuid;

-- ===========================================================================
-- V. CUSTOM FIELD VALUES: the RPC, the two nulls, and a deleted parent
-- ===========================================================================
insert into public.contacts (id, organisation_id, name)
values ('222200c5-0000-0000-0000-0000000000c5', :'limit_org'::uuid, 'Values Probe');

select id as v_text from public.custom_field_definitions
 where organisation_id = :'limit_org'::uuid and key = 'u2' \gset
select id as v_num from public.custom_field_definitions
 where organisation_id = :'limit_org'::uuid and key = 'u3' \gset
select id as v_gone from public.custom_field_definitions
 where organisation_id = :'limit_org'::uuid and key = 'p3' \gset
-- A definition with NO value row yet, so V8's INSERT reaches the policy rather
-- than the (field_id, entity_id) unique index -- RLS is evaluated first, so a
-- collision here would answer 42501 for the wrong reason.
select id as v_free from public.custom_field_definitions
 where organisation_id = :'limit_org'::uuid and key = 'u4' \gset

set role authenticated;
set request.jwt.claims = :'pmanager_c';

-- A MANAGER, WHO DOES NOT HOLD manage_custom_fields (A3). Filling in a value is
-- an ordinary CRM write on the record, gated by the ENTITY's key -- § F asserts
-- the booker/venue_manager halves of the same rule; this asserts it through the
-- RPC the panel actually calls.
select crm.val('V1  a manager (NO manage_custom_fields) saves two values through the RPC',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"hello"'::jsonb, %L,'12'::jsonb))::text$$,
    :'limit_org', :'v_text', :'v_num'), '2');
select crm.val('V1a ...and the rows are really there, with the jsonb TYPES intact',
  $$select string_agg(jsonb_typeof(value), ',' order by jsonb_typeof(value))
     from public.custom_field_values
    where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'number,string');

-- JSON null IS THE CLEAR INSTRUCTION, and it is never stored: clearing DELETES
-- the row, which is what the DELETE grant on this table is for.
select crm.val('V2  JSON null in the payload CLEARS -- and the row is gone, not nulled',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'null'::jsonb, %L,'99'::jsonb))::text$$,
    :'limit_org', :'v_text', :'v_num'), '2');
select crm.val('V2a ...leaving exactly ONE row, and no SQL NULL and no jsonb null behind',
  $$select count(*)::text from public.custom_field_values
    where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, '1');

-- A REMOVED definition must not accept new values, or "remove this field" means
-- nothing. The RPC raises rather than silently writing fewer rows -- the
-- shortfall check.
select crm.val('V3  a REMOVED definition refuses new values, and the whole call rolls back',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"revived"'::jsonb))::text$$,
    :'limit_org', :'v_gone'), 'denied(42501)');

-- ANOTHER TENANT'S DEFINITION. The composite FK on
-- (field_id, organisation_id, entity_type) is what makes this a REFERENTIAL
-- failure rather than a policy answer -- schema_invariants A8 measures it as
-- postgres; this measures it as an authenticated caller who passes every
-- policy term on the way in.
select crm.try('V4  a value against ANOTHER tenant''s definition -> 23503, not 42501',
  format($$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    values (%L,'aaaa0000-0000-0000-0000-000000000002','contact',
            '222200c5-0000-0000-0000-0000000000c5','"cross tenant"'::jsonb)$$,
    :'limit_org'), 'denied(23503)');
reset role; reset request.jwt.claims;

-- ---- THE TWO NULLS, PLANTED DIRECTLY ---------------------------------------
-- Neither is producible through the write path. Both are reachable by a direct
-- PostgREST insert, and 20260827232512 left keeping them apart to Task 5.
-- PostgREST cannot distinguish them on the way OUT -- measured:
-- `select row_to_json(t) from (select null::jsonb a, 'null'::jsonb b) t` is
-- {"a":null,"b":null} -- so what is asserted here is the property that IS
-- true: a round trip never converts one into the other, because the write path
-- writes neither.
insert into public.custom_field_values
  (id, organisation_id, field_id, entity_type, entity_id, value)
values ('bbbb00c5-0000-0000-0000-0000000000a1', :'limit_org'::uuid,
        :'v_text'::uuid, 'contact', '222200c5-0000-0000-0000-0000000000c5', null),
       ('bbbb00c5-0000-0000-0000-0000000000a2', :'limit_org'::uuid,
        (select id from public.custom_field_definitions
          where organisation_id=:'limit_org'::uuid and key='u1'),
        'contact', '222200c5-0000-0000-0000-0000000000c5', 'null'::jsonb);

set role authenticated;
set request.jwt.claims = :'pmanager_c';
-- Save an UNRELATED field. Neither planted row is named in the payload, so
-- neither may change.
select crm.val('V5  a save of an unrelated field leaves both planted rows alone',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'42'::jsonb))::text$$,
    :'limit_org', :'v_num'), '1');
reset role; reset request.jwt.claims;
select crm.val('V5a SQL NULL is still SQL NULL after the round trip',
  $$select (value is null)::text from public.custom_field_values
     where id='bbbb00c5-0000-0000-0000-0000000000a1'$$, 'true');
select crm.val('V5b jsonb ''null'' is still jsonb ''null'' -- NOT converted to SQL NULL',
  $$select (value is not null and jsonb_typeof(value) = 'null')::text
     from public.custom_field_values
     where id='bbbb00c5-0000-0000-0000-0000000000a2'$$, 'true');

-- ---- I-2: A KEY THE PAYLOAD DOES NOT CARRY IS LEFT ALONE -------------------
-- The DATABASE half of the `skip` outcome. lib/crm/custom-fields.ts's
-- buildCustomFieldPayload() omits a field the form did not carry, and that is
-- only a fix if the RPC then leaves it alone -- the delete touches only ids it
-- is given a JSON null for, and the upsert only ids it is given a value for.
--
-- Before fix round 1 an absent group marker produced `value: null`, which the
-- payload carried as the CLEAR verb, so a form rendered without a field DELETED
-- that field's value. Three comments and two unit-test titles claimed the
-- opposite. This asserts the RPC's side of the corrected contract against a
-- REAL stored value rather than the planted nulls V5 uses.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('V5c set two real values, both stored',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"keep me"'::jsonb, %L,'7'::jsonb))::text$$,
    :'limit_org', :'v_text', :'v_num'), '2');
-- The save a partial form produces: ONE key, and the other field's id is not in
-- the payload at all. Not `{"<id>": null}`, which is the CLEAR verb.
select crm.val('V5d ...then a save carrying ONLY the other key',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'8'::jsonb))::text$$,
    :'limit_org', :'v_num'), '1');
reset role; reset request.jwt.claims;
select crm.val('V5e ...leaves the omitted field''s value EXACTLY as it was',
  format($$select value::text from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5' and field_id=%L$$,
    :'v_text'), '"keep me"');
-- The negative control, so V5e is not satisfied by an RPC that ignores its
-- payload: the SAME field id, sent as an explicit JSON null, IS cleared.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('V5f NEGATIVE CONTROL: the same id sent as JSON null IS cleared',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'null'::jsonb))::text$$,
    :'limit_org', :'v_text'), '1');
reset role; reset request.jwt.claims;
select crm.val('V5g ...and that row really is gone',
  format($$select count(*)::text from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5' and field_id=%L$$,
    :'v_text'), '0');

-- ---- A DELETED PARENT ------------------------------------------------------
-- 20260829011000 puts private.entity_is_live() into the three WRITE policies
-- and deliberately not into the SELECT one: the restore path needs a deleted
-- record's page to render, values included.
update public.contacts set deleted_at = now()
 where id = '222200c5-0000-0000-0000-0000000000c5';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('V6  DELETED CONTACT: its custom field values are still READABLE',
  $$select (count(*) > 0)::text from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'true');
select crm.val('V7  DELETED CONTACT: the RPC refuses -- the DB backs the parent end',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"while deleted"'::jsonb))::text$$,
    :'limit_org', :'v_num'), 'denied(42501)');
select crm.try('V8  DELETED CONTACT: a direct INSERT is a LOUD 403, not a silent no-op',
  format($$insert into public.custom_field_values
      (organisation_id, field_id, entity_type, entity_id, value)
    values (%L,%L,'contact','222200c5-0000-0000-0000-0000000000c5','"planted"'::jsonb)$$,
    :'limit_org', :'v_free'), 'denied(42501)');
-- An UPDATE refused by a USING clause matches NOTHING and answers 204 over
-- HTTP -- the entire reason lib/crm/write.ts exists. Asserted as the DIFFERENT
-- mechanism it is.
select crm.try('V9  DELETED CONTACT: an UPDATE matches nothing -- ok(0), a silent 204',
  $$update public.custom_field_values set value='"pwned"'::jsonb
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'ok(0)');
select crm.try('V10 DELETED CONTACT: a DELETE likewise matches nothing',
  $$delete from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'ok(0)');
reset role; reset request.jwt.claims;

update public.contacts set deleted_at = null
 where id = '222200c5-0000-0000-0000-0000000000c5';
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('V11 RESTORED: the same save applies again',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"after restore"'::jsonb))::text$$,
    :'limit_org', :'v_text'), '1');
reset role; reset request.jwt.claims;

-- ---- THE WORKSPACE TERM ON THE RPC -----------------------------------------
-- RLS answers "may this caller write this row"; p_organisation_id answers "is
-- this row the one this URL is about". For pmulti -- an admin of BOTH alpha and
-- beta -- those diverge, which is the case 20260828234500 exists for.
set role authenticated;
set request.jwt.claims = :'pmulti_c';
select crm.val('V12 the RIGHT rows with the WRONG organisation id -> refused',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"wrong workspace"'::jsonb))::text$$,
    :'beta_org', :'v_text'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---- A READ_ONLY CALLER ----------------------------------------------------
-- pro holds view_crm and no manage key. The empty state must not lie: they SEE
-- the definitions and the values and cannot write either.
insert into public.organisation_memberships
  (organisation_id, user_id, role, status, joined_at)
values (:'limit_org'::uuid, :'pro', 'read_only', 'active', now());
-- The probe contact becomes THEIRS, so V14 measures the read path rather than
-- record scope refusing it. V14a is the other half.
update public.contacts set owner_user_id = :'pro'
 where id = '222200c5-0000-0000-0000-0000000000c5';
set role authenticated;
set request.jwt.claims = :'pro_c';
select crm.val('V13 read_only SEES the workspace''s definitions -- the empty state must not lie',
  format($$select (count(*) >= 7)::text from public.custom_field_definitions
     where organisation_id=%L$$, :'limit_org'), 'true');
-- RECORD SCOPE STILL APPLIES TO THE VALUES, and the first draft of this pair
-- got it wrong in the reassuring direction: it asserted `true` for a
-- record-scoped caller against a contact with NO owner, and the suite returned
-- `false`. That is the SELECT policy working --
-- custom_field_values_select_via_entity resolves through
-- private.entity_is_visible(), which carries the record-scope term -- so the
-- honest statement is that a read_only user sees the values of records IN
-- THEIR SCOPE and no others. The definitions (V13) are not record-scoped and
-- must not be: withholding them would leave a user looking at values with no
-- field names.
select crm.val('V14 read_only SEES the values on a record THEY OWN',
  $$select (count(*) > 0)::text from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'true');
select crm.val('V14a ...and NOT on one outside their scope -- record scope survives the panel',
  $$select count(*)::text from public.custom_field_values
     where entity_id='22220000-0000-0000-0000-000000000002'$$, '0');
select crm.val('V15 ...and the RPC refuses them',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"read only"'::jsonb))::text$$,
    :'limit_org', :'v_text'), 'denied(42501)');
select crm.try('V16 ...and so does a direct definition INSERT',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','ro_probe','RO','text')$$, :'limit_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---- A SUSPENDED WORKSPACE (founder decision Q6) ---------------------------
-- Read-only, not closed. The reads above stay open; every write closes, and the
-- MECHANISM differs per verb -- which is the thing lib/crm/write.ts has to be
-- able to tell apart.
update public.organisations set deleted_at = now() where id = :'limit_org'::uuid;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('V17 SUSPENDED: values are still READABLE',
  $$select (count(*) > 0)::text from public.custom_field_values
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'true');
select crm.val('V18 SUSPENDED: the RPC refuses -- 42501, not a silent success',
  format($$select public.set_custom_field_values(
      %L,'contact','222200c5-0000-0000-0000-0000000000c5',
      jsonb_build_object(%L,'"suspended"'::jsonb))::text$$,
    :'limit_org', :'v_text'), 'denied(42501)');
select crm.try('V19 SUSPENDED: a direct value UPDATE matches nothing -- ok(0), the 204 shape',
  $$update public.custom_field_values set value='"suspended"'::jsonb
     where entity_id='222200c5-0000-0000-0000-0000000000c5'$$, 'ok(0)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.try('V20 SUSPENDED: a definition INSERT is a LOUD 42501',
  format($$insert into public.custom_field_definitions
      (organisation_id, entity_type, key, label, field_type)
    values (%L,'contact','susp','Susp','text')$$, :'limit_org'), 'denied(42501)');
select crm.try('V21 SUSPENDED: removing a field matches nothing -- ok(0)',
  format($$update public.custom_field_definitions set deleted_at = now()
     where organisation_id=%L and key='u2'$$, :'limit_org'), 'ok(0)');
reset role; reset request.jwt.claims;
update public.organisations set deleted_at = null where id = :'limit_org'::uuid;

-- POSITIVE CONTROL for the whole suspension block: the same statements against
-- the reinstated workspace. Without it, "refused while suspended" is satisfied
-- by a policy that refuses always.
set role authenticated;
set request.jwt.claims = :'padmin_c';
select crm.try('V22 REINSTATED: removing a field applies again',
  format($$update public.custom_field_definitions set deleted_at = now()
     where organisation_id=%L and key='u2'$$, :'limit_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 2 CRM: RLS / PERMISSIONS / RECORD SCOPE =========='

select seq,
       case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from crm.results order by seq;

select count(*) filter (where pass)         as passed,
       count(*) filter (where not pass)     as failed,
       count(*)                             as total
from crm.results;
