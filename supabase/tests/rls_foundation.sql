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
-- CAST OF CHARACTERS
--   alice  owner of org A          bob   owner of org B (the other tenant)
--   carol  ACTIVE standard_user in org A -- lowest-privilege real member
--   dave   INVITED-but-not-active in org A -- the "not yet consented" case
--   super  platform superuser via a public.platform_admins row, and a member
--          of NO organisation at all. That is the point: platform status
--          carries no tenant with it, so the superuser has no ordinary
--          member-level read of anyone's data (CLAUDE.md § Superuser
--          dashboard, "no direct tenant-data access outside impersonation").
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
-- run-rls-tests.sh creates these auth.users rows through the Admin API, and
-- as of Task 6 an AFTER INSERT trigger on auth.users (private.handle_new_user)
-- already provisioned a public.profiles row for each of them -- with a NULL
-- full_name, since the script sends no user_metadata. So this is now an UPSERT
-- that names them, not the INSERT that creates them. Do not revert it to a
-- plain INSERT: \set ON_ERROR_STOP on means the primary-key conflict would
-- abort the entire suite.
insert into public.profiles (id, full_name) values
  (:'alice','Alice'), (:'bob','Bob'), (:'carol','Carol'),
  (:'dave','Dave'), (:'super','Superuser')
on conflict (id) do update set full_name = excluded.full_name;

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

-- alice (owner) invites carol and dave. Impersonated: this is the positive
-- control for the manage_members write path. Note both go in as 'invited' --
-- the INSERT policy now refuses anything else, so an admin cannot mint an
-- already-active membership for someone who never consented.
set role authenticated;
set request.jwt.claims = :'alice_c';
insert into public.organisation_memberships (organisation_id, user_id, role, status)
select id, :'carol', 'standard_user', 'invited' from public.organisations where slug='org-a';
insert into public.organisation_memberships (organisation_id, user_id, role, status)
select id, :'dave', 'standard_user', 'invited' from public.organisations where slug='org-a';
reset role; reset request.jwt.claims;

-- Carol ACCEPTS her invite -- through the REAL public.accept_invite() RPC
-- (Task 6), impersonated as carol, exactly like create_organisation above.
-- This used to be a DBA UPDATE standing in for a function that did not exist
-- yet; now that it does, the fixture goes through the sanctioned path and the
-- function is itself under test here as well as in section C17-C24.
set role authenticated;
set request.jwt.claims = :'carol_c';
select public.accept_invite(id)
  from public.organisation_memberships
 where user_id = (select auth.uid());
reset role; reset request.jwt.claims;
-- dave stays 'invited' on purpose -- he is the invited-but-not-active subject.

-- DBA-only action: grant platform superuser. Note this is an allowlist row with
-- NO organisation attached -- the superuser is not a member of org A, org B or
-- anything else, and therefore has no ordinary member read of any tenant.
insert into public.platform_admins (user_id) values (:'super');

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

select harness.val('A4  alice sees only org A memberships (alice+carol+dave, not bob''s)',
  $$select count(*)::text from public.organisation_memberships$$, '3');

select harness.val('A5  no org B membership row leaks to alice',
  format($$select count(*)::text from public.organisation_memberships where organisation_id=%L$$, :'org_b_id'), '0');

-- Carol is active in org A so her profile is visible; Dave is only INVITED, so
-- his is not; Bob is another tenant; Superuser holds no membership anywhere.
select harness.val('A6  alice sees only own + fellow-ACTIVE-member profiles',
  $$select string_agg(full_name,',' order by full_name) from public.profiles$$, 'Alice,Carol');

select harness.val('A7  create_organisation made alice an ACTIVE owner (positive control)',
  $$select status||'/'||role from public.organisation_memberships
     where user_id = (select auth.uid())$$, 'active/owner');

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
  $$select private.has_platform_permission('view_audit_log')::text$$, 'false');

select harness.val('B4  INVITED dave sees 0 organisations',
  $$select count(*)::text from public.organisations$$, '0');

select harness.val('B5  INVITED dave still sees his OWN membership row',
  $$select count(*)::text from public.organisation_memberships$$, '1');

-- status='invited' on purpose: an otherwise-VALID invite, so the only thing
-- that can reject it is dave's lack of manage_members -- which is what this
-- test is about. With status='active' it would pass for the wrong reason.
select harness.try('B6  INVITED dave cannot INSERT a membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'admin','invited')$$, :'org_a_id', :'bob'), 'denied(42501)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('B7  NULL org id never means platform level (fail-closed)',
  $$select public.has_permission(null,'manage_members')::text$$, 'false');

select harness.val('B8  alice''s org A permission does NOT satisfy org B',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_b_id'), 'false');

select harness.val('B9  alice (org owner) is not a platform superuser',
  $$select private.has_platform_permission('view_audit_log')::text$$, 'false');

select harness.val('B10 alice cannot reach superuser billing permission',
  $$select private.has_platform_permission('manage_billing')::text$$, 'false');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- C. manage_members enforcement
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'carol_c';

-- Again an otherwise-valid invite, so the manage_members check is the only
-- thing that can reject it.
select harness.try('C1  ACTIVE non-admin (standard_user) cannot INSERT a membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'admin','invited')$$, :'org_a_id', :'bob'), 'denied(42501)');

select harness.try('C2  ACTIVE non-admin cannot promote herself to admin',
  format($$update public.organisation_memberships set role='admin' where user_id=%L$$, :'carol'), 'ok(0)');

select harness.try('C3  ACTIVE non-admin cannot DELETE a membership',
  $$delete from public.organisation_memberships$$, 'ok(0)');

reset role; reset request.jwt.claims;

-- An admin's INSERT is an INVITE, never a completed membership. Without this,
-- holding manage_members means adding any user id to your org as an active
-- member with no consent from them -- and active membership is what every read
-- policy keys off, so the victim is immediately exposed to that org's data.
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('C4  admin cannot mint an already-ACTIVE membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'standard_user','active')$$, :'org_a_id', :'bob'),
  'denied(42501)');

select harness.try('C5  admin cannot back-date joined_at on an invite',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status,joined_at)
           values (%L,%L,'standard_user','invited', now())$$, :'org_a_id', :'bob'),
  'denied(42501)');

select harness.try('C6  admin cannot INSERT a pre-revoked membership either',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'standard_user','revoked')$$, :'org_a_id', :'bob'),
  'denied(42501)');

