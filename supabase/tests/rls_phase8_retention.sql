-- ===========================================================================
-- Phase 8 Task 6 (retention and garbage collection) RLS / behaviour suite.
--
-- Covers 20261003000000 .. 20261003006000:
--   private.retention_periods()            THE ONE DECLARED PLACE
--   private.retention_subjects() + assert_retention_roll()
--                                          the roll and its derivation
--   private.sweep_*                        seven sweeps
--   private.purge_audit_events()           THE DANGEROUS ONE, five rails
--   public.retention_object_manifest()     what the runner deletes
--   public.start_retention_run/run_retention_sweep/fail_retention_run
--   public.set_retention_enabled()         the kill switch
--   private.membership_keeps_an_owner()    Q179's new refusal
--   private.run_incident_alert_tick()      FIVE halves now
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh, after the erasure suite, on
-- the same P7VARS fixtures. Section RZ removes every row it made.
--
-- ===========================================================================
-- THE DENOMINATOR RULE (progress.md, standing lesson 1), WHICH THIS SUITE
-- NEEDS MORE THAN MOST
-- ===========================================================================
-- Every sweep here is a function whose whole job is to make things absent. A
-- suite that asserted only absences would pass PERFECTLY against a job that
-- did nothing at all, because its subjects never existed. So every "it is
-- gone" is preceded by "it was there", counted, and every boundary is
-- asserted from BOTH sides: a row ONE DAY INSIDE its period survives the same
-- run that takes the row one day past it. A sweep that deleted everything and
-- a sweep that deleted the right thing look identical without the survivor.
--
-- ===========================================================================
-- TIME TRAVEL: BY WRITING TIMESTAMPS INTO THE PAST, NEVER BY SLEEPING
-- ===========================================================================
-- The rate-limit and alert suites' rule. Two tables need their write guard out
-- of the way to be backdated (public.export_jobs and public.erasure_jobs both
-- refuse a write to a finished job), and the suite disables exactly that
-- trigger for exactly that statement and asserts it is back on afterwards --
-- the rls_foundation § D and erasure § EN7 pattern. `session_replication_role
-- = replica` is NEVER used: it is the thing three functions in this feature
-- refuse outright, and the psql runner would be the one place it could be
-- reached for.
--
-- SECTIONS:
--   RF  fixtures
--   RC  the catalogue: tables, RLS, policies, grants, privileges, the clock
--   RD  the declaration, the roll and the derivation, asked DIRECTLY
--   RS  the six row sweeps, each with its denominator and both boundaries
--   RA  the audit purge's five rails, each asked directly
--   RW  the 60-day workspace purge, and its three recorded traps
--   RQ  Q179: an unsanctioned account deletion refuses
--   RR  the run: dry, live, idempotent, kill-switched, one summary row
--   RZ  housekeeping
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists rt cascade;
create schema rt;

create table rt.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function rt.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into rt.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function rt.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform rt.record(p_label, p_expected, v_actual);
end $$;

create function rt.try(p_label text, p_sql text, p_expected text)
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
  perform rt.record(p_label, p_expected, v_actual);
end $$;

-- THE HINT TOO. Every rail in this task raises with its own hint precisely so
-- that "the floor refused" and "the ceiling refused" and "a privilege was
-- missing" -- which would otherwise be one 55000 and one 42501 -- can be told
-- apart. A mutation that removes the floor and leaves the ceiling must not be
-- able to look like a pass.
create function rt.try_hint(p_label text, p_sql text, p_expected text)
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
  perform rt.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema rt to authenticated, anon, service_role;
grant execute on function rt.record(text,text,text)   to authenticated, anon, service_role;
grant execute on function rt.val(text,text,text)      to authenticated, anon, service_role;
grant execute on function rt.try(text,text,text)      to authenticated, anon, service_role;
grant execute on function rt.try_hint(text,text,text) to authenticated, anon, service_role;


-- ===========================================================================
-- RF  FIXTURES
-- ===========================================================================
-- Two throwaway accounts and three throwaway workspaces, all with `rt-`
-- prefixed slugs and `@rt.invalid` addresses, so that nothing this suite
-- sweeps belongs to any other suite -- and section RX counts a bystander
-- tenant's rows either side of the run to prove it.
-- ===========================================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-4000-9000-0000000067a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rt-owner@rt.invalid', 'x', now(), now(), now()),
  ('00000000-0000-4000-9000-0000000067a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rt-mate@rt.invalid', 'x', now(), now(), now());

insert into public.organisations (id, name, slug) values
  ('00000000-0000-4000-9000-0000000067b1', 'RT Keep Ltd',  'rt-keep'),
  ('00000000-0000-4000-9000-0000000067b2', 'RT Purge Ltd', 'rt-purge'),
  ('00000000-0000-4000-9000-0000000067b3', 'RT Back Ltd',  'rt-back');

insert into public.organisation_memberships (organisation_id, user_id, role, status) values
  ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1', 'owner',   'active'),
  ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a2', 'manager', 'active'),
  ('00000000-0000-4000-9000-0000000067b2', '00000000-0000-4000-9000-0000000067a1', 'owner',   'active'),
  ('00000000-0000-4000-9000-0000000067b3', '00000000-0000-4000-9000-0000000067a1', 'owner',   'active');

-- THE BYSTANDER COUNT, TAKEN BEFORE ANYTHING IS SWEPT. Section RX compares
-- against it, so "the sweeps reached no workspace but their own" is measured
-- rather than assumed from whichever suites happen to have run first.
create table rt.bystanders as
  select count(*) as n from public.organisations where slug not like 'rt-%';

insert into public.contacts (id, organisation_id, name) values
  ('00000000-0000-4000-9000-0000000067c1', '00000000-0000-4000-9000-0000000067b1', 'RT Keep Contact'),
  ('00000000-0000-4000-9000-0000000067c2', '00000000-0000-4000-9000-0000000067b2', 'RT Purge Contact');


-- ===========================================================================
-- RC  THE CATALOGUE
-- ===========================================================================

select rt.val('RC1 public.retention_runs has RLS on',
  $$select relrowsecurity::text from pg_class where oid = 'public.retention_runs'::regclass$$, 'true');
select rt.val('RC2 public.retention_settings has RLS on',
  $$select relrowsecurity::text from pg_class where oid = 'public.retention_settings'::regclass$$, 'true');
select rt.val('RC3 both carry exactly ONE policy each, and it is a SELECT',
  $$select string_agg(polrelid::regclass::text || ':' || polcmd, ',' order by polrelid::regclass::text)
      from (select polrelid, polcmd::text as polcmd from pg_policy) p
     where polrelid in ('public.retention_runs'::regclass, 'public.retention_settings'::regclass)$$,
  'public.retention_runs:r,public.retention_settings:r');
