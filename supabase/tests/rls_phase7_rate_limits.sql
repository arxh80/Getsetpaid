-- ===========================================================================
-- Phase 7 Task 5 (Rate limiting + incident alerts + platform health) suite.
--
-- Covers 20260909020000_rate_limiting_and_incident_alerts.sql:
--   public.rate_limit_policies              THE one place a limit's value lives
--   public.rate_limit_counters              fixed-window counters
--   public.incident_alerts                  platform-scoped alert store
--   private.rate_limit_window_start()       the window arithmetic
--   private.record_rate_limit_event()       the limiter core + crossing write
--   public.consume_rate_limit()             the session-facing wrapper
--   public.hook_password_verification_attempt()   the per-account login lockout
--   private.document_quarantine_alert()     the malware-hit trigger
--   private.incident_alert_resolution_guard()     the resolve column gate
--   public.platform_health_snapshot()       the /super/health read
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs LAST of the psql suites, after rls_phase7_overrides.sql, and
--   reuses the SAME fixtures whole -- the twelve Phase 2 users, orgs ALPHA
--   and BETA, plus `super`. It plants NOTHING in a tenant table except one
--   document in § RQ, which § RZ deletes; every counter and alert it creates
--   is deleted at § RZ too, so the HTTP block below still runs against the
--   state it was written against.
--
-- IT USES ITS OWN `rl` SCHEMA, so a Task 5 failure is not reported under a
-- Task 4 heading. The helpers are rls_phase7_overrides.sql's `ov.*`, verbatim,
-- with the schema renamed.
--
-- ===========================================================================
-- THE ONE THING THIS SUITE CANNOT PROVE, STATED UP FRONT
-- ===========================================================================
-- It proves the DATABASE half: the values, the arithmetic, the verdict, the
-- crossing write, the visibility boundaries and the login lockout's state
-- machine. It does NOT prove that the application obeys a verdict -- that is
-- tests/integration/rls/rate-limits.test.ts (the 31st network-directory read
-- refused through the real enforcement point) and tests/e2e/health.spec.ts.
-- A suite that proved only this half would be consistent with an app that
-- called consume_rate_limit() and ignored the answer.
--
-- SECTIONS:
--   RF  fixtures and their sanity
--   RV  THE VALUES -- SECURITY.md § 5's table, row by row, against the seed
--   RW  window arithmetic: same bin, boundary, epoch alignment
--   RC  counter integrity: increment, refusals counted, stale-window cleanup
--   RS  consume_rate_limit(): scope binding, membership, refusal at max+1
--   RA  incident_alerts: exactly-once crossing, visibility, the resolve gate
--   RH  the login hook: lockout, correct-password-still-rejected, reset
--   RQ  the malware-quarantine trigger
--   RP  platform_health_snapshot(): guarded, self-auditing, aggregate-only
--   RD  DELIVERY (Task 6c): the pg_cron clock (Q118) and the account-holder
--       lockout seam (Q114) -- including the two structural caps
--   RZ  housekeeping
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   denied(22023)  rejected by an explicit validation.
--   denied(28000)  rejected for having no session at all.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- psql vars required (supplied by run-rls-tests.sh's P7VARS).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists rl cascade;
create schema rl;

create table rl.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function rl.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into rl.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function rl.try(p_label text, p_sql text, p_expected text)
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
  perform rl.record(p_label, p_expected, v_actual);
end $$;

create function rl.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform rl.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema rl to authenticated, anon, service_role;
grant execute on function rl.record(text,text,text) to authenticated, anon, service_role;
grant execute on function rl.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function rl.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
-- A subject id that belongs to no real user, for the counter/window sections:
-- those assertions are about ARITHMETIC, and binding them to a fixture user
-- would make them fail for a second reason (a stray counter from an earlier
-- section) that has nothing to do with what they measure.
select '00000000-0000-4000-8000-0000000000a1'::uuid as synth_a \gset
select '00000000-0000-4000-8000-0000000000a2'::uuid as synth_b \gset
\o

-- ===========================================================================
-- § RF  FIXTURES AND THEIR SANITY
-- ===========================================================================
select rl.val('RF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select rl.val('RF2 FIXTURE: ALPHA is ACTIVE',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'alpha_org'), 'true');
select rl.val('RF3 FIXTURE: no counters exist for the synthetic subjects yet',
  format($$select count(*)::text from public.rate_limit_counters
            where subject_id in (%L,%L)$$, :'synth_a', :'synth_b'), '0');

-- The alert denominator every "exactly once" assertion below measures
-- against. Taken now, so the suite is honest about alerts raised by EARLIER
-- suites (the lifecycle/overrides suites touch documents not at all, but
-- assuming zero is the kind of assumption that turns into a false green).
\o /dev/null
select count(*) as alerts_before from public.incident_alerts \gset
\o
select rl.val('RF4 FIXTURE: the alert denominator is readable',
  format($$select (%L::int >= 0)::text$$, (:'alerts_before')::text), 'true');

-- ===========================================================================
-- § RV  THE VALUES -- SECURITY.md § 5's TABLE, ROW BY ROW
--
-- THIS IS THE SECTION THAT MAKES "config lives in one place" TRUE. The brief
-- names the § 5 table as the requirement itself, so each row is asserted
-- against the seed literally rather than through a helper that could be wrong
-- in the same direction as the seed. If somebody edits a limit in a later
-- migration without editing SECURITY.md, this fails and names the row.
-- ===========================================================================
select rl.val('RV1 Login: 5 attempts / 15 min, per account',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='login_account'$$,
  '5/900/account');
select rl.val('RV2 Password recovery: 3 / hour, per account',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='password_recovery'$$,
  '3/3600/account');
select rl.val('RV3 Search: 60 / min, per user',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='search'$$,
  '60/60/user');
select rl.val('RV4 Exports: 5 / hour, per organisation',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='exports'$$,
  '5/3600/organisation');
select rl.val('RV5 Network discovery: 30 / min, per user -- ITS OWN CATEGORY',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='network_discovery'$$,
  '30/60/user');
select rl.val('RV6 In-app feedback: 10 / hour, per user',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='feedback'$$,
  '10/3600/user');
select rl.val('RV6a Connection requests: 10 / hour, per ORGANISATION (Q79 spam, Q112)',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='network_connection_request'$$,
  '10/3600/organisation');
-- ORG-SCOPED IS THE LOAD-BEARING HALF of that row and gets its own assertion:
-- a per-USER budget is bypassed by inviting a colleague (seats are cheap, six
-- roles hold manage_network_connections), and the pestered organisation
-- experiences one WORKSPACE, not one person. A future edit that "simplifies"
-- this to 'user' would look tidy and would reopen the vector.
select rl.val('RV6b ...and it is org-scoped, not user-scoped, deliberately',
  $$select subject_scope from public.rate_limit_policies
     where category='network_connection_request'$$, 'organisation');
-- Phase 8 Task 2 (20260923000000): consent GRANTS, 10 / hour per user,
-- enforced at the insert. Withdrawals are never metered (SECURITY.md § 5).
select rl.val('RV6c Consent grants: 10 / hour, per user (Phase 8 Task 2)',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='consent_grant'$$,
  '10/3600/user');
-- EIGHT ROWS AND NO MORE (seven until Phase 8 Task 2 added consent_grant --
-- which turned this assertion red until the row above and SECURITY.md § 5
-- were written, exactly as designed). A ninth category appearing without a
-- § 5 row is the drift this assertion exists to catch, in the direction the
-- others cannot.
select rl.val('RV7 the policy table holds exactly the eight § 5 categories',
  $$select count(*)::text from public.rate_limit_policies$$, '8');
-- network_discovery must never be folded into search (FOLLOW-UPS:3408-3419):
-- its unit cost is O(platform-wide published rows), not O(tenant).
select rl.val('RV8 network_discovery is a DISTINCT category from search',
  $$select (
      (select max_requests from public.rate_limit_policies where category='network_discovery')
      <> (select max_requests from public.rate_limit_policies where category='search')
    )::text$$, 'true');

-- Nobody may write the values from a client path. They change by migration.
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.try('RV9 not even the SUPERUSER may UPDATE a limit value',
  $$update public.rate_limit_policies set max_requests = 9999 where category='search'$$,
  'denied(42501)');
select rl.try('RV10 ...nor INSERT a new category',
  $$insert into public.rate_limit_policies
      (category, subject_scope, max_requests, window_seconds, description)
    values ('smuggled','user',1,1,'x')$$,
  'denied(42501)');
select rl.val('RV11 the superuser CAN read the configuration, all eight rows (the health view states it)',
  $$select count(*)::text from public.rate_limit_policies$$, '8');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select rl.val('RV12 an ordinary member reads ZERO policy rows (a limit is learned by being refused)',
  $$select count(*)::text from public.rate_limit_policies$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § RW  THE WINDOW ARITHMETIC, IN ISOLATION
--
-- Separated from the consume path deliberately (the function is IMMUTABLE and
-- has its own name) so the boundary behaviour is testable without a counter
-- row in the way.
-- ===========================================================================
select rl.val('RW1 two instants inside one 60s bin share a window_start',
  $$select (private.rate_limit_window_start('2026-09-09 12:00:00.000+00'::timestamptz, 60)
          = private.rate_limit_window_start('2026-09-09 12:00:59.999+00'::timestamptz, 60))::text$$,
  'true');
select rl.val('RW2 one microsecond ACROSS the boundary starts a new window',
  $$select (private.rate_limit_window_start('2026-09-09 12:00:59.999999+00'::timestamptz, 60)
          < private.rate_limit_window_start('2026-09-09 12:01:00.000000+00'::timestamptz, 60))::text$$,
  'true');
select rl.val('RW3 the bin is EPOCH-aligned, not first-request-aligned',
  $$select private.rate_limit_window_start('2026-09-09 12:00:37+00'::timestamptz, 60)
             at time zone 'UTC'$$,
  '2026-09-09 12:00:00');
select rl.val('RW4 a 900s (15 min) window bins to the quarter hour',
  $$select private.rate_limit_window_start('2026-09-09 12:07:37+00'::timestamptz, 900)
             at time zone 'UTC'$$,
  '2026-09-09 12:00:00');
select rl.val('RW5 ...and the next quarter hour is a different window',
  $$select private.rate_limit_window_start('2026-09-09 12:15:00+00'::timestamptz, 900)
             at time zone 'UTC'$$,
  '2026-09-09 12:15:00');
select rl.val('RW6 a 3600s window bins to the hour',
  $$select private.rate_limit_window_start('2026-09-09 12:59:59+00'::timestamptz, 3600)
             at time zone 'UTC'$$,
  '2026-09-09 12:00:00');
-- The arithmetic is private. A client role that could call it directly could
-- not do any harm with it, but the grant surface is asserted anyway: the
-- house rule is that private helpers are not API.
select rl.val('RW7 private.rate_limit_window_start() is NOT executable by `authenticated`',
  $$select has_function_privilege('authenticated',
      'private.rate_limit_window_start(timestamptz,integer)', 'EXECUTE')::text$$,
  'false');

-- ===========================================================================
-- § RC  COUNTER INTEGRITY
--
-- Driven as `postgres` through private.record_rate_limit_event() directly --
-- the core, without the session wrapper -- because these assertions are about
-- the counter, not about who may reach it. § RS covers the wrapper.
-- ===========================================================================
select rl.val('RC1 the first event in a window counts 1 and is ALLOWED',
  format($$select allowed || '/' || request_count
             from private.record_rate_limit_event('search','user',%L)$$, :'synth_a'),
  'true/1');
select rl.val('RC2 the second counts 2',
  format($$select request_count::text
             from private.record_rate_limit_event('search','user',%L)$$, :'synth_a'),
  '2');
select rl.val('RC3 exactly ONE counter row exists for this subject',
  format($$select count(*)::text from public.rate_limit_counters
            where category='search' and subject_id=%L$$, :'synth_a'),
  '1');
select rl.val('RC4 ...and it holds the count, not a row per request',
  format($$select request_count::text from public.rate_limit_counters
            where category='search' and subject_id=%L$$, :'synth_a'),
  '2');

-- REFUSALS ARE COUNTED. The migration's header gives both reasons: the count
-- then measures PRESSURE rather than permitted traffic, and the exactly-once
-- alert-at-crossing write only works if the crossing request's own increment
-- commits.
\o /dev/null
-- Spend the whole 30-request network_discovery budget on synth_b, then two
-- more. generate_series drives it so the assertion below is about the 31st
-- and 32nd specifically.
select private.record_rate_limit_event('network_discovery','user',:'synth_b')
  from generate_series(1,30);
\o
select rl.val('RC5 the 30th request (the limit) is still ALLOWED',
  format($$select allowed::text from public.rate_limit_counters c
             cross join lateral (select c.request_count <= 30 as allowed) x
            where c.category='network_discovery' and c.subject_id=%L$$, :'synth_b'),
  'true');
select rl.val('RC6 the 31st is REFUSED',
  format($$select allowed::text
             from private.record_rate_limit_event('network_discovery','user',%L)$$, :'synth_b'),
  'false');
select rl.val('RC7 ...and the refusal was COUNTED (31, not clamped at 30)',
  format($$select request_count::text from public.rate_limit_counters
            where category='network_discovery' and subject_id=%L$$, :'synth_b'),
  '31');
select rl.val('RC8 the 32nd is refused too, and counting continues (pressure, not a clamp)',
  format($$select allowed || '/' || request_count
             from private.record_rate_limit_event('network_discovery','user',%L)$$, :'synth_b'),
  'false/32');
select rl.val('RC9 retry_after_seconds is inside the window, never negative',
  format($$select (retry_after_seconds between 0 and 60)::text
             from private.record_rate_limit_event('network_discovery','user',%L)$$, :'synth_b'),
  'true');

-- OPPORTUNISTIC CLEANUP, the no-scheduler pattern: a subject's dead windows go
-- when the subject next shows up.
\o /dev/null
insert into public.rate_limit_counters
  (category, subject_scope, subject_id, window_start, request_count)
values ('search','user',:'synth_a',
        private.rate_limit_window_start(now(), 60) - interval '10 minutes', 99);
\o
select rl.val('RC10 a stale window row exists before the next consume',
  format($$select count(*)::text from public.rate_limit_counters
            where category='search' and subject_id=%L$$, :'synth_a'),
  '2');
\o /dev/null
select private.record_rate_limit_event('search','user',:'synth_a');
\o
select rl.val('RC11 ...and the next consume SWEPT it, leaving only the live window',
  format($$select count(*)::text from public.rate_limit_counters
            where category='search' and subject_id=%L$$, :'synth_a'),
  '1');

-- Caller-bug validation. These DO raise (unlike a refusal, which returns a
-- verdict), because they mean the calling code is wrong, not that a user is
-- going too fast.
select rl.try('RC12 an unknown category raises 22023',
  format($$select * from private.record_rate_limit_event('not_a_category','user',%L)$$, :'synth_a'),
  'denied(22023)');
select rl.try('RC13 a scope that disagrees with the policy raises 22023',
  format($$select * from private.record_rate_limit_event('search','organisation',%L)$$, :'synth_a'),
  'denied(22023)');
select rl.try('RC14 a null subject raises 22023',
  $$select * from private.record_rate_limit_event('search','user',null)$$,
  'denied(22023)');

-- THE COUNTERS ARE NOT CLIENT-WRITABLE. Every write path is a definer
-- function; a client that could INSERT could zero its own budget.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select rl.try('RC15 a member cannot INSERT a counter row',
  format($$insert into public.rate_limit_counters
             (category, subject_scope, subject_id, window_start)
           values ('search','user',%L, now())$$, :'pmanager'),
  'denied(42501)');
select rl.try('RC16 ...nor UPDATE one down',
  $$update public.rate_limit_counters set request_count = 0$$,
  'denied(42501)');
select rl.try('RC17 ...nor DELETE one',
  $$delete from public.rate_limit_counters$$,
  'denied(42501)');
select rl.val('RC18 ...nor READ anybody''s counters, their own included',
  $$select count(*)::text from public.rate_limit_counters$$, '0');
select rl.try('RC19 ...nor reach the definer core directly',
  format($$select * from private.record_rate_limit_event('search','user',%L)$$, :'pmanager'),
  'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.val('RC20 the SUPERUSER reads counters (the abuse half of the health view)',
  format($$select (count(*) > 0)::text from public.rate_limit_counters
            where subject_id in (%L,%L)$$, :'synth_a', :'synth_b'),
  'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § RS  consume_rate_limit() -- THE SESSION-FACING WRAPPER
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select rl.val('RS1 a member consumes their OWN search budget and is allowed',
  $$select allowed::text from public.consume_rate_limit('search')$$, 'true');
reset role; reset request.jwt.claims;
select rl.val('RS2 ...and the counter it wrote is keyed on THAT user, not on a supplied id',
  format($$select count(*)::text from public.rate_limit_counters
            where category='search' and subject_scope='user' and subject_id=%L$$, :'pmanager'),
  '1');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
-- ACCOUNT-SCOPED CATEGORIES ARE NOT CONSUMABLE FROM A SESSION. Letting a
-- signed-in attacker burn the login budget of an account they already control
-- would let them lock it into looking attacked -- and worse, a stranger who
-- learned a user id could lock that user out.
select rl.try('RS3 login_account is REFUSED from a client session (42501)',
  $$select * from public.consume_rate_limit('login_account')$$, 'denied(42501)');
select rl.try('RS4 password_recovery likewise',
  $$select * from public.consume_rate_limit('password_recovery')$$, 'denied(42501)');
select rl.try('RS5 an unknown category is a caller bug (22023)',
  $$select * from public.consume_rate_limit('not_a_category')$$, 'denied(22023)');
select rl.try('RS6 an organisation-scoped category with no organisation is a caller bug',
  $$select * from public.consume_rate_limit('exports')$$, 'denied(22023)');
select rl.val('RS7 a member CAN spend their OWN organisation''s export budget',
  format($$select allowed::text from public.consume_rate_limit('exports',%L)$$, :'alpha_org'),
  'true');
-- The DoS-through-the-limiter hole: without the membership check, any
-- authenticated stranger could exhaust another tenant's export allowance.
-- Q79/Q112's budget rides the SAME org-scoped path, so it inherits both
-- guards. Asserted rather than argued: the wrapper decides scope from the
-- POLICY ROW, so a future edit that flipped this category to 'user' would
-- silently reopen the invite-a-colleague bypass and nothing else would notice.
select rl.try('RS7a network_connection_request needs an organisation too (22023)',
  $$select * from public.consume_rate_limit('network_connection_request')$$,
  'denied(22023)');
select rl.val('RS7b ...and a member CAN spend their own workspace''s request budget',
  format($$select allowed::text
             from public.consume_rate_limit('network_connection_request',%L)$$,
         :'alpha_org'),
  'true');
select rl.try('RS7c ...but NOT a foreign workspace''s (42501) -- no framing another org',
  format($$select * from public.consume_rate_limit('network_connection_request',%L)$$,
         :'beta_org'),
  'denied(42501)');
select rl.try('RS8 ...but NOT a foreign organisation''s (42501)',
  format($$select * from public.consume_rate_limit('exports',%L)$$, :'beta_org'),
  'denied(42501)');

-- ---------------------------------------------------------------------------
-- FIX ROUND 1, REVIEW FINDING I1 -- THE COLUMN RS7c STOPPED ONE SHORT OF.
--
-- RS7c proves a foreign organisation cannot be named on an ORGANISATION-scoped
-- category. Nothing asserted the USER-scoped combination, and that was the one
-- that worked: the wrapper validated p_organisation_id only on the
-- organisation branch and passed it through to the core -- and therefore into
-- incident_alerts.organisation_id -- on every other. A manager of ALPHA could
-- file 61 `search` calls naming BETA and produce an alert the operator reads
-- as "BETA tripped a rate limit", with /super/health rendering the workspace
-- NAME and nothing else. Organisation ids are harvestable
-- (network_profiles.organisation_id is SELECT-granted to `authenticated`
-- under the cross-tenant directory policy, and RLS filters rows not columns),
-- so this was targeted, not guesswork.
--
-- RS7d is the assertion that FAILS against the old function: it returned
-- ok(1)/true.
-- ---------------------------------------------------------------------------
select rl.try('RS7d a user-scoped category naming a FOREIGN workspace is a caller bug (22023) -- I1',
  format($$select * from public.consume_rate_limit('search',%L)$$, :'beta_org'),
  'denied(22023)');
select rl.try('RS7e ...and naming your OWN workspace is refused too -- the attribution is not the caller''s to supply',
  format($$select * from public.consume_rate_limit('network_discovery',%L)$$, :'alpha_org'),
  'denied(22023)');
reset role; reset request.jwt.claims;

-- A REAL user-scoped crossing, so the null attribution is measured on a live
-- alert row rather than argued from the source. The counter is cleared first:
-- § RS1 already spent one `search` unit and a fixed window that turned over
-- between then and here would leave the burst one short of its own crossing.
\o /dev/null
delete from public.rate_limit_counters where category='search' and subject_id=:'pmanager';
delete from public.incident_alerts
 where alert_type='rate_limit_tripped' and details->>'subject_id' = :'pmanager';
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
\o /dev/null
do $$ begin for i in 1..61 loop perform 1 from public.consume_rate_limit('search'); end loop; end $$;
\o
reset role; reset request.jwt.claims;
select rl.val('RS7f a user-scoped crossing files exactly one alert',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$,
         :'pmanager'),
  '1');
select rl.val('RS7g ...and it is attributed to NO workspace -- null, which /super/health says in words',
  format($$select (organisation_id is null)::text from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$,
         :'pmanager'),
  'true');
select rl.val('RS7h ...while still recording WHAT it was about (details.subject_scope)',
  format($$select details->>'subject_scope' from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$,
         :'pmanager'),
  'user');

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select rl.try('RS9 a FOREIGN organisation''s Owner cannot spend ALPHA''s export budget either',
  format($$select * from public.consume_rate_limit('exports',%L)$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- NO SESSION: refused, never a silent allow. Measured from the `authenticated`
-- role with no JWT claims, which is the only way to reach the wrapper's own
-- no-session branch -- as `anon` the EXECUTE grant is checked FIRST and the
-- call dies at 42501 before a line of the body runs (RS10b), so an anon probe
-- would prove the grant and leave the 28000 branch unmeasured.
set role authenticated;
reset request.jwt.claims;
select rl.try('RS10 with NO session the wrapper refuses (28000), never fails open',
  $$select * from public.consume_rate_limit('search')$$, 'denied(28000)');
reset role;
set role anon;
select rl.try('RS10b `anon` never reaches the body at all -- 42501 at the grant',
  $$select * from public.consume_rate_limit('search')$$, 'denied(42501)');
reset role;
select rl.val('RS11 `anon` holds no EXECUTE on the wrapper at all',
  $$select has_function_privilege('anon','public.consume_rate_limit(text,uuid)','EXECUTE')::text$$,
  'false');
select rl.val('RS12 `authenticated` does',
  $$select has_function_privilege('authenticated','public.consume_rate_limit(text,uuid)','EXECUTE')::text$$,
  'true');

-- ---------------------------------------------------------------------------
-- FIX ROUND 1, REVIEW FINDING I2 -- THE CONNECTION-REQUEST BUDGET IS ENFORCED
-- AT THE WRITE, NOT ONLY IN THE APPLICATION.
--
-- The behaviour is proved through the actual bypass in
-- tests/integration/security/connection-request-budget.test.ts (a real
-- supabase-js client POSTing straight to PostgREST, eleven times). What
-- belongs HERE is the structure that test depends on: the grant is still
-- there (so the trigger is the meter rather than a revoked grant pretending
-- to be one), and the trigger is BEFORE INSERT on the table itself, so no
-- writer -- the app's form, a stripped-form post, a raw INSERT -- can be
-- reached by a path that skips it.
-- ---------------------------------------------------------------------------
select rl.val('RS13 `authenticated` still holds INSERT on network_connection_requests',
  $$select has_table_privilege('authenticated','public.network_connection_requests','INSERT')::text$$,
  'true');
select rl.val('RS14 ...and a BEFORE INSERT trigger meters every one of them -- I2',
  $$select count(*)::text from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.network_connection_requests'::pg_catalog.regclass
       and t.tgname = 'meter_connection_request'
       and not t.tgisinternal
       and (t.tgtype & 2) = 2      -- BEFORE
       and (t.tgtype & 4) = 4$$,   -- INSERT
  '1');
select rl.val('RS15 ...calling the metering function, not something else',
  $$select p.proname from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.network_connection_requests'::pg_catalog.regclass
       and t.tgname = 'meter_connection_request'$$,
  'meter_connection_request');

-- ===========================================================================
-- § RA  INCIDENT ALERTS
-- ===========================================================================
-- THE EXACTLY-ONCE CROSSING. synth_b crossed its network_discovery limit in
-- § RC (at request 31) and was refused twice more after that. Exactly one
-- alert should exist for that subject/window.
select rl.val('RA1 crossing the limit filed EXACTLY ONE alert for that subject',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='rate_limit_tripped'
              and details->>'subject_id' = %L$$, :'synth_b'),
  '1');
select rl.val('RA2 ...and it names the category and the limit, not a record',
  format($$select (details->>'category') || '/' || (details->>'max_requests')
             from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$, :'synth_b'),
  'network_discovery/30');
select rl.val('RA3 the alert arrives UNRESOLVED and UNNOTIFIED (Task 6''s email seam)',
  format($$select (resolved_at is null) || '/' || (notified_at is null)
             from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$, :'synth_b'),
  'true/true');
-- The summary is a TEMPLATE, never user-entered content: this table renders
-- on a platform surface, so the same allowlist-of-identifiers discipline
-- audit_events payloads keep applies here.
select rl.val('RA4 the summary carries no subject id, filename or free text',
  format($$select (summary not like '%%'||%L||'%%')::text from public.incident_alerts
            where alert_type='rate_limit_tripped' and details->>'subject_id' = %L$$,
         :'synth_b', :'synth_b'),
  'true');

-- VISIBILITY. Platform-scoped: superuser reads, nobody else does -- not a
-- member, not an Owner, not the aal1 form of the superuser themselves.
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.val('RA5 the SUPERUSER reads incident alerts',
  $$select (count(*) > 0)::text from public.incident_alerts$$, 'true');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select rl.val('RA6 an ORG OWNER (aal2) reads ZERO',
  $$select count(*)::text from public.incident_alerts$$, '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select rl.val('RA7 an ordinary member reads ZERO',
  $$select count(*)::text from public.incident_alerts$$, '0');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select rl.val('RA8 the superuser at aal1 -- a stolen password with no factor -- reads ZERO',
  $$select count(*)::text from public.incident_alerts$$, '0');
reset role; reset request.jwt.claims;

-- NO CLIENT INSERT PATH AT ALL. The writers are the definer functions.
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.try('RA9 not even the superuser may INSERT an alert',
  $$insert into public.incident_alerts (alert_type, summary)
    values ('rate_limit_tripped','hand-written')$$,
  'denied(42501)');
select rl.try('RA10 ...nor DELETE one (an alert is evidence; resolving is the lifecycle)',
  $$delete from public.incident_alerts$$, 'denied(42501)');

-- THE RESOLVE GATE. RLS filters rows, not columns (the Q103 rule), so which
-- columns an update may touch is the guard trigger's job, not the policy's.
\o /dev/null
select id as trip_alert from public.incident_alerts
 where alert_type='rate_limit_tripped' and details->>'subject_id' = :'synth_b' \gset
\o
select rl.try('RA11 the superuser resolves an alert (resolved_at + own id)',
  format($$update public.incident_alerts
              set resolved_at = now(), resolved_by = %L where id = %L$$,
         :'super', :'trip_alert'),
  'ok(1)');
select rl.try('RA12 ...but cannot file the resolution under SOMEBODY ELSE''s id',
  format($$update public.incident_alerts
              set resolved_at = now(), resolved_by = %L where id = %L$$,
         :'powner', :'trip_alert'),
  'denied(42501)');
select rl.try('RA13 ...cannot rewrite the summary',
  format($$update public.incident_alerts set summary = 'rewritten' where id = %L$$,
         :'trip_alert'),
  'denied(42501)');
select rl.try('RA14 ...cannot re-point it at another organisation',
  format($$update public.incident_alerts set organisation_id = %L where id = %L$$,
         :'beta_org', :'trip_alert'),
  'denied(42501)');
select rl.try('RA15 ...cannot edit the details payload',
  format($$update public.incident_alerts set details = '{}'::jsonb where id = %L$$,
         :'trip_alert'),
  'denied(42501)');
-- notified_at is in the IMMUTABLE set on purpose: it belongs to Task 6's
-- server-side sender, not to the operator's browser. An operator who could
-- stamp it could silence an alert's email without sending one.
select rl.try('RA16 ...and cannot stamp notified_at -- that is Task 6''s delivery seam',
  format($$update public.incident_alerts set notified_at = now() where id = %L$$,
         :'trip_alert'),
  'denied(42501)');
select rl.try('RA17 un-resolving is allowed (a mis-click is reversible)',
  format($$update public.incident_alerts
              set resolved_at = null, resolved_by = null where id = %L$$, :'trip_alert'),
  'ok(1)');
-- ---------------------------------------------------------------------------
-- FIX ROUND 1, REVIEW FINDING I4 -- RESOLVING AUDITS ITSELF, AND A REOPEN
-- CANNOT ERASE WHO RESOLVED.
--
-- RA11 resolved this alert and RA17 reopened it, which is precisely the
-- sequence that used to leave the row reading `resolved_at = null,
-- resolved_by = null` with no record anywhere that it had ever been resolved.
-- `resolved_by` on the row was the stated compensating control for having no
-- audit row at all; RA17 is the branch that destroys it. Both transitions now
-- write to public.audit_events, from an AFTER UPDATE trigger rather than from
-- the server action -- because this table carries a client UPDATE grant and a
-- permissive superuser UPDATE policy, so a raw PATCH is a resolve path no call
-- site could cover.
-- ---------------------------------------------------------------------------
select rl.val('RA24 resolving wrote an incident_alert.resolved audit row -- I4',
  format($$select count(*)::text from public.audit_events
            where action='incident_alert.resolved' and target_id=%L$$, :'trip_alert'),
  '1');
select rl.val('RA25 ...and reopening wrote incident_alert.reopened',
  format($$select count(*)::text from public.audit_events
            where action='incident_alert.reopened' and target_id=%L$$, :'trip_alert'),
  '1');
-- THE ONE THAT MAKES THE TRAIL SURVIVE THE BRANCH THAT MOTIVATED IT: the
-- reopen's `before` carries the resolution it erased, so "who resolved this,
-- and when" is answerable after the columns are null.
select rl.val('RA26 ...carrying the resolver the reopen erased, in `before`',
  format($$select (before->>'resolved_by' = %L)::text from public.audit_events
            where action='incident_alert.reopened' and target_id=%L$$,
         :'super', :'trip_alert'),
  'true');
select rl.val('RA27 ...both attributed to the acting superuser, not to nobody',
  format($$select (bool_and(actor_user_id = %L))::text from public.audit_events
            where action in ('incident_alert.resolved','incident_alert.reopened')
              and target_id=%L$$, :'super', :'trip_alert'),
  'true');

-- ---------------------------------------------------------------------------
-- FIX ROUND 1, REVIEW FINDING I3 -- THE TASK 6 EMAIL SEAM HAS AN ACCESS PATH.
--
-- `notified_at` was designed as the delivery seam and `service_role` held NO
-- privilege on this table at all: `rolbypassrls` bypasses POLICIES, not table
-- PRIVILEGES, so Task 6's sender -- a server-side job with the service-role
-- key and no user session -- could neither read the unnotified rows nor stamp
-- one. 20260909070000 grants the minimum that makes it real, and these five
-- assertions are the shape of that minimum: the sender may read and may stamp
-- ONE COLUMN; it may not rewrite alert content; and the operator's half is
-- unchanged (RA16 above still refuses a client stamp).
-- ---------------------------------------------------------------------------
select rl.val('RA19 service_role can READ unnotified alerts -- Task 6''s first query',
  $$select has_table_privilege('service_role','public.incident_alerts','SELECT')::text$$,
  'true');
select rl.val('RA20 ...and can stamp notified_at',
  $$select has_column_privilege('service_role','public.incident_alerts','notified_at','UPDATE')::text$$,
  'true');
select rl.val('RA21 ...but cannot rewrite the summary (column-level grant, not table-level)',
  $$select has_column_privilege('service_role','public.incident_alerts','summary','UPDATE')::text$$,
  'false');
select rl.val('RA22 ...nor resolve one on the operator''s behalf',
  $$select has_column_privilege('service_role','public.incident_alerts','resolved_at','UPDATE')::text$$,
  'false');
select rl.val('RA23 ...nor INSERT or DELETE: the writers are still the definer functions',
  $$select (has_table_privilege('service_role','public.incident_alerts','INSERT')
            or has_table_privilege('service_role','public.incident_alerts','DELETE'))::text$$,
  'false');

reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select rl.try('RA18 an ORG OWNER''s resolve matches nothing (filtered by the policy)',
  format($$update public.incident_alerts set resolved_at = now(), resolved_by = %L
            where id = %L$$, :'powner', :'trip_alert'),
  'ok(0)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § RH  THE LOGIN HOOK -- SECURITY.md § 5's per-account half, ENFORCED
--
-- Driven as `postgres` calling the hook with the event shape GoTrue sends.
-- That is not a mock of the mechanism: it IS the mechanism -- GoTrue's only
-- contribution is to call this function and obey the returned decision, and
-- config.toml wires it. The end-to-end proof through real GoTrue was taken
-- by hand at implementation time (five wrong passwords pass through, the
-- sixth and a subsequent CORRECT one both come back "Too many failed sign-in
-- attempts") and is recorded in task-5-report.md; what a repeatable suite can
-- own is the state machine.
-- ===========================================================================
\o /dev/null
delete from public.rate_limit_counters where category='login_account' and subject_id=:'pstd1';
delete from public.incident_alerts
 where alert_type='repeated_login_failures' and details->>'subject_id' = :'pstd1';
\o
select rl.val('RH1 a FAILED attempt is allowed through to GoTrue''s own error',
  format($$select public.hook_password_verification_attempt(
             jsonb_build_object('user_id',%L,'valid',false))->>'decision'$$, :'pstd1'),
  'continue');
\o /dev/null
select public.hook_password_verification_attempt(
         jsonb_build_object('user_id',:'pstd1','valid',false)) from generate_series(1,4);
\o
select rl.val('RH2 five failures are counted',
  format($$select request_count::text from public.rate_limit_counters
            where category='login_account' and subject_id=%L$$, :'pstd1'),
  '5');
select rl.val('RH3 the SIXTH attempt is REJECTED -- the lockout',
  format($$select public.hook_password_verification_attempt(
             jsonb_build_object('user_id',%L,'valid',false))->>'decision'$$, :'pstd1'),
  'reject');
-- THE LOAD-BEARING ONE. A lockout that lifts for a correct password is not a
-- lockout: the brute force simply continues until it succeeds.
select rl.val('RH4 a CORRECT password is rejected too while locked out',
  format($$select public.hook_password_verification_attempt(
             jsonb_build_object('user_id',%L,'valid',true))->>'decision'$$, :'pstd1'),
  'reject');
select rl.val('RH5 the rejection carries a message the user can act on',
  format($$select (public.hook_password_verification_attempt(
             jsonb_build_object('user_id',%L,'valid',false))->>'message'
             like 'Too many failed sign-in attempts%%')::text$$, :'pstd1'),
  'true');
select rl.val('RH6 exactly ONE repeated_login_failures alert was filed for this account',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='repeated_login_failures'
              and details->>'subject_id' = %L$$, :'pstd1'),
  '1');
select rl.val('RH7 ...and it is a login alert, NOT a generic rate_limit_tripped one',
  format($$select alert_type from public.incident_alerts
            where details->>'subject_id' = %L$$, :'pstd1'),
  'repeated_login_failures');
-- A SUCCESSFUL sign-in clears the slate. Without it, five typos spread over
-- months would eventually lock the account, because fixed windows only forget
-- rows the opportunistic cleanup reaches.
\o /dev/null
delete from public.rate_limit_counters where category='login_account' and subject_id=:'pstd2';
select public.hook_password_verification_attempt(
         jsonb_build_object('user_id',:'pstd2','valid',false)) from generate_series(1,3);
\o
select rl.val('RH8 three failures on a second account are counted',
  format($$select request_count::text from public.rate_limit_counters
            where category='login_account' and subject_id=%L$$, :'pstd2'),
  '3');
select rl.val('RH9 a SUCCESSFUL sign-in continues...',
  format($$select public.hook_password_verification_attempt(
             jsonb_build_object('user_id',%L,'valid',true))->>'decision'$$, :'pstd2'),
  'continue');
select rl.val('RH10 ...and RESETS the counter to nothing',
  format($$select count(*)::text from public.rate_limit_counters
            where category='login_account' and subject_id=%L$$, :'pstd2'),
  '0');
-- FAILS CLOSED on a malformed event: GoTrue surfaces a hook error as a failed
-- login, never as an unmetered pass.
select rl.try('RH11 a malformed event (no user_id) RAISES rather than passing',
  $$select public.hook_password_verification_attempt('{"valid":false}'::jsonb)$$,
  'denied(22023)');
-- Only GoTrue's own role may call it. A client that could would be able to
-- lock any account out by user id.
select rl.val('RH12 `authenticated` holds NO EXECUTE on the hook',
  $$select has_function_privilege('authenticated',
      'public.hook_password_verification_attempt(jsonb)','EXECUTE')::text$$,
  'false');
select rl.val('RH13 `anon` holds none either',
  $$select has_function_privilege('anon',
      'public.hook_password_verification_attempt(jsonb)','EXECUTE')::text$$,
  'false');
select rl.val('RH14 supabase_auth_admin -- GoTrue itself -- does',
  $$select has_function_privilege('supabase_auth_admin',
      'public.hook_password_verification_attempt(jsonb)','EXECUTE')::text$$,
  'true');

-- ===========================================================================
-- § RQ  THE MALWARE-QUARANTINE TRIGGER
--
-- A TRIGGER rather than app code, so no upload path -- present or future --
-- can forget to raise the alert.
-- ===========================================================================
\o /dev/null
select gen_random_uuid() as doc_a \gset
select gen_random_uuid() as doc_b \gset
insert into public.documents
  (id, organisation_id, filename, storage_key, mime_type, size_bytes,
   scan_status, scanned_at)
values (:'doc_a', :'alpha_org', 'suite-quarantined.pdf',
        :'alpha_org' || '/' || :'doc_a', 'application/pdf', 1024,
        'quarantined', now());
\o
select rl.val('RQ1 a document INSERTED already quarantined files an alert',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$, :'doc_a'),
  '1');
select rl.val('RQ2 ...carrying the document id and NOT the filename',
  format($$select (summary not like '%%suite-quarantined%%')::text
             from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$, :'doc_a'),
  'true');
select rl.val('RQ3 ...and it is attributed to the owning organisation',
  format($$select (organisation_id = %L)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$,
         :'alpha_org', :'doc_a'),
  'true');
\o /dev/null
insert into public.documents
  (id, organisation_id, filename, storage_key, mime_type, size_bytes, scan_status)
values (:'doc_b', :'alpha_org', 'suite-pending.pdf',
        :'alpha_org' || '/' || :'doc_b', 'application/pdf', 2048, 'pending');
\o
select rl.val('RQ4 a PENDING document files no alert',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$, :'doc_b'),
  '0');
\o /dev/null
update public.documents set scan_status='quarantined', scanned_at=now() where id=:'doc_b';
\o
select rl.val('RQ5 the TRANSITION into quarantine files exactly one',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$, :'doc_b'),
  '1');
-- The UPDATE trigger's WHEN clause fires on the TRANSITION only. Without it a
-- soft-delete (which moves deleted_at, not scan_status) would re-file the
-- alert every time.
\o /dev/null
update public.documents set deleted_at = now() where id=:'doc_b';
update public.documents set deleted_at = null  where id=:'doc_b';
\o
select rl.val('RQ6 a NON-transition update (soft-delete/restore) does not re-file it',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='upload_quarantined' and details->>'document_id' = %L$$, :'doc_b'),
  '1');

-- ===========================================================================
-- § RP  platform_health_snapshot() -- THE /super/health READ
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select rl.try('RP1 an ordinary member is refused the snapshot (42501)',
  $$select public.platform_health_snapshot()$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select rl.try('RP2 an ORG OWNER at aal2 is refused too',
  $$select public.platform_health_snapshot()$$, 'denied(42501)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select rl.try('RP3 the superuser at aal1 is refused -- MFA is the gate',
  $$select public.platform_health_snapshot()$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- SUPERUSER ACCESS AUDITS ITSELF. The count is taken around ONE call, so a
-- snapshot that stopped auditing shows up as 0 rather than as a number that
-- happens to be non-zero from an earlier phase.
\o /dev/null
select count(*) as viewed_before from public.audit_events
 where action = 'platform_health.viewed' \gset
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.val('RP4 the SUPERUSER at aal2 gets a snapshot',
  $$select (public.platform_health_snapshot() ? 'organisations')::text$$, 'true');
select rl.val('RP5 it carries every section the page reads',
  $$select (public.platform_health_snapshot()
              ?& array['generated_at','organisations','users','memberships_active',
                       'subscriptions','storage','storage_top_organisations','abuse'])::text$$,
  'true');
select rl.val('RP6 the organisation counts are real numbers, not nulls',
  $$select ((public.platform_health_snapshot()->'organisations'->>'total')::int >= 2)::text$$,
  'true');
select rl.val('RP7 the abuse block counts the quarantines this suite planted',
  $$select ((public.platform_health_snapshot()->'abuse'->>'quarantined_uploads_24h')::int >= 2)::text$$,
  'true');
select rl.val('RP8 ...and the open-alert count is non-negative',
  $$select ((public.platform_health_snapshot()->'abuse'->>'open_alerts')::int >= 0)::text$$,
  'true');
-- THE DEFERRED-NOTIFICATION QUEUE IS ON THE PAGE (fix round 2, finding N4).
-- Both keys, because the count alone cannot tell a one-tick backlog from a
-- queue that is not draining -- the age beside it is what diagnoses. § RD34
-- drives the same two numbers against a queue this suite deliberately
-- saturates; these two prove the projection exists at all.
select rl.val('RP8a the abuse block names the deferred lockout-notification queue',
  $$select (public.platform_health_snapshot()->'abuse'
              ?& array['lockout_notifications_pending',
                       'lockout_notifications_oldest_at'])::text$$,
  'true');
select rl.val('RP8b ...counted in ACCOUNTS, and non-negative',
  $$select ((public.platform_health_snapshot()
              ->'abuse'->>'lockout_notifications_pending')::int >= 0)::text$$,
  'true');
-- THE PROJECTION IS THE MASK. The aggregates run over tenant tables that carry
-- no superuser SELECT policy; if the snapshot ever grew a record field, this
-- is the assertion that would have to be deleted to keep the suite green.
-- STAYS INSIDE THE SUPERUSER SESSION: the snapshot is permission-gated, so
-- running it after the reset below would measure 42501 and pass for the wrong
-- reason -- vacuously true over zero array elements is a real hazard for a
-- bool_and assertion, and denied() is worse.
select rl.val('RP10 storage_top_organisations discloses names and numbers ONLY',
  $$select (select coalesce(bool_and(k in ('name','slug','bytes','documents')),true)::text
              from jsonb_array_elements(
                     (select public.platform_health_snapshot()
                        ->'storage_top_organisations')) e,
                   jsonb_object_keys(e) k)$$,
  'true');
select rl.val('RP10a ...over a NON-EMPTY projection, so RP10 is not vacuous',
  $$select (jsonb_array_length(public.platform_health_snapshot()
              ->'storage_top_organisations') >= 1)::text$$, 'true');
reset role; reset request.jwt.claims;
-- NINE successful calls above (RP4-RP8, RP8a, RP8b, RP10, RP10a -- the two
-- N4 assertions joined the block in fix round 2). RP1-RP3 raise on the
-- permission gate BEFORE the audit write, deliberately -- a refused read is
-- not a read -- so they contribute nothing here and must not be counted.
select rl.val('RP9 EVERY call wrote a platform_health.viewed audit row (nine calls above)',
  format($$select ((select count(*) from public.audit_events
                     where action='platform_health.viewed') - %L::bigint >= 9)::text$$,
         (:'viewed_before')::text),
  'true');
select rl.val('RP11 `anon` holds no EXECUTE on the snapshot',
  $$select has_function_privilege('anon','public.platform_health_snapshot()','EXECUTE')::text$$,
  'false');

-- ===========================================================================
-- § RD  DELIVERY -- THE CLOCK (Q118) AND THE ACCOUNT-HOLDER SEAM (Q114)
--
-- Task 6c wired two things that Task 5 and Task 6 left as seams. Both are
-- asserted here rather than in a unit test, because both are database facts:
-- WHETHER A JOB IS REGISTERED AT ALL, and whether the account-holder
-- notification's cap is a property of the data or a promise in a comment.
--
-- THE SUBJECT EXISTS BEFORE ANYTHING IS ASSERTED ABOUT IT. § RH has just
-- driven a real lockout on `pstd1` and § RH6 measured its ONE alert row, so
-- everything below reads a row that provably exists -- not an empty set that
-- would satisfy "no unnotified alerts" trivially.
-- ===========================================================================

-- ---- the clock ------------------------------------------------------------
select rl.val('RD1 pg_cron is installed',
  $$select count(*)::text from pg_extension where extname='pg_cron'$$, '1');
select rl.val('RD2 pg_net is installed',
  $$select count(*)::text from pg_extension where extname='pg_net'$$, '1');
select rl.val('RD3 exactly ONE cron job exists -- the product has one scheduler',
  $$select count(*)::text from cron.job$$, '1');
select rl.val('RD4 ...named incident-alert-delivery, every 10 minutes',
  $$select jobname || ' @ ' || schedule from cron.job$$,
  'incident-alert-delivery @ */10 * * * *');
select rl.val('RD5 ...running private.deliver_incident_alerts(), and nothing else',
  $$select command from cron.job where jobname='incident-alert-delivery'$$,
  'select private.deliver_incident_alerts()');
select rl.val('RD6 ...and it is active',
  $$select active::text from cron.job where jobname='incident-alert-delivery'$$, 'true');
select rl.val('RD7 no client role may run the job body',
  $$select (has_function_privilege('authenticated','private.deliver_incident_alerts()','EXECUTE')
         or has_function_privilege('anon','private.deliver_incident_alerts()','EXECUTE')
         or has_function_privilege('service_role','private.deliver_incident_alerts()','EXECUTE'))::text$$,
  'false');
-- LOCAL DEV IS A REAL NO-OP, MEASURED. With no Vault entries the function must
-- return before it builds a request -- not POST an empty bearer, and not guess
-- a URL. The pg_net queue is counted either side of a real call.
select rl.val('RD8 FIXTURE: neither Vault entry exists on this stack',
  $$select count(*)::text from vault.secrets
     where name in ('incident_alert_delivery_url','incident_alert_delivery_secret')$$, '0');
\o /dev/null
select count(*)::text as net_before from net.http_request_queue \gset
select private.deliver_incident_alerts();
\o
select rl.val('RD9 ...so a tick queues NO http request at all',
  format($$select ((select count(*) from net.http_request_queue) = %L::bigint)::text$$,
         :'net_before'), 'true');

-- ---- the account-holder seam ----------------------------------------------
select rl.val('RD10 account_notified_at exists and is null on the fresh lockout alert',
  format($$select (account_notified_at is null)::text from public.incident_alerts
            where alert_type='repeated_login_failures' and details->>'subject_id' = %L$$,
         :'pstd1'), 'true');
select rl.val('RD11 service_role may stamp account_notified_at',
  $$select has_column_privilege('service_role','public.incident_alerts','account_notified_at','UPDATE')::text$$,
  'true');
-- ===========================================================================
-- RD12 REVERSED BY PHASE 7 TASK 7 (20260919000000), AND THE REVERSAL IS THE
-- POINT -- NOT A WEAKENED ASSERTION.
-- ===========================================================================
-- This used to read "RD12 the grant does NOT gate the column -- authenticated
-- holds table-level UPDATE", expecting `true`, with a header calling that "the
-- uncomfortable one": the table's UPDATE grant was TABLE-LEVEL, so any column
-- a later migration added was writable by grant the moment it existed, and the
-- GUARD was the whole of the column gate. `account_notified_at`
-- (20260916001000) had to be remembered into that guard's list by hand, which
-- is what raised DECISIONS-QUEUE Q125.
--
-- Task 7's permission matrix found the same shape mechanically and closed it:
-- `authenticated` now holds UPDATE on `resolved_at` and `resolved_by` ONLY --
-- the two columns lib/admin/health-actions.ts actually writes -- so a column
-- added after today is OUTSIDE the grant and fails closed with 42501 instead
-- of relying on somebody updating a list. The assertion therefore states the
-- new fact, in both directions.
select rl.val('RD12 the grant DOES gate the column now -- account_notified_at is outside it',
  $$select has_column_privilege('authenticated','public.incident_alerts','account_notified_at','UPDATE')::text$$,
  'false');
select rl.val('RD12a ...and the grant is exactly the resolution flag, nothing wider',
  $$select string_agg(column_name, ',' order by column_name)
      from information_schema.column_privileges
     where table_schema='public' and table_name='incident_alerts'
       and grantee='authenticated' and privilege_type='UPDATE'$$,
  'resolved_at,resolved_by');
-- THE GUARD IS STILL THERE, AND IT IS NOW UNREACHABLE FROM ANY CLIENT PATH --
-- which is the correct end state and also a denominator problem this comment
-- refuses to leave implicit. Every column in the guard's immutable list is now
-- outside the client grant, so no session can reach the `raise` to be refused
-- by it: the guard has become pure defence in depth, and RD13's refusal below
-- is delivered by the GRANT first. Deleting the guard entirely would leave
-- RD13 green. So the guard's continued existence and its list are asserted
-- directly, from its own body -- the parsed-body idiom rls_phase2_crm.sql
-- § M1d2 established -- rather than inferred from a refusal that another
-- control is now producing.
select rl.val('RD12b the guard still exists and still names the delivery-seam columns',
  $$select (pg_catalog.pg_get_functiondef(p.oid) like '%account_notified_at%'
        and pg_catalog.pg_get_functiondef(p.oid) like '%new.notified_at%'
        and pg_catalog.pg_get_functiondef(p.oid) like '%resolved_by must be the resolving caller%')::text
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'incident_alert_resolution_guard'$$,
  'true');
-- THE REFUSAL ITSELF, unchanged in outcome and now delivered by the grant:
-- the operator is the one client who CAN update this table (the resolve flag),
-- so a superuser must still not be able to silence a customer's lockout
-- notice.
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.try('RD13 the aal2 SUPERUSER cannot stamp account_notified_at either',
  format($$update public.incident_alerts set account_notified_at = now()
            where alert_type='repeated_login_failures' and details->>'subject_id' = %L$$, :'pstd1'),
  'denied(42501)');
select rl.val('RD14 pending_lockout_notifications() is not callable from a session',
  $$select has_function_privilege('authenticated',
      'public.pending_lockout_notifications(integer)','EXECUTE')::text$$, 'false');
reset role; reset request.jwt.claims;
select rl.val('RD15 ...nor by anon',
  $$select has_function_privilege('anon',
      'public.pending_lockout_notifications(integer)','EXECUTE')::text$$, 'false');
select rl.val('RD16 ...and service_role -- the sender -- may call it',
  $$select has_function_privilege('service_role',
      'public.pending_lockout_notifications(integer)','EXECUTE')::text$$, 'true');

select rl.val('RD17 the locked-out account is pending exactly once',
  format($$select count(*)::text from public.pending_lockout_notifications()
            where account_user_id = %L$$, :'pstd1'), '1');
select rl.val('RD18 ...addressed to the account''s OWN address, from auth.users',
  format($$select (n.email = (select u.email::text from auth.users u where u.id = %L))::text
            from public.pending_lockout_notifications() n where n.account_user_id = %L$$,
         :'pstd1', :'pstd1'), 'true');
select rl.val('RD19 ...carrying the policy''s own numbers, not a hardcoded sentence',
  format($$select max_requests || '/' || window_seconds
            from public.pending_lockout_notifications() where account_user_id = %L$$,
         :'pstd1'), '5/900');

-- CAP #1, STRUCTURAL: more failures in the SAME window file no further alert,
-- so they can produce no further email however hard the account is hammered.
\o /dev/null
select public.hook_password_verification_attempt(
         jsonb_build_object('user_id',:'pstd1','valid',false)) from generate_series(1,20);
\o
select rl.val('RD20 CAP 1: twenty more failed attempts file NO second alert',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='repeated_login_failures' and details->>'subject_id' = %L$$,
         :'pstd1'), '1');
select rl.val('RD21 ...and the counter kept counting past the limit (pressure, not traffic)',
  format($$select (request_count > 5)::text from public.rate_limit_counters
            where category='login_account' and subject_id=%L$$, :'pstd1'), 'true');

-- CAP #2, STRUCTURAL: a BACKLOG of windows (the clock down for an hour) is ONE
-- email and one stamp over every id, not one email per window. Planted as
-- `postgres`, which is the only writer this table has.
\o /dev/null
insert into public.incident_alerts (alert_type, organisation_id, summary, details, created_at)
values ('repeated_login_failures', null,
        'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
        jsonb_build_object('category','login_account','subject_scope','account',
          'subject_id', :'pstd1', 'max_requests', 5, 'window_seconds', 900),
        now() - interval '20 minutes');
\o
select rl.val('RD22 two pending alerts now exist for that one account',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='repeated_login_failures' and details->>'subject_id' = %L
              and account_notified_at is null$$, :'pstd1'), '2');
select rl.val('RD23 CAP 2: the sender is still offered ONE row for that account...',
  format($$select count(*)::text from public.pending_lockout_notifications()
            where account_user_id = %L$$, :'pstd1'), '1');
select rl.val('RD24 ...carrying BOTH alert ids, so one send stamps both',
  format($$select array_length(alert_ids, 1)::text from public.pending_lockout_notifications()
            where account_user_id = %L$$, :'pstd1'), '2');
select rl.val('RD25 ...and the most recent window is the one the email will name',
  format($$select (latest_at = (select max(created_at) from public.incident_alerts
                                 where alert_type='repeated_login_failures'
                                   and details->>'subject_id' = %L))::text
            from public.pending_lockout_notifications() where account_user_id = %L$$,
         :'pstd1', :'pstd1'), 'true');

-- ONCE STAMPED, GONE. The stamp is what stops the next tick re-sending.
\o /dev/null
update public.incident_alerts set account_notified_at = now()
 where alert_type='repeated_login_failures' and details->>'subject_id' = :'pstd1';
\o
select rl.val('RD26 a stamped account is no longer pending',
  format($$select count(*)::text from public.pending_lockout_notifications()
            where account_user_id = %L$$, :'pstd1'), '0');
-- THE TWO SEAMS ARE INDEPENDENT: stamping the account holder's must not mark
-- the row as delivered to the OPERATOR, or one failure would silence the other.
select rl.val('RD27 ...and the OPERATOR digest seam is untouched by it',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='repeated_login_failures' and details->>'subject_id' = %L
              and notified_at is null$$, :'pstd1'), '2');

