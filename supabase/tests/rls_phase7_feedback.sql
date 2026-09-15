-- ===========================================================================
-- Phase 7 Task 6 (In-app feedback) suite.
--
-- Covers 20260911000000_in_app_feedback.sql:
--   public.feedback                          the platform-scoped table
--   private.feedback_before_insert()         attribution + the 10/hour meter
--   private.feedback_update_guard()          the status-only column gate
--   private.audit_feedback_submission()      feedback.submitted
--   private.audit_feedback_status_change()   feedback.status_changed
--   private.feedback_quarantine_alert()      the malware-hit incident row
--   public.audit_feedback_screenshot_view()  the audited-view RPC
--   private.feedback_retention_cutoff()      the 2-year read-time clock
--   storage.buckets 'feedback-screenshots'   + its four client fences
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs LAST of the psql suites, after rls_phase7_rate_limits.sql, and
--   reuses the SAME fixtures whole (the twelve Phase 2 users, orgs ALPHA and
--   BETA, plus `super`). Every row, counter, alert and audit event it creates
--   is deleted at § FZ, so the HTTP block below runs against the state it was
--   written against.
--
-- IT USES ITS OWN `fb` SCHEMA. Helpers are rls_phase7_rate_limits.sql's
-- `rl.*`, verbatim, with the schema renamed.
--
-- ===========================================================================
-- WHAT THIS SUITE PROVES, AND THE TWO TASK 5 FINDINGS IT EXISTS TO PIN
-- ===========================================================================
-- Task 5's I1 was a caller-supplied organisation reaching a platform table;
-- its I2 was a budget metered in the application only, bypassable by a direct
-- PostgREST INSERT. Both classes apply to `feedback` exactly, and both are
-- asserted here from the position the attacker holds -- a real session's
-- claims, `set role authenticated`, which is what a PostgREST request becomes:
--   § FI  attribution cannot be forged (column grant, trigger, policy -- each
--         measured, FI6-FI11), and a refused forgery spends no budget (FI12)
--   § FM  the meter binds the raw INSERT (FM1-FM6), including that it does
--         not count refusals (Q115) and files exactly one unattributed alert
--   § FA  the screenshot-view audit refuses everyone but the aal2 superuser,
--         and refuses a row with nothing to view
-- It proves the DATABASE half. That the application calls
-- audit_feedback_screenshot_view() BEFORE it mints a URL is proved by
-- tests/e2e/feedback.spec.ts reading the audit row back after the real link
-- is followed.
--
-- SECTIONS:
--   FB  fixtures and their sanity
--   FP  privileges: the column-narrow grants, per role
--   FI  INSERT: attribution stamped, forgery refused, constraints, audit
--   FR  SELECT: submitter 0 / member 0 / foreign owner 0 / superuser / aal1 / retention
--   FU  UPDATE: status only, audited; the guard with the grant switched off
--   FM  the meter at the write
--   FA  the screenshot-view audit RPC + the quarantine alert
--   FS  the bucket and its fences
--   FX  feedback during SUPPORT ACCESS (Task 6c, founder ruling Q121): the
--       label is accepted only for a live impersonating superuser, and a
--       member cannot forge it
--   FZ  housekeeping
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   denied(23514)  a CHECK constraint refused it.
--   denied(PT429)  the meter refused it (PostgREST answers HTTP 429).
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists fb cascade;
create schema fb;

create table fb.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function fb.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into fb.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function fb.try(p_label text, p_sql text, p_expected text)
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
  perform fb.record(p_label, p_expected, v_actual);
end $$;

create function fb.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform fb.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema fb to authenticated, anon, service_role;
grant execute on function fb.record(text,text,text) to authenticated, anon, service_role;
grant execute on function fb.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function fb.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
-- Ids chosen up front, the way the application chooses them (crypto.randomUUID
-- before the INSERT), so the screenshot-key CHECK can be exercised.
select gen_random_uuid()::text as fi_a   \gset
select gen_random_uuid()::text as fi_b   \gset
select gen_random_uuid()::text as fi_c   \gset
select gen_random_uuid()::text as fi_old \gset
select gen_random_uuid()::text as fa_shot \gset
select gen_random_uuid()::text as fa_old  \gset
select gen_random_uuid()::text as fa_quar \gset
select gen_random_uuid()::text as fi_forge \gset
-- Fix round 1 (M1): one key with NO object behind it, one WITH.
select gen_random_uuid()::text as fi_declared \gset
select gen_random_uuid()::text as fi_withobj  \gset
select count(*)::text as alerts_before from public.incident_alerts \gset
select count(*)::text as audit_before  from public.audit_events where target_type='feedback' \gset
\o

-- ===========================================================================
-- § FB  FIXTURES AND THEIR SANITY
-- ===========================================================================
select fb.val('FB1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select fb.val('FB2 FIXTURE: pstd1 is an ACTIVE standard_user of ALPHA',
  format($$select role from public.organisation_memberships
            where organisation_id=%L and user_id=%L and status='active'$$, :'alpha_org', :'pstd1'),
  'standard_user');
select fb.val('FB3 FIXTURE: pstd1 holds NO membership of BETA (the forgery target)',
  format($$select count(*)::text from public.organisation_memberships
            where organisation_id=%L and user_id=%L$$, :'beta_org', :'pstd1'), '0');
select fb.val('FB4 FIXTURE: no feedback rows exist for the suite''s submitters yet',
  format($$select count(*)::text from public.feedback where user_id in (%L,%L)$$, :'pstd1', :'pstd2'), '0');
select fb.val('FB5 FIXTURE: no feedback counters exist for them yet',
  format($$select count(*)::text from public.rate_limit_counters
            where category='feedback' and subject_id in (%L,%L)$$, :'pstd1', :'pstd2'), '0');