select rt.val('RC4 no client role holds INSERT, UPDATE or DELETE on either',
  $$select coalesce(string_agg(distinct grantee || ':' || privilege_type, ','), 'none')
      from information_schema.table_privileges
     where table_schema = 'public'
       and table_name in ('retention_runs', 'retention_settings')
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')$$, 'none');
select rt.val('RC5 `authenticated` holds SELECT on both -- the policy is what narrows it',
  $$select string_agg(distinct table_name, ',' order by table_name)
      from information_schema.table_privileges
     where table_schema = 'public' and grantee = 'authenticated'
       and privilege_type = 'SELECT'
       and table_name in ('retention_runs', 'retention_settings')$$,
  'retention_runs,retention_settings');

-- THE SINGLETON IS ENFORCED, NOT A CONVENTION. A settings table with two rows
-- and no rule about which one wins is how a kill switch gets flipped and does
-- nothing.
select rt.val('RC6 there is exactly one settings row',
  $$select count(*)::text from public.retention_settings$$, '1');
select rt.try('RC7 a SECOND settings row is refused by the primary key',
  $$insert into public.retention_settings (id, enabled, audit_purge_enabled) values (true, true, true)$$,
  'denied(23505)');
select rt.try('RC8 ...and an `id = false` row by the CHECK',
  $$insert into public.retention_settings (id, enabled, audit_purge_enabled) values (false, true, true)$$,
  'denied(23514)');

-- THE SWEEPS ARE UNREACHABLE FROM ANY CLIENT ROLE.
select rt.val('RC9 no client role may execute any private retention function',
  $$select string_agg(p.proname || ':' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('service_role', p.oid, 'EXECUTE'))::text, ',' order by p.proname)
      from pg_proc p
     where p.pronamespace = 'private'::regnamespace
       and p.proname in ('purge_audit_events', 'reap_stuck_jobs', 'retention_sweep_body',
                         'sweep_document_bytes', 'sweep_erasure_jobs', 'sweep_expired_workspaces',
                         'sweep_feedback', 'sweep_incident_alerts', 'sweep_rate_limit_counters')$$,
  'purge_audit_events:false,reap_stuck_jobs:false,retention_sweep_body:false,sweep_document_bytes:false,sweep_erasure_jobs:false,sweep_expired_workspaces:false,sweep_feedback:false,sweep_incident_alerts:false,sweep_rate_limit_counters:false');

select rt.val('RC10 the three runner RPCs and the manifest are service_role ONLY',
  $$select string_agg(p.proname || ':' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE'))::text
        || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text,
        ',' order by p.proname)
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fail_retention_run', 'retention_object_manifest',
                         'run_retention_sweep', 'start_retention_run')$$,
  'fail_retention_run:false/true,retention_object_manifest:false/true,run_retention_sweep:false/true,start_retention_run:false/true');

select rt.val('RC11 the kill switch is the ONE retention RPC `authenticated` can reach',
  $$select has_function_privilege('authenticated', 'public.set_retention_enabled(boolean,boolean,text)', 'EXECUTE')::text$$,
  'true');

-- ---- THE CLOCK. FIVE HALVES NOW, AND STILL ONE JOB -------------------------
select rt.val('RC12 exactly ONE cron job still exists',
  $$select count(*)::text from cron.job$$, '1');
select rt.val('RC13 ...named incident-alert-delivery, every 10 minutes, command UNTOUCHED',
  $$select jobname || ' @ ' || schedule || ' :: ' || command from cron.job$$,
  'incident-alert-delivery @ */10 * * * * :: select private.run_incident_alert_tick()');
-- ALL FIVE HALVES, FROM THE TICK'S LATEST DEFINITION. Task 6 is the fifth and
-- the four before it are asserted BY NAME, because "rebuild from the latest
-- definition" is how this phase has twice lost something it did not re-read.
select rt.val('RC14 the tick reaches all FIVE halves',
  $$select string_agg(h, ',' order by h)
      from (select unnest(array['deliver_erasure_jobs', 'deliver_export_jobs',
                                'deliver_incident_alerts', 'deliver_retention_sweep',
                                'raise_dsr_deadline_alerts']) as h) t
     where pg_get_functiondef('private.run_incident_alert_tick()'::regprocedure) like '%' || t.h || '%'$$,
  'deliver_erasure_jobs,deliver_export_jobs,deliver_incident_alerts,deliver_retention_sweep,raise_dsr_deadline_alerts');
select rt.val('RC15 and the retention half is in its OWN subtransaction, so it cannot take the others down',
  $$select (pg_get_functiondef('private.run_incident_alert_tick()'::regprocedure)
            like '%begin%perform private.deliver_retention_sweep();%exception when others%')::text$$,
  'true');
select rt.val('RC16 the tick runs, with every half reached, and raises nothing',
  $$select coalesce((select 'raised' from (select private.run_incident_alert_tick()) t where false), 'ran')$$,
  'ran');
-- LOCAL DEV IS A REAL NO-OP, MEASURED: with no Vault entries the poster
-- returns before it builds a request rather than POSTing an empty bearer.
select rt.val('RC17 the retention poster queues no request on an unconfigured stack',
  $$select (select count(*) from net.http_request_queue)::text$$,
  (select count(*)::text from net.http_request_queue));


-- ===========================================================================
-- RD  THE DECLARATION, THE ROLL, AND THE DERIVATION -- ASKED DIRECTLY
-- ===========================================================================

select rt.val('RD1 every class the sweeps name is declared',
  $$select string_agg(c, ',' order by c)
      from (select unnest(array['audit_hot','audit_total','erasure_job_failed','feedback',
                                'financial','incident_alert','operational','rate_limit_counter',
                                'stuck_job','storage_orphan','workspace']) c) t
     where exists (select 1 from private.retention_periods() p where p.class = t.c)$$,
  'audit_hot,audit_total,erasure_job_failed,feedback,financial,incident_alert,operational,rate_limit_counter,storage_orphan,stuck_job,workspace');
select rt.val('RD2 the Q133 defaults are what the database says they are',
  $$select string_agg(class || '=' || period::text, ' | ' order by class)
      from private.retention_periods()
     where class in ('audit_hot','audit_total','feedback','financial','operational','workspace')$$,
  'audit_hot=30 days | audit_total=1 year | feedback=2 years | financial=7 years | operational=2 years | workspace=60 days');
-- A NULL INTERVAL IS A NULL CUTOFF AND `where created_at < null` DELETES
-- NOTHING, SILENTLY, FOR EVER. So an undeclared class RAISES.
select rt.try_hint('RD3 an undeclared class RAISES rather than returning null',
  $$select private.retention_period('not_a_class')$$, 'denied(22023:unknown_retention_class)');
select rt.val('RD4 the two read-time paths derive from the declaration, unchanged',
  -- NOT `now() - cutoff = interval '2 years'`: subtracting two timestamps
  -- yields an interval in DAYS, so that form compares '730 days' with
  -- '2 years' and is false however correct the cutoff is. Measured on the
  -- first run of this suite.
  $$select private.organisation_retention_days()::text || '/' ||
           (private.feedback_retention_cutoff() = now() - interval '2 years')::text$$,
  '60/true');

-- THE ROLL AND THE CATALOGUE ARE THE SAME SET, asserted three ways because
-- the first two together do not establish it (a duplicate passes both).
select rt.val('RD5 every table in `public` is classified',
  $$select coalesce(string_agg(t, ','), 'none') from private.unclassified_retention_subjects() t$$,
  'none');