-- ===========================================================================
-- A SATURATED QUEUE MUST SERVE THE ACCOUNT STILL UNDER ATTACK (fix round 2,
-- review finding N3).
--
-- Fix round 1 capped the delivery run at 30 accounts per tick. The cap is
-- right; ordering the queue by each account's MOST RECENT unnotified alert was
-- not. A hammered account re-crosses its lockout window every 15 minutes, which
-- ADVANCES that timestamp and pushes it behind every quieter account -- so on a
-- queue the cap keeps full, the accounts under active attack are deferred every
-- tick, which is the exact inverse of what founder ruling Q114 is for.
--
-- THE QUEUE IS SATURATED HERE, NOT DESCRIBED. Two accounts are made pending and
-- the queue is given room for ONE, because the queue's capacity IS `p_limit`
-- (lib/email/lockout-notification.ts clamps it to LOCKOUT_NOTIFICATION_LIMIT =
-- 30 and passes it straight through). Saturating through that parameter
-- exercises the same cap-plus-ordering interaction the 30-account case does,
-- and needs two real auth.users rows instead of thirty-one.
--
--   pstd1, STILL UNDER ATTACK: first crossing 60 minutes ago, latest NOW.
--   pstd2, QUIET:              one crossing 30 minutes ago, nothing since.
--
-- min(created_at):  pstd1 = -60m  <  pstd2 = -30m   -> pstd1 served (shipped)
-- max(created_at):  pstd1 = now   >  pstd2 = -30m   -> pstd2 served (the bug)
--
-- So RD30 is the finding: it reads `pstd1` today and read `pstd2` before
-- 20260918000000.
-- ===========================================================================
\o /dev/null
-- Start from a clean queue: every OTHER account's pending alert is STAMPED
-- rather than deleted, so `RZ2`'s row-count denominator is untouched while the
-- saturated queue below contains exactly the two accounts this block plants.
--
-- AND THE STAMP IS RECORDED SO § RZ CAN PUT IT BACK (pre-merge fix round). The
-- first cut stamped every pending row blanket-fashion and restored none of
-- them: § RZ deletes only this suite's own fixture ids, so a row planted by any
-- other section or any other file stayed silently marked as delivered, and
-- RZ2's count(*) comparison could not see a column change. Latent on a fresh
-- reset (the pre-existing pending set is empty) and real the moment anything
-- else plants one -- which is the shape of contamination that is discovered by
-- a later suite failing for no visible reason.
create temporary table rd_stamped_by_this_block as
  select a.id
  from public.incident_alerts a
  where a.alert_type = 'repeated_login_failures'
    and a.account_notified_at is null
    and coalesce(a.details->>'subject_id', '') not in (:'pstd1', :'pstd2');