select fb.val('FB6 the feedback policy row is SECURITY.md § 5''s: 10 per 3600s, per user',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='feedback'$$, '10/3600/user');
select fb.val('FB7 audit_events target_type=feedback denominator taken',
  $$select 'taken'$$, 'taken');

-- ===========================================================================
-- § FP  PRIVILEGES -- column-narrow, per role, measured not read
-- ===========================================================================
select fb.val('FP1 anon holds nothing on feedback',
  $$select (has_table_privilege('anon','public.feedback','SELECT')
         or has_table_privilege('anon','public.feedback','INSERT')
         or has_table_privilege('anon','public.feedback','UPDATE')
         or has_table_privilege('anon','public.feedback','DELETE'))::text$$, 'false');
select fb.val('FP2 authenticated may INSERT the submission columns...',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='authenticated' and privilege_type='INSERT'$$,
  'category,id,message,organisation_id,route,screenshot_key,screenshot_mime,screenshot_scan_status,screenshot_scanned_at,screenshot_size_bytes,user_agent');
select fb.val('FP3 ...and NOT user_id / user_email / organisation_role / status / notified_at / created_at',
  $$select count(*)::text
      from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='authenticated' and privilege_type='INSERT'
       and column_name in ('user_id','user_email','organisation_role','status','notified_at','created_at','during_support_access')$$,
  '0');
select fb.val('FP4 authenticated may UPDATE exactly one column: status',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='authenticated' and privilege_type='UPDATE'$$, 'status');
select fb.val('FP5 authenticated holds no DELETE',
  $$select has_table_privilege('authenticated','public.feedback','DELETE')::text$$, 'false');
-- Fix round 1 (M2): the sender never reads a row -- its one UPDATE matches on
-- id and notified_at, and that is ALL it may select. A whole-table SELECT on
-- a BYPASSRLS role was a read of message/user_email/route across every
-- workspace and past retention.
select fb.val('FP6 service_role may SELECT exactly id and notified_at (what its UPDATE''s WHERE needs)',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='service_role' and privilege_type='SELECT'$$, 'id,notified_at');
select fb.val('FP6b ...and holds NO table-level SELECT (20260911030000 narrowed it)',
  $$select has_table_privilege('service_role','public.feedback','SELECT')::text$$, 'false');
select fb.val('FP7 service_role may UPDATE notified_at alone',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='service_role' and privilege_type='UPDATE'$$, 'notified_at');
select fb.val('FP8 service_role holds no INSERT or DELETE',
  $$select (has_table_privilege('service_role','public.feedback','INSERT')
         or has_table_privilege('service_role','public.feedback','DELETE'))::text$$, 'false');
select fb.val('FP9 RLS is enabled on feedback',
  $$select relrowsecurity::text from pg_class where oid='public.feedback'::regclass$$, 'true');
select fb.val('FP10 exactly one SELECT policy, and it is the platform one (no policy names a submitter)',
  $$select string_agg(polname, ',') from pg_policy
     where polrelid='public.feedback'::regclass and polcmd='r'$$, 'feedback_select_platform');
select fb.val('FP11 no DELETE policy for any role',
  $$select count(*)::text from pg_policy where polrelid='public.feedback'::regclass and polcmd='d'$$, '0');

-- ===========================================================================
-- § FI  INSERT -- attribution stamped, forgery refused, constraints, audit
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd1_c';

select fb.try('FI1 a member submits feedback naming their OWN workspace (no user_id sent)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, %L, 'bug', 'The venue picker loses my filter.', '/org-alpha/venues')$$,
         :'fi_a', :'alpha_org'),
  'ok(1)');
select fb.try('FI6 FORGERY: naming user_id in the INSERT is refused at the column grant',
  format($$insert into public.feedback (id, user_id, organisation_id, category, message, route)
           values (%L, %L, %L, 'bug', 'x', '/')$$, :'fi_forge', :'pstd2', :'alpha_org'),
  'denied(42501)');
select fb.try('FI7 FORGERY: naming organisation_role is refused the same way',
  format($$insert into public.feedback (id, organisation_id, organisation_role, category, message, route)
           values (%L, %L, 'owner', 'bug', 'x', '/')$$, :'fi_forge', :'alpha_org'),
  'denied(42501)');
select fb.try('FI8 FORGERY: naming status is refused the same way',
  format($$insert into public.feedback (id, organisation_id, status, category, message, route)
           values (%L, %L, 'actioned', 'bug', 'x', '/')$$, :'fi_forge', :'alpha_org'),
  'denied(42501)');
select fb.try('FI9 FORGERY: a workspace the caller is NOT a member of is refused by the trigger',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, %L, 'bug', 'blame beta', '/org-beta')$$, :'fi_forge', :'beta_org'),
  'denied(42501)');
select fb.try('FI10 a submission from OUTSIDE any workspace (organisation_id null) is accepted',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'idea', 'Invites page could show who invited me.', '/invites')$$, :'fi_b'),
  'ok(1)');
select fb.try('FI11 a workspace id that does not exist is refused (42501, never a dangling row)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, '00000000-0000-4000-8000-0000000000ff', 'bug', 'x', '/')$$, :'fi_forge'),
  'denied(42501)');