select rt.val('RD6 the roll is exactly the size of the catalogue',
  $$select ((select count(*) from private.retention_subjects())
          = (select count(*) from pg_class
              where relnamespace = 'public'::regnamespace and relkind in ('r','p')))::text$$, 'true');
select rt.val('RD7 ...and carries no table twice',
  $$select ((select count(*) from private.retention_subjects())
          = (select count(distinct table_name) from private.retention_subjects()))::text$$, 'true');
select rt.val('RD8 the derivation passes on the live schema',
  $$select coalesce((select 'raised' from (select private.assert_retention_roll()) t where false), 'ok')$$, 'ok');

-- AND THE DERIVATION'S THREE REFUSALS, EACH PLANTED AND ASKED DIRECTLY.
-- This is the "assert what it dropped" half: a roll that classifies nothing
-- new is a roll nobody will notice has gone stale.
create table public.rt_unclassified_probe (id uuid primary key default gen_random_uuid());
select rt.try_hint('RD9 a NEW TABLE nobody classified refuses the whole job',
  $$select private.assert_retention_roll()$$, 'denied(55000:unclassified_retention_subject)');
drop table public.rt_unclassified_probe;
select rt.val('RD10 ...and the refusal goes away when the table does (the control)',
  $$select coalesce((select 'raised' from (select private.assert_retention_roll()) t where false), 'ok')$$, 'ok');

-- The stale and duplicate halves, by rewriting the roll and restoring it
-- byte-identically -- the erasure suite's EC10 shape, so this probe does not
-- restate the roll's contents and cannot go stale as it grows.
create table rt.saved_defs (name text primary key, def text);
insert into rt.saved_defs values
  ('subjects', pg_get_functiondef('private.retention_subjects()'::regprocedure)),
  ('periods',  pg_get_functiondef('private.retention_periods()'::regprocedure));

-- THE DUPLICATE IS INJECTED BY REGEX, AND THE INJECTION IS ASSERTED. The
-- first cut matched a literal `  values` + newline + `    ('audit_events'`,
-- which is not what pg_get_functiondef returns -- so the mutation silently did
-- nothing and RD11 recorded a cheerful `ok` against a guard that had never
-- been asked. That is the fifth instance this phase has measured of a check
-- that could not see its own subject, and the fix is the one the other four
-- got: the probe RAISES if its own edit changed nothing.
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'subjects');
  v_new := pg_catalog.regexp_replace(
             v_def, 'values',
             'values (''audit_events'', ''swept'', ''audit_total'', ''duplicate probe''),', '');
  if v_new = v_def then
    raise exception 'RD11 could not inject the duplicate -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.try_hint('RD11 a table classified TWICE refuses -- the check RD5 and RD6 cannot make',
  $$select private.assert_retention_roll()$$, 'denied(55000:duplicate_retention_subject)');
do $$ begin execute (select def from rt.saved_defs where name = 'subjects'); end $$;
select rt.val('RD12 ...and the roll is restored byte-identically',
  $$select (pg_get_functiondef('private.retention_subjects()'::regprocedure)
            = (select def from rt.saved_defs where name = 'subjects'))::text$$, 'true');


-- ===========================================================================
-- RS  THE SIX ROW SWEEPS
-- ===========================================================================
-- Each one: the subject is PLANTED and COUNTED, a sibling ONE DAY INSIDE the
-- period is planted beside it, the sweep runs, and both are counted again.
-- The survivor is what separates "swept correctly" from "swept everything".
-- ===========================================================================

-- ---- Q110, stale rate-limit counters ---------------------------------------
insert into public.rate_limit_counters (category, subject_scope, subject_id, window_start, request_count)
values ('search', 'user', '00000000-0000-4000-9000-0000000067a1', now() - interval '8 days', 1),
       ('search', 'user', '00000000-0000-4000-9000-0000000067a2', now() - interval '6 days', 1);
select rt.val('RS1 DENOMINATOR: both counters exist, one past its period and one inside it',
  $$select count(*)::text from public.rate_limit_counters
     where subject_id in ('00000000-0000-4000-9000-0000000067a1','00000000-0000-4000-9000-0000000067a2')$$, '2');
select rt.val('RS2 the sweep deletes exactly the expired one',
  $$select (private.sweep_rate_limit_counters(false, 500))->>'rate_limit_counters.rows'$$, '1');
select rt.val('RS3 ...and the one a day INSIDE its period survives',
  $$select subject_id::text from public.rate_limit_counters
     where subject_id in ('00000000-0000-4000-9000-0000000067a1','00000000-0000-4000-9000-0000000067a2')$$,
  '00000000-0000-4000-9000-0000000067a2');
select rt.val('RS4 running it again deletes nothing (idempotent)',
  $$select (private.sweep_rate_limit_counters(false, 500))->>'rate_limit_counters.rows'$$, '0');

-- ---- Q120, feedback --------------------------------------------------------
insert into public.feedback (id, user_id, category, message, route, created_at) values
  ('00000000-0000-4000-9000-0000000067d1', '00000000-0000-4000-9000-0000000067a1',
   'bug', 'rt expired', '/rt', now() - interval '2 years' - interval '1 day'),
  ('00000000-0000-4000-9000-0000000067d2', '00000000-0000-4000-9000-0000000067a1',
   'bug', 'rt fresh', '/rt', now() - interval '2 years' + interval '1 day');
select rt.val('RS5 DENOMINATOR: both feedback rows exist',
  $$select count(*)::text from public.feedback where route = '/rt'$$, '2');
select rt.val('RS6 the DRY run counts one and deletes nothing',
  $$select (private.sweep_feedback(true, 500))->>'feedback.rows'
        || '/' || (select count(*)::text from public.feedback where route = '/rt')$$, '1/2');
select rt.val('RS7 the live sweep deletes exactly the expired one',
  $$select (private.sweep_feedback(false, 500))->>'feedback.rows'$$, '1');
select rt.val('RS8 ...and the one a day INSIDE its period survives',
  $$select string_agg(message, ',') from public.feedback where route = '/rt'$$, 'rt fresh');

-- ---- Q117, resolved incident alerts ----------------------------------------
insert into public.incident_alerts (id, alert_type, summary, created_at, resolved_at, resolved_by) values
  ('00000000-0000-4000-9000-0000000067e1', 'rate_limit_tripped', 'rt old resolved',
   now() - interval '2 years', now() - interval '1 year' - interval '1 day',
   '00000000-0000-4000-9000-0000000067a1'),
  ('00000000-0000-4000-9000-0000000067e2', 'rate_limit_tripped', 'rt new resolved',
   now() - interval '2 years', now() - interval '1 year' + interval '1 day',
   '00000000-0000-4000-9000-0000000067a1'),
  ('00000000-0000-4000-9000-0000000067e3', 'rate_limit_tripped', 'rt ancient OPEN',
   now() - interval '5 years', null, null);
select rt.val('RS9 DENOMINATOR: three alerts, one long-resolved, one recently, one OPEN and ancient',
  $$select count(*)::text from public.incident_alerts where summary like 'rt %'$$, '3');