select count(*)::text as rd_pending_before from rd_stamped_by_this_block \gset
update public.incident_alerts set account_notified_at = now()
 where id in (select id from rd_stamped_by_this_block);
delete from public.incident_alerts
 where alert_type = 'repeated_login_failures'
   and details->>'subject_id' in (:'pstd1', :'pstd2');
insert into public.incident_alerts (alert_type, organisation_id, summary, details, created_at)
values
  ('repeated_login_failures', null,
   'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
   jsonb_build_object('category','login_account','subject_scope','account',
     'subject_id', :'pstd1', 'max_requests', 5, 'window_seconds', 900),
   now() - interval '60 minutes'),
  ('repeated_login_failures', null,
   'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
   jsonb_build_object('category','login_account','subject_scope','account',
     'subject_id', :'pstd1', 'max_requests', 5, 'window_seconds', 900),
   now()),
  ('repeated_login_failures', null,
   'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
   jsonb_build_object('category','login_account','subject_scope','account',
     'subject_id', :'pstd2', 'max_requests', 5, 'window_seconds', 900),
   now() - interval '30 minutes');
\o
-- THE DENOMINATORS FIRST. Without these, RD30's single row could mean "the
-- hammered account was the only one offered" instead of "it was CHOSEN".
select rl.val('RD28 DENOMINATOR: with room for everyone, BOTH accounts are pending',
  format($$select count(*)::text from public.pending_lockout_notifications(500)
            where account_user_id in (%L,%L)$$, :'pstd1', :'pstd2'), '2');