select harness.try('C7  admin CAN issue a plain invite (positive control)',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'standard_user','invited')$$, :'org_a_id', :'bob'),
  'ok(1)');

-- Undo C7 so later counts stay stable.
select harness.try('C7b cleanup: remove the invite issued by C7',
  format($$delete from public.organisation_memberships where user_id=%L$$, :'bob'), 'ok(1)');

-- The invitee cannot self-accept through a plain UPDATE. Task 6 has now built
-- the sanctioned path (public.accept_invite, section J), and this assertion is
-- exactly what must NOT change as a result: the acceptance function is an
-- addition, not a loosening. If this ever starts returning ok(1), the Task 4
-- UPDATE policy has been weakened and the consent invariant is gone.
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'dave_c';

select harness.try('C8  invitee still cannot self-accept via a plain UPDATE (see J)',
  $$update public.organisation_memberships set status='active', joined_at=now()
     where user_id = (select auth.uid())$$, 'ok(0)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- C9-C16. THE CONSENT INVARIANT ACROSS THE UPDATE PATH.
--
-- Guarding only the INSERT was not enough: an admin could INSERT the row as
-- 'invited' and then UPDATE it straight to 'active' -- two statements, same
-- consent-free active membership. These assert the transition guard closes
-- that WITHOUT breaking the legitimate reasons the UPDATE policy exists.
--
-- dave is 'invited' throughout; carol is 'active'.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

-- (a) the hole itself, exactly as reported
select harness.try('C9  REGRESSION: admin cannot flip an INVITED row to active',
  format($$update public.organisation_memberships
              set status='active', joined_at=now() where user_id=%L$$, :'dave'),
  'denied(42501)');

select harness.val('C9b ...and dave really is still invited afterwards',
  format($$select status from public.organisation_memberships where user_id=%L$$, :'dave'),
  'invited');

-- the full two-statement exploit chain, end to end
select harness.try('C10 exploit chain step 1: INSERT bob as a legitimate invite',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'standard_user','invited')$$, :'org_a_id', :'bob'), 'ok(1)');

select harness.try('C10b exploit chain step 2: UPDATE it to active -> MUST FAIL',
  format($$update public.organisation_memberships
              set status='active', joined_at=now() where user_id=%L$$, :'bob'),
  'denied(42501)');

-- (a) continued: revoked -> active is a silent reinstatement, also blocked
select harness.try('C11 admin CAN revoke a pending invite (invited -> revoked)',
  format($$update public.organisation_memberships set status='revoked' where user_id=%L$$, :'bob'),
  'ok(1)');

select harness.try('C12 REGRESSION: admin cannot reinstate revoked -> active',
  format($$update public.organisation_memberships
              set status='active', joined_at=now() where user_id=%L$$, :'bob'),
  'denied(42501)');

select harness.try('C12b cleanup: remove bob''s row',
  format($$delete from public.organisation_memberships where user_id=%L$$, :'bob'), 'ok(1)');

-- (b) NO REGRESSION on legitimate admin actions: role management on a member
-- who really did join must still work.
select harness.try('C13 admin CAN change an ACTIVE member''s role (active -> active)',
  format($$update public.organisation_memberships set role='manager' where user_id=%L$$, :'carol'),
  'ok(1)');

select harness.val('C13b ...and the role really changed',
  format($$select role from public.organisation_memberships where user_id=%L$$, :'carol'),
  'manager');

select harness.try('C14 admin CAN edit a PENDING invite''s role (invited -> invited)',
  format($$update public.organisation_memberships set role='booker' where user_id=%L$$, :'dave'),
  'ok(1)');

-- (c) revoking an active member must still work
select harness.try('C15 admin CAN revoke an ACTIVE member (active -> revoked)',
  format($$update public.organisation_memberships set status='revoked' where user_id=%L$$, :'carol'),
  'ok(1)');

select harness.try('C15b ...but cannot then un-revoke her (revoked -> active)',
  format($$update public.organisation_memberships set status='active' where user_id=%L$$, :'carol'),
  'denied(42501)');

-- restore carol to active as the DBA (stands in for Task 6's accept function,
-- which bypasses RLS) so the rest of the suite still has an active member.
reset role; reset request.jwt.claims;
update public.organisation_memberships
   set status='active', role='standard_user' where user_id = :'carol';

-- The snapshot mechanic membership_update_is_permitted() relies on: a MULTI-ROW
-- update must evaluate every row against statement-start state, so an admin
-- cannot launder an invited row through a batch that also touches active ones.
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.try('C16 blanket UPDATE cannot launder invited rows via a batch',
  $$update public.organisation_memberships set status='active', joined_at=now()$$,
  'denied(42501)');

select harness.val('C16b ...and dave is STILL invited (nothing partially applied)',
  format($$select status from public.organisation_memberships where user_id=%L$$, :'dave'),
  'invited');

-- ---------------------------------------------------------------------------
-- C17-C21. IDENTITY-COLUMN AND joined_at PINNING.
--
-- Guarding the status TRANSITION was still not enough. An admin could take an
-- ALREADY-ACTIVE row and repoint it at a different user: status never changes,
-- so a status-only guard passes cleanly, and the victim ends up an active
-- member of an organisation they never heard of. Same outcome, different
-- column. organisation_id, user_id and joined_at are now immutable through
-- this policy -- no legitimate client edit ever changes them.
-- ---------------------------------------------------------------------------