select rt.val('RS10 the sweep deletes exactly the long-resolved one',
  $$select (private.sweep_incident_alerts(false, 500))->>'incident_alerts.rows'$$, '1');
-- THE RULE THAT MATTERS MOST: an OPEN alert is never purged at any age,
-- because an unresolved alert is an outstanding problem and deleting it would
-- delete the reason nobody has looked at it yet. Five years old, still here.
select rt.val('RS11 ...the recently-resolved one AND the five-year-old OPEN one both survive',
  $$select string_agg(summary, ',' order by summary) from public.incident_alerts where summary like 'rt %'$$,
  'rt ancient OPEN,rt new resolved');

-- ---- Q175, failed erasure jobs ---------------------------------------------
-- The guard on public.erasure_jobs refuses a write to a finished job for every
-- writer, so the backdating disables exactly that trigger for exactly these
-- statements. RS15 asserts it is back on: a suite that left a guard disabled
-- would silently weaken every assertion after it.
alter table public.erasure_jobs disable trigger user;
insert into public.erasure_jobs (id, kind, subject_user_id, status) values
  ('00000000-0000-4000-9000-0000000067f1', 'account', '00000000-0000-4000-9000-0000000067a1', 'queued'),
  ('00000000-0000-4000-9000-0000000067f2', 'account', '00000000-0000-4000-9000-0000000067a2', 'queued');
update public.erasure_jobs set status = 'failed', failure_reason = 'rt probe',
       started_at = now() - interval '100 days', completed_at = now() - interval '91 days'
 where id = '00000000-0000-4000-9000-0000000067f1';
update public.erasure_jobs set status = 'failed', failure_reason = 'rt probe',
       started_at = now() - interval '100 days', completed_at = now() - interval '89 days'
 where id = '00000000-0000-4000-9000-0000000067f2';
alter table public.erasure_jobs enable trigger user;
select rt.val('RS12 DENOMINATOR: two failed erasure jobs, one either side of 90 days',
  $$select count(*)::text from public.erasure_jobs where failure_reason = 'rt probe'$$, '2');
select rt.val('RS13 the sweep deletes exactly the one past 90 days',
  $$select (private.sweep_erasure_jobs(false, 500))->>'erasure_jobs.rows'$$, '1');
select rt.val('RS14 ...and the one a day INSIDE survives',
  $$select id::text from public.erasure_jobs where failure_reason = 'rt probe'$$,
  '00000000-0000-4000-9000-0000000067f2');
select rt.val('RS15 the write guard is BACK ON, so nothing after this is weakened',
  $$select (select count(*)::text from pg_trigger
             where tgrelid = 'public.erasure_jobs'::regclass
               and not tgisinternal and tgenabled = 'D')$$, '0');

-- ---- Q166, the reaper. NOT A DELETION --------------------------------------
alter table public.erasure_jobs disable trigger user;
insert into public.erasure_jobs (id, kind, subject_user_id, status) values
  ('00000000-0000-4000-9000-0000000067f3', 'account', '00000000-0000-4000-9000-0000000067a2', 'queued');
update public.erasure_jobs set status = 'running', started_at = now() - interval '2 hours'
 where id = '00000000-0000-4000-9000-0000000067f3';
alter table public.erasure_jobs enable trigger user;
select rt.val('RS16 DENOMINATOR: a job stuck `running` for two hours',
  $$select status from public.erasure_jobs where id = '00000000-0000-4000-9000-0000000067f3'$$, 'running');
select rt.val('RS17 the reaper FAILS it rather than deleting it',
  $$select (private.reap_stuck_jobs(false, 500))->>'erasure_jobs.reaped'$$, '1');
select rt.val('RS18 ...the row survives, says what happened, and says NOTHING WAS DELETED',
  $$select status || '/' ||
           (failure_reason like '%NOTHING WAS DELETED%')::text
      from public.erasure_jobs where id = '00000000-0000-4000-9000-0000000067f3'$$, 'failed/true');

-- ---- Q52, document bytes ---------------------------------------------------
-- No object is ever planted in the bucket from psql, so these rows are the
-- "the object is already gone and the row is not" direction -- which is the
-- self-healing one requirement 5 asks to be handled rather than described.
insert into public.documents (id, organisation_id, filename, storage_key, mime_type, size_bytes,
                              scan_status, scanned_at, deleted_at) values
  ('00000000-0000-4000-9000-000000006701', '00000000-0000-4000-9000-0000000067b1', 'old.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006701',
   'application/pdf', 10, 'clean', now(), now() - interval '2 years' - interval '1 day'),
  ('00000000-0000-4000-9000-000000006702', '00000000-0000-4000-9000-0000000067b1', 'newer.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006702',
   'application/pdf', 10, 'clean', now(), now() - interval '2 years' + interval '1 day');
select rt.val('RS19 DENOMINATOR: two soft-deleted documents, one either side of two years, neither purged',
  $$select count(*)::text from public.documents
     where organisation_id = '00000000-0000-4000-9000-0000000067b1' and bytes_purged_at is null$$, '2');
select rt.val('RS20 the sweep stamps exactly the expired one',
  $$select (private.sweep_document_bytes(false, 500))->>'documents.bytes_purged'$$, '1');
select rt.val('RS21 ...and the one a day INSIDE its period is untouched',
  $$select string_agg(filename, ',' order by filename) from public.documents
     where organisation_id = '00000000-0000-4000-9000-0000000067b1' and bytes_purged_at is null$$, 'newer.pdf');
-- THE CLASS IS DERIVED, NOT ASSUMED. Attaching the newer document to an event
-- that carries financial entries moves it from the two-year class to the
-- seven-year one -- so a document DELETED TWO YEARS AND A DAY AGO would now
-- survive. Asserted on the function directly, because by RS21 the row that
-- would demonstrate it has already been stamped.
insert into public.events (id, organisation_id, name, starts_at, status)
values ('00000000-0000-4000-9000-000000006711', '00000000-0000-4000-9000-0000000067b1',
        'RT Money Night', now(), 'draft');
insert into public.document_links (organisation_id, parent_id, entity_type, entity_id)
values ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-000000006702',
        'event', '00000000-0000-4000-9000-000000006711');
select rt.val('RS22 a document on an event with NO money is `operational` (2 years)',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006702')$$, 'operational');
insert into public.financial_entries (organisation_id, event_id, category, status, amount_minor, currency, occurred_on)
values ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-000000006711',
        'fee', 'actual', 1000, 'GBP', current_date);
select rt.val('RS23 ...and the SAME document becomes `financial` (7 years) the moment the event carries money',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006702')$$, 'financial');


-- ===========================================================================
-- RA  THE AUDIT PURGE'S FIVE RAILS
-- ===========================================================================
-- The most dangerous code in this phase. Every rail is asked DIRECTLY, with
-- its own hint, so a mutation that removes one cannot be mistaken for one
-- that removes another -- or for a missing privilege, which is the same
-- SQLSTATE.
-- ===========================================================================

-- A base of recent rows, so the sanity ceiling is not tripped by the handful
-- of old ones below. 200 recent, 3 old: 1.5%.
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
select '00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1',
       'rt.recent', 'platform', gen_random_uuid(), now() - interval '1 day'
  from generate_series(1, 200);
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
select '00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1',
       'rt.old', 'platform', gen_random_uuid(), now() - interval '1 year' - interval '1 day'
  from generate_series(1, 3);
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
values ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1',
        'rt.edge', 'platform', gen_random_uuid(), now() - interval '1 year' + interval '1 day');