select rl.val('RD29 DENOMINATOR: ...and they are the ONLY accounts pending',
  $$select count(*)::text from public.pending_lockout_notifications(500)$$, '2');
-- THE FINDING. One slot, two candidates, and the one still being hammered wins.
select rl.val('RD30 SATURATED: the account still under ATTACK is the one served',
  format($$select (account_user_id = %L)::text
             from public.pending_lockout_notifications(1)$$, :'pstd1'), 'true');
-- WHY THAT IS NOT AN ACCIDENT OF THE PLANT: the hammered account's most recent
-- alert is genuinely the NEWEST in the queue, so the old `order by max()` had to
-- put it last. This is the assertion that makes RD30 a regression test rather
-- than a coincidence.
select rl.val('RD31 ...even though its LATEST alert is the newest in the queue',
  format($$select ((select pg_catalog.max(created_at) from public.incident_alerts
                     where alert_type='repeated_login_failures' and details->>'subject_id' = %L)
                 > (select pg_catalog.max(created_at) from public.incident_alerts
                     where alert_type='repeated_login_failures' and details->>'subject_id' = %L))::text$$,
         :'pstd1', :'pstd2'), 'true');
-- AND THE PAYLOAD IS UNCHANGED: only the ORDERING moved. The email still names
-- the most recent lockout window, which is what the copy quotes.
select rl.val('RD32 ...and latest_at is still that account''s MOST RECENT window',
  format($$select (latest_at = (select pg_catalog.max(created_at) from public.incident_alerts
                                 where alert_type='repeated_login_failures'
                                   and details->>'subject_id' = %L))::text
             from public.pending_lockout_notifications(1)$$, :'pstd1'), 'true');