-- (carol is ACTIVE in org A here, so status stays untouched throughout)
select harness.try('C17 REGRESSION: admin cannot repoint an ACTIVE row''s user_id',
  format($$update public.organisation_memberships set user_id=%L where user_id=%L$$,
         :'bob', :'carol'), 'denied(42501)');

select harness.try('C18 REGRESSION: admin cannot repoint a row''s organisation_id',
  format($$update public.organisation_memberships set organisation_id=%L where user_id=%L$$,
         :'org_b_id', :'carol'), 'denied(42501)');

select harness.try('C19 REGRESSION: admin cannot forge joined_at on an invited row',
  format($$update public.organisation_memberships set joined_at=now() where user_id=%L$$,
         :'dave'), 'denied(42501)');

select harness.val('C19b ...and dave''s joined_at is still null',
  format($$select coalesce(joined_at::text,'null') from public.organisation_memberships
            where user_id=%L$$, :'dave'), 'null');

select harness.try('C20 admin cannot clear joined_at on an active member either',
  format($$update public.organisation_memberships set joined_at=null where user_id=%L$$,
         :'carol'), 'denied(42501)');

-- Rewriting the primary key itself must fail closed, not find a different row.
select harness.try('C21 admin cannot rewrite a row''s id to dodge the guard',
  format($$update public.organisation_memberships set id=gen_random_uuid(), user_id=%L
            where user_id=%L$$, :'bob', :'carol'), 'denied(42501)');

reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- C22-C25. OUTCOME-LEVEL ASSERTIONS.
--
-- Everything above asserts that a STATEMENT was rejected. That is not the same
-- as asserting the WORLD is unchanged -- the identity-rewrite bypass passed
-- every statement-level check that existed at the time, because it never
-- touched the column being watched. These assert the actual end state from the
-- would-be victim's own session, which is the thing that actually matters.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'bob_c';

select harness.val('C22 OUTCOME: bob never consented, so he sees only his own org',
  $$select count(*)::text from public.organisations$$, '1');

select harness.val('C23 OUTCOME: bob holds exactly one membership, in his own org',
  format($$select count(*)::text from public.organisation_memberships
            where organisation_id=%L$$, :'org_a_id'), '0');

reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'dave_c';

select harness.val('C24 OUTCOME: dave is still only INVITED, so he sees 0 orgs',
  $$select count(*)::text from public.organisations$$, '0');

select harness.val('C25 OUTCOME: dave''s row is untouched (invited, never joined)',
  $$select status||'/'||coalesce(joined_at::text,'null')
      from public.organisation_memberships where user_id=(select auth.uid())$$,
  'invited/null');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- D. platform_superuser self-escalation guard (every write path)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

-- TWO GUARDS NOW ANSWER THIS WRITE, AND BOTH ARE ASSERTED (Phase 8 Task 5 fix
-- round 1, I1). Alice is the sole Owner of org A, so the new BEFORE trigger
-- private.membership_keeps_an_owner() refuses her role change first, with
-- 22023 -- which would have quietly replaced this section's proof that the
-- POLICY refuses a self-escalation. So D1 keeps its original assertion with
-- the new trigger held off, and D1a records the new one beside it. Never one
-- instead of the other: a policy that stopped refusing escalation would
-- otherwise be invisible behind a trigger that refuses everything.
reset role; reset request.jwt.claims;
alter table public.organisation_memberships disable trigger membership_keeps_an_owner;
set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.try('D1  owner cannot UPDATE own row to platform_superuser',
  format($$update public.organisation_memberships set role='platform_superuser' where user_id=%L$$, :'alice'),
  'denied(42501)');
reset role; reset request.jwt.claims;
alter table public.organisation_memberships enable trigger membership_keeps_an_owner;
set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.try('D1a and the owner guard refuses it too, first, because she is org A''s only owner',
  format($$update public.organisation_memberships set role='platform_superuser' where user_id=%L$$, :'alice'),
  'denied(22023)');

-- status='invited' so the ONLY thing wrong with this row is the role -- this
-- isolates the platform_superuser guard rather than passing on the status one.
select harness.try('D2  owner cannot INSERT a new platform_superuser membership',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'platform_superuser','invited')$$, :'org_a_id', :'bob'),
  'denied(42501)');

-- The platform_admins allowlist is unreachable from any client role: RLS with
-- zero policies AND no GRANT. These probe every operation on it.
select harness.val('D3  owner cannot READ the platform_admins allowlist',
  $$select count(*)::text from public.platform_admins$$, 'denied(42501)');

select harness.try('D4  owner cannot ADD herself to the platform_admins allowlist',
  format($$insert into public.platform_admins (user_id) values (%L)$$, :'alice'), 'denied(42501)');

select harness.try('D4b owner cannot DELETE from the platform_admins allowlist',
  $$delete from public.platform_admins$$, 'denied(42501)');

select harness.try('D4c owner cannot REPOINT an allowlist row at herself',
  format($$update public.platform_admins set user_id=%L$$, :'alice'), 'denied(42501)');

-- The same pair, for the same reason: moving her row out of org A leaves org A
-- with no owner, so the trigger answers before the policy does.
reset role; reset request.jwt.claims;
alter table public.organisation_memberships disable trigger membership_keeps_an_owner;
set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.try('D5  owner cannot hop her membership into org B',
  format($$update public.organisation_memberships set organisation_id=%L where user_id=%L$$, :'org_b_id', :'alice'),
  'denied(42501)');
reset role; reset request.jwt.claims;
alter table public.organisation_memberships enable trigger membership_keeps_an_owner;
set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.try('D5a and the owner guard refuses the hop too -- org A would be left ownerless',
  format($$update public.organisation_memberships set organisation_id=%L where user_id=%L$$, :'org_b_id', :'alice'),
  'denied(22023)');