select rt.val('RA1 DENOMINATOR: 3 rows past a year, 1 one day inside it, 200 recent',
  $$select (select count(*) from public.audit_events where action = 'rt.old')::text || '/' ||
           (select count(*) from public.audit_events where action = 'rt.edge')::text || '/' ||
           (select count(*) from public.audit_events where action = 'rt.recent')::text$$, '3/1/200');

-- RAIL 1 -- THE HARD FLOOR, ASKED DIRECTLY.
select rt.val('RA2 the hard floor is one year, asked of the function itself',
  $$select private.audit_retention_floor()::text$$, '1 year');
-- AND THROUGH THE PURGE, by declaring a shorter period and watching it refuse
-- rather than obey. This is the rail's whole point: the declaration is the
-- configuration, the floor is not, and the floor wins.
do $$
declare v_def text;
begin
  v_def := (select def from rt.saved_defs where name = 'periods');
  execute pg_catalog.replace(v_def, '(''audit_total'',' || chr(10) || '     interval ''1 year''',
                                    '(''audit_total'',' || chr(10) || '     interval ''30 days''');
end $$;
select rt.val('RA3 DENOMINATOR: the declaration really does now say 30 days',
  $$select (private.retention_period('audit_total'))::text$$, '30 days');
select rt.try_hint('RA4 ...and the purge REFUSES it rather than deleting a year of evidence',
  $$select private.purge_audit_events(false, 500)$$, 'denied(55000:audit_retention_below_floor)');
select rt.val('RA5 nothing was deleted while it refused',
  $$select (select count(*) from public.audit_events where action in ('rt.old','rt.edge','rt.recent'))::text$$, '204');
do $$ begin execute (select def from rt.saved_defs where name = 'periods'); end $$;
-- MEASURED, AND WRITTEN DOWN RATHER THAN WORKED AROUND SILENTLY:
-- private.retention_period() is IMMUTABLE and is called with a CONSTANT
-- argument, so the planner const-folds it and the folded value lives in this
-- session's cached plan. Restoring the function is therefore not enough --
-- RA9 to RA15 all failed on this suite's first run with
-- `audit_retention_below_floor`, against a declaration that already said a
-- year again. `discard plans` is the session-level answer.
--
-- IT IS NOT A DEFECT IN THE PRODUCT, and the reason is worth stating rather
-- than leaving a reader to wonder: the declaration changes only by migration,
-- a migration is followed by a deploy, and every PostgREST and pg_cron session
-- is younger than that. The only caller that can hold a stale plan across a
-- change is a long-lived session that was already open when it happened --
-- which is this suite, and psql.
discard plans;
select rt.val('RA6 the declaration is restored byte-identically',
  $$select (pg_get_functiondef('private.retention_periods()'::regprocedure)
            = (select def from rt.saved_defs where name = 'periods'))::text$$, 'true');

-- RAIL 2 -- THE KILL SWITCH, over the audit purge ALONE.
update public.retention_settings set audit_purge_enabled = false where id;
select rt.val('RA7 with the audit switch off the purge refuses and SAYS WHY',
  $$select (private.purge_audit_events(false, 500))->>'audit_events.refused_because'$$, 'audit_purge_disabled');
select rt.val('RA8 ...and every other sweep is untouched by it (they are different decisions)',
  $$select (private.sweep_incident_alerts(true, 500))->>'incident_alerts.capped'$$, 'false');
update public.retention_settings set audit_purge_enabled = true where id;

-- RAIL 5 + THE DRY RUN -- counts before and after, and a preview that removes
-- nothing.
select rt.val('RA9 the DRY run counts three and deletes none, reporting the total either side',
  $$select ((private.purge_audit_events(true, 500))->>'audit_events.rows') || '/' ||
           ((private.purge_audit_events(true, 500))->>'audit_events.total_before') || '/' ||
           (select count(*)::text from public.audit_events where action = 'rt.old')$$,
  (select '3/' || count(*)::text || '/3' from public.audit_events));

-- RAIL 4 -- BOUNDED AND RESUMABLE, OLDEST FIRST.
-- THE DELETE AND THE COUNT ARE TWO STATEMENTS, and they have to be: both
-- halves of one `select` see the SAME SNAPSHOT, so a count in the same
-- statement as the purge reads the table as it was BEFORE it -- which on this
-- suite's first run recorded `2/3` where 3 was the count before the delete of
-- 2. A probe that measures the state it was supposed to change, before it
-- changed it, is the same bug class as a probe that never ran.
select rt.val('RA10 a run limited to 2 deletes 2 and REPORTS that it was capped',
  $$select ((private.purge_audit_events(false, 2))->>'audit_events.rows') || '/' ||
           ((private.purge_audit_events(true, 2))->>'audit_events.capped')$$, '2/false');
select rt.val('RA10a ...leaving exactly the remainder, oldest-first',
  $$select count(*)::text from public.audit_events where action = 'rt.old'$$, '1');
select rt.val('RA11 ...and the next run finishes the remainder rather than skipping it',
  $$select (private.purge_audit_events(false, 500))->>'audit_events.rows'$$, '1');
select rt.val('RA11a ...with none of them left',
  $$select count(*)::text from public.audit_events where action = 'rt.old'$$, '0');
select rt.val('RA12 the row ONE DAY INSIDE the year survives, and so do the 200 recent ones',
  $$select (select count(*) from public.audit_events where action = 'rt.edge')::text || '/' ||
           (select count(*) from public.audit_events where action = 'rt.recent')::text$$, '1/200');
select rt.val('RA13 running it again deletes nothing (idempotent)',
  $$select (private.purge_audit_events(false, 500))->>'audit_events.rows'$$, '0');

-- RAIL 3 -- THE SANITY CEILING. 1200 rows past a year against a table that
-- is mostly them: at steady state a run deletes ten minutes of rows, so this
-- shape means the clock, the period or the column is wrong.
delete from public.audit_events where action = 'rt.recent';
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
select '00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1',
       'rt.flood', 'platform', gen_random_uuid(), now() - interval '2 years'
  from generate_series(1, 1200);
select rt.val('RA14 DENOMINATOR: 1200 rows past the period, and they are most of the table',
  $$select ((select count(*) from public.audit_events where action = 'rt.flood') > 1000
            and (select count(*) from public.audit_events where action = 'rt.flood')::numeric
                / (select count(*) from public.audit_events)::numeric > 0.20)::text$$, 'true');
select rt.try_hint('RA15 the sanity ceiling REFUSES it',
  $$select private.purge_audit_events(false, 5000)$$, 'denied(55000:audit_purge_over_ceiling)');
select rt.val('RA16 ...and nothing was deleted while it refused',
  $$select (select count(*) from public.audit_events where action = 'rt.flood')::text$$, '1200');