-- STARVATION-PROOF BY CONSTRUCTION: a FURTHER crossing on the hammered account
-- -- the thing that used to push it to the back -- does not move it at all.
\o /dev/null
insert into public.incident_alerts (alert_type, organisation_id, summary, details, created_at)
values ('repeated_login_failures', null,
        'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
        jsonb_build_object('category','login_account','subject_scope','account',
          'subject_id', :'pstd1', 'max_requests', 5, 'window_seconds', 900),
        now() + interval '1 minute');
\o
select rl.val('RD33 a FURTHER crossing does not push the victim back down the queue',
  format($$select (account_user_id = %L)::text
             from public.pending_lockout_notifications(1)$$, :'pstd1'), 'true');

-- AND THE DEFERRAL IS VISIBLE TO THE OPERATOR (fix round 2, finding N4). The
-- run is bounded and nothing reads pg_net's response, so /super/health's own
-- count is the only surface that can say a queue exists. Read through the
-- health RPC as the aal2 superuser, against the queue saturated above -- two
-- accounts waiting, which is exactly what RD28/RD29 measured from the sender's
-- side. A count that disagreed with the sender's queue would be worse than no
-- count at all.
-- Taken as `postgres`, BEFORE the role switch, so the comparison is against the
-- table's own truth rather than against whatever the superuser session can see.
\o /dev/null
select pg_catalog.min(created_at)::text as oldest_pending from public.incident_alerts
 where alert_type='repeated_login_failures' and account_notified_at is null \gset
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.val('RD34 /super/health COUNTS the two accounts waiting to be told',
  $$select ((public.platform_health_snapshot()
              ->'abuse'->>'lockout_notifications_pending')::int)::text$$, '2');