-- CHECK constraints, from the submitter's own position.
select fb.try('FI15 an unknown category is a CHECK violation',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'praise', 'x', '/')$$, :'fi_forge'), 'denied(23514)');
select fb.try('FI16 a blank message is a CHECK violation',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'bug', '   ', '/')$$, :'fi_forge'), 'denied(23514)');
select fb.try('FI17 a route not beginning with / is a CHECK violation',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'bug', 'x', 'javascript:alert(1)')$$, :'fi_forge'), 'denied(23514)');
-- Since fix round 1 (20260911020000) a SESSION writer naming any screenshot
-- key meets the trigger's object-existence test BEFORE Postgres evaluates
-- the CHECK constraints (BEFORE INSERT triggers run first), so from the
-- submitter's seat every malformed screenshot row is 42501. The CHECKs are
-- proved below from the sessionless seat, where the trigger passes through.
select fb.try('FI18 a screenshot key not pinned to the row''s own id is refused (trigger first: 42501)',
  format($$insert into public.feedback (id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, null, 'bug', 'x', '/', 'feedback/%s', 'image/png', 10, 'clean', now())$$,
         :'fi_forge', :'fi_a'), 'denied(42501)');
select fb.try('FI19 a screenshot key without its mime/size/verdict is refused (trigger first: 42501)',
  format($$insert into public.feedback (id, organisation_id, category, message, route, screenshot_key)
           values (%L, null, 'bug', 'x', '/', 'feedback/%s')$$, :'fi_forge', :'fi_forge'), 'denied(42501)');
select fb.try('FI19b a non-image screenshot mime is refused (trigger first: 42501)',
  format($$insert into public.feedback (id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, null, 'bug', 'x', '/', 'feedback/%s', 'application/pdf', 10, 'clean', now())$$,
         :'fi_forge', :'fi_forge'), 'denied(42501)');
reset role; reset request.jwt.claims;
-- The CHECKs themselves, from the seat the trigger exempts (postgres, no session).
select fb.try('FI18c CHECK: a key not pinned to the row''s own id is 23514 for a sessionless writer',
  format($$insert into public.feedback (id, user_id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, %L, null, 'bug', 'x', '/', 'feedback/%s', 'image/png', 10, 'clean', now())$$,
         :'fi_forge', :'pstd1', :'fi_a'), 'denied(23514)');
select fb.try('FI19c CHECK: a key without its mime/size/verdict is 23514 for a sessionless writer',
  format($$insert into public.feedback (id, user_id, organisation_id, category, message, route, screenshot_key)
           values (%L, %L, null, 'bug', 'x', '/', 'feedback/%s')$$, :'fi_forge', :'pstd1', :'fi_forge'), 'denied(23514)');
select fb.try('FI19d CHECK: a non-image mime is 23514 for a sessionless writer',
  format($$insert into public.feedback (id, user_id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, %L, null, 'bug', 'x', '/', 'feedback/%s', 'application/pdf', 10, 'clean', now())$$,
         :'fi_forge', :'pstd1', :'fi_forge'), 'denied(23514)');

-- What the database STORED, read as postgres.
select fb.val('FI2 the stored user_id is the SESSION''s, whatever was (not) sent',
  format($$select (user_id = %L)::text from public.feedback where id=%L$$, :'pstd1', :'fi_a'), 'true');
select fb.val('FI3 user_email is stamped from auth.users',
  format($$select (f.user_email = u.email)::text from public.feedback f
            join auth.users u on u.id = f.user_id where f.id=%L$$, :'fi_a'), 'true');
select fb.val('FI4 organisation_role is stamped from the caller''s OWN membership row',
  format($$select organisation_role from public.feedback where id=%L$$, :'fi_a'), 'standard_user');
select fb.val('FI5 status is new and notified_at is null on arrival',
  format($$select status || '/' || coalesce(notified_at::text, 'null') from public.feedback where id=%L$$, :'fi_a'),
  'new/null');
select fb.val('FI10b the workspace-less row carries no role',
  format($$select coalesce(organisation_role, 'null') from public.feedback where id=%L$$, :'fi_b'), 'null');
select fb.val('FI12 the meter charged the two ACCEPTED rows and nothing refused (metered after authorisation)',
  format($$select request_count::text from public.rate_limit_counters
            where category='feedback' and subject_scope='user' and subject_id=%L$$, :'pstd1'), '2');
select fb.val('FI13 feedback.submitted was audited for the workspace row, actor = the submitter',
  format($$select count(*)::text from public.audit_events
            where action='feedback.submitted' and target_type='feedback'
              and target_id=%L and actor_user_id=%L and organisation_id=%L$$,
         :'fi_a', :'pstd1', :'alpha_org'), '1');
select fb.val('FI14 ...its payload carries category/role/route and NEVER the message',
  format($$select (after ? 'category' and after ? 'route' and after ? 'organisation_role'
                   and not (after ? 'message'))::text
            from public.audit_events where action='feedback.submitted' and target_id=%L$$, :'fi_a'), 'true');
select fb.val('FI14b no refused forgery left an audit row behind',
  format($$select count(*)::text from public.audit_events where target_id=%L$$, :'fi_forge'), '0');