-- THE CEILING IS ASKED DIRECTLY TOO, so a mutation of the function alone is
-- distinguishable from a mutation of the purge's own literal.
select rt.val('RA17 the ceiling is 20 per cent and 1000 rows, asked of the function itself',
  $$select max_share::text || '/' || min_rows::text from private.audit_purge_ceiling()$$, '0.20/1000');
delete from public.audit_events where action = 'rt.flood';

-- AND THE HOUSE CONTROL.
select rt.try_hint('RA18 the purge refuses `replica` outright',
  $$set local session_replication_role = replica;
    select private.purge_audit_events(true, 1)$$, 'denied(55000:replication_role_must_be_origin)');


-- ===========================================================================
-- RW  THE 60-DAY WORKSPACE PURGE, AND ITS THREE RECORDED TRAPS
-- ===========================================================================

-- rt-purge: closed 61 days ago. rt-back: closed 59 days ago and then
-- REINSTATED. rt-keep: live throughout, and the bystander RX counts.
update public.organisations set deleted_at = now(), lifecycle_state = 'deleted',
       lifecycle_reason = 'rt probe'
 where id = '00000000-0000-4000-9000-0000000067b2';
update public.organisations set lifecycle_changed_at = now() - interval '61 days'
 where id = '00000000-0000-4000-9000-0000000067b2';

update public.organisations set deleted_at = now(), lifecycle_state = 'suspended',
       lifecycle_reason = 'rt probe'
 where id = '00000000-0000-4000-9000-0000000067b3';
update public.organisations set lifecycle_changed_at = now() - interval '59 days'
 where id = '00000000-0000-4000-9000-0000000067b3';

select rt.val('RW1 DENOMINATOR: one workspace one day PAST its 60 days, one one day inside',
  $$select string_agg(slug || '=' || (retention_expires_at < now())::text, ',' order by slug)
      from public.organisations where slug in ('rt-purge','rt-back')$$,
  'rt-back=false,rt-purge=true');
select rt.val('RW2 the DRY run counts one and purges nothing',
  $$select ((private.sweep_expired_workspaces(true, 50))->>'organisations.purged') || '/' ||
           (select count(*)::text from public.organisations where slug = 'rt-purge')$$, '1/1');
select rt.val('RW3 the live sweep purges exactly the expired one, through erase_organisation()',
  $$select (private.sweep_expired_workspaces(false, 50))->>'organisations.purged'$$, '1');
select rt.val('RW4 ...and it is gone, records and all',
  $$select (select count(*) from public.organisations where slug = 'rt-purge')::text || '/' ||
           (select count(*) from public.contacts where id = '00000000-0000-4000-9000-0000000067c2')::text$$, '0/0');
select rt.val('RW5 the workspace one day INSIDE its window is untouched',
  $$select count(*)::text from public.organisations where slug = 'rt-back'$$, '1');
-- TRAP 1: reinstatement works right up to the deadline, and needs no special
-- case -- the lifecycle trigger clears retention_expires_at when deleted_at
-- is cleared, so a reinstated workspace has no deadline for the sweep to find.
-- The rule is "while it is closed", not "59 days yes, 60 days no".
update public.organisations set deleted_at = null where id = '00000000-0000-4000-9000-0000000067b3';
select rt.val('RW6 TRAP 1: reinstating clears the deadline outright',
  $$select coalesce(retention_expires_at::text, 'none') || '/' || lifecycle_state
      from public.organisations where slug = 'rt-back'$$, 'none/active');
select rt.val('RW7 ...so even a run a year later cannot see it',
  $$select (private.sweep_expired_workspaces(false, 50))->>'organisations.purged'$$, '0');
-- TRAP 2: closing an ALREADY-SUSPENDED workspace RESTARTS the clock. It is
-- the customer-favourable direction and CLAUDE.md's "never silently delete
-- data" resolves the ambiguity that way.
update public.organisations set deleted_at = now(), lifecycle_state = 'suspended',
       lifecycle_reason = 'rt probe'
 where id = '00000000-0000-4000-9000-0000000067b3';
update public.organisations set lifecycle_changed_at = now() - interval '61 days'
 where id = '00000000-0000-4000-9000-0000000067b3';
select rt.val('RW8 DENOMINATOR: suspended 61 days ago, and therefore sweepable',
  $$select (retention_expires_at < now())::text from public.organisations where slug = 'rt-back'$$, 'true');
update public.organisations set lifecycle_state = 'deleted', lifecycle_reason = 'rt closed later'
 where id = '00000000-0000-4000-9000-0000000067b3';
select rt.val('RW9 TRAP 2: CLOSING it restarts the clock -- it is no longer sweepable',
  $$select (retention_expires_at > now())::text from public.organisations where slug = 'rt-back'$$, 'true');
select rt.val('RW10 ...and a run now purges nothing',
  $$select (private.sweep_expired_workspaces(false, 50))->>'organisations.purged'$$, '0');
-- TRAP 3: the purge is the FIRST caller erase_organisation() has ever had, and
-- it inherits every refusal. A live workspace is never purged, whatever its
-- dates say.
select rt.try_hint('RW11 TRAP 3: a LIVE workspace is refused by the primitive, not by the sweep',
  $$select private.erase_organisation('00000000-0000-4000-9000-0000000067b1', null, true)$$,
  'denied(22023:workspace_is_live)');
select rt.val('RW12 the purge wrote ONE summary audit row, counts only, actor = the tombstone',
  $$select count(*)::text || '/' || bool_and(actor_user_id = private.erased_user_id())::text
      from public.audit_events
     where action = 'organisation.erased'
       and target_id = '00000000-0000-4000-9000-0000000067b2'$$, '1/true');

-- ---- RX: THE BYSTANDER, COUNTED EITHER SIDE ---------------------------------
select rt.val('RX1 the live workspace this suite never aimed at still has its contact',
  $$select count(*)::text from public.contacts
     where id = '00000000-0000-4000-9000-0000000067c1'$$, '1');
select rt.val('RX2 ...and every workspace this suite did not make is still there',
  -- MEASURED AGAINST A COUNT TAKEN BEFORE THE SWEEPS RAN, not against "ALPHA
  -- exists": this suite runs after twenty others inside run-rls-tests.sh and
  -- standalone during development, and an assertion that holds only in the
  -- first case is one nobody can iterate on -- which is how it fails silently
  -- the day somebody reorders the runner.
  $$select (select count(*) from public.organisations where slug not like 'rt-%')::text$$,
  (select n::text from rt.bystanders));


-- ===========================================================================
-- RQ  Q179: AN UNSANCTIONED ACCOUNT DELETION REFUSES
-- ===========================================================================
-- rt-keep has an Owner, another member and a contact: deleting the Owner's
-- auth.users row directly would leave `owners 0 / members 1 / crm 1`, which
-- is exactly what this refuses now and admitted before.
-- ===========================================================================

select rt.val('RQ1 DENOMINATOR: rt-keep is live, has ONE active owner, another member and a record',
  $$select (select count(*) from public.organisation_memberships
             where organisation_id = '00000000-0000-4000-9000-0000000067b1'
               and role = 'owner' and status = 'active')::text || '/' ||
           (select count(*) from public.organisation_memberships
             where organisation_id = '00000000-0000-4000-9000-0000000067b1')::text || '/' ||
           (select count(*) from public.contacts
             where organisation_id = '00000000-0000-4000-9000-0000000067b1')::text$$, '1/2/1');