-- status='invited' so the forged invited_by is the ONLY defect in the row.
select harness.try('D6  owner cannot forge invited_by attribution',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status,invited_by)
           values (%L,%L,'admin','invited',%L)$$, :'org_a_id', :'bob', :'super'),
  'denied(42501)');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- E. audit_events: superuser-only read, append-only, no direct write path
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('E1  org OWNER sees 0 audit_events',
  $$select count(*)::text from public.audit_events$$, '0');

-- Two independent locks, asserted separately. 42883 = undefined_function: it
-- is not in `public` at all, so the Data API has no route to it. 42501 =
-- permission denied: even naming it in `private` gets nowhere without EXECUTE.
select harness.try('E2  log_audit_event is not in the exposed schema at all',
  $$select public.log_audit_event('forged.action','organisation')$$, 'denied(42883)');

select harness.try('E2b authenticated cannot EXECUTE private.log_audit_event',
  $$select private.log_audit_event('forged.action','organisation')$$, 'denied(42501)');

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

-- PHASE 7 TASK A: org_a and org_b already carry a Starter row each --
-- public.create_organisation() (lines 127/132 above) now writes one at birth
-- for every organisation, org_a/org_b included. G3/G3b below are specifically
-- about the INSERT policy (organisation_subscriptions_insert_platform_billing),
-- so they need a genuinely absent row to insert INTO, or they measure a
-- duplicate-key error (23505) instead of the grant this section is FOR.
-- Stripped here, as postgres, the same way § N's N1 in rls_phase2_crm.sql
-- reaches the "no subscription row" state deliberately rather than by
-- accident.
delete from public.organisation_subscriptions where organisation_id in (:'org_a_id', :'org_b_id');

set role authenticated;
set request.jwt.claims = :'super_c';

select harness.try('G3  platform superuser CAN write a subscription (positive control)',
  format($$insert into public.organisation_subscriptions
           (organisation_id,plan_id,billing_cycle,seat_count,status,current_period_end)
           values (%L,'pro','monthly',1,'active', now()+interval '1 year')$$, :'org_a_id'),
  'ok(1)');

-- Give org B a subscription too, so the targeted-vs-unqualified update below
-- has two rows to distinguish between.
select harness.try('G3b superuser writes a second org''s subscription',
  format($$insert into public.organisation_subscriptions
           (organisation_id,plan_id,billing_cycle,seat_count,status,current_period_end)
           values (%L,'starter','monthly',1,'active', now()+interval '1 year')$$, :'org_b_id'),
  'ok(1)');

