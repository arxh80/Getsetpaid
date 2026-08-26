-- ===========================================================================
-- Foundation-phase RLS / tenant-isolation test suite.
--
-- Covers the permission engine and policies created by
-- migrations/20260826154304_permission_engine_and_rls.sql (Task 4).
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   (that script creates the auth.users rows this file needs and passes their
--    UUIDs in as psql variables; it requires a freshly reset local stack:
--    `supabase db reset --local` first, because the fixtures below assume an
--    empty public schema.)
--
-- HOW THE IMPERSONATION WORKS
--   PostgREST authenticates a request by switching to the `authenticated`
--   Postgres role and setting the `request.jwt.claims` GUC, which is what
--   auth.uid() reads. This suite does exactly the same two things, so the
--   policies are exercised through the same mechanism a real API request uses
--   -- not through a mocked-out uid.
--
-- WHY THE ASSERTION HELPERS EXIST
--   A denied statement raises, which would abort the run and lose everything
--   after it. harness.try/harness.val catch inside plpgsql (implicit
--   savepoint) and record `denied(<sqlstate>)` as an ordinary result, so a
--   denial is an assertable value rather than a crash. Output is a PASS/FAIL
--   table -- nothing here needs eyeballing.
--
--   Note the deliberate distinction in the expectations below:
--     denied(42501) = the write was REJECTED (no grant, or policy violation)
--     ok(0)         = the write was accepted but matched no rows, because RLS
--                     filtered the target row out first. Both are secure
--                     outcomes; they are different mechanisms and the tests
--                     assert which one is expected.
--
-- Positive controls (F3, G3, G5, H1, H9, I3, B5, A6 ...) are included on
-- purpose: without them a suite of "expect 0 rows" assertions passes
-- perfectly against a database where nothing works at all.
--
-- psql vars required: alice bob carol dave super (uuids) and
--                     alice_c bob_c carol_c dave_c super_c (jwt claim json)
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists harness cascade;
create schema harness;

create table harness.results (
  seq    serial primary key,
  label  text,
  expected text,
  actual   text,
  pass   boolean
);

-- SECURITY DEFINER: the assertions are recorded while the session is switched
-- to `authenticated`/`anon`, which have no privileges on harness.results.
create function harness.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into harness.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- Runs a DML/DDL statement as the CURRENT (impersonated) role and records
-- either ok(<rows affected>) or denied(<sqlstate>).
create function harness.try(p_label text, p_sql text, p_expected text)
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
  perform harness.record(p_label, p_expected, v_actual);
end $$;

-- Runs a scalar SELECT as the CURRENT role and records its value.
create function harness.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform harness.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema harness to authenticated, anon, service_role;
grant execute on function harness.record(text,text,text) to authenticated, anon, service_role;
grant execute on function harness.try(text,text,text)   to authenticated, anon, service_role;
grant execute on function harness.val(text,text,text)   to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.profiles (id, full_name) values
  (:'alice','Alice'), (:'bob','Bob'), (:'carol','Carol'),
  (:'dave','Dave'), (:'super','Superuser');

-- alice creates org A, bob creates org B -- both through the sanctioned path,
-- impersonated, so create_organisation() is itself under test.
set role authenticated;
set request.jwt.claims = :'alice_c';
select public.create_organisation('Org A','org-a') as org_a;
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'bob_c';
select public.create_organisation('Org B','org-b') as org_b;
reset role; reset request.jwt.claims;

-- alice (owner) adds carol active + dave invited. Impersonated: this is the
-- positive control for the manage_members write path.
set role authenticated;
set request.jwt.claims = :'alice_c';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
select id, :'carol', 'standard_user', 'active', now() from public.organisations where slug='org-a';
insert into public.organisation_memberships (organisation_id, user_id, role, status)
select id, :'dave', 'standard_user', 'invited' from public.organisations where slug='org-a';
reset role; reset request.jwt.claims;