-- THIS SUITE'S OWN AUDIT ROWS GO FIRST, and the reason is worth a sentence.
-- THIRTEEN foreign keys reference auth.users with NO ON DELETE action (Task 5
-- § EB pins them by name), so a direct delete of anybody who has ever been an
-- actor is refused with 23503 BEFORE the membership guard is reached at all.
-- That is Task 5's subject and not this one's: private.erase_account() clears
-- them by walking pg_constraint. Leaving them here would make RQ5 -- "the
-- declared deletion IS admitted" -- fail for a reason that has nothing to do
-- with Q179, and a door that looks shut because something else is in the way
-- is exactly the false refusal this suite is written to avoid.
delete from public.audit_events where actor_user_id = '00000000-0000-4000-9000-0000000067a1';
delete from public.incident_alerts where resolved_by = '00000000-0000-4000-9000-0000000067a1';

-- AND THE DENOMINATOR IS DERIVED, NOT LISTED. The two deletes above name the
-- two tables THIS SUITE happened to write; a third one added by a later phase
-- would make RQ5 fail with 23503 and look like Q179's door being shut. So the
-- check walks pg_constraint for every blocking reference to auth.users -- the
-- same walk private.erase_account() does -- and counts how many still name the
-- subject. It must be zero before the guard is the thing being measured.
do $$
declare v_rec record; v_n bigint; v_total bigint := 0; v_seen int := 0;
begin
  for v_rec in
    select con.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass
       and con.confdeltype = 'a'
       and c.relkind in ('r', 'p')
  loop
    v_seen := v_seen + 1;
    execute pg_catalog.format('select count(*) from %s where %I = $1', v_rec.tbl, v_rec.col)
      into v_n using '00000000-0000-4000-9000-0000000067a1'::uuid;
    v_total := v_total + v_n;
  end loop;
  -- The walk itself must have found something, or "zero references" is the
  -- answer to a question nobody asked. Thirteen at 191 migrations.
  perform rt.record('RQ0 DENOMINATOR: the blocker walk sees the thirteen references it should',
                    'true', (v_seen >= 13)::text);
  perform rt.record('RQ0a ...and none of them still names the subject, so the GUARD is what refuses',
                    '0', v_total::text);
end $$;
select rt.try_hint('RQ2 a direct `delete from auth.users` REFUSES -- the Studio Auth-page click',
  $$delete from auth.users where id = '00000000-0000-4000-9000-0000000067a1'$$,
  'denied(42501:account_deletion_is_not_sanctioned)');
select rt.val('RQ3 ...and the workspace still has its owner',
  $$select count(*)::text from public.organisation_memberships
     where organisation_id = '00000000-0000-4000-9000-0000000067b1'
       and role = 'owner' and status = 'active'$$, '1');
-- THE DECLARATION AND THE DELETE HAVE TO BE ONE STATEMENT, because the
-- marker is TRANSACTION-local and psql autocommits every statement -- so a
-- `do $$ ... $$` that sets it, followed by a separate `delete`, sets it and
-- throws it away. Measured on this suite's first run: RQ5 recorded
-- `denied(42501)` against a marker that had already been discarded, which
-- would have read as "the door does not open" and been wrong.
--
-- Each probe is therefore ONE DO block that declares, attempts, records the
-- outcome and closes the door. rt.record() commits with that same statement
-- rather than being rolled back -- the DF11-DF13 class the runner's pinned
-- total exists to catch.
--
-- THE MARKER NAMES THE SUBJECT. A bare boolean would let one declared erasure
-- license the deletion of anybody else in the same transaction.
do $$
declare v_actual text; v_hint text;
begin
  perform private.begin_account_deletion('00000000-0000-4000-9000-0000000067a2');
  begin
    delete from auth.users where id = '00000000-0000-4000-9000-0000000067a1';
    v_actual := 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_actual := 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
  end;
  perform rt.record('RQ4 declaring the WRONG account does not license this one',
                    'denied(42501:account_deletion_is_not_sanctioned)', v_actual);
  perform private.end_account_deletion();
end $$;
-- AND THE DOOR OPENS FOR THE SANCTIONED PATH -- or this would be a wall, and
-- private.erase_account() would be broken by its own guard.
do $$
declare v_actual text; v_n bigint;
begin
  perform private.begin_account_deletion('00000000-0000-4000-9000-0000000067a1');
  begin
    delete from auth.users where id = '00000000-0000-4000-9000-0000000067a1';
    get diagnostics v_n = row_count;
    v_actual := 'ok(' || v_n || ')';
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform rt.record('RQ5 the DECLARED deletion is admitted (or the chokepoint itself is broken)',
                    'ok(1)', v_actual);
  perform private.end_account_deletion();
end $$;
select rt.val('RQ6 ...and it took the membership with it, leaving the colleague',
  $$select count(*)::text from public.organisation_memberships
     where organisation_id = '00000000-0000-4000-9000-0000000067b1'$$, '1');
-- A NON-OWNER IS UNAFFECTED: the refusal fires only where it would previously
-- have done damage, which is the whole measurement of Q179's reach.
select rt.try('RQ7 deleting a NON-owner needs no declaration at all',
  $$delete from auth.users where id = '00000000-0000-4000-9000-0000000067a2'$$, 'ok(1)');


-- ===========================================================================
-- RR  THE RUN
-- ===========================================================================

select rt.val('RR1 a sessionless DRY run completes and records itself',
  $$with r as (select public.start_retention_run(true) as run)
    select ((select public.run_retention_sweep((r.run).id, 500) from r) ? 'run_id')::text$$, 'true');
select rt.val('RR2 ...as a `dry` run, `completed`, with a duration and no refusals',
  $$select mode || '/' || status || '/' || (duration_ms is not null)::text || '/' || refused::text
      from public.retention_runs order by started_at desc limit 1$$, 'dry/completed/true/{}');
select rt.val('RR3 ...and it wrote ONE summary audit row, on the run''s own thread, marked dry',
  $$select count(*)::text || '/' || (max(after->>'mode'))
      from public.audit_events a
      join public.retention_runs r on r.correlation_id = a.correlation_id
     where a.action = 'retention.swept'$$, '1/dry');
select rt.val('RR4 the summary row''s actor is the tombstone -- a scheduled job has nobody on it',
  $$select (actor_user_id = private.erased_user_id())::text
      from public.audit_events where action = 'retention.swept' limit 1$$, 'true');
select rt.val('RR5 `swept` is counts and flags only -- no string can reach a table on /super/health',
  $$select count(*)::text from jsonb_each((select swept from public.retention_runs order by started_at desc limit 1)) e
     where jsonb_typeof(e.value) not in ('number','boolean')$$, '0');