-- REGRESSION (review finding #1). Postgres applies SELECT policies to an
-- UPDATE's row-matching too. With only the is_active_member SELECT policy, the
-- superuser -- a member of nothing -- could see no subscription rows, so a
-- TARGETED update silently hit 0 rows while an UNQUALIFIED one still wrote
-- whatever the member policy happened to expose. A write path that fails when
-- aimed and succeeds when unaimed is the dangerous shape; these assert it is
-- gone.
select harness.val('G6  superuser CAN READ every org''s subscription',
  $$select count(*)::text from public.organisation_subscriptions$$, '2');

select harness.try('G7  REGRESSION: superuser TARGETED update reaches the aimed org',
  format($$update public.organisation_subscriptions set seat_count=7
            where organisation_id=%L$$, :'org_b_id'), 'ok(1)');

select harness.val('G8  ...and it changed the RIGHT org (org B, not org A)',
  format($$select seat_count::text from public.organisation_subscriptions
            where organisation_id=%L$$, :'org_b_id'), '7');

select harness.val('G9  ...and left org A alone',
  format($$select seat_count::text from public.organisation_subscriptions
            where organisation_id=%L$$, :'org_a_id'), '1');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'bob_c';

select harness.val('G4  org B owner cannot READ org A''s subscription',
  format($$select count(*)::text from public.organisation_subscriptions
            where organisation_id=%L$$, :'org_a_id'), '0');

select harness.val('G4b org B owner sees exactly his own org''s subscription',
  $$select count(*)::text from public.organisation_subscriptions$$, '1');

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

-- 9, not 10: 'platform_superuser' is deliberately no longer an org role.
select harness.val('H1  authenticated CAN read roles (positive control)',
  $$select count(*)::text from public.roles$$, '9');

select harness.val('H1b platform_superuser is NOT an assignable org role',
  $$select count(*)::text from public.roles where key='platform_superuser'$$, '0');

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
select harness.val('H18 service_role cannot read the platform_admins allowlist',
  $$select count(*)::text from public.platform_admins$$, 'denied(42501)');
reset role;

set role anon;
select harness.val('H19 anon cannot read the platform_admins allowlist',
  $$select count(*)::text from public.platform_admins$$, 'denied(42501)');
select harness.val('H20 anon cannot call has_platform_permission',
  $$select private.has_platform_permission('view_audit_log')::text$$, 'denied(42501)');
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
-- J. accept_invite()  (Task 6)
--
-- The sanctioned invited -> active transition. C8 asserts the plain UPDATE is
-- still refused; this section asserts the function that replaces it cannot be
-- turned into a way to join an organisation you were never invited to.
--
-- RUNS LAST ON PURPOSE: J5 consumes dave's invite, and dave being 'invited' is
-- a precondition of sections B, C and C22-C25. Do not move this section up.
--
-- The threat model, in order:
--   accept someone else's invite            -> J1
--   accept an invite that does not exist    -> J2 (must be INDISTINGUISHABLE
--                                                  from J1 -- see design note
--                                                  (c) in the migration)
--   reach the function without a session    -> J3, J4
--   re-accept / reinstate an existing row   -> J7, J8
-- ===========================================================================

-- Membership ids needed below. Read as the table owner, before impersonating.
select id as alice_mem_id from public.organisation_memberships
 where user_id = :'alice' \gset
select id as dave_mem_id  from public.organisation_memberships
 where user_id = :'dave' \gset
select id as carol_mem_id from public.organisation_memberships
 where user_id = :'carol' \gset

set role authenticated;
set request.jwt.claims = :'dave_c';

-- THE CORE ATTACK: dave holds a real, valid pending invite, so he is exactly
-- the caller who legitimately may call this function -- just not with someone
-- else's row id. The ownership predicate lives in the lookup's WHERE clause,
-- so alice's row is never even read.
select harness.try('J1  invitee cannot accept ANOTHER user''s membership row',
  format($$select public.accept_invite(%L)$$, :'alice_mem_id'), 'denied(42501)');

-- Same sqlstate as J1, and the migration raises the same message text too.
-- Two distinguishable errors here would be a membership-id enumeration oracle
-- (DESIGN.md § Error pages: "exists, not yours" must look like "not found").
select harness.try('J2  ...and a nonexistent membership id fails IDENTICALLY',
  $$select public.accept_invite(gen_random_uuid())$$, 'denied(42501)');

select harness.try('J2b a NULL membership id is rejected, not silently ignored',
  $$select public.accept_invite(null)$$, 'denied(22023)');

-- alice's row is untouched by the failed J1 -- statement-level rejection is not
-- the same claim as "the world is unchanged" (same reasoning as C22-C25).
select harness.val('J1b OUTCOME: dave still sees 0 organisations after J1',
  $$select count(*)::text from public.organisations$$, '0');

reset role; reset request.jwt.claims;

-- No EXECUTE grant to anon: an unauthenticated caller cannot even reach the
-- auth.uid() null-check inside the function.
set role anon;
select harness.try('J3  anon has no EXECUTE on accept_invite',
  $$select public.accept_invite(gen_random_uuid())$$, 'denied(42501)');
reset role;

-- service_role is granted nothing anywhere in this schema (Task 4 design note
-- (e)) and accept_invite is no exception -- a leaked service key is not a way
-- to force-join anyone to an organisation.
set role service_role;
select harness.try('J4  service_role has no EXECUTE on accept_invite either',
  $$select public.accept_invite(gen_random_uuid())$$, 'denied(42501)');
reset role;

-- Positive control. Without this, every assertion above passes against a
-- function that simply always raises.
set role authenticated;
set request.jwt.claims = :'dave_c';

select harness.try('J5  invitee CAN accept their OWN invite (positive control)',
  format($$select public.accept_invite(%L)$$, :'dave_mem_id'), 'ok(1)');

select harness.val('J6  OUTCOME: dave is now active WITH a joined_at stamp',
  $$select status||'/'||(joined_at is not null)::text
      from public.organisation_memberships where user_id=(select auth.uid())$$,
  'active/true');

select harness.val('J6b OUTCOME: dave can now actually see org A',
  $$select count(*)::text from public.organisations$$, '1');

-- Re-accepting must not re-stamp joined_at or re-audit. This is the case that
-- gets its OWN error message (unlike J1/J2): the caller already proved
-- ownership to reach it, so there is nothing left to leak.
select harness.try('J7  accepting an ALREADY-ACTIVE row is refused',
  format($$select public.accept_invite(%L)$$, :'dave_mem_id'), 'denied(22023)');

reset role; reset request.jwt.claims;

-- Carol accepted in the fixtures, through this same function.
set role authenticated;
set request.jwt.claims = :'carol_c';
select harness.try('J8  an existing active member cannot re-accept',
  format($$select public.accept_invite(%L)$$, :'carol_mem_id'), 'denied(22023)');
reset role; reset request.jwt.claims;

-- The acceptance is audited, like create_organisation. Only the platform
-- superuser can read audit_events, so the assertion runs as super.
set role authenticated;
set request.jwt.claims = :'super_c';

select harness.val('J9  both acceptances (carol fixture + dave J5) were audited',
  $$select count(*)::text from public.audit_events
     where action='membership.accepted'$$, '2');

select harness.val('J10 the audit record names the actor and the org, not a guess',
  format($$select (actor_user_id=%L)::text||'/'||(organisation_id=%L)::text
             from public.audit_events
            where action='membership.accepted' and target_id=%L$$,
         :'dave', :'org_a_id', :'dave_mem_id'), 'true/true');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- K. MFA / assurance level in the permission engine
--    (20260827210000_mfa_aal_permission_gate.sql)
--
-- CLAUDE.md § Session security requires MFA for Owner, Admin, Finance and the
-- Platform Superuser. Before that migration, that requirement lived ONLY in
-- which component app/(app)/layout.tsx chose to render -- so a stolen Owner
-- password bought an aal1 session that could POST straight to PostgREST with
-- the public anon key and invite itself an admin. The Next.js app is not on
-- that path; the database is. These assertions are that path.
--
-- ALL OTHER FIXTURE USERS ARE UNCHANGED. alice/bob/super run at aal2
-- throughout the rest of this file and carol/dave at aal1 (see run-rls-tests.sh
-- for why each), so every assertion above still asserts exactly what it always
-- did. This section re-impersonates the SAME users at a DIFFERENT assurance
-- level; it adds cases rather than altering any.
--
-- The two halves matter equally:
--   K1-K6, K12-K15  the gate BITES     -- privileged writes refused at aal1
--   K7-K10, K14, K16  the gate does NOT OVERREACH -- everything an
--                     un-enrolled user needs in order to reach and complete
--                     enrolment still works at aal1. Get this half wrong and
--                     the first Owner of every organisation is permanently
--                     locked out with no path back in.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- K1-K6. alice is a REAL owner of org A. Same user, same role, same row --
-- the only thing different from section C is that this session never presented
-- a factor. Everything C proved she could do, she now cannot.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'alice_c1';

select harness.val('K1  aal1 owner: has_permission(manage_members) is FALSE',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_a_id'), 'false');

select harness.val('K2  aal1 owner: has_permission(manage_organisation) is FALSE',
  format($$select public.has_permission(%L,'manage_organisation')::text$$, :'org_a_id'), 'false');

-- THE EXPLOIT ITSELF: an otherwise-perfectly-valid invite, at admin, from a
-- session holding a stolen password and nothing else.
select harness.try('K3  EXPLOIT: aal1 owner cannot INSERT an admin invite',
  format($$insert into public.organisation_memberships (organisation_id,user_id,role,status)
           values (%L,%L,'admin','invited')$$, :'org_a_id', :'super'),
  'denied(42501)');

-- ok(0), not denied: the UPDATE/DELETE policies fail in their USING clause, so
-- the row is filtered out before the write is attempted. Different mechanism
-- from K3's WITH CHECK rejection, same security outcome -- the suite asserts
-- which one, exactly as it does for C2/C3 vs C1.
select harness.try('K4  aal1 owner cannot change a member''s role',
  format($$update public.organisation_memberships set role='admin' where user_id=%L$$, :'carol'),
  'ok(0)');

select harness.try('K5  aal1 owner cannot DELETE a membership',
  format($$delete from public.organisation_memberships where user_id=%L$$, :'carol'), 'ok(0)');

select harness.try('K6  aal1 owner cannot rename or soft-delete her own org',
  $$update public.organisations set name='Pwned', deleted_at=now() where slug='org-a'$$, 'ok(0)');

-- ---------------------------------------------------------------------------
-- K7-K10. THE LOCKOUT GUARD. An Owner who has not enrolled yet has to be able
-- to load the app far enough to enrol. Every read the post-auth shell and the
-- enrolment screen depend on must still work at aal1. If any of these ever
-- turns into 0 or denied, the aal gate has been widened onto a read path and
-- every privileged user is locked out with no way back in.
-- ---------------------------------------------------------------------------
select harness.val('K7  LOCKOUT GUARD: aal1 owner still sees her own membership row',
  $$select count(*)::text from public.organisation_memberships
     where user_id = (select auth.uid())$$, '1');

select harness.val('K8  LOCKOUT GUARD: aal1 owner still sees her own profile',
  $$select count(*)::text from public.profiles where id = (select auth.uid())$$, '1');

select harness.val('K9  LOCKOUT GUARD: aal1 owner still sees her organisation',
  $$select count(*)::text from public.organisations where slug='org-a'$$, '1');

-- The workspace switcher and the members page both read the whole org's
-- membership list; neither read policy touches has_permission (design note (h)),
-- and this asserts that stayed true.
select harness.val('K10 LOCKOUT GUARD: aal1 owner still reads the org member list',
  $$select count(*)::text from public.organisation_memberships$$, '3');

reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- K11. POSITIVE CONTROL. Without this, K1-K6 pass just as well against a
-- has_permission() that returns false for everybody, i.e. against a completely
-- broken product.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('K11 POSITIVE CONTROL: the SAME owner at aal2 has the permission',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_a_id'), 'true');

reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- K12-K16. The platform superuser, where the identity/permission split lives.
--
-- K14 is the subtle one and the reason public.is_platform_admin() deliberately
-- is NOT aal-gated: lib/auth/mfa-gate.ts asks "does the MFA requirement apply
-- to this caller?" and must ask it FROM AN aal1 SESSION, because a superuser
-- who has not presented a factor is precisely the caller the gate exists to
-- stop. If is_platform_admin() inherited the aal2 requirement it would answer
-- "no, not a superuser", the gate would conclude MFA does not apply, and the
-- superuser would be waved through WITHOUT MFA -- the aal check inverted into
-- the hole it was added to close.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'super_c1';

select harness.val('K12 aal1 superuser: has_platform_permission is FALSE',
  $$select private.has_platform_permission('view_audit_log')::text$$, 'false');

select harness.val('K13 aal1 superuser sees 0 audit_events (cf. E5 at aal2)',
  $$select count(*)::text from public.audit_events$$, '0');

select harness.val('K14 ...but is_platform_admin() is still TRUE -- the MFA gate depends on it',
  $$select public.is_platform_admin()::text$$, 'true');

select harness.try('K15 aal1 superuser cannot write an entitlement row',
  format($$update public.organisation_subscriptions set seat_count=99
            where organisation_id=%L$$, :'org_a_id'), 'ok(0)');

reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';

select harness.val('K16 POSITIVE CONTROL: the SAME superuser at aal2 reads audit_events',
  $$select (count(*) > 0)::text from public.audit_events$$, 'true');

reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- K17-K18. FAIL CLOSED on an absent claim. A JWT with no `aal` at all is not
-- what this stack emits today, but "the claim we key a security decision on
-- stopped being sent" must read as "no", never as "unknown, allow".
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'alice_c0';

select harness.val('K17 FAIL CLOSED: no aal claim at all is not aal2',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'org_a_id'), 'false');

select harness.val('K18 FAIL CLOSED: session_is_aal2() is false, not null',
  $$select private.session_is_aal2()::text$$, 'false');

reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- K19-K20. The rule is ROLE-scoped, not a blanket aal2-to-write. MFA is
-- required for owner/admin/finance ONLY and is optional for every other role
-- at MVP, so the predicate must key on the role. A blanket rule would pass
-- K1-K6 identically and lock out manager/booker/standard_user the moment a
-- later phase grants one of them a write permission.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'alice_c';

select harness.val('K19 the MFA-required role list is exactly owner/admin/finance',
  $$select string_agg(r.key,',' order by r.key) from public.roles r
     where private.role_requires_mfa(r.key)$$, 'admin,finance,owner');

select harness.val('K20 ...and no other seeded role is caught by it',
  $$select count(*)::text from public.roles r
     where private.role_requires_mfa(r.key)$$, '3');

reset role; reset request.jwt.claims;

-- ===========================================================================
-- W. workspace slugs that would shadow a route  (Phase 8 Task 2 review M7,
--    20260923005000, Q151/Q154)
-- ===========================================================================
-- A workspace lives at /<slug>; a static top-level route with the same name
-- wins, so a workspace called `legal` could be created and never opened.
-- Both paths that set a slug -- create_organisation() and an Owner's direct
-- UPDATE of organisations.slug -- pass private.organisations_slug_not_reserved().
-- The positive controls run inside a DO block that raises a marker at the
-- end, so they prove the write WAS accepted and then roll it back (the later
-- suites count organisations and read org-a by slug).
create function harness.try_hint(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql;
    v_actual := 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_actual := 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
  end;
  perform harness.record(p_label, p_expected, v_actual);
end $$;
grant execute on function harness.try_hint(text,text,text) to authenticated, anon, service_role;

select count(*)::text as orgs_before_w from public.organisations \gset

select harness.val('W1  the reserved list is the ten static top-level routes',
  $$select string_agg(slug, ',' order by slug) from private.reserved_workspace_slugs()$$,
  'account,api,auth,invites,legal,login,magic-link,onboarding,signup,super');
select harness.val('W2  the guard is a BEFORE INSERT OR UPDATE OF slug trigger, enabled',
  $$select tgenabled::text || ':' || (pg_get_triggerdef(oid) ~ 'BEFORE INSERT OR UPDATE OF slug')::text
      from pg_trigger where tgrelid = 'public.organisations'::regclass
       and tgname = 'organisations_slug_not_reserved'$$, 'O:true');

set role authenticated;
set request.jwt.claims = :'carol_c';
select harness.try_hint('W3  create_organisation refuses `legal` (the Task 1 route)',
  $$select public.create_organisation('Legal Eagles','legal')$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W4  ...and `account` (this task''s route)',
  $$select public.create_organisation('Account','account')$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W5  ...however it is spelt (create_organisation lower-cases and trims)',
  $$select public.create_organisation('Super',' SUPER ')$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W6  ...and `magic-link` (a route inside the (auth) group)',
  $$select public.create_organisation('Magic','magic-link')$$, 'denied(22023:reserved_slug)');
select harness.try('W7  POSITIVE: a slug that merely CONTAINS a reserved word is accepted',
  $q$do $d$ begin
      perform public.create_organisation('Legal Team','legal-team');
      raise exception 'accepted' using errcode = 'P0098';
    end $d$ $q$, 'denied(P0098)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.val('W8  DENOMINATOR: alice (Owner, aal2) can read org-a, whose slug she may change',
  $$select count(*)::text from public.organisations where slug = 'org-a'$$, '1');
select harness.try_hint('W9  an Owner cannot MOVE her workspace onto a reserved slug',
  $$update public.organisations set slug = 'legal' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W10 ...nor onto one spelt differently',
  $$update public.organisations set slug = 'Onboarding' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try('W11 POSITIVE: she CAN move it to an ordinary slug (rolled back)',
  $q$do $d$ begin
      update public.organisations set slug = 'org-a-moved' where slug = 'org-a';
      if not found then raise exception 'no row' using errcode = 'P0097'; end if;
      raise exception 'accepted' using errcode = 'P0098';
    end $d$ $q$, 'denied(P0098)');
reset role; reset request.jwt.claims;

-- A workspace that ALREADY holds a reserved slug (created before this
-- migration) is not locked: an update that leaves the slug alone passes, and
-- so does moving it AWAY from the reserved slug. Planted in replica mode (no
-- triggers), exercised with the triggers on, rolled back.
select harness.try('W12 a pre-existing reserved-slug workspace can still be renamed, and moved off it',
  $q$do $d$
    declare v_id uuid;
    begin
      execute 'set local session_replication_role = replica';
      insert into public.organisations (name, slug) values ('Grandfathered', 'invites') returning id into v_id;
      execute 'set local session_replication_role = origin';
      update public.organisations set name = 'Grandfathered, renamed' where id = v_id;
      update public.organisations set slug = 'invites-team' where id = v_id;
      if (select slug from public.organisations where id = v_id) <> 'invites-team' then
        raise exception 'not moved' using errcode = 'P0097';
      end if;
      raise exception 'accepted' using errcode = 'P0098';
    end $d$ $q$, 'denied(P0098)');
select harness.try_hint('W13 ...but a workspace cannot be moved ONTO a reserved slug by postgres either',
  $q$do $d$
    declare v_id uuid;
    begin
      insert into public.organisations (name, slug) values ('Plain', 'plain-w13') returning id into v_id;
      update public.organisations set slug = 'api' where id = v_id;
    end $d$ $q$, 'denied(22023:reserved_slug)');
select harness.val('W14 no organisation was added or changed by this section',
  format($$select (count(*) = %s and count(*) filter (where slug = 'org-a') = 1)::text from public.organisations$$,
         :orgs_before_w), 'true');
select harness.val('W15 session_replication_role is back to origin',
  $$select current_setting('session_replication_role')$$, 'origin');

-- ---------------------------------------------------------------------------
-- W16-W40. the slug GRAMMAR on every write, and the NORMALISED reserved key
-- (scoped re-review N2, 20260923006000). Every input the re-review measured
-- an Owner's direct UPDATE accepting is here, through the same path (alice,
-- Owner at aal2, the column grant). A look-alike or variant of a reserved
-- name must report reserved_slug; anything else outside the grammar
-- invalid_slug.
-- ---------------------------------------------------------------------------
select harness.val('W16 the normalised key folds fullwidth, NBSP, tab, newline and case',
  $$select string_agg(private.workspace_slug_key(s), ',' order by n)
      from (values (1, 'ｌｅｇａｌ'), (2, E'legal\u00a0'), (3, E'legal\t'),
                   (4, E'\nLEGAL'), (5, E'\u3000Ａｃｃｏｕｎｔ '), (6, 'lеgal')) v(n, s)$$,
  -- the sixth is Cyrillic U+0435: NFKC does not fold it, the grammar refuses it (W31)
  'legal,legal,legal,legal,account,lеgal');
select harness.val('W17 the key and the guard are not callable by any client role',
  $$select (not has_function_privilege('authenticated', 'private.workspace_slug_key(text)', 'execute')
            and not has_function_privilege('anon', 'private.workspace_slug_key(text)', 'execute')
            and not has_function_privilege('service_role', 'private.workspace_slug_key(text)', 'execute'))::text$$,
  'true');

set role authenticated;
set request.jwt.claims = :'alice_c';
select harness.try_hint('W18 Owner PATCH: `..` is refused (grammar)',
  $$update public.organisations set slug = '..' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W19 Owner PATCH: the empty slug is refused',
  $$update public.organisations set slug = '' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W20 Owner PATCH: `legal/x` is refused (a path, not a segment)',
  $$update public.organisations set slug = 'legal/x' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W21 Owner PATCH: `_next` is refused (Next.js''s own prefix)',
  $$update public.organisations set slug = '_next' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W22 Owner PATCH: `legal<TAB>` is refused AS RESERVED (key trims the tab)',
  $$update public.organisations set slug = E'legal\t' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W23 Owner PATCH: `legal<NBSP>` is refused as reserved (NFKC maps NBSP to a space)',
  $$update public.organisations set slug = E'legal\u00a0' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W24 Owner PATCH: fullwidth `ｌｅｇａｌ` is refused as reserved (NFKC)',
  $$update public.organisations set slug = 'ｌｅｇａｌ' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W25 Owner PATCH: fullwidth upper-case `ＳＩＧＮＵＰ` is refused as reserved',
  $$update public.organisations set slug = 'ＳＩＧＮＵＰ' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W26 Owner PATCH: `LEGAL` is refused as reserved',
  $$update public.organisations set slug = 'LEGAL' where slug = 'org-a'$$, 'denied(22023:reserved_slug)');
select harness.try_hint('W27 Owner PATCH: an upper-case NON-reserved slug is refused (grammar, not folded)',
  $$update public.organisations set slug = 'Org-A-Two' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W28 Owner PATCH: a trailing newline on an ordinary slug is refused',
  $$update public.organisations set slug = E'org-a-two\n' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W29 Owner PATCH: a double hyphen is refused',
  $$update public.organisations set slug = 'org--a' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W30 ...leading hyphen',
  $$update public.organisations set slug = '-org-a' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W31 Owner PATCH: Cyrillic look-alike `lеgal` is refused (grammar: ASCII only)',
  $$update public.organisations set slug = 'lеgal' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W32 Owner PATCH: one character is too short',
  $$update public.organisations set slug = 'a' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W33 Owner PATCH: 64 characters is too long',
  $$update public.organisations set slug = repeat('a', 64) where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try_hint('W34 Owner PATCH: a slug with an inner space is refused',
  $$update public.organisations set slug = 'org a' where slug = 'org-a'$$, 'denied(22023:invalid_slug)');
select harness.try('W35 POSITIVE: exactly 63 and exactly 2 characters are accepted (rolled back)',
  $q$do $d$ begin
      update public.organisations set slug = repeat('a', 63) where slug = 'org-a';
      if not found then raise exception 'no row' using errcode = 'P0097'; end if;
      update public.organisations set slug = 'a1' where slug = repeat('a', 63);
      if not found then raise exception 'no row' using errcode = 'P0097'; end if;
      raise exception 'accepted' using errcode = 'P0098';
    end $d$ $q$, 'denied(P0098)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'carol_c';
select harness.try_hint('W36 create_organisation: fullwidth `ｌｅｇａｌ` is refused (its own grammar runs first)',
  $$select public.create_organisation('Wide','ｌｅｇａｌ')$$, 'denied(22023:)');
reset role; reset request.jwt.claims;

select harness.try_hint('W37 postgres cannot INSERT an ungrammatical slug either (the trigger, not a grant)',
  $$insert into public.organisations (name, slug) values ('Raw', '_next')$$, 'denied(22023:invalid_slug)');
-- A workspace that ALREADY holds an ungrammatical slug (from before
-- 20260923006000) is not locked: a rename and a lifecycle-style update that
-- leave the slug alone pass, and so does moving it to a grammatical slug;
-- moving it to ANOTHER ungrammatical slug is refused. Planted in replica mode.
select harness.try('W38 a pre-existing ungrammatical workspace can be renamed and moved to a valid slug',
  $q$do $d$
    declare v_id uuid;
    begin
      execute 'set local session_replication_role = replica';
      insert into public.organisations (name, slug) values ('Old Style', 'Old_Style') returning id into v_id;
      execute 'set local session_replication_role = origin';
      update public.organisations set name = 'Old Style, renamed' where id = v_id;
      update public.organisations set name = name, slug = slug where id = v_id;
      update public.organisations set slug = 'old-style' where id = v_id;
      if (select slug from public.organisations where id = v_id) <> 'old-style' then
        raise exception 'not moved' using errcode = 'P0097';
      end if;
      raise exception 'accepted' using errcode = 'P0098';
    end $d$ $q$, 'denied(P0098)');
select harness.try_hint('W39 ...but it cannot be moved to another ungrammatical slug',
  $q$do $d$
    declare v_id uuid;
    begin
      execute 'set local session_replication_role = replica';
      insert into public.organisations (name, slug) values ('Old Style', 'Old_Style') returning id into v_id;
      execute 'set local session_replication_role = origin';
      update public.organisations set slug = 'Old_Style_2' where id = v_id;
    end $d$ $q$, 'denied(22023:invalid_slug)');
select harness.val('W40 no organisation was added or changed by W16-W39, and replication role is origin',
  format($$select (count(*) = %s and count(*) filter (where slug = 'org-a') = 1
                   and current_setting('session_replication_role') = 'origin')::text
             from public.organisations$$, :orgs_before_w), 'true');

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