-- DBA-only action: grant platform_superuser. Deliberately placed INSIDE org-a
-- so that alice can see the row -- otherwise the anti-escalation guards below
-- would be masked by RLS row filtering rather than actually exercised.
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
select id, :'super', 'platform_superuser', 'active', now()
  from public.organisations where slug='org-a';

select id as org_a_id from public.organisations where slug='org-a' \gset
select id as org_b_id from public.organisations where slug='org-b' \gset

-- Silence the per-assertion `select harness.*(...)` result rows; the only
-- output that matters is the results table at the bottom.
\o /dev/null

-- ===========================================================================
-- A. Tenant isolation: reads
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('A1  alice sees exactly 1 organisation (her own)',
  $$select count(*)::text from public.organisations$$, '1');

select harness.val('A2  alice cannot see org B by slug',
  $$select count(*)::text from public.organisations where slug='org-b'$$, '0');

select harness.val('A3  alice cannot see org B by literal uuid',
  format($$select count(*)::text from public.organisations where id=%L$$, :'org_b_id'), '0');

select harness.val('A4  alice sees only org A memberships (3 rows, not bob''s)',
  $$select count(*)::text from public.organisation_memberships$$, '4');

select harness.val('A5  no org B membership row leaks to alice',
  format($$select count(*)::text from public.organisation_memberships where organisation_id=%L$$, :'org_b_id'), '0');

select harness.val('A6  alice sees only own + fellow-ACTIVE-member profiles',
  $$select string_agg(full_name,',' order by full_name) from public.profiles$$, 'Alice,Carol,Superuser');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- B. Permission engine: status and cross-tenant scoping
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'dave_c';

