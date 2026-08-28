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
-- P. A SOFT-DELETED (SUSPENDED) ORGANISATION (IMP-4)
-- ===========================================================================
-- CLAUDE.md § Superuser dashboard ships suspend/reinstate as soft delete.
-- Before fix round 1, organisations.deleted_at was invisible to the permission
-- engine, so a suspended tenant kept full CRM read AND write. Restores the
-- organisation at the end so the rest of the fixture is untouched.
update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('P1  SUSPENDED: the CRM is unreadable',
  $$select count(*)::text from public.contacts$$, '0');
select crm.try('P2  SUSPENDED: the CRM is unwritable',
  format($$insert into public.contacts (organisation_id, name)
    values (%L,'suspended')$$, :'alpha_org'), 'denied(42501)');
select crm.val('P3  SUSPENDED: has_permission agrees',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select crm.val('P4  SUSPENDED: so does the set form (the two must not drift)',
  format($$select exists (select 1 from private.permitted_organisations('view_crm') x
                          where x = %L)::text$$, :'alpha_org'), 'false');
-- The deliberate exception: is_active_member is UNCHANGED, so the workspace
-- itself is still visible and the app can render a suspension notice rather
-- than a blank screen or an error.
select crm.val('P5  SUSPENDED: the organisation row is still visible (suspension notice)',
  $$select count(*)::text from public.organisations where slug='org-alpha'$$, '1');
select crm.val('P6  SUSPENDED: memberships still readable (workspace switcher)',
  $$select (count(*) > 0)::text from public.organisation_memberships$$, 'true');
reset role; reset request.jwt.claims;

-- Reinstatement is now a privileged action with no client path. Fail-closed and
-- correct per CLAUDE.md (suspend/reinstate is a superuser function), but Phase 7
-- must ship the superuser reinstate path in the same change as the suspend
-- button or it ships a one-way door. Routed in FOLLOW-UPS.md.
set role authenticated;
set request.jwt.claims = :'powner_c';
select crm.try('P7  SUSPENDED: even the Owner cannot un-suspend (Phase 7 owns this)',
  $$update public.organisations set deleted_at=null where slug='org-alpha'$$, 'ok(0)');
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = null where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select crm.val('P8  REINSTATED: the CRM comes back',
  $$select (count(*) > 0)::text from public.contacts$$, 'true');
reset role; reset request.jwt.claims;

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