select rl.val('RD35 ...and dates the queue from the OLDEST unnotified crossing',
  format($$select (((public.platform_health_snapshot()
                      ->'abuse'->>'lockout_notifications_oldest_at')::timestamptz)
                 = %L::timestamptz)::text$$, :'oldest_pending'), 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- AN ALERT THE SENDER CAN NEVER SERVE MUST NOT BE COUNTED AS WAITING
-- (pre-merge fix round, the Task 6c fix-round-2 residual).
--
-- The health aggregate used to filter on TWO predicates (alert_type,
-- account_notified_at is null) while public.pending_lockout_notifications()
-- filters on EIGHT -- adding a uuid-shaped subject_id, integer-shaped
-- max_requests/window_seconds, a join to auth.users and a non-empty address.
-- So an alert whose subject cannot be resolved -- a deleted user, a malformed
-- details payload, a permanently undeliverable address -- was counted forever
-- and served never: the count pinned at >= 1 and the age froze, which is
-- EXACTLY the reading /super/health tells the operator is a stalled delivery
-- clock. The one diagnostic the count exists to provide had an unbounded
-- false-positive mode, and § RD34/RD35 could not see it because this block's
-- own setup stamps every other pending row first.
--
-- ONE unresolvable alert is planted, deliberately OLDER than anything else in
-- the queue, so the old expression would have both counted it AND dated the
-- queue from it. 20260921001000 reads both numbers off the sender's function.
-- ===========================================================================
\o /dev/null
select pg_catalog.gen_random_uuid()::text as ghost_subject \gset
insert into public.incident_alerts (alert_type, organisation_id, summary, details, created_at)
values ('repeated_login_failures', null,
        'Repeated failed sign-in attempts on one account (limit 5 per 900 seconds).',
        jsonb_build_object('category','login_account','subject_scope','account',
          'subject_id', :'ghost_subject', 'max_requests', 5, 'window_seconds', 900),
        now() - interval '240 minutes');
\o
select rl.val('RD36 CONTROL: the planted subject resolves to NO auth.users row',
  format($$select count(*)::text from auth.users where id = %L$$, :'ghost_subject'), '0');
select rl.val('RD37 CONTROL: the naive two-predicate reading counts THREE subjects...',
  $$select count(distinct details->>'subject_id')::text from public.incident_alerts
     where alert_type='repeated_login_failures' and account_notified_at is null$$, '3');
select rl.val('RD38 ...but the SENDER''s queue is two -- it can never serve the third',
  $$select count(*)::text from public.pending_lockout_notifications(500)$$, '2');
set role authenticated;
set request.jwt.claims = :'super_c';
select rl.val('RD39 MEASURED: /super/health agrees with the SENDER, not with the naive filter',
  $$select ((public.platform_health_snapshot()
              ->'abuse'->>'lockout_notifications_pending')::int)::text$$, '2');
select rl.val('RD40 ...and dates the queue from the oldest SERVABLE crossing, not the ghost''s',
  $$select ((public.platform_health_snapshot()
              ->'abuse'->>'lockout_notifications_oldest_at')::timestamptz
            > pg_catalog.now() - interval '120 minutes')::text$$, 'true');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § RZ  HOUSEKEEPING
--
-- Every counter, alert and document this suite created is removed, so the
-- HTTP block below -- and the health numbers any later reader takes -- run
-- against the state they were written against. Deleted as `postgres`: there
-- is deliberately no client DELETE path on any of these tables.
-- ===========================================================================
\o /dev/null
delete from public.documents where id in (:'doc_a', :'doc_b');
delete from public.incident_alerts
 where details->>'document_id' in (:'doc_a', :'doc_b')
    or details->>'subject_id'  in (:'synth_a', :'synth_b', :'pstd1', :'pstd2', :'pmanager', :'ghost_subject');
delete from public.rate_limit_counters
 where subject_id in (:'synth_a', :'synth_b', :'pstd1', :'pstd2', :'pmanager', :'alpha_org');
-- AND THE COLUMN § RD28 BLANKET-STAMPED IS PUT BACK (pre-merge fix round).
-- Deleting this suite's own fixture ids was never enough: § RD28 stamped
-- account_notified_at on every OTHER pending row to clear the queue, and a
-- count(*) comparison cannot see a column that changed on rows that still
-- exist. The ids were captured then; they are restored now, and asserted.
update public.incident_alerts set account_notified_at = null
 where id in (select id from rd_stamped_by_this_block);
\o
select rl.val('RZ0a § RD28''s blanket stamp is fully reverted',
  $$select count(*)::text from public.incident_alerts a
     join rd_stamped_by_this_block t on t.id = a.id
     where a.account_notified_at is not null$$, '0');
select rl.val('RZ0b ...so the pending denominator is back where § RD28 found it',
  $$select count(*)::text from public.incident_alerts
     where alert_type = 'repeated_login_failures' and account_notified_at is null$$,
  :'rd_pending_before');
select rl.val('RZ1 no counters this suite created remain',
  format($$select count(*)::text from public.rate_limit_counters
            where subject_id in (%L,%L,%L,%L,%L,%L)$$,
         :'synth_a', :'synth_b', :'pstd1', :'pstd2', :'pmanager', :'alpha_org'),
  '0');
select rl.val('RZ2 the alert table is back to the denominator § RF found',
  format($$select ((select count(*) from public.incident_alerts) = %L::bigint)::text$$,
         (:'alerts_before')::text),
  'true');
select rl.val('RZ3 the two suite documents are gone (not soft-deleted -- never existed)',
  format($$select count(*)::text from public.documents where id in (%L,%L)$$,
         :'doc_a', :'doc_b'),
  '0');
select rl.val('RZ4 ALPHA is still active and untouched',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$,
         :'alpha_org'), 'true');
select rl.val('RZ5 the eight seeded policy rows (seven + Phase 8 consent_grant) are exactly as they were',
  $$select count(*)::text from public.rate_limit_policies$$, '8');

\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from rl.results order by seq;
select count(*) filter (where not pass) as failures, count(*) as total from rl.results;