select harness.val('B1  INVITED (not active) dave: has_permission(org A) is false',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_a_id'), 'false');

select harness.val('B2  INVITED dave: has_permission for the org-update key is false',
  format($$select public.has_permission(%L,'manage_organisation')::text$$, :'org_a_id'), 'false');

select harness.val('B3  INVITED dave: has_platform_permission is false',
  $$select public.has_platform_permission('view_audit_log')::text$$, 'false');

select harness.val('B4  INVITED dave sees 0 organisations',
  $$select count(*)::text from public.organisations$$, '0');

select harness.val('B5  INVITED dave still sees his OWN membership row',
  $$select count(*)::text from public.organisation_memberships$$, '1');

select harness.try('B6  INVITED dave cannot INSERT a membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'admin','active')$$, :'org_a_id', :'bob'), 'denied(42501)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('B7  NULL org id never means platform level (fail-closed)',
  $$select public.has_permission(null,'manage_members')::text$$, 'false');

select harness.val('B8  alice''s org A permission does NOT satisfy org B',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_b_id'), 'false');

select harness.val('B9  alice (org owner) is not a platform superuser',
  $$select public.has_platform_permission('view_audit_log')::text$$, 'false');

select harness.val('B10 alice cannot reach superuser billing permission',
  $$select public.has_platform_permission('manage_billing')::text$$, 'false');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- C. manage_members enforcement
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'carol_c';

select harness.try('C1  ACTIVE non-admin (standard_user) cannot INSERT a membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'admin','active')$$, :'org_a_id', :'bob'), 'denied(42501)');

select harness.try('C2  ACTIVE non-admin cannot promote herself to admin',
  format($$update public.organisation_memberships set role='admin' where user_id=%L$$, :'carol'), 'ok(0)');

select harness.try('C3  ACTIVE non-admin cannot DELETE a membership',
  $$delete from public.organisation_memberships$$, 'ok(0)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- D. platform_superuser self-escalation guard (every write path)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('D1  owner cannot UPDATE own row to platform_superuser',
  format($$update public.organisation_memberships set role='platform_superuser' where user_id=%L$$, :'alice'),
  'denied(42501)');

select harness.try('D2  owner cannot INSERT a new platform_superuser membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'platform_superuser','active')$$, :'org_a_id', :'bob'),
  'denied(42501)');

select harness.try('D3  owner cannot DELETE the platform_superuser row in her own org',
  $$delete from public.organisation_memberships where role='platform_superuser'$$, 'ok(0)');

select harness.try('D4  owner cannot DEMOTE the platform_superuser row in her own org',
  $$update public.organisation_memberships set role='admin' where role='platform_superuser'$$, 'ok(0)');

select harness.try('D5  owner cannot hop her membership into org B',
  format($$update public.organisation_memberships set organisation_id=%L where user_id=%L$$, :'org_b_id', :'alice'),
  'denied(42501)');

select harness.try('D6  owner cannot forge invited_by attribution',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status,invited_by)
           values (%L,%L,'admin','active',%L)$$, :'org_a_id', :'bob', :'super'),
  'denied(42501)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- E. audit_events: superuser-only read, append-only, no direct write path
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('E1  org OWNER sees 0 audit_events',
  $$select count(*)::text from public.audit_events$$, '0');

select harness.try('E2  authenticated cannot EXECUTE log_audit_event',
  $$select public.log_audit_event('forged.action','organisation')$$, 'denied(42501)');

select harness.try('E3  authenticated cannot INSERT audit_events',
  format($$insert into public.audit_events (organisation_id,actor_user_id,action,target_type,correlation_id)
           values (%L,%L,'forged','organisation',gen_random_uuid())$$, :'org_a_id', :'alice'),
  'denied(42501)');

select harness.try('E4  authenticated cannot DELETE audit_events',
  $$delete from public.audit_events$$, 'denied(42501)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';

select harness.val('E5  platform superuser CAN read audit_events across all orgs',
  $$select count(distinct organisation_id)::text from public.audit_events where action='organisation.created'$$, '2');

select harness.try('E6  even the superuser cannot UPDATE audit_events (append-only)',
  $$update public.audit_events set action='tampered'$$, 'denied(42501)');

select harness.try('E7  even the superuser cannot DELETE audit_events',
  $$delete from public.audit_events$$, 'denied(42501)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- F. organisations: no client INSERT, gated UPDATE  (regression: design note f)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('F1  no client INSERT into organisations (function-only)',
  $$insert into public.organisations (name,slug) values ('Sneaky','sneaky')$$, 'denied(42501)');

select harness.try('F2  alice cannot UPDATE org B',
  format($$update public.organisations set name='Pwned' where id=%L$$, :'org_b_id'), 'ok(0)');

select harness.try('F3  owner CAN rename her own org (positive control)',
  $$update public.organisations set name='Org A renamed' where slug='org-a'$$, 'ok(1)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'carol_c';

select harness.try('F4  REGRESSION: standard_user cannot rename the org',
  $$update public.organisations set name='Carol Owns This' where slug='org-a'$$, 'ok(0)');

select harness.try('F5  REGRESSION: standard_user cannot SOFT-DELETE the tenant',
  $$update public.organisations set deleted_at=now() where slug='org-a'$$, 'ok(0)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- G. organisation_subscriptions: entitlement self-grant  (design note g)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('G1  REGRESSION: owner cannot self-grant a Pro subscription',
  format($$insert into public.organisation_subscriptions
           (organisation_id,plan_id,billing_cycle,seat_count,status,current_period_end)
           values (%L,'pro','monthly',1,'active', now()+interval '1 year')$$, :'org_a_id'),
  'denied(42501)');

select harness.try('G2  owner cannot write org B''s subscription either',
  format($$insert into public.organisation_subscriptions
           (organisation_id,plan_id,billing_cycle,seat_count,status,current_period_end)
           values (%L,'pro','monthly',1,'active', now()+interval '1 year')$$, :'org_b_id'),
  'denied(42501)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';

select harness.try('G3  platform superuser CAN write a subscription (positive control)',
  format($$insert into public.organisation_subscriptions
           (organisation_id,plan_id,billing_cycle,seat_count,status,current_period_end)
           values (%L,'pro','monthly',1,'active', now()+interval '1 year')$$, :'org_a_id'),
  'ok(1)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'bob_c';

select harness.val('G4  org B owner cannot READ org A''s subscription',
  $$select count(*)::text from public.organisation_subscriptions$$, '0');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'carol_c';

select harness.val('G5  active member CAN read own org subscription (positive control)',
  $$select plan_id from public.organisation_subscriptions$$, 'pro');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- H. Reference data + anon + unauthenticated + service_role
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('H1  authenticated CAN read roles (positive control)',
  $$select count(*)::text from public.roles$$, '10');

select harness.try('H2  authenticated cannot write role_permissions',
  $$insert into public.role_permissions (role_key,permission_key) values ('standard_user','view_audit_log')$$,
  'denied(42501)');

select harness.try('H3  authenticated cannot write subscription_plans',
  $$update public.subscription_plans set price_monthly_minor=0$$, 'denied(42501)');

reset role; reset request.jwt.claims;

-- authenticated Postgres role but NO jwt claims at all (auth.uid() is null)
set role authenticated;
select harness.val('H4  authenticated with no JWT: 0 orgs',
  $$select count(*)::text from public.organisations$$, '0');
select harness.val('H5  authenticated with no JWT: 0 memberships',
  $$select count(*)::text from public.organisation_memberships$$, '0');
select harness.val('H6  authenticated with no JWT: 0 profiles',
  $$select count(*)::text from public.profiles$$, '0');
select harness.val('H7  authenticated with no JWT: 0 audit_events',
  $$select count(*)::text from public.audit_events$$, '0');
select harness.try('H8  authenticated with no JWT cannot create an org',
  $$select public.create_organisation('Ghost','ghost')$$, 'denied(28000)');
reset role;

set role anon;
select harness.val('H9  anon CAN read subscription_plans (pricing page)',
  $$select count(*)::text from public.subscription_plans$$, '3');
select harness.val('H10 anon cannot read organisations',
  $$select count(*)::text from public.organisations$$, 'denied(42501)');
select harness.val('H11 anon cannot read organisation_memberships',
  $$select count(*)::text from public.organisation_memberships$$, 'denied(42501)');
select harness.val('H12 anon cannot read profiles',
  $$select count(*)::text from public.profiles$$, 'denied(42501)');
select harness.val('H13 anon cannot read audit_events',
  $$select count(*)::text from public.audit_events$$, 'denied(42501)');
select harness.try('H14 anon cannot call create_organisation',
  $$select public.create_organisation('Anon Org','anon-org')$$, 'denied(42501)');
select harness.val('H15 anon cannot call has_permission',
  $$select public.has_permission(null,'x')::text$$, 'denied(42501)');
reset role;

set role service_role;
select harness.val('H16 service_role has no table privileges on organisations',
  $$select count(*)::text from public.organisations$$, 'denied(42501)');
select harness.val('H17 service_role has no table privileges on audit_events',
  $$select count(*)::text from public.audit_events$$, 'denied(42501)');
reset role;

-- ===========================================================================
-- I. profiles
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('I1  alice cannot hand her profile row to bob (WITH CHECK)',
  format($$update public.profiles set id=%L where id=%L$$, :'bob', :'alice'), 'denied(42501)');

select harness.try('I2  alice cannot edit bob''s profile',
  format($$update public.profiles set full_name='Owned' where id=%L$$, :'bob'), 'ok(0)');

select harness.try('I3  alice CAN edit her own profile (positive control)',
  format($$update public.profiles set full_name='Alice A' where id=%L$$, :'alice'), 'ok(1)');

select harness.try('I4  no client INSERT into profiles',
  $$insert into public.profiles (id,full_name) values (gen_random_uuid(),'Ghost')$$, 'denied(42501)');

select harness.try('I5  no client DELETE from profiles',
  format($$delete from public.profiles where id=%L$$, :'alice'), 'denied(42501)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '================= RESULTS ================='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from harness.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from harness.results;