select fb.val('FI14c no refused forgery left a row behind',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fi_forge'), '0');

-- FIX ROUND 1, FINDING M1: "the row says there is a screenshot" must mean
-- "the server put bytes there". A session writer may not DECLARE a key (and
-- with it a scan verdict) that no object backs. The key below passes the
-- shape CHECK (it is the row's own id), so what refuses it is the trigger's
-- new storage.objects existence test -- and, because it runs before the
-- meter, the refusal spends nothing.
\o /dev/null
insert into storage.objects (bucket_id, name)
values ('feedback-screenshots', 'feedback/' || :'fi_withobj');
\o
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fb.try('FI22 DECLARED SCREENSHOT: a clean verdict with NO object behind the key is refused (42501)',
  format($$insert into public.feedback (id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, %L, 'bug', 'phantom clean', '/org-alpha', 'feedback/%s', 'image/png', 10, 'clean', now())$$,
         :'fi_declared', :'alpha_org', :'fi_declared'), 'denied(42501)');
select fb.try('FI22b ...and a QUARANTINED verdict with no object is refused too (no phantom alert)',
  format($$insert into public.feedback (id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, %L, 'bug', 'phantom quarantine', '/org-alpha', 'feedback/%s', 'image/png', 10, 'quarantined', now())$$,
         :'fi_declared', :'alpha_org', :'fi_declared'), 'denied(42501)');
select fb.try('FI23 CONTROL: the same INSERT with an object under the key is accepted',
  format($$insert into public.feedback (id, organisation_id, category, message, route,
             screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
           values (%L, %L, 'bug', 'real screenshot', '/org-alpha', 'feedback/%s', 'image/png', 10, 'clean', now())$$,
         :'fi_withobj', :'alpha_org', :'fi_withobj'), 'ok(1)');
reset role; reset request.jwt.claims;
select fb.val('FI22c the phantom quarantine filed NO upload_quarantined alert',
  format($$select count(*)::text from public.incident_alerts where details->>'feedback_id'=%L$$, :'fi_declared'), '0');
select fb.val('FI22d ...and left no row',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fi_declared'), '0');
select fb.val('FI23b the meter charged the accepted screenshot row and neither refused declaration (3 in all)',
  format($$select request_count::text from public.rate_limit_counters
            where category='feedback' and subject_scope='user' and subject_id=%L$$, :'pstd1'), '3');

-- anon and sessionless writers.
set role anon;
select fb.try('FI20 anon cannot insert at all',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'bug', 'x', '/')$$, :'fi_forge'), 'denied(42501)');
reset role;
select fb.try('FI21 a SESSIONLESS writer (postgres fixture) inserts with an explicit user_id and passes the trigger through',
  format($$insert into public.feedback (id, user_id, organisation_id, category, message, route)
           values (%L, %L, %L, 'other', 'planted', '/org-alpha')$$, :'fi_c', :'pstd1', :'alpha_org'),
  'ok(1)');
select fb.val('FI21b ...and it audited nothing and metered nothing (no actor to attribute)',
  format($$select (select count(*) from public.audit_events where target_id=%L)::text || '/' ||
                  (select request_count from public.rate_limit_counters
                    where category='feedback' and subject_id=%L)::text$$, :'fi_c', :'pstd1'), '0/3');

-- ===========================================================================
-- § FR  SELECT -- who reads what
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fb.val('FR1 the SUBMITTER reads zero rows -- not even their own',
  $$select count(*)::text from public.feedback$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd2_c';
select fb.val('FR2 a fellow member of the same workspace reads zero',
  $$select count(*)::text from public.feedback$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select fb.val('FR3 a foreign workspace''s aal2 Owner reads zero',
  $$select count(*)::text from public.feedback$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c1';
select fb.val('FR5 an aal1 superuser session reads zero (has_platform_permission is aal2-gated)',
  $$select count(*)::text from public.feedback$$, '0');
reset role; reset request.jwt.claims;

-- The retention row: planted 3 years old, as postgres.
\o /dev/null
insert into public.feedback (id, user_id, organisation_id, category, message, route, created_at)
values (:'fi_old', :'pstd1', :'alpha_org', 'bug', 'ancient', '/', now() - interval '3 years');
-- Fix round 1 (M6): FR4 is a PROPERTY, not a count of a fixed id list. The
-- expected value is what postgres sees inside retention; the superuser must
-- read exactly that many of pstd1's rows and none of the expired ones.
select count(*)::text as fr4_expected from public.feedback
 where user_id=:'pstd1' and created_at >= private.feedback_retention_cutoff() \gset
select count(*)::text as fr4_expired from public.feedback
 where user_id=:'pstd1' and created_at < private.feedback_retention_cutoff() \gset
\o
select fb.val('FR4d CONTROL: at least one of pstd1''s rows is past retention, so FR4/FR4c measure the clock',
  format($$select (%L::int >= 1)::text$$, :'fr4_expired'), 'true');
set role authenticated;
set request.jwt.claims = :'super_c';
select fb.val('FR4 the aal2 superuser reads exactly pstd1''s IN-RETENTION rows -- as many as postgres counts',
  format($$select count(*)::text from public.feedback where user_id=%L$$, :'pstd1'), :'fr4_expected');
select fb.val('FR4c ...and none of pstd1''s rows past the cutoff',
  format($$select count(*)::text from public.feedback
            where user_id=%L and created_at < private.feedback_retention_cutoff()$$, :'pstd1'), '0');
select fb.val('FR4b ...with its stamped email, role and route',
  format($$select (user_email is not null and organisation_role='standard_user' and route='/org-alpha/venues')::text
            from public.feedback where id=%L$$, :'fi_a'), 'true');
select fb.val('FR6 RETENTION: a row three years old is INVISIBLE to the superuser (read-time expiry)',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fi_old'), '0');
reset role; reset request.jwt.claims;
select fb.val('FR6b ...and it does exist (postgres sees it), so FR6 measured the policy, not an absent row',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fi_old'), '1');

-- ===========================================================================
-- § FU  UPDATE -- status only, superuser only, audited
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select fb.try('FU1 the aal2 superuser moves a row to read',
  format($$update public.feedback set status='read' where id=%L$$, :'fi_a'), 'ok(1)');
select fb.try('FU3 ...but cannot rewrite the message (column-level grant)',
  format($$update public.feedback set message='edited' where id=%L$$, :'fi_a'), 'denied(42501)');
select fb.try('FU4 ...nor stamp notified_at -- that is the sender''s column',
  format($$update public.feedback set notified_at=now() where id=%L$$, :'fi_a'), 'denied(42501)');
select fb.try('FU4b ...nor re-point the row at another workspace',
  format($$update public.feedback set organisation_id=%L where id=%L$$, :'beta_org', :'fi_a'), 'denied(42501)');
select fb.try('FU6b the superuser cannot DELETE (no grant, no policy -- a submission is kept for its window)',
  format($$delete from public.feedback where id=%L$$, :'fi_a'), 'denied(42501)');
reset role; reset request.jwt.claims;
select fb.val('FU2 feedback.status_changed was audited with before/after, actor = super',
  format($$select before->>'status' || '->' || (after->>'status') from public.audit_events
            where action='feedback.status_changed' and target_id=%L and actor_user_id=%L$$,
         :'fi_a', :'super'), 'new->read');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fb.try('FU5 the submitter''s own status update matches nothing (USING filters the row away)',
  format($$update public.feedback set status='archived' where id=%L$$, :'fi_a'), 'ok(0)');
select fb.try('FU6 the submitter cannot DELETE',
  format($$delete from public.feedback where id=%L$$, :'fi_a'), 'denied(42501)');
reset role; reset request.jwt.claims;
select fb.val('FU5b ...and the status is still what the superuser set',
  format($$select status from public.feedback where id=%L$$, :'fi_a'), 'read');

-- The sender's half.
set role service_role;
select fb.try('FU8 service_role stamps notified_at (the sender, after a successful send)',
  format($$update public.feedback set notified_at=now() where id=%L and notified_at is null$$, :'fi_a'), 'ok(1)');
select fb.try('FU8b ...and cannot move status (column grant)',
  format($$update public.feedback set status='archived' where id=%L$$, :'fi_a'), 'denied(42501)');
reset role;

-- THE GUARD WITH THE GRANT SWITCHED OFF (the LP10 discipline): widen the
-- UPDATE grant, attack as the superuser, and prove the trigger refuses alone.
\o /dev/null
grant update (message) on public.feedback to authenticated;
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select fb.try('FU10 with update(message) GRANTED, private.feedback_update_guard() still refuses it',
  format($$update public.feedback set message='edited' where id=%L$$, :'fi_a'), 'denied(42501)');
reset role; reset request.jwt.claims;
\o /dev/null
revoke update (message) on public.feedback from authenticated;
\o
select fb.val('FU10b the widened grant is revoked again',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='feedback' and grantee='authenticated'
       and privilege_type='UPDATE' and column_name='message'$$, '0');

-- ===========================================================================
-- § FM  THE METER, AT THE WRITE -- pstd2 has a fresh budget
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd2_c';
-- Fix round 1 (I1): the READ the app runs before any Storage I/O. A fresh
-- budget reads the whole limit; reading it spends nothing (FM3 still holds).
select fb.val('FM0 feedback_budget_remaining() reads the whole limit for a fresh session',
  $$select remaining::text from public.feedback_budget_remaining()$$, '10');
select fb.try('FM1 ten submissions in one window are accepted (one multi-row INSERT, trigger per row)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           select gen_random_uuid(), %L, 'idea', 'burst ' || g, '/org-alpha'
             from generate_series(1,10) g$$, :'alpha_org'), 'ok(10)');
select fb.try('FM2 the eleventh is refused with PT429 -- a real HTTP 429 through PostgREST',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (gen_random_uuid(), %L, 'idea', 'eleventh', '/org-alpha')$$, :'alpha_org'), 'denied(PT429)');
select fb.try('FM2b ...and again (repeatable, nothing rolled back that mattered)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (gen_random_uuid(), null, 'idea', 'twelfth', '/')$$), 'denied(PT429)');
select fb.val('FM8 ...and the pre-check now reads 0 for this session (the app refuses before touching storage)',
  $$select remaining::text from public.feedback_budget_remaining()$$, '0');
select fb.val('FM8b ...with the same remainder the trigger put in hint: 0 < retry <= 3600',
  $$select (retry_after_seconds > 0 and retry_after_seconds <= 3600)::text from public.feedback_budget_remaining()$$, 'true');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fb.val('FM8c the read is the CALLER''s own budget: pstd1 (3 accepted) reads 7, not pstd2''s 0',
  $$select remaining::text from public.feedback_budget_remaining()$$, '7');
reset role; reset request.jwt.claims;
set role anon;
select fb.try('FM9 anon cannot read a budget (no EXECUTE)',
  $$select * from public.feedback_budget_remaining()$$, 'denied(42501)');
reset role;
select fb.try('FM9b a SESSIONLESS caller is refused (fail closed: no session, no budget)',
  $$select * from public.feedback_budget_remaining()$$, 'denied(42501)');
select fb.val('FM10 the pre-check is STABLE (a read, cannot spend) and SECURITY DEFINER (clients cannot read counters)',
  $$select provolatile::text || '/' || prosecdef::text from pg_proc
     where proname='feedback_budget_remaining' and pronamespace='public'::regnamespace$$, 's/true');
select fb.val('FM3 the counter reads exactly the limit -- refusals are NOT counted (Q115, second instance)',
  format($$select request_count::text from public.rate_limit_counters
            where category='feedback' and subject_scope='user' and subject_id=%L$$, :'pstd2'), '10');
select fb.val('FM4 exactly ten rows exist for pstd2',
  format($$select count(*)::text from public.feedback where user_id=%L$$, :'pstd2'), '10');
select fb.val('FM5 exactly ONE rate_limit_tripped alert, filed at the last ACCEPTED submission',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'category'='feedback'
              and details->>'subject_id'=%L$$, :'pstd2'), '1');
select fb.val('FM6 ...and it names NO workspace (user-scoped budgets attribute none -- 20260909050000''s rule)',
  format($$select (organisation_id is null and details->>'subject_scope'='user'
                   and (details->>'counts_refusals')::boolean = false)::text
            from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id'=%L$$, :'pstd2'), 'true');
select fb.val('FM7 the ten accepted submissions were each audited',
  format($$select count(*)::text from public.audit_events
            where action='feedback.submitted' and actor_user_id=%L$$, :'pstd2'), '10');

-- ===========================================================================
-- § FA  THE SCREENSHOT-VIEW AUDIT RPC, AND THE QUARANTINE ALERT
-- ===========================================================================
\o /dev/null
insert into public.feedback (id, user_id, organisation_id, category, message, route,
  screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
values (:'fa_shot', :'pstd1', :'alpha_org', 'bug', 'with a screenshot', '/org-alpha/contacts',
        'feedback/' || :'fa_shot', 'image/png', 1234, 'clean', now());
insert into public.feedback (id, user_id, organisation_id, category, message, route, created_at,
  screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
values (:'fa_old', :'pstd1', :'alpha_org', 'bug', 'old with a screenshot', '/', now() - interval '3 years',
        'feedback/' || :'fa_old', 'image/png', 1234, 'clean', now() - interval '3 years');
\o

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select fb.try('FA2 the SUBMITTER cannot record a screenshot view (42501)',
  format($$select public.audit_feedback_screenshot_view(%L)$$, :'fa_shot'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select fb.try('FA3 an aal1 superuser session cannot either',
  format($$select public.audit_feedback_screenshot_view(%L)$$, :'fa_shot'), 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select fb.val('FA4 the aal2 superuser records a view and gets the audit row''s id back',
  format($$select (public.audit_feedback_screenshot_view(%L) is not null)::text$$, :'fa_shot'), 'true');
select fb.try('FA6 ...but not for a row with NO screenshot (nothing to view, nothing to audit)',
  format($$select public.audit_feedback_screenshot_view(%L)$$, :'fi_a'), 'denied(42501)');
select fb.try('FA7 ...nor for a row outside retention',
  format($$select public.audit_feedback_screenshot_view(%L)$$, :'fa_old'), 'denied(42501)');
select fb.try('FA7b ...nor for an id that does not exist',
  $$select public.audit_feedback_screenshot_view('00000000-0000-4000-8000-0000000000ff')$$, 'denied(42501)');
reset role; reset request.jwt.claims;
select fb.val('FA5 feedback.screenshot_viewed: one row, actor = super, target = the feedback, org = its workspace',
  format($$select count(*)::text from public.audit_events
            where action='feedback.screenshot_viewed' and target_type='feedback'
              and target_id=%L and actor_user_id=%L and organisation_id=%L$$,
         :'fa_shot', :'super', :'alpha_org'), '1');
select fb.val('FA5b no refused call left an audit row',
  format($$select count(*)::text from public.audit_events
            where action='feedback.screenshot_viewed' and target_id in (%L,%L,%L)$$,
         :'fi_a', :'fa_old', :'fa_shot'), '1');
select fb.val('FA8 anon and service_role hold no EXECUTE on the view-audit RPC',
  $$select (has_function_privilege('anon','public.audit_feedback_screenshot_view(uuid)','EXECUTE')
         or has_function_privilege('service_role','public.audit_feedback_screenshot_view(uuid)','EXECUTE'))::text$$,
  'false');

-- The quarantine alert, by trigger, for a sessionless writer too.
\o /dev/null
insert into public.feedback (id, user_id, organisation_id, category, message, route,
  screenshot_key, screenshot_mime, screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at)
values (:'fa_quar', :'pstd1', :'alpha_org', 'bug', 'eicar', '/org-alpha',
        'feedback/' || :'fa_quar', 'image/png', 68, 'quarantined', now());
\o
select fb.val('FA9 a quarantined screenshot files ONE upload_quarantined alert carrying the feedback id',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'feedback_id'=%L
              and organisation_id=%L$$, :'fa_quar', :'alpha_org'), '1');
select fb.val('FA9b ...and never the message',
  format($$select (summary not like '%%eicar%%' and not (details ? 'message'))::text
            from public.incident_alerts where details->>'feedback_id'=%L$$, :'fa_quar'), 'true');
select fb.val('FA10 a clean screenshot filed no alert',
  format($$select count(*)::text from public.incident_alerts where details->>'feedback_id'=%L$$, :'fa_shot'), '0');

-- ===========================================================================
-- § FS  THE BUCKET AND ITS FENCES
-- ===========================================================================
select fb.val('FS1 the feedback-screenshots bucket exists and is PRIVATE',
  $$select public::text from storage.buckets where id='feedback-screenshots'$$, 'false');
select fb.val('FS2 ...capped at 5 MiB',
  $$select file_size_limit::text from storage.buckets where id='feedback-screenshots'$$, '5242880');
select fb.val('FS3 ...images only (belt-and-braces behind the app''s sniff)',
  $$select array_to_string(allowed_mime_types, ',') from storage.buckets where id='feedback-screenshots'$$,
  'image/png,image/jpeg,image/webp,image/gif');
select fb.val('FS4 four RESTRICTIVE deny-all client fences name the bucket',
  $$select count(*)::text from pg_policy
     where polrelid='storage.objects'::regclass and not polpermissive
       and polname like 'feedback_screenshots_deny_client_%'$$, '4');

-- ===========================================================================
-- § FX  FEEDBACK DURING SUPPORT ACCESS -- FOUNDER RULING Q121
--
-- Task 6's fix round hid the control and refused the submission; Q121 reverses
-- that. The row is ACCEPTED with no workspace and labelled "sent during
-- support access", and the LABEL is the thing that must not be forgeable --
-- it tells the founder "this row is mine, from inside a customer's workspace",
-- which is Task 6's I1 bug class on a new column.
--
-- Everything here is driven from the position the attacker holds: a real
-- session's claims under `set role authenticated`, which is what a PostgREST
-- request becomes. The app's own layout and server action are not in the
-- picture at all, deliberately -- a direct INSERT runs neither.
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as fx_member    \gset
select gen_random_uuid()::text as fx_forge     \gset
select gen_random_uuid()::text as fx_support   \gset
select gen_random_uuid()::text as fx_expired   \gset
select gen_random_uuid()::text as fx_named     \gset
select gen_random_uuid()::text as fx_ownpage   \gset
select gen_random_uuid()::text as fx_otherorg  \gset
select gen_random_uuid()::text as fx_session   \gset
\o

select fb.val('FX1 FIXTURE: `super` holds NO membership of BETA -- the workspace it will impersonate',
  format($$select count(*)::text from public.organisation_memberships
            where organisation_id=%L and user_id=%L$$, :'beta_org', :'super'), '0');
select fb.val('FX2 FIXTURE: no impersonation session is live for `super` yet',
  format($$select count(*)::text from public.impersonation_sessions
            where superuser_user_id=%L and status='active' and expires_at > now()$$, :'super'), '0');
select fb.val('FX3 `during_support_access` is OUTSIDE the authenticated INSERT grant',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public' and table_name='feedback'
       and grantee='authenticated' and privilege_type='INSERT'
       and column_name='during_support_access'$$, '0');

-- ---- A MEMBER, NOT IMPERSONATING -----------------------------------------
set role authenticated;
set request.jwt.claims = :'pstd1_c';

select fb.try('FX4 a member may still submit with NO workspace (/invites, /onboarding)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'idea', 'An invite screen idea.', '/invites')$$, :'fx_member'),
  'ok(1)');
-- THE FORGERY. A member who names the column at all is refused by the GRANT,
-- before any trigger runs -- the user_id/status precedent, and the reason the
-- label cannot be planted by a stripped form post or a raw PostgREST INSERT.
select fb.try('FX6 a member CANNOT name during_support_access -- 42501 at the column grant',
  format($$insert into public.feedback (id, organisation_id, category, message, route, during_support_access)
           values (%L, null, 'idea', 'I am the operator, honest.', '/invites', true)$$, :'fx_forge'),
  'denied(42501)');
-- And a member cannot mint themselves a session to become one, either: the
-- label's whole premise is a row on a table no member may write.
select fb.try('FX8 a member cannot create an impersonation session to earn the label',
  format($$insert into public.impersonation_sessions
             (superuser_user_id, target_organisation_id, reason, status,
              admin_accepted_by, accepted_at, started_at, expires_at)
           values (%L, %L, 'let me in', 'active', %L, now(), now(), now() + interval '1 hour')$$,
         :'pstd1', :'alpha_org', :'pstd1'),
  'denied(42501)');

reset role; reset request.jwt.claims;

-- READ BACK AS `postgres`, DELIBERATELY. A submitter has no SELECT policy on
-- their own row (Q103), so the same two reads taken inside the session return
-- <null> and 0 WHATEVER LANDED -- which is a test that passes while the thing
-- is broken. Measured the hard way after FX5 did exactly that on the first
-- run of this section.
select fb.val('FX5 ...and that row is NOT labelled -- an absent workspace is not support access',
  format($$select during_support_access::text from public.feedback where id=%L$$, :'fx_member'),
  'false');
select fb.val('FX7 ...and the forged-label attempt left NO row',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fx_forge'), '0');
select fb.val('FX7b DENOMINATOR: the same read DOES see the accepted row, so FX7''s 0 means something',
  format($$select count(*)::text from public.feedback where id=%L$$, :'fx_member'), '1');

-- ---- THE OPERATOR, INSIDE A LIVE SUPPORT-ACCESS SESSION -------------------
-- Planted as `postgres`: the RPCs that normally create this row are Task 2's
-- and are proved in rls_phase7_impersonation.sql. What is under test here is
-- what the LABEL reads off, not how the session is granted.
\o /dev/null
insert into public.impersonation_sessions
  (id, superuser_user_id, target_organisation_id, reason, status,
   admin_accepted_by, accepted_at, started_at, expires_at)
values (:'fx_session', :'super', :'beta_org', 'Task 6c suite: the Q121 label.',
        'active', :'pbowner', now(), now(), now() + interval '1 hour');
\o

set role authenticated;
set request.jwt.claims = :'super_c';

select fb.val('FX9 private.is_impersonating() is TRUE for the operator in a live session',
  $$select private.is_impersonating()::text$$, 'true');
select fb.try('FX10 the operator submits with no workspace, and it is ACCEPTED (Q121)',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'bug', 'The venue picker loses its filter here too.',
                   '/org-beta/venues')$$, :'fx_support'),
  'ok(1)');
select fb.val('FX11 ...and the DATABASE labelled it, with no column supplied',
  format($$select during_support_access::text from public.feedback where id=%L$$, :'fx_support'),
  'true');
select fb.val('FX12 ...with the route the operator was on, and still no workspace',
  format($$select coalesce(organisation_id::text,'<none>') || ' ' || route
            from public.feedback where id=%L$$, :'fx_support'),
  '<none> /org-beta/venues');
select fb.val('FX13 ...attributed to the operator, like every other submission',
  format($$select (user_id = %L)::text from public.feedback where id=%L$$, :'super', :'fx_support'),
  'true');
-- SUPPORT ACCESS STILL CANNOT CLAIM THE WORKSPACE. The reversal changed where
-- the row lands, not what an impersonator may assert about a tenant.
-- ---- FIX ROUND 1, M2: THE LABEL IS ABOUT THE REQUEST, NOT THE PERSON ------
-- Before the fix the label read off private.is_impersonating(), which asks
-- only "does this caller hold a live session ANYWHERE". So the operator's own
-- feedback from /super/feedback -- about the dashboard, nothing to do with a
-- customer -- was stamped "Sent during support access" for as long as some
-- session was open in another tab. Same session as FX10 above, still live;
-- the only thing that differs is the page the operator was on.
select fb.try('FX19 the SAME live session, submitting from /super -- accepted',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'idea', 'The feedback list wants a date filter.', '/super/feedback')$$,
         :'fx_ownpage'),
  'ok(1)');
select fb.val('FX20 ...and NOT labelled: the operator''s own screens are not a customer''s workspace',
  format($$select during_support_access::text from public.feedback where id=%L$$, :'fx_ownpage'),
  'false');
-- And a route naming a DIFFERENT workspace than the one under session is not
-- support access either -- the scoping is to the impersonated organisation,
-- not to "any slug-shaped first segment".
select fb.try('FX21 a route naming a workspace this session does NOT cover -- accepted',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'bug', 'Typed a slug I am not inside.', '/org-alpha/venues')$$,
         :'fx_otherorg'),
  'ok(1)');
select fb.val('FX22 ...and NOT labelled',
  format($$select during_support_access::text from public.feedback where id=%L$$, :'fx_otherorg'),
  'false');
select fb.val('FX23 DENOMINATOR: the route-scoped predicate IS true for the impersonated workspace',
  $$select private.is_impersonating_route('/org-beta/venues')::text$$, 'true');
select fb.val('FX24 ...and false for the operator''s own area, same session, same instant',
  $$select private.is_impersonating_route('/super/feedback')::text$$, 'false');

select fb.try('FX14 the operator STILL cannot name the workspace they are inside',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, %L, 'bug', 'Attributed to them.', '/org-beta/venues')$$,
         :'fx_named', :'beta_org'),
  'denied(42501)');

reset role; reset request.jwt.claims;

-- ---- THE CLOCK IS THE GRANT, HERE TOO -------------------------------------
-- Q95: an expired session reads `active` in the column and grants nothing.
-- The label follows the same rule, or it would outlive the access it names.
\o /dev/null
update public.impersonation_sessions set expires_at = now() - interval '1 minute'
 where id = :'fx_session';
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select fb.val('FX15 an EXPIRED session is not impersonation -- the time-box is evaluated live',
  $$select private.is_impersonating()::text$$, 'false');
select fb.try('FX16 ...so a submission from it is accepted and NOT labelled',
  format($$insert into public.feedback (id, organisation_id, category, message, route)
           values (%L, null, 'other', 'After the session lapsed.', '/super')$$, :'fx_expired'),
  'ok(1)');
select fb.val('FX17 ...unlabelled, measured',
  format($$select during_support_access::text from public.feedback where id=%L$$, :'fx_expired'),
  'false');
reset role; reset request.jwt.claims;

select fb.val('FX18 exactly ONE labelled row exists in the whole table',
  $$select count(*)::text from public.feedback where during_support_access$$, '1');

-- ===========================================================================
-- § FZ  HOUSEKEEPING
-- ===========================================================================
\o /dev/null
delete from public.incident_alerts
 where (details->>'category'='feedback' and details->>'subject_id' in (:'pstd1', :'pstd2', :'super'))
    or details->>'feedback_id' in (:'fa_quar', :'fa_shot');
delete from public.audit_events where target_type='feedback';
-- § FX added `super` as a submitter (the operator's own support-access row)
-- and one planted impersonation session; both go back the way they came.
delete from public.feedback where user_id in (:'pstd1', :'pstd2', :'super');
delete from public.rate_limit_counters where category='feedback' and subject_id in (:'pstd1', :'pstd2', :'super');
delete from public.impersonation_sessions where id = :'fx_session';
-- storage.protect_delete() refuses a direct DELETE on storage.objects unless
-- this GUC is set (the Storage API sets it for its own deletes). The planted
-- row above never had bytes behind it, so the API cannot be asked; the guard
-- is lifted for exactly this statement and put back.
set storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id='feedback-screenshots' and name='feedback/' || :'fi_withobj';
reset storage.allow_delete_query;
\o
select fb.val('FZ6 the planted storage object is gone',
  format($$select count(*)::text from storage.objects where bucket_id='feedback-screenshots' and name='feedback/%s'$$, :'fi_withobj'), '0');
select fb.val('FZ1 no feedback rows this suite created remain',
  format($$select count(*)::text from public.feedback where user_id in (%L,%L,%L)$$,
         :'pstd1', :'pstd2', :'super'), '0');
select fb.val('FZ2 no feedback counters remain',
  format($$select count(*)::text from public.rate_limit_counters
            where category='feedback' and subject_id in (%L,%L,%L)$$,
         :'pstd1', :'pstd2', :'super'), '0');
select fb.val('FZ7 the planted impersonation session is gone',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'fx_session'), '0');
select fb.val('FZ3 the alert table is back to the denominator § FB found',
  format($$select ((select count(*) from public.incident_alerts) = %L::bigint)::text$$, :'alerts_before'), 'true');
select fb.val('FZ4 the feedback audit rows are back to the denominator',
  format($$select ((select count(*) from public.audit_events where target_type='feedback') = %L::bigint)::text$$,
         :'audit_before'), 'true');
select fb.val('FZ5 ALPHA is still active and untouched',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$, :'alpha_org'), 'true');

\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from fb.results order by seq;
select count(*) filter (where not pass) as failures, count(*) as total from fb.results;