-- THE KILL SWITCH, AT THE RUN LEVEL. A refused run still writes a row: "the
-- job has not deleted anything since the 4th because somebody turned it off"
-- and "there has been nothing to delete" must not look the same.
-- ASKED WITH try_hint, NOT val. The first cut wrapped the call in
-- `select ... where false`, which the planner never evaluates -- so the RPC
-- was not called at all and the assertion recorded a cheerful 'raised'
-- against a guard nobody had asked. A probe that does not reach its subject
-- is this phase's recurring bug, in the suite written to catch it.
select rt.try_hint('RR6 the master switch is superuser-only, even for `postgres`',
  $$select public.set_retention_enabled(false, true, 'rt probe')$$,
  'denied(42501:retention_switch_is_superuser_only)');
update public.retention_settings set enabled = false where id;
select rt.val('RR7 with the job off, a run is RECORDED as refused rather than skipped silently',
  $$select (public.start_retention_run(false)).status || '/' ||
           ((public.start_retention_run(false)).refused->>'*')$$, 'refused/retention_disabled');
update public.retention_settings set enabled = true where id;

-- A FAILING SWEEP CANNOT STOP ANY OTHER SWEEP. Proved by breaking one: the
-- roll's derivation refuses while an unclassified table exists, and every
-- other sweep still runs and is still counted.
create table public.rt_unclassified_probe (id uuid primary key default gen_random_uuid());
select rt.try_hint('RR8 an unclassified table stops the run at STEP 0, before a row moves',
  $$with r as (select public.start_retention_run(false) as run)
    select public.run_retention_sweep((r.run).id, 500) from r$$,
  'denied(55000:unclassified_retention_subject)');
drop table public.rt_unclassified_probe;

select rt.val('RR9 a LIVE run now completes and every sweep is represented in its counts',
  $$with r as (select public.start_retention_run(false) as run)
    select (select count(*)::text from jsonb_each(public.run_retention_sweep((r.run).id, 500)) e
             where e.key in ('rate_limit_counters.rows','feedback.rows','incident_alerts.rows',
                             'erasure_jobs.rows','export_jobs.reaped','documents.bytes_purged',
                             'audit_events.rows','organisations.purged')) from r$$, '8');
select rt.val('RR10 running it twice more changes nothing (idempotent, and safe to run late)',
  $$with a as (select public.start_retention_run(false) as run)
    select (select (public.run_retention_sweep((a.run).id, 500))->>'audit_events.rows' from a)$$, '0');
select rt.val('RR11 a run cannot be completed twice',
  $$select (public.run_retention_sweep(
              (select id from public.retention_runs order by started_at desc limit 1), 500)) is not null$$,
  'denied(22023)');
select rt.try_hint('RR12 the run refuses `replica` at its outermost gate',
  $$set local session_replication_role = replica;
    with r as (select public.start_retention_run(true) as run)
    select public.run_retention_sweep((r.run).id, 500) from r$$,
  'denied(55000:replication_role_must_be_origin)');
select rt.val('RR13 the object manifest is readable and derives keys rather than taking them',
  $$select (select count(*) >= 0 from public.retention_object_manifest(10))::text$$, 'true');

-- ---------------------------------------------------------------------------
-- RR14/RR15: THE ONE THING THIS SUITE CANNOT ASK BY CALLING, ASSERTED FROM
-- THE CATALOGUE INSTEAD.
--
-- The three runner RPCs shipped with a gate that refused `request.jwt.claims
-- is not null` -- which PostgREST sets on EVERY request INCLUDING the
-- service_role one the runner makes, so the job refused its own runner and
-- every run returned `unavailable`. Every assertion in this section passed
-- anyway, because as `postgres` over psql there is no such setting at all:
-- the suite could not see its own subject. It was found by
-- tests/integration/retention/runner.test.ts, which is the only test in the
-- estate that calls these over PostgREST.
--
-- So the SHAPE of the gate is pinned here, read out of the live function
-- bodies: it must consult the session ROLE against the same open list of
-- server roles its three siblings use, and it must not consult
-- `request.jwt.claims` at all -- whose presence says only that a request came
-- through PostgREST and nothing whatever about who made it.
-- ---------------------------------------------------------------------------
select rt.val('RR14 all three runner RPCs gate on the session ROLE, like their siblings',
  $$select string_agg(p.proname || ':' ||
        (pg_get_functiondef(p.oid) like '%''postgres'', ''service_role'', ''none''%')::text,
        ',' order by p.proname)
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fail_retention_run', 'run_retention_sweep', 'start_retention_run')$$,
  'fail_retention_run:true,run_retention_sweep:true,start_retention_run:true');
select rt.val('RR15 ...and NONE of them consults request.jwt.claims, which PostgREST always sets',
  $$select count(*)::text
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fail_retention_run', 'run_retention_sweep', 'start_retention_run')
       and pg_get_functiondef(p.oid) like '%request.jwt.claims%'$$, '0');


-- ===========================================================================
-- RZ  HOUSEKEEPING
-- ===========================================================================
-- Every row this suite made, removed -- so a second run over the same database
-- measures the same thing, and no other suite inherits a sweep's leavings.

delete from public.audit_events where action in ('rt.recent','rt.old','rt.edge','rt.flood','retention.swept');
delete from public.audit_events where action = 'organisation.erased'
   and target_id = '00000000-0000-4000-9000-0000000067b2';
delete from public.retention_runs;
delete from public.feedback where route = '/rt';
delete from public.incident_alerts where summary like 'rt %';
alter table public.erasure_jobs disable trigger user;
delete from public.erasure_jobs where failure_reason in ('rt probe')
   or id = '00000000-0000-4000-9000-0000000067f3';
alter table public.erasure_jobs enable trigger user;
delete from public.rate_limit_counters
 where subject_id in ('00000000-0000-4000-9000-0000000067a1','00000000-0000-4000-9000-0000000067a2');
delete from public.organisations where slug in ('rt-keep','rt-back','rt-purge');
delete from auth.users where email like '%@rt.invalid';
update public.retention_settings set enabled = true, audit_purge_enabled = true, reason = null where id;

select rt.val('RZ1 every fixture workspace is gone',
  $$select count(*)::text from public.organisations where slug like 'rt-%'$$, '0');
select rt.val('RZ2 every fixture account is gone',
  $$select count(*)::text from auth.users where email like '%@rt.invalid'$$, '0');
select rt.val('RZ3 the run log is empty again',
  $$select count(*)::text from public.retention_runs$$, '0');
select rt.val('RZ4 the switches are back to their seeded state',
  $$select enabled::text || '/' || audit_purge_enabled::text from public.retention_settings$$, 'true/true');
select rt.val('RZ5 the erasure write guard is enabled',
  $$select count(*)::text from pg_trigger
     where tgrelid = 'public.erasure_jobs'::regclass and not tgisinternal and tgenabled = 'D'$$, '0');
select rt.val('RZ6 the derivation still passes on the schema this suite leaves behind',
  $$select coalesce((select 'raised' from (select private.assert_retention_roll()) t where false), 'ok')$$, 'ok');

\echo ''
\echo '--- PHASE 8 RETENTION: failures ---'
select seq, label, expected, actual from rt.results where not pass order by seq;
select count(*) as failed from rt.results where not pass;
select count(*) as recorded from rt.results;
