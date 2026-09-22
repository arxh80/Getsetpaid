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
-- CALLED, NOT WRAPPED (fix round 1). RC16, RD8, RD10 and RZ6 shipped as
--   select coalesce((select 'raised' from (select f()) t where false), 'ok')
-- and `where false` is a One-Time Filter: the planner never puts f() in the
-- plan at all (EXPLAIN shows a bare Result), so all four recorded a cheerful
-- pass against a function nobody had called. RR6's own comment describes this
-- exact bug in this exact suite, and four copies of it were still here. rt.try
-- executes the statement and records `ok(1)` or the SQLSTATE.
select rt.try('RC16 the tick RUNS, with every half reached, and raises nothing',
  $$select private.run_incident_alert_tick()$$, 'ok(1)');
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
select rt.val('RD6 the roll is exactly the size of the catalogue -- and the catalogue is at least every table in `public`',
  $$select ((select count(*) from private.retention_subjects())
          = (select count(*) from private.retention_roll_relations()))::text || '/' ||
           ((select count(*) from private.retention_roll_relations())
         >= (select count(*) from pg_class
              where relnamespace = 'public'::regnamespace and relkind in ('r','p')))::text$$, 'true/true');
select rt.val('RD7 ...and carries no table twice',
  $$select ((select count(*) from private.retention_subjects())
          = (select count(distinct table_name) from private.retention_subjects()))::text$$, 'true');
select rt.try('RD8 the derivation passes on the live schema (CALLED -- see RC16)',
  $$select private.assert_retention_roll()$$, 'ok(1)');

-- AND THE DERIVATION'S THREE REFUSALS, EACH PLANTED AND ASKED DIRECTLY.
-- This is the "assert what it dropped" half: a roll that classifies nothing
-- new is a roll nobody will notice has gone stale.
create table public.rt_unclassified_probe (id uuid primary key default gen_random_uuid());
select rt.try_hint('RD9 a NEW TABLE nobody classified refuses the whole job',
  $$select private.assert_retention_roll()$$, 'denied(55000:unclassified_retention_subject)');
drop table public.rt_unclassified_probe;
select rt.try('RD10 ...and the refusal goes away when the table does (the control, CALLED)',
  $$select private.assert_retention_roll()$$, 'ok(1)');

-- WHAT ELSE COUNTS AS "A NEW RETAINED THING" (fix round 1, review finding m1).
-- As shipped the derivation saw ordinary and partitioned tables in `public`
-- and nothing else. The reviewer planted four more shapes; two of them HOLD
-- DATA and passed silently.
create materialized view public.rt_probe_mv as select id, name from public.contacts;
select rt.try_hint('RD10a a MATERIALIZED VIEW holds a copy of the data, and refuses the job until it is classified',
  $$select private.assert_retention_roll()$$, 'denied(55000:unclassified_retention_subject)');
select rt.val('RD10b ...and the refusal NAMES it',
  $$select string_agg(t, ',') from private.unclassified_retention_subjects() t$$, 'rt_probe_mv');
drop materialized view public.rt_probe_mv;
create table private.rt_probe_private (id uuid primary key default gen_random_uuid());
select rt.val('RD10c a table in `private` is seen too, under its qualified name',
  $$select string_agg(t, ',') from private.unclassified_retention_subjects() t$$, 'private.rt_probe_private');
drop table private.rt_probe_private;
create view public.rt_probe_v as select id from public.contacts;
select rt.try('RD10d CONTROL: a plain VIEW stores nothing and is not asked about',
  $$select private.assert_retention_roll()$$, 'ok(1)');
drop view public.rt_probe_v;
-- THE STATED LIMIT, MEASURED RATHER THAN IMPLIED: a table in a schema this
-- product's migrations do not own is NOT seen. 20261004005000's header says
-- why that is a decision (Task 5's roll made the same one) and why a schema
-- allowlist was rejected -- this very suite's `rt` schema would trip it.
select rt.try('RD10e STATED LIMIT: a table in another schema (this suite''s own `rt`) does not refuse the job',
  $$select private.assert_retention_roll()$$, 'ok(1)');

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
-- RL  THE PUBLISHED PAGE AND THE DECLARATION SAY THE SAME THING
--     (fix round 1, review finding I3 / Q183)
-- ===========================================================================
-- /legal/data-retention v5 deleted "Automated deletion is still being built"
-- and left two sentences standing that were only survivable under it:
-- "Inactive account data: 2 years" (nothing sweeps it) and "When a period
-- ends, the data is permanently deleted or anonymised" (false for every
-- `retained_with_workspace` table). v6 (20261004006000) says plainly what is
-- NOT deleted. This section is what stops v7 drifting the same way:
--
--   RL2  every one of the ELEVEN declared periods appears on the page, IN THE
--        SENTENCE THAT STATES IT, with the number read out of
--        private.retention_periods() -- so counsel's answer to Q133, a reissue
--        of that one function, reds the page until somebody corrects it too.
--   RL4  every table the roll calls `retained_with_workspace` is NAMED in the
--        page's "What is not deleted automatically" list -- so a new tenant
--        table nobody told the page about is a red assertion.
-- ===========================================================================

create function rt.period_words(p interval) returns text language sql immutable as $$
  select case
    when extract(year from p)  > 0 then extract(year from p)::int  || ' year' || case when extract(year from p)  > 1 then 's' else '' end
    when extract(day from p)   > 0 then extract(day from p)::int   || ' day'  || case when extract(day from p)   > 1 then 's' else '' end
    when extract(hour from p)  > 0 then extract(hour from p)::int  || ' hour' || case when extract(hour from p)  > 1 then 's' else '' end
  end
$$;

-- THE SENTENCE EACH CLASS IS STATED IN, with {p} where the period goes. The
-- fragments are the page's; the NUMBERS are the database's.
create table rt.page_sentences (class text primary key, fragment text not null);
insert into rt.page_sentences values
  ('operational',        '**The file behind a deleted document:** {p} after the document was deleted'),
  ('financial',          '-- or {p} if the document is attached to an event that carries financial entries'),
  ('feedback',           'including any screenshot: {p} from submission'),
  ('audit_hot',          'searchable by our operator for {p},'),
  ('audit_total',        'kept for up to {p} in total, then deleted'),
  ('workspace',          '**A suspended or closed workspace:** {p} from suspension or closure'),
  ('incident_alert',     '**Security alerts raised for our operator:** {p} after the alert was resolved'),
  ('erasure_job_failed', '**The record of an account deletion that failed:** {p} after it failed'),
  ('rate_limit_counter', 'in a recent window): {p} after that window closed'),
  ('storage_orphan',     'by an upload that did not complete): {p}.'),
  ('stuck_job',          'stuck "in progress" for more than {p} is marked as failed');

select rt.val('RL1 DENOMINATOR: eleven classes are declared, every one has a sentence to be found in, and the page is the unreviewed current version',
  $$select (select count(*)::text from private.retention_periods()) || '/' ||
           (select coalesce(string_agg(p.class, ','), 'none') from private.retention_periods() p
             where not exists (select 1 from rt.page_sentences s where s.class = p.class)) || '/' ||
           (select (version >= 6)::text || '/' || (counsel_reviewed_at is null)::text
              from public.legal_documents where slug = 'data-retention' and status = 'published')$$,
  '11/none/true/true');
select rt.val('RL2 EVERY declared period is on the published page, in the sentence that states it, with the DATABASE''S number',
  $$select coalesce(string_agg(p.class, ',' order by p.class), 'none')
      from private.retention_periods() p
      join rt.page_sentences s on s.class = p.class
     where strpos((select body from public.legal_documents where slug = 'data-retention' and status = 'published'),
                  replace(s.fragment, '{p}', rt.period_words(p.period))) = 0$$, 'none');
-- THE STANDING MUTATION: counsel answers Q133 -- "seven years is six" -- by
-- reissuing the one function. The page must go red until it is corrected.
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'periods');
  v_new := pg_catalog.replace(v_def, 'interval ''7 years''', 'interval ''6 years''');
  if v_new = v_def then
    raise exception 'RL3 could not change the declared period -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.val('RL3 MUTATION: when the declaration changes to 6 years, the page that still says 7 is NAMED',
  $$select coalesce(string_agg(p.class, ',' order by p.class), 'none')
      from private.retention_periods() p
      join rt.page_sentences s on s.class = p.class
     where strpos((select body from public.legal_documents where slug = 'data-retention' and status = 'published'),
                  replace(s.fragment, '{p}', rt.period_words(p.period))) = 0$$, 'financial');
do $$ begin execute (select def from rt.saved_defs where name = 'periods'); end $$;
discard plans;
select rt.val('RL3a ...and the declaration is restored byte-identically',
  $$select (pg_get_functiondef('private.retention_periods()'::regprocedure)
            = (select def from rt.saved_defs where name = 'periods'))::text$$, 'true');

select rt.val('RL4 every table the roll calls `retained_with_workspace` is NAMED in the page''s list of what is NOT deleted',
  $$select (select count(*)::text from private.retention_subjects() where treatment = 'retained_with_workspace')
        || '/' ||
           coalesce((select string_agg(s.table_name, ',' order by s.table_name)
                       from private.retention_subjects() s
                      where s.treatment = 'retained_with_workspace'
                        and strpos(
                              split_part(split_part(
                                (select body from public.legal_documents
                                  where slug = 'data-retention' and status = 'published'),
                                '## What is not deleted automatically', 2), '## A deleted account', 1),
                              replace(s.table_name, '_', ' ')) = 0), 'none')$$, '11/none');
select rt.val('RL5 the page says PLAINLY that nothing removes a deleted record, an inactive account or a financial record -- and no longer promises that every period ends in deletion',
  $$select (body like '%**No period removes it after that.**%')::text || '/' ||
           (body like '%**No automated process applies it today:**%')::text || '/' ||
           (body like '%**Nothing deletes them when the 7 years end.**%')::text || '/' ||
           (body like '%When a period ends, the data is permanently deleted or anonymised%')::text
      from public.legal_documents where slug = 'data-retention' and status = 'published'$$,
  'true/true/true/false');
select rt.val('RL6 DENOMINATOR for RL5: the version it superseded DID make that promise, with nothing beside it to qualify it',
  $$select (body like '%When a period ends, the data is permanently deleted or anonymised%')::text || '/' ||
           (body like '%still being built%')::text
      from public.legal_documents where slug = 'data-retention' and version = 5$$, 'true/false');
-- m4: v5's migration published EVERY draft of the slug. v6 publishes by id.
select rt.val('RL7 exactly ONE data-retention version is published, and no draft of it was swept up (m4)',
  $$select (select count(*)::text from public.legal_documents where slug = 'data-retention' and status = 'published')
        || '/' ||
           (select count(*)::text from public.legal_documents where slug = 'data-retention' and status = 'draft')$$,
  '1/0');


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
-- THE BYTES-FIRST GATE, WHICH THIS SUITE USED TO BE BLIND TO (the first
-- round's mutation M8: 0 of 116). The reason given then was that psql can
-- plant a storage object and cannot remove one. True -- and a subtransaction
-- that is ROLLED BACK removes it. So: an expired row WITH its screenshot still
-- stored, swept live, its outcome carried out in the exception message. The
-- wrong-KIND survivor for this sweep: past its period in every respect, and
-- kept, because deleting it would orphan an image of somebody's screen.
do $$
declare v_out text; v_r jsonb; v_still bigint;
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('feedback-screenshots', 'feedback/00000000-0000-4000-9000-0000000067d3');
    insert into public.feedback (id, user_id, category, message, route, screenshot_key, screenshot_mime,
                                 screenshot_size_bytes, screenshot_scan_status, screenshot_scanned_at, created_at)
    values ('00000000-0000-4000-9000-0000000067d3', '00000000-0000-4000-9000-0000000067a1', 'bug',
            'rt with a screenshot', '/rt', 'feedback/00000000-0000-4000-9000-0000000067d3', 'image/png', 10,
            'clean', pg_catalog.now(), pg_catalog.now() - interval '2 years' - interval '1 day');
    v_r := private.sweep_feedback(false, 500);
    select pg_catalog.count(*) into v_still from public.feedback
     where id = '00000000-0000-4000-9000-0000000067d3';
    raise exception 'RS_RESULT rows=%/waiting=%/still_there=%',
      v_r->>'feedback.rows', v_r->>'feedback.waiting_on_bytes', v_still;
  exception when others then
    v_out := sqlerrm;
  end;
  perform rt.record('RS8a WRONG KIND: an EXPIRED feedback row whose screenshot is STILL STORED is deferred, counted as waiting, and survives',
                    'rows=0/waiting=1/still_there=1', pg_catalog.replace(v_out, 'RS_RESULT ', ''));
end $$;

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
-- THE WRONG-KIND SURVIVOR (fix round 1, I4). A SUCCEEDED job, THREE YEARS
-- old, pseudonymous as a real one is. It is "the evidence that a statutory
-- deletion was performed, which is the last thing a retention job should
-- destroy" -- and as shipped, deleting `j.status = 'failed'` from the sweep
-- (the review's mutation MC) reddened NOTHING, because every row this section
-- planted was a failed one and the only survivor was a YOUNG failed one. RS9's
-- five-year-old OPEN alert is the model: a survivor of the wrong KIND.
insert into public.erasure_jobs (id, kind, subject_user_id, requested_by, status, summary,
                                 requested_at, started_at, completed_at)
values ('00000000-0000-4000-9000-0000000067f4', 'account', null, null, 'succeeded', '{"rt_probe": 1}',
        now() - interval '3 years', now() - interval '3 years', now() - interval '3 years');
alter table public.erasure_jobs enable trigger user;
select rt.val('RS12 DENOMINATOR: two failed erasure jobs, one either side of 90 days',
  $$select count(*)::text from public.erasure_jobs where failure_reason = 'rt probe'$$, '2');
select rt.val('RS13 the sweep deletes exactly the one past 90 days',
  $$select (private.sweep_erasure_jobs(false, 500))->>'erasure_jobs.rows'$$, '1');
select rt.val('RS14 ...and the one a day INSIDE survives',
  $$select id::text from public.erasure_jobs where failure_reason = 'rt probe'$$,
  '00000000-0000-4000-9000-0000000067f2');
select rt.val('RS14a WRONG KIND: a SUCCEEDED erasure job THREE YEARS old survives -- it is the proof the deletion happened',
  $$select status || '/' || (completed_at < now() - interval '90 days')::text
      from public.erasure_jobs where id = '00000000-0000-4000-9000-0000000067f4'$$, 'succeeded/true');
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
-- THE WRONG-KIND SURVIVOR (I4): a LIVE document, three years old, whose object
-- is absent -- everything the sweep looks for EXCEPT being deleted.
insert into public.documents (id, organisation_id, filename, storage_key, mime_type, size_bytes,
                              scan_status, scanned_at, created_at) values
  ('00000000-0000-4000-9000-000000006706', '00000000-0000-4000-9000-0000000067b1', 'live-and-old.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006706',
   'application/pdf', 10, 'clean', now() - interval '3 years', now() - interval '3 years');
select rt.val('RS19 DENOMINATOR: two soft-deleted documents, one either side of two years, neither purged',
  $$select count(*)::text from public.documents
     where organisation_id = '00000000-0000-4000-9000-0000000067b1' and bytes_purged_at is null
       and deleted_at is not null$$, '2');
select rt.val('RS20 the sweep stamps exactly the expired one',
  $$select (private.sweep_document_bytes(false, 500))->>'documents.bytes_purged'$$, '1');
select rt.val('RS21 ...and the one a day INSIDE its period is untouched -- and so is the LIVE one three years old (wrong kind)',
  $$select string_agg(filename, ',' order by filename) from public.documents
     where organisation_id = '00000000-0000-4000-9000-0000000067b1' and bytes_purged_at is null$$,
  'live-and-old.pdf,newer.pdf');
-- THE CLASS IS DERIVED, NOT ASSUMED -- and, since fix round 2 (I-N1 / Q186),
-- FROZEN WHEN THE CLOCK STARTS. Attaching the newer document to an event that
-- carries financial entries moves what the LIVE derivation answers from the
-- two-year class to the seven-year one; it does NOT move the class the sweep
-- reads, which was stamped `operational` when 6702 was born deleted with no
-- link at all. § RK-N1 walks both directions of that; RS23a is the half of
-- it this fixture can show.
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
select rt.val('RS23 ...and the SAME document becomes `financial` (7 years) the moment the event carries money -- in the LIVE derivation',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006702')$$, 'financial');
select rt.val('RS23a ...while the class the SWEEP reads was frozen `operational` when its clock started, and money arriving later does not promote it (I-N1 / Q186)',
  $$select retention_class from public.documents where id = '00000000-0000-4000-9000-000000006702'$$, 'operational');


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
-- THREE DIFFERENT AGES, INSERTED NEWEST FIRST (fix round 1, m2). As shipped all
-- three shared one timestamp, so "oldest first" could only ever be asserted as
-- a COUNT -- and removing `order by a.created_at` from the purge reddened
-- nothing. Heap order here is the OPPOSITE of age order, so an unordered
-- `limit 2` takes the two newest and RA10a names the wrong survivor.
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
select '00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-0000000067a1',
       'rt.old', 'platform', gen_random_uuid(), now() - interval '1 year' - make_interval(days => g)
  from generate_series(1, 3) g order by g;
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
select rt.val('RA10a ...leaving exactly ONE, and it is the NEWEST of the three -- the two OLDEST went first',
  $$select count(*)::text || '/' ||
           bool_and(created_at > now() - interval '1 year' - interval '1 day' - interval '1 hour')::text
      from public.audit_events where action = 'rt.old'$$, '1/true');
select rt.val('RA11 ...and the next run finishes the remainder rather than skipping it',
  $$select (private.purge_audit_events(false, 500))->>'audit_events.rows'$$, '1');
select rt.val('RA11a ...with none of them left',
  $$select count(*)::text from public.audit_events where action = 'rt.old'$$, '0');
select rt.val('RA12 the row ONE DAY INSIDE the year survives, and so do the 200 recent ones',
  $$select (select count(*) from public.audit_events where action = 'rt.edge')::text || '/' ||
           (select count(*) from public.audit_events where action = 'rt.recent')::text$$, '1/200');
select rt.val('RA13 running it again deletes nothing (idempotent)',
  $$select (private.purge_audit_events(false, 500))->>'audit_events.rows'$$, '0');

-- ---------------------------------------------------------------------------
-- RA-I1: "THE PURGE EXEMPTS NO ACTION" -- ASSERTED, IN BOTH DIRECTIONS
-- (fix round 1, review finding I1).
--
-- 20261003003000 states it as a design promise: "exempts no action, because
-- an exemption list is a retention policy written twice". Nothing measured
-- it. The reviewer added `or a.action like 'impersonation%'` to the purge's
-- WHERE clause -- which deletes THE ENTIRE RECORD OF SUPERUSER ACCESS TO
-- TENANT DATA, AT ANY AGE -- and all 116 assertions passed, because every
-- survivor in this section carried one of the suite's own action values
-- (`rt.edge`, `rt.recent`) and a term keyed on `action` missed them all. A
-- term keyed on organisation_id or actor_user_id had the same hole.
--
-- So: EVERY action the product writes, DERIVED from the live catalogue and
-- not listed -- every literal `p_action => '...'` in any function, every
-- literal in a function that inserts into audit_events directly, every
-- CRM trigger's target x verb, every action already in the table, and
-- (since fix round 2, m-N4) the whole of private.audit_action_catalogue(),
-- the database's copy of lib/admin/audit-actions.ts -- is planted FOUR
-- times: one day inside the period and one day past it, each
-- once as a TENANT row (organisation set, a person as actor) and once as a
-- PLATFORM row (no organisation, the Q130 tombstone as actor). The derivation
-- over-collects (`auth.users` is not an action) and that is harmless: the
-- purge must treat any string alike, which is the property.
--
-- Then the purged and surviving SETS are asserted. An exemption added reds
-- RA-I1d; an over-delete added reds RA-I1e.
-- ---------------------------------------------------------------------------
create table rt.i1_actions as
  with fn as (
    select p.prosrc, p.proname, p.oid from pg_proc p
     where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  )
  select distinct action from (
    select m[1] as action from fn, lateral regexp_matches(fn.prosrc, 'p_action\s*=>\s*''([a-z_0-9.]+)''', 'g') m
    union all
    select m[1] from fn, lateral regexp_matches(fn.prosrc, '''([a-z_0-9]+\.[a-z_0-9]+)''', 'g') m
     where fn.prosrc ~ 'insert\s+into\s+public\.audit_events' or fn.prosrc ~ 'log_audit_event'
    union all
    select replace(encode(t.tgargs, 'escape'), '\000', '') || '.' || v[1]
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid and p.proname = 'audit_crm_change',
           lateral regexp_matches(p.prosrc, '''\.([a-z_]+)''', 'g') v
     where not t.tgisinternal
    union all
    select split_part(replace(encode(t.tgargs, 'escape'), '\000', chr(1)), chr(1), 1)
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid and p.proname = 'audit_crm_row'
     where not t.tgisinternal
    union all
    select a.action from public.audit_events a where a.action not like 'rt.%'
    -- AND THE PRODUCT'S OWN CATALOGUE (fix round 2, re-review finding m-N4):
    -- ELEVEN catalogue names were outside every arm above -- the five DSR
    -- transitions built as 'data_subject_request.' || status, the two
    -- impersonation terminals built from the state, and the four dot-less
    -- document_* actions passed in from TypeScript -- and exempting three of
    -- them by name reddened 0 of 221. private.audit_action_catalogue() is the
    -- database's copy of lib/admin/audit-actions.ts, bound to it both ways.
    union all
    select private.audit_action_catalogue()
  ) x
  where action is not null and action <> '' and action not like '%.';

select rt.val('RA-I1a2 DENOMINATOR (m-N4): the eleven names the regexes could not see are planted BY NAME, and the whole catalogue is in the set',
  $$select (select count(*)::text from (
              select unnest(array['data_subject_request.fulfilment_recorded', 'data_subject_request.in_progress',
                                  'data_subject_request.rejected', 'data_subject_request.routed',
                                  'data_subject_request.withdrawn', 'document_deleted', 'document_downloaded',
                                  'document_quarantined', 'document_uploaded', 'impersonation.ended',
                                  'impersonation.expired']) as c) t
             where exists (select 1 from rt.i1_actions a where a.action = t.c))
        || '/' ||
           (select coalesce(string_agg(c, ','), 'none')
              from private.audit_action_catalogue() c
             where not exists (select 1 from rt.i1_actions a where a.action = c))
        || '/' || (select (count(*) >= 96)::text from private.audit_action_catalogue())$$,
  '11/none/true');
select rt.val('RA-I1a DENOMINATOR: the catalogue is derived and SEES the classes that matter -- impersonation, organisation, a CRM write, a platform read, this job',
  $$select ((select count(*) from rt.i1_actions) >= 60)::text || '/' ||
           (select string_agg(c, ',' order by c)
              from (select unnest(array['impersonation.started', 'organisation.erased', 'contact.updated',
                                        'platform_health.viewed', 'retention.swept']) c) t
             where exists (select 1 from rt.i1_actions a where a.action = t.c))$$,
  'true/contact.updated,impersonation.started,organisation.erased,platform_health.viewed,retention.swept');

insert into public.audit_events
  (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, created_at)
select case when v.tenant then '00000000-0000-4000-9000-0000000067b1'::uuid end,
       case when v.tenant then '00000000-0000-4000-9000-0000000067a1'::uuid else private.erased_user_id() end,
       a.action, 'platform',
       case when v.past then '00000000-0000-4000-9000-000000006aa2'::uuid
            else '00000000-0000-4000-9000-000000006aa1'::uuid end,
       gen_random_uuid(),
       case when v.past then now() - interval '1 year' - interval '1 day'
            else now() - interval '1 year' + interval '1 day' end
  from rt.i1_actions a
 cross join (values (true, true), (true, false), (false, true), (false, false)) v(tenant, past);

select rt.val('RA-I1b DENOMINATOR: every action is planted four times -- inside and past, tenant and platform',
  $$select ((select count(*) from public.audit_events where target_id = '00000000-0000-4000-9000-000000006aa1')
          = 2 * (select count(*) from rt.i1_actions))::text || '/' ||
           ((select count(*) from public.audit_events where target_id = '00000000-0000-4000-9000-000000006aa2')
          = 2 * (select count(*) from rt.i1_actions))::text$$, 'true/true');
select rt.val('RA-I1c the purge takes EXACTLY the rows past the period -- two per action, no more and no fewer',
  $$select (((private.purge_audit_events(false, 5000))->>'audit_events.rows')::bigint
          = 2 * (select count(*) from rt.i1_actions))::text$$, 'true');
select rt.val('RA-I1d NO ACTION IS EXEMPT: of the rows a day PAST the period, none of any action survives',
  $$select coalesce(string_agg(distinct action, ',' order by action), 'none')
      from public.audit_events where target_id = '00000000-0000-4000-9000-000000006aa2'$$, 'none');
select rt.val('RA-I1e NO ACTION IS OVER-DELETED: of the rows a day INSIDE it, every action survives, as a tenant row AND as a platform row',
  $$select coalesce(string_agg(w.action || case when w.tenant then '(tenant)' else '(platform)' end, ','
                               order by w.action, w.tenant), 'none')
      from (select a.action, v.tenant from rt.i1_actions a cross join (values (true), (false)) v(tenant)) w
     where not exists (
       select 1 from public.audit_events e
        where e.target_id = '00000000-0000-4000-9000-000000006aa1'
          and e.action = w.action
          and (e.organisation_id is not null) = w.tenant)$$, 'none');
delete from public.audit_events
 where target_id in ('00000000-0000-4000-9000-000000006aa1', '00000000-0000-4000-9000-000000006aa2');

-- "OLDEST FIRST", FROM THE CATALOGUE AS WELL (m2). RA10a measures it for the
-- audit purge; this asks it of EVERY bounded query in EVERY sweep at once --
-- a `limit p_limit` with no `order by` in front of it takes an arbitrary
-- slice, and a capped run that does that can skip the same rows for ever.
select rt.val('RA-M2 every `limit p_limit` in every sweep, the purge and the reaper sits directly under an ORDER BY',
  $$select string_agg(p.proname || ':' ||
             (regexp_count(pg_get_functiondef(p.oid), 'limit p_limit')
            = regexp_count(pg_get_functiondef(p.oid), 'order by [a-z_.]+\s+limit p_limit'))::text
             || '/' || (regexp_count(pg_get_functiondef(p.oid), 'limit p_limit') > 0)::text,
           ',' order by p.proname)
      from pg_proc p
     where p.pronamespace = 'private'::regnamespace
       and p.proname in ('purge_audit_events', 'reap_stuck_jobs', 'sweep_document_bytes', 'sweep_erasure_jobs',
                         'sweep_expired_workspaces', 'sweep_feedback', 'sweep_incident_alerts',
                         'sweep_rate_limit_counters')$$,
  'purge_audit_events:true/true,reap_stuck_jobs:true/true,sweep_document_bytes:true/true,sweep_erasure_jobs:true/true,sweep_expired_workspaces:true/true,sweep_feedback:true/true,sweep_incident_alerts:true/true,sweep_rate_limit_counters:true/true');

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

-- THE WRONG-KIND SURVIVOR (I4): a LIVE workspace carrying a PAST
-- retention_expires_at. The review's mutation MA -- the sweep losing
-- `o.deleted_at is not null` -- reddened nothing, and its note was that the
-- state is unreachable "only because a trigger nulls the column". MEASURED
-- HERE, IT IS STRONGER THAN THAT: organisations_lifecycle_matches_deleted_at
-- is a CHECK whose third term is
--   (lifecycle_state = 'active') = (retention_expires_at is null)
-- so the state is unrepresentable for EVERY writer, with the trigger out of
-- the way. RW0 asks that directly. RW5a/RW5b then ask the sweep's and the
-- manifest's OWN term anyway, with the constraint dropped inside a rolled-back
-- subtransaction -- because a second line of defence nobody has ever asked is
-- one nobody knows is there.
alter table public.organisations disable trigger organisation_lifecycle_sync;
select rt.try('RW0 a LIVE workspace cannot carry a retention deadline AT ALL -- the CHECK refuses it with the sync trigger disabled',
  $$update public.organisations set retention_expires_at = now() - interval '1 day'
     where id = '00000000-0000-4000-9000-0000000067b1'$$, 'denied(23514)');
alter table public.organisations enable trigger organisation_lifecycle_sync;
select rt.val('RW0a ...and the trigger is back on, so nothing after this is weakened',
  $$select count(*)::text from pg_trigger where tgrelid = 'public.organisations'::regclass
       and not tgisinternal and tgenabled = 'D'$$, '0');

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
-- THE SWEEP'S AND THE MANIFEST'S OWN `deleted_at is not null`, ASKED WITH THE
-- CONSTRAINT OUT OF THE WAY. Everything below happens in one subtransaction
-- that is rolled back -- the dropped CHECK, the disabled trigger, the planted
-- deadline, the planted storage object (psql can plant one and cannot remove
-- one) and the dry run -- and the answer is carried out in the exception
-- message (the RK18 shape). rt-purge is already gone and rt-back is inside its
-- window, so an honest dry count here is ZERO.
do $$
declare v_out text; v_run uuid; v_named bigint; v_seen bigint; v_dry text; v_live text;
begin
  begin
    alter table public.organisations drop constraint organisations_lifecycle_matches_deleted_at;
    alter table public.organisations disable trigger organisation_lifecycle_sync;
    update public.organisations set retention_expires_at = pg_catalog.now() - interval '1 day'
     where id = '00000000-0000-4000-9000-0000000067b1';
    -- BACK ON BEFORE THE RUN IS OPENED, and not as tidiness: that trigger is the
    -- named guard of two retention clocks, and with it disabled
    -- private.assert_retention_clocks() REFUSES the run (`forgeable_retention_
    -- clock`). It did exactly that to the first cut of this probe.
    alter table public.organisations enable trigger organisation_lifecycle_sync;
    select (o.deleted_at is null)::text || (o.retention_expires_at < pg_catalog.now())::text into v_live
      from public.organisations o where o.id = '00000000-0000-4000-9000-0000000067b1';
    insert into storage.objects (bucket_id, name)
    values ('documents', '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006706');
    select pg_catalog.count(*) into v_seen from storage.objects
     where name = '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006706';
    v_dry := (private.sweep_expired_workspaces(true, 50))->>'organisations.purged';
    v_run := (public.start_retention_run(true)).id;
    select pg_catalog.count(*) into v_named
      from public.retention_object_manifest(v_run, 500) m
     where m.object_key like '00000000-0000-4000-9000-0000000067b1/%';
    raise exception 'RW_RESULT planted=%/object=%/dry=%/named=%', v_live, v_seen, v_dry, v_named;
  exception when others then
    v_out := sqlerrm;
  end;
  perform rt.record('RW5a WRONG KIND: a LIVE workspace with a past deadline is not COUNTED by the sweep, and the manifest NAMES none of its files -- with a real object there to name',
                    'planted=truetrue/object=1/dry=0/named=0', pg_catalog.replace(v_out, 'RW_RESULT ', ''));
end $$;
select rt.val('RW5b the probe rolled everything back: the CHECK and the trigger are both there, and rt-keep carries no deadline',
  $$select (select count(*)::text from pg_constraint where conname = 'organisations_lifecycle_matches_deleted_at')
        || '/' || (select count(*)::text from pg_trigger where tgrelid = 'public.organisations'::regclass
                     and not tgisinternal and tgenabled = 'D')
        || '/' || (select coalesce(retention_expires_at::text, 'none') from public.organisations
                    where id = '00000000-0000-4000-9000-0000000067b1')$$, '1/0/none');
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
-- RK  WHO CAN WRITE A CLOCK? (fix round 1, review finding C1)
-- ===========================================================================
-- Until this section existed NOTHING in this suite asked who can write the
-- columns a sweep's cutoff reads. `authenticated` held table-wide INSERT and
-- UPDATE on public.documents, so an ordinary Owner could write
-- `deleted_at = now() - interval '8 years'` and have a SEVEN-YEAR financial
-- document's file named in the next manifest, or forge `bytes_purged_at` and
-- keep a file out of every future sweep while the row claimed a lawful
-- deletion that never happened.
--
-- TWO HALVES:
--   RK1-RK19a  public.documents, asked AS THE TENANT (an aal2 Owner of their
--              own paid workspace -- the session a real browser has), and then
--              asked of the TRIGGER DIRECTLY with the column grant switched
--              back on, because a rule only ever asked through a path that
--              carries its own guard has not been asked.
--   RK20-      THE DERIVATION. Every timestamp column any retention function
--              reads is derived from the functions' own source, must be on
--              private.retention_clock_columns(), and -- if any client role
--              can write it -- must name a guard that exists AND have a
--              passing behavioural probe recorded by THIS RUN of this suite.
-- ===========================================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('00000000-0000-4000-9000-0000000067a3', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'rt-super@rt.invalid', 'x', now(), now(), now());
insert into public.platform_admins (user_id) values ('00000000-0000-4000-9000-0000000067a3');

-- A PAID PLAN, or documents_update_manage_documents' WITH CHECK refuses every
-- write for an entitlement reason and every refusal below is a false one.
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values ('00000000-0000-4000-9000-0000000067b1', 'pro', 'monthly', 1, 'active', now() + interval '30 days');

insert into public.documents (id, organisation_id, owner_user_id, filename, storage_key, mime_type,
                              size_bytes, scan_status, scanned_at) values
  ('00000000-0000-4000-9000-000000006703', '00000000-0000-4000-9000-0000000067b1',
   '00000000-0000-4000-9000-0000000067a1', 'settlement.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006703',
   'application/pdf', 10, 'clean', now()),
  ('00000000-0000-4000-9000-000000006704', '00000000-0000-4000-9000-0000000067b1',
   '00000000-0000-4000-9000-0000000067a1', 'pending.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006704',
   'application/pdf', 10, 'pending', null);
-- THE REVIEWER'S EXACT CASE: a FINANCIAL-class document. 6703 goes on the
-- event RS23 gave a financial entry, so its class is seven years.
insert into public.document_links (organisation_id, parent_id, entity_type, entity_id)
values ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-000000006703',
        'event', '00000000-0000-4000-9000-000000006711');

select rt.val('RK1 DENOMINATOR: the target is a LIVE, FINANCIAL-class (7-year) document nothing would sweep',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006703') || '/' ||
           (deleted_at is null)::text || '/' ||
           ((private.sweep_document_bytes(true, 500))->>'documents.bytes_purged')
      from public.documents where id = '00000000-0000-4000-9000-000000006703'$$, 'financial/true/0');

set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';

select rt.val('RK2 DENOMINATOR: the Owner really can see and reach the row (so a refusal below is a refusal)',
  $$select count(*)::text from public.documents where id = '00000000-0000-4000-9000-000000006703'$$, '1');
-- THE ORDINARY PRESS KEEPS WORKING. The value is OVERWRITTEN, not refused --
-- the incident-alert resolution guard's rule: a person says THAT they deleted
-- it, never WHEN.
select rt.try('RK3 the Owner soft-deletes it NAMING A TIME EIGHT YEARS AGO -- the write is accepted',
  $$update public.documents set deleted_at = now() - interval '8 years'
     where id = '00000000-0000-4000-9000-000000006703'$$, 'ok(1)');
reset role;
select rt.val('CLOCK public.documents.deleted_at -- RK4: the clock it got is THE DATABASE''S, not the one it named',
  $$select (deleted_at > now() - interval '1 minute')::text
      from public.documents where id = '00000000-0000-4000-9000-000000006703'$$, 'true');
select rt.val('RK5 ...so the sweep still sees NOTHING to purge, seconds after an "8 years ago" delete',
  $$select (private.sweep_document_bytes(true, 500))->>'documents.bytes_purged'$$, '0');
set role authenticated;
select rt.try_hint('RK6 RE-DATING an already-deleted document is refused outright',
  $$update public.documents set deleted_at = now() - interval '8 years'
     where id = '00000000-0000-4000-9000-000000006703'$$,
  'denied(42501:document_deleted_at_is_the_databases_clock)');
select rt.try('RK7 forging bytes_purged_at is refused BY THE GRANT, before any trigger runs',
  $$update public.documents set bytes_purged_at = now() - interval '1 day'
     where id = '00000000-0000-4000-9000-000000006703'$$, 'denied(42501)');
select rt.try('RK8 re-pointing storage_key at another object is refused by the grant',
  $$update public.documents
       set storage_key = '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006704x'
     where id = '00000000-0000-4000-9000-000000006703'$$, 'denied(42501)');
select rt.try('RK9 a document cannot be BORN deleted',
  $$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes, deleted_at)
    values ('00000000-0000-4000-9000-0000000067b1', 'born-deleted.pdf',
            '00000000-0000-4000-9000-0000000067b1/rk9', 'application/pdf', 1, now() - interval '8 years')$$,
  'denied(42501)');
select rt.try('RK10 ...or born purged',
  $$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes, bytes_purged_at)
    values ('00000000-0000-4000-9000-0000000067b1', 'born-purged.pdf',
            '00000000-0000-4000-9000-0000000067b1/rk10', 'application/pdf', 1, now())$$,
  'denied(42501)');
-- THE CONTROLS. A narrowing that also broke the product's own three writes
-- would satisfy every refusal above.
select rt.try('RK11 CONTROL: the upload INSERT, with exactly the columns lib/crm/documents.ts sends',
  $$insert into public.documents (id, organisation_id, owner_user_id, filename, storage_key,
                                  mime_type, size_bytes, scan_status)
    values ('00000000-0000-4000-9000-000000006705', '00000000-0000-4000-9000-0000000067b1',
            '00000000-0000-4000-9000-0000000067a1', 'control.pdf',
            '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006705',
            'application/pdf', 10, 'pending')$$, 'ok(1)');
select rt.try('RK12 CONTROL: the scan-verdict UPDATE',
  $$update public.documents set scan_status = 'clean', scanned_at = now()
     where id = '00000000-0000-4000-9000-000000006704'$$, 'ok(1)');
select rt.try('RK13 CONTROL: RESTORE (deleted_at back to null) still works',
  $$update public.documents set deleted_at = null
     where id = '00000000-0000-4000-9000-000000006703'$$, 'ok(1)');
reset role;
reset request.jwt.claims;
select rt.val('RK14 ...and the restored document is live and unpurged',
  $$select (deleted_at is null)::text || '/' || (bytes_purged_at is null)::text
      from public.documents where id = '00000000-0000-4000-9000-000000006703'$$, 'true/true');

-- A PURGED DOCUMENT IS A DELETED DOCUMENT, FOR EVERY WRITER. 6701 was stamped
-- by RS20. Restoring it would produce a live row whose file is gone; stamping
-- a live row (the review's mutation MD) would produce the same thing from the
-- other side.
select rt.try('RK15 a document whose bytes were purged cannot be RESTORED, even by `postgres`',
  $$update public.documents set deleted_at = null
     where id = '00000000-0000-4000-9000-000000006701'$$, 'denied(23514)');
select rt.try('RK16 ...and a LIVE document cannot be stamped purged, even by `postgres`',
  $$update public.documents set bytes_purged_at = now()
     where id = '00000000-0000-4000-9000-000000006703'$$, 'denied(23514)');
select rt.try_hint('RK17 storage_key is immutable for EVERY writer -- `postgres` included',
  $$update public.documents set storage_key = '00000000-0000-4000-9000-0000000067b1/moved'
     where id = '00000000-0000-4000-9000-000000006703'$$,
  'denied(42501:document_storage_key_is_immutable)');

-- THE TRIGGER, ASKED DIRECTLY. RK7 is answered by the column grant, so on its
-- own it says nothing about the trigger behind it. Here the grant is switched
-- BACK ON inside a subtransaction, the same write is made as the same Owner,
-- the outcome is carried out of the subtransaction in the exception message
-- (so the grant is rolled back and the record() row is not), and the trigger
-- has to be the thing that refuses.
do $$
declare v_out text; v_a text; v_b text; v_h text;
begin
  begin
    execute 'grant insert (deleted_at, bytes_purged_at), update (bytes_purged_at) on public.documents to authenticated';
    perform pg_catalog.set_config('request.jwt.claims',
      '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}', true);
    execute 'set local role authenticated';
    begin
      update public.documents set bytes_purged_at = now() - interval '1 day'
       where id = '00000000-0000-4000-9000-000000006702';
      v_a := 'ok';
    exception when others then
      get stacked diagnostics v_h = pg_exception_hint;
      v_a := 'denied(' || sqlstate || ':' || coalesce(v_h, '') || ')';
    end;
    begin
      insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes, deleted_at)
      values ('00000000-0000-4000-9000-0000000067b1', 'born-deleted.pdf',
              '00000000-0000-4000-9000-0000000067b1/rk18', 'application/pdf', 1, now() - interval '8 years');
      v_b := 'ok';
    exception when others then
      get stacked diagnostics v_h = pg_exception_hint;
      v_b := 'denied(' || sqlstate || ':' || coalesce(v_h, '') || ')';
    end;
    raise exception 'RK_RESULT %|%', v_a, v_b;
  exception when others then
    v_out := sqlerrm;
  end;
  perform rt.record('RK18 THE TRIGGER ITSELF refuses a forged bytes_purged_at, with the grant switched back on',
                    'denied(42501:document_bytes_purged_at_is_the_sweeps)',
                    pg_catalog.split_part(pg_catalog.replace(v_out, 'RK_RESULT ', ''), '|', 1));
  perform rt.record('RK19 ...and a born-deleted INSERT',
                    'denied(42501:document_is_born_live)',
                    pg_catalog.split_part(pg_catalog.replace(v_out, 'RK_RESULT ', ''), '|', 2));
end $$;
select rt.val('RK19a the probe''s grant was rolled back with its subtransaction',
  $$select has_column_privilege('authenticated', 'public.documents', 'bytes_purged_at', 'UPDATE')::text$$, 'false');


-- ---------------------------------------------------------------------------
-- RK-N1  THE PERIOD HALF OF THE CLOCK (fix round 2, re-review finding I-N1)
--
-- Fix round 1 pinned the TIMESTAMP half of the document clock -- deleted_at
-- is the database's. The re-review found the PERIOD half still open: which
-- class a document falls in, `financial` (7 years) or `operational` (2), was
-- computed AT SWEEP TIME by private.document_retention_class() from
-- financial_entries.event_id -- a column the tenant writes on every edit,
-- from a hidden form field (lib/crm/finance.ts). Measured as an aal2 Owner:
-- a document on a money event, deleted three years ago, read `financial/0`;
-- one `update financial_entries set event_id = <other event>` and it read
-- `operational/1` -- sweepable that hour. The one lever a tenant had left for
-- the permanent destruction of a file, and the page promised there was none.
--
-- Q186, recommended default, taken: THE CLASS IS FROZEN WHEN THE CLOCK
-- STARTS, in both directions. documents.retention_class is stamped by the
-- same guard that owns the null -> value deleted_at transition, cleared on
-- restore, outside every client grant, immutable otherwise for every writer,
-- and the sweep and the manifest read the STAMP and never recompute it.
-- Every assertion below was red against the fix-round-1 schema first.
-- ---------------------------------------------------------------------------
insert into public.events (id, organisation_id, name, starts_at, status)
values ('00000000-0000-4000-9000-000000006712', '00000000-0000-4000-9000-0000000067b1',
        'RT Dry Night', now(), 'draft');
insert into public.documents (id, organisation_id, owner_user_id, filename, storage_key, mime_type,
                              size_bytes, scan_status, scanned_at) values
  ('00000000-0000-4000-9000-000000006707', '00000000-0000-4000-9000-0000000067b1',
   '00000000-0000-4000-9000-0000000067a1', 'fee-agreement.pdf',
   '00000000-0000-4000-9000-0000000067b1/00000000-0000-4000-9000-000000006707',
   'application/pdf', 10, 'clean', now());
insert into public.document_links (organisation_id, parent_id, entity_type, entity_id)
values ('00000000-0000-4000-9000-0000000067b1', '00000000-0000-4000-9000-000000006707',
        'event', '00000000-0000-4000-9000-000000006711');

select rt.val('RK-N1a DENOMINATOR: a LIVE document on the money event carries NO frozen class yet, and the live derivation says financial',
  $$select coalesce(retention_class, 'null') || '/' || private.document_retention_class(id)
      from public.documents where id = '00000000-0000-4000-9000-000000006707'$$, 'null/financial');

set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';
select rt.try('RK-N1b the Owner soft-deletes it -- the ordinary press',
  $$update public.documents set deleted_at = now()
     where id = '00000000-0000-4000-9000-000000006707'$$, 'ok(1)');
select rt.try('RK-N1c ...and cannot write the frozen class at all: the column is outside the grant',
  $$update public.documents set retention_class = 'operational'
     where id = '00000000-0000-4000-9000-000000006707'$$, 'denied(42501)');
reset role;
reset request.jwt.claims;
select rt.val('RK-N1d THE CLASS WAS FROZEN AT THE PRESS: financial, stamped by the database',
  $$select retention_class from public.documents where id = '00000000-0000-4000-9000-000000006707'$$,
  'financial');
-- Aged three years AS POSTGRES (a re-date by a non-session writer keeps the
-- frozen class): inside the 7-year period, past the 2-year one -- the
-- re-review's exact fixture.
update public.documents set deleted_at = now() - interval '3 years'
 where id = '00000000-0000-4000-9000-000000006707';
select rt.val('RK-N1e DENOMINATOR: deleted 3 years ago, financial, the dry sweep takes nothing -- the re-review''s `financial/0`',
  $$select retention_class || '/' || ((private.sweep_document_bytes(true, 500))->>'documents.bytes_purged')
      from public.documents where id = '00000000-0000-4000-9000-000000006707'$$, 'financial/0');

-- THE REPRODUCTION. The Owner moves the one financial entry off the event --
-- the hidden-field edit -- and the LIVE derivation flips to operational.
set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';
select rt.try('RK-N1f the Owner moves the financial entry to another event (finance write, accepted)',
  $$update public.financial_entries set event_id = '00000000-0000-4000-9000-000000006712'
     where event_id = '00000000-0000-4000-9000-000000006711'$$, 'ok(1)');
reset role;
reset request.jwt.claims;
select rt.val('RK-N1g ...the live derivation now says operational -- the lever the re-review pulled',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006707')$$, 'operational');
select rt.val('RK-N1h ...AND THE SWEEP STILL TAKES NOTHING: it reads the frozen class, which is still financial',
  $$select retention_class || '/' || ((private.sweep_document_bytes(true, 500))->>'documents.bytes_purged')
      from public.documents where id = '00000000-0000-4000-9000-000000006707'$$, 'financial/0');
select rt.val('RK-N1i ...and the manifest''s own predicate names it for no key either (it has no object, so the arm is asked directly)',
  $$select count(*)::text from public.documents d
     where d.id = '00000000-0000-4000-9000-000000006707'
       and d.deleted_at < now() - private.retention_period(d.retention_class)$$, '0');

-- THE STANDING MUTATION: the sweep RECOMPUTES the class -- fix round 1's
-- shipped behaviour -- and the same row is sweepable that hour.
insert into rt.saved_defs values
  ('doc_sweep', pg_get_functiondef('private.sweep_document_bytes(boolean,integer)'::regprocedure));
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'doc_sweep');
  v_new := pg_catalog.replace(v_def, 'private.retention_period(d.retention_class)',
                                     'private.retention_period(private.document_retention_class(d.id))');
  if v_new = v_def then
    raise exception 'RK-N1j could not make the sweep recompute the class -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.val('RK-N1j MUTATION: a sweep that recomputes the class at sweep time takes the file -- `operational/1`, the re-review''s reproduction',
  $$select private.document_retention_class('00000000-0000-4000-9000-000000006707') || '/' ||
           ((private.sweep_document_bytes(true, 500))->>'documents.bytes_purged')$$, 'operational/1');
do $$ begin execute (select def from rt.saved_defs where name = 'doc_sweep'); end $$;
select rt.val('RK-N1k ...the sweep is restored byte-identically and takes nothing again',
  $$select (pg_get_functiondef('private.sweep_document_bytes(boolean,integer)'::regprocedure)
            = (select def from rt.saved_defs where name = 'doc_sweep'))::text || '/' ||
           ((private.sweep_document_bytes(true, 500))->>'documents.bytes_purged')$$, 'true/0');

-- THE FROZEN CLASS IS IMMUTABLE FOR EVERY WRITER outside the two transitions
-- that own it -- `postgres` included, the storage_key rule -- and asked of
-- the TRIGGER DIRECTLY with the grant switched back on (the RK18 shape).
select rt.try_hint('RK-N1m re-writing a frozen class is refused for `postgres` too',
  $$update public.documents set retention_class = 'operational'
     where id = '00000000-0000-4000-9000-000000006707'$$,
  'denied(42501:document_retention_class_is_frozen_at_deletion)');
-- THE CHECK IS THE SECOND LAYER, asked with the guard DISABLED for exactly
-- these two statements (the erasure § EN7 pattern): a live document cannot
-- carry a class and a deleted one cannot lose it, for any writer.
do $$
declare v_a text; v_b text;
begin
  execute 'alter table public.documents disable trigger guard_retention_columns';
  begin
    update public.documents set retention_class = 'financial'
     where id = '00000000-0000-4000-9000-000000006704';
    v_a := 'ok';
  exception when others then v_a := 'denied(' || sqlstate || ')';
  end;
  begin
    update public.documents set retention_class = null
     where id = '00000000-0000-4000-9000-000000006707';
    v_b := 'ok';
  exception when others then v_b := 'denied(' || sqlstate || ')';
  end;
  execute 'alter table public.documents enable trigger guard_retention_columns';
  perform rt.record('RK-N1n with the guard DISABLED, the CHECK alone refuses a LIVE document carrying a class', 'denied(23514)', v_a);
  perform rt.record('RK-N1n2 ...and a DELETED document losing its class', 'denied(23514)', v_b);
end $$;
select rt.val('RK-N1n3 the guard is back on',
  $$select tgenabled from pg_trigger where tgrelid = 'public.documents'::regclass and tgname = 'guard_retention_columns'$$, 'O');
do $$
declare v_out text; v_a text; v_b text; v_h text;
begin
  begin
    execute 'grant insert (retention_class), update (retention_class) on public.documents to authenticated';
    perform pg_catalog.set_config('request.jwt.claims',
      '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}', true);
    execute 'set local role authenticated';
    begin
      update public.documents set retention_class = 'operational'
       where id = '00000000-0000-4000-9000-000000006707';
      v_a := 'ok';
    exception when others then
      get stacked diagnostics v_h = pg_exception_hint;
      v_a := 'denied(' || sqlstate || ':' || coalesce(v_h, '') || ')';
    end;
    begin
      insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes, retention_class)
      values ('00000000-0000-4000-9000-0000000067b1', 'born-classed.pdf',
              '00000000-0000-4000-9000-0000000067b1/rkn1', 'application/pdf', 1, 'operational');
      v_b := 'ok';
    exception when others then
      get stacked diagnostics v_h = pg_exception_hint;
      v_b := 'denied(' || sqlstate || ':' || coalesce(v_h, '') || ')';
    end;
    raise exception 'RK_RESULT %|%', v_a, v_b;
  exception when others then
    v_out := sqlerrm;
  end;
  perform rt.record('RK-N1o THE TRIGGER ITSELF refuses a session re-class, with the grant switched back on',
                    'denied(42501:document_retention_class_is_frozen_at_deletion)',
                    pg_catalog.split_part(pg_catalog.replace(v_out, 'RK_RESULT ', ''), '|', 1));
  perform rt.record('RK-N1p ...and a document born with a class',
                    'denied(42501:document_is_born_live)',
                    pg_catalog.split_part(pg_catalog.replace(v_out, 'RK_RESULT ', ''), '|', 2));
end $$;
select rt.val('RK-N1q the probe''s grant was rolled back with its subtransaction',
  $$select (has_column_privilege('authenticated', 'public.documents', 'retention_class', 'UPDATE')
         or has_column_privilege('authenticated', 'public.documents', 'retention_class', 'INSERT'))::text$$, 'false');

-- RESTORE CLEARS THE FREEZE, and a fresh delete freezes what is true THEN --
-- which is the honest answer to "the workspace moved the money and wants the
-- shorter period": restore, and delete again.
set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';
select rt.try('RK-N1r the Owner restores it',
  $$update public.documents set deleted_at = null where id = '00000000-0000-4000-9000-000000006707'$$, 'ok(1)');
reset role;
reset request.jwt.claims;
select rt.val('RK-N1s ...and the frozen class is CLEARED with the clock',
  $$select coalesce(retention_class, 'null') from public.documents where id = '00000000-0000-4000-9000-000000006707'$$,
  'null');
set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';
select rt.try('RK-N1t the Owner deletes it again, with the money now elsewhere',
  $$update public.documents set deleted_at = now() where id = '00000000-0000-4000-9000-000000006707'$$, 'ok(1)');
select rt.try('RK-N1u ...and moves the money back (so the rest of this suite sees the event it expects)',
  $$update public.financial_entries set event_id = '00000000-0000-4000-9000-000000006711'
     where event_id = '00000000-0000-4000-9000-000000006712'$$, 'ok(1)');
reset role;
reset request.jwt.claims;
select rt.val('RK-N1v the second deletion froze `operational` -- what was true at THAT press -- and the money coming back does not promote it',
  $$select retention_class || '/' || private.document_retention_class(id)
      from public.documents where id = '00000000-0000-4000-9000-000000006707'$$, 'operational/financial');

-- THE OTHER DIRECTION (Q186, "in both directions"): a document frozen
-- `operational` is not PROMOTED when money arrives later. 6702 was born
-- deleted in § RS with no link at all; RS23 then made its event a money
-- event, and the live derivation has said financial since (the money is
-- back on 6711 as of RK-N1u).
select rt.val('RK-N1l the other direction: 6702''s live derivation says financial, its FROZEN class is still operational',
  $$select private.document_retention_class(id) || '/' || retention_class
      from public.documents where id = '00000000-0000-4000-9000-000000006702'$$, 'financial/operational');

-- THE ROLL KNOWS THE PERIOD HALF IS A CLOCK. It is a text column, so the
-- date/timestamp derivation cannot see it; it is derived instead as THE
-- COLUMN A SWEEP HANDS TO private.retention_period(), which is what makes a
-- sweep that goes back to recomputing it visible: `retention_period(
-- private.document_retention_class(d.id))` names no column, and the roll
-- entry for the stamped one is then a clock nothing reads.
select rt.val('RK-N1w documents.retention_class is a derived candidate, read by the sweep and the manifest, and on the roll as a clock guarded by the same trigger',
  $$select (select read_by from private.retention_clock_candidates()
             where table_name = 'documents' and column_name = 'retention_class')
        || ' :: ' ||
           (select role || ':' || guard from private.retention_clock_columns()
             where table_name = 'documents' and column_name = 'retention_class')$$,
  'retention_object_manifest,sweep_document_bytes :: clock:trigger:private.guard_document_retention_columns');
select rt.val('RK-N1x ...and no client role can write it (non-forgeable by construction, the better answer)',
  $$select (client_insert or client_update)::text || '/' || coalesce(guard_missing, 'none')
      from private.retention_clock_exposure()
     where table_name = 'documents' and column_name = 'retention_class'$$, 'false/none');


-- ---------------------------------------------------------------------------
-- RK20-  THE DERIVATION: EVERY CLOCK, AND THE NEXT ONE.
--
-- A probe whose label begins `CLOCK <schema.table.column> ` is THE behavioural
-- proof for that column, and RK27 requires one -- recorded by THIS run, and
-- PASSING -- for every clock column any client role can write. RK4 above is
-- the first, which is why it carries that label.
-- ---------------------------------------------------------------------------

-- incident_alerts.resolved_at: the aal2 operator is the only client that can
-- reach it, so the probe is the operator naming a date five years ago.
insert into public.incident_alerts (id, alert_type, summary, created_at)
values ('00000000-0000-4000-9000-0000000067e4', 'rate_limit_tripped', 'rt clock probe',
        now() - interval '6 years');
set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a3","role":"authenticated","aal":"aal2"}';
select rt.try('RK20 DENOMINATOR: the operator resolves an alert NAMING A DATE FIVE YEARS AGO -- accepted',
  $$update public.incident_alerts
       set resolved_at = now() - interval '5 years', resolved_by = '00000000-0000-4000-9000-0000000067a3'
     where id = '00000000-0000-4000-9000-0000000067e4'$$, 'ok(1)');
reset role;
reset request.jwt.claims;
select rt.val('CLOCK public.incident_alerts.resolved_at -- the operator''s "5 years ago" became now(), and the sweep takes nothing',
  $$select (resolved_at > now() - interval '1 minute')::text || '/' ||
           ((private.sweep_incident_alerts(true, 500))->>'incident_alerts.rows')
      from public.incident_alerts where id = '00000000-0000-4000-9000-0000000067e4'$$, 'true/0');

-- organisations: a LIVE workspace (rt-keep) and a CLOSED one (rt-back, which
-- RW9 left closed with its clock restarted), both asked as their own Owner.
set role authenticated;
set request.jwt.claims to '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}';
select rt.val('RK21 DENOMINATOR: the Owner can see both workspaces, the live one and the closed one',
  $$select count(*)::text from public.organisations where slug in ('rt-keep', 'rt-back')$$, '2');
select rt.try('RK22 DENOMINATOR: the Owner writes BOTH workspace clocks on their LIVE workspace -- accepted',
  $$update public.organisations
       set retention_expires_at = now() - interval '1 day',
           lifecycle_changed_at = now() - interval '61 days'
     where slug = 'rt-keep'$$, 'ok(1)');
-- BY HINT, NOT BY SQLSTATE (fix round 2, m-N2). organisations_update_manage_
-- organisation's WITH CHECK (`deleted_at is null`) refuses this same write
-- with the same 42501, so with the named guard fully dead the bare code
-- still read `denied(42501)` -- 0 of 221 red. The guard now carries a hint
-- (20261005002000), BEFORE ROW runs before WITH CHECK, and the probe asks
-- for the hint: the policy answering instead reads `denied(42501:)`.
select rt.try_hint('CLOCK public.organisations.deleted_at -- a tenant write to it is refused BY THE LIFECYCLE GUARD, named by its hint',
  $$update public.organisations set deleted_at = now() - interval '61 days' where slug = 'rt-keep'$$,
  'denied(42501:organisation_lifecycle_is_the_rpcs)');
select rt.try('RK23 ...and the CLOSED workspace admits no tenant UPDATE at all (0 rows, with the row visible)',
  $$update public.organisations set lifecycle_changed_at = now() - interval '61 days' where slug = 'rt-back'$$,
  'ok(0)');
reset role;
reset request.jwt.claims;
select rt.val('CLOCK public.organisations.retention_expires_at -- nulled by the sync trigger on the live workspace, untouched on the closed one',
  $$select (select coalesce(retention_expires_at::text, 'null') from public.organisations where slug = 'rt-keep')
        || '/' || (select (retention_expires_at > now())::text from public.organisations where slug = 'rt-back')$$,
  'null/true');
select rt.val('CLOCK public.organisations.lifecycle_changed_at -- likewise, and nothing became sweepable',
  $$select (select coalesce(lifecycle_changed_at::text, 'null') from public.organisations where slug = 'rt-keep')
        || '/' || ((private.sweep_expired_workspaces(true, 50))->>'organisations.purged')$$,
  'null/0');

-- storage.objects.created_at, THE ORPHAN CLOCK. psql can plant an object and
-- cannot remove one (storage.protect_delete()), so the whole probe runs in a
-- subtransaction that is rolled back, and its outcome is carried out in the
-- exception message -- the RK18 shape.
do $$
declare v_out text; v_seen bigint; v_rows bigint; v_ins text;
begin
  begin
    insert into storage.objects (bucket_id, name) values ('documents', 'rt-clock-probe/object');
    select pg_catalog.count(*) into v_seen from storage.objects where name = 'rt-clock-probe/object';
    perform pg_catalog.set_config('request.jwt.claims',
      '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}', true);
    execute 'set local role authenticated';
    update storage.objects set created_at = pg_catalog.now() - interval '10 years'
     where name = 'rt-clock-probe/object';
    get diagnostics v_rows = row_count;
    begin
      insert into storage.objects (bucket_id, name, created_at)
      values ('documents', 'rt-clock-probe/forged', pg_catalog.now() - interval '10 years');
      v_ins := 'ok';
    exception when others then
      v_ins := 'denied(' || sqlstate || ')';
    end;
    raise exception 'RK_RESULT planted=%/update=ok(%)/insert=%', v_seen, v_rows, v_ins;
  exception when others then
    v_out := sqlerrm;
  end;
  perform rt.record('CLOCK storage.objects.created_at -- a client can neither back-date a stored object nor insert a back-dated one',
                    'planted=1/update=ok(0)/insert=denied(42501)',
                    pg_catalog.replace(v_out, 'RK_RESULT ', ''));
end $$;
select rt.val('RK24 the storage probe left nothing behind',
  $$select count(*)::text from storage.objects where name like 'rt-clock-probe/%'$$, '0');

-- WHICH LAYER REFUSES A CLIENT WRITE TO storage.objects? (fix round 2, m-N2.)
-- The roll named the six RESTRICTIVE deny-all policies, and the re-review
-- rewrote two of them to `true` and watched the probe above stay green --
-- because no PERMISSIVE policy admits a client role at all, and RLS
-- default-denies. The roll now names that layer too, `no_permissive_policy`,
-- and this is the standing mutation for both layers, in one rolled-back
-- subtransaction (the RK18 shape): a permissive policy is created, and the
-- existence check must name it; THEN the documents-bucket restrictive
-- policies are opened as the re-review opened them (plus SELECT), and the probe's own two
-- statements must now SUCCEED -- which is what shows the probe measures
-- behaviour and not the catalogue.
do $$
declare v_out text; v_missing text; v_hint text; v_refusal text; v_fence text; v_rows bigint; v_ins text;
begin
  begin
    execute 'create policy rt_permissive_probe on storage.objects for all to authenticated using (true) with check (true)';
    select guard_missing into v_missing from private.retention_clock_exposure()
     where schema_name = 'storage' and table_name = 'objects' and column_name = 'created_at';
    begin
      perform private.assert_retention_clocks();
      v_refusal := 'ok';
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_refusal := 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
    end;
    -- THE RESTRICTIVE LAYER, ISOLATED: with default deny gone (the permissive
    -- policy above) the fence alone must still refuse the probe's writes.
    -- This is the assertion the re-review's G5 (the fence opened, default
    -- deny still there) could not redden -- and it reds it now.
    insert into storage.objects (bucket_id, name) values ('documents', 'rt-clock-probe/object');
    perform pg_catalog.set_config('request.jwt.claims',
      '{"sub":"00000000-0000-4000-9000-0000000067a1","role":"authenticated","aal":"aal2"}', true);
    execute 'set local role authenticated';
    update storage.objects set created_at = pg_catalog.now() - interval '10 years'
     where name = 'rt-clock-probe/object';
    get diagnostics v_rows = row_count;
    begin
      insert into storage.objects (bucket_id, name, created_at)
      values ('documents', 'rt-clock-probe/forged', pg_catalog.now() - interval '10 years');
      v_ins := 'ok';
    exception when others then
      v_ins := 'denied(' || sqlstate || ')';
    end;
    v_fence := 'update=ok(' || v_rows || ')/insert=' || v_ins;
    execute 'reset role';
    -- Both layers open: the re-review's G5 on top of the permissive policy,
    -- plus the SELECT half of the fence, because an UPDATE with a WHERE
    -- clause reads the row through the SELECT policies first and a row it
    -- cannot see is `ok(0)` whatever the UPDATE policies say.
    execute 'alter policy documents_deny_client_select on storage.objects using (true)';
    execute 'alter policy documents_deny_client_insert on storage.objects with check (true)';
    execute 'alter policy documents_deny_client_update on storage.objects using (true) with check (true)';
    execute 'set local role authenticated';
    update storage.objects set created_at = pg_catalog.now() - interval '10 years'
     where name = 'rt-clock-probe/object';
    get diagnostics v_rows = row_count;
    begin
      insert into storage.objects (bucket_id, name, created_at)
      values ('documents', 'rt-clock-probe/forged', pg_catalog.now() - interval '10 years');
      v_ins := 'ok';
    exception when others then
      v_ins := 'denied(' || sqlstate || ')';
    end;
    raise exception 'RK_RESULT %|%|%|update=ok(%)/insert=%', coalesce(v_missing, 'none'), v_refusal, v_fence, v_rows, v_ins;
  exception when others then
    v_out := pg_catalog.replace(sqlerrm, 'RK_RESULT ', '');
  end;
  perform rt.record('RK24a MUTATION: a PERMISSIVE policy admitting a client on storage.objects -- the existence check names default deny as the guard now missing',
                    'no_permissive_policy', pg_catalog.split_part(v_out, '|', 1));
  perform rt.record('RK24b ...and the clock roll REFUSES the job for it',
                    'denied(55000:forgeable_retention_clock)', pg_catalog.split_part(v_out, '|', 2));
  perform rt.record('RK24e ...and with default deny gone, THE RESTRICTIVE FENCE ALONE still refuses the probe''s writes (the layer the re-review''s G5 opened, isolated)',
                    'update=ok(0)/insert=denied(42501)', pg_catalog.split_part(v_out, '|', 3));
  perform rt.record('RK24c ...and with the restrictive documents policies opened as well, the probe''s own writes SUCCEED -- so the probe measures behaviour, not the catalogue',
                    'update=ok(1)/insert=ok', pg_catalog.split_part(v_out, '|', 4));
end $$;
select rt.val('RK24d the mutation was rolled back: no permissive policy, the restrictive policies as fenced, no object left behind',
  $$select (select count(*)::text from pg_policy where polrelid = 'storage.objects'::regclass and polpermissive)
        || '/' ||
           (select count(*)::text from pg_policy
             where polrelid = 'storage.objects'::regclass and polname like 'documents_deny_client_%'
               and coalesce(pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid))
                   = '(bucket_id <> ''documents''::text)')
        || '/' || (select count(*)::text from storage.objects where name like 'rt-clock-probe/%')$$,
  '0/4/0');

-- ---- THE DERIVED ASSERTIONS ------------------------------------------------
select rt.val('RK25 DENOMINATOR: the derivation sees the retention functions -- and the column C1 was about',
  $$select ((select count(*) from private.retention_clock_candidates()) >= 10)::text || '/' ||
           (select count(*)::text from private.retention_clock_candidates()
             where schema_name = 'public' and table_name = 'documents' and column_name = 'deleted_at')$$,
  'true/1');
select rt.val('RK26 every date/timestamp column a retention function reads is CLASSIFIED',
  $$select coalesce(string_agg(c.schema_name || '.' || c.table_name || '.' || c.column_name, ','), 'none')
      from private.retention_clock_candidates() c
     where not exists (select 1 from private.retention_clock_columns() d
                        where d.schema_name = c.schema_name and d.table_name = c.table_name
                          and d.column_name = c.column_name)$$, 'none');
-- BY NAME, so the day this list changes is a day somebody reads this section.
select rt.val('RK27 the clocks a CLIENT ROLE can write are exactly these six',
  $$select string_agg(schema_name || '.' || table_name || '.' || column_name, ',' order by 1)
      from private.retention_clock_exposure() where client_insert or client_update$$,
  'public.documents.deleted_at,public.incident_alerts.resolved_at,public.organisations.deleted_at,public.organisations.lifecycle_changed_at,public.organisations.retention_expires_at,storage.objects.created_at');
select rt.val('RK28 ...EVERY ONE of them names a guard that really exists',
  $$select coalesce(string_agg(schema_name || '.' || table_name || '.' || column_name, ','), 'none')
      from private.retention_clock_exposure()
     where (client_insert or client_update) and (guard is null or guard_missing is not null)$$, 'none');
select rt.val('RK29 ...and EVERY ONE of them has a PASSING behavioural probe recorded by this run',
  $$select coalesce(string_agg(c, ',' order by c), 'none')
      from (select schema_name || '.' || table_name || '.' || column_name as c
              from private.retention_clock_exposure() where client_insert or client_update
            except
            select substring(label from '^CLOCK ([a-z_.]+) ') from rt.results
             where label like 'CLOCK %' and pass) x$$, 'none');
select rt.try('RK30 the refusal passes on the live schema (CALLED, not wrapped in `where false`)',
  $$select private.assert_retention_clocks()$$, 'ok(1)');

-- THE SHAPES THE DERIVATION USED TO MISS (fix round 2, m-N1). The re-review
-- planted seven ways for a sweep to read a client-writable clock and found
-- the derivation refused only the direct read and a new client role. Four
-- are closed by 20261005003000 and planted here, all at once, in one chain:
--   G  the sweep body calls a WRAPPER,
--   B  which calls the sweep, which reads through a HELPER FUNCTION,
--   A  which reads one table through a VIEW that ALIASES the column,
--   E  and another table in `private`.
-- Nothing in the sweep body's own source names a table. All three columns
-- must be derived, each read by the helper, and the job must refuse. The
-- other three shapes (jsonb, epoch/text, a helper outside `private`) are
-- STATED limits in the function's comment, not closed, and RK30d records
-- the one that is cheapest to show.
create table public.rt_clock_probe (id uuid primary key default gen_random_uuid(), expired_at timestamptz);
grant select, insert, update on public.rt_clock_probe to authenticated;
create table public.rt_clock_probe_v (id uuid primary key default gen_random_uuid(), expired_at timestamptz);
grant select, insert, update on public.rt_clock_probe_v to authenticated;
create view public.rt_clock_view as select id, expired_at as when_it_expired from public.rt_clock_probe_v;
-- (`authenticated` already holds USAGE on `private`: every RLS policy calls a
-- private function as the querying role. Revoking it afterwards would break
-- the product for the rest of this suite, which the first cut of this block
-- did.)
create table private.rt_clock_probe_p (id uuid primary key default gen_random_uuid(), expired_at timestamptz);
grant select, insert, update on private.rt_clock_probe_p to authenticated;
create function private.rt_clock_helper() returns bigint
language sql security definer set search_path = '' as $$
  select (select pg_catalog.count(*) from public.rt_clock_probe p where p.expired_at < pg_catalog.now())
       + (select pg_catalog.count(*) from public.rt_clock_view v where v.when_it_expired < pg_catalog.now())
       + (select pg_catalog.count(*) from private.rt_clock_probe_p q where q.expired_at < pg_catalog.now())
$$;
create function private.sweep_rt_clock_probe(p_dry boolean, p_limit integer) returns jsonb
language sql security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('rt_clock_probe.rows', private.rt_clock_helper())
$$;
create function private.sweep_rt_wrapper(p_dry boolean, p_limit integer) returns jsonb
language sql security definer set search_path = '' as $$
  select private.sweep_rt_clock_probe(p_dry, p_limit)
$$;
insert into rt.saved_defs values
  ('sweep_body', pg_get_functiondef('private.retention_sweep_body(boolean,integer)'::regprocedure)),
  ('clock_roll', pg_get_functiondef('private.retention_clock_columns()'::regprocedure));
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'sweep_body');
  v_new := pg_catalog.replace(v_def, 'return query select v_swept, v_refused;',
             'v_swept := v_swept || private.sweep_rt_wrapper(p_dry, p_limit);' || chr(10) ||
             '  return query select v_swept, v_refused;');
  if v_new = v_def then
    raise exception 'RK30a could not inject the wrapped sweep -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.val('RK30a MUTATION (m-N1): through a wrapper, a helper, a view with an aliased column and a `private` table, all three clocks are DERIVED, each read by the helper',
  $$select string_agg(schema_name || '.' || table_name || '.' || column_name || '<-' || read_by, ',' order by 1)
      from private.retention_clock_candidates() where table_name like 'rt_clock_probe%'$$,
  'private.rt_clock_probe_p.expired_at<-rt_clock_helper,public.rt_clock_probe.expired_at<-rt_clock_helper,public.rt_clock_probe_v.expired_at<-rt_clock_helper');
select rt.try_hint('RK30b ...and the job REFUSES for them',
  $$select private.assert_retention_clocks()$$, 'denied(55000:undeclared_retention_clock)');
select rt.val('RK30c DENOMINATOR: the sweep body''s own source names none of the three -- the walk found them, not a name match at depth one',
  $$select (pg_get_functiondef('private.retention_sweep_body(boolean,integer)'::regprocedure) ~ 'rt_clock_probe')::text$$, 'false');
-- THE STATED LIMIT, MEASURED (the re-review's D): a clock stored as an epoch
-- integer is not a candidate by type. Recorded so the limit is a measurement
-- and not a sentence.
create table public.rt_clock_probe_e (id uuid primary key default gen_random_uuid(), expired_epoch bigint);
grant select, insert, update on public.rt_clock_probe_e to authenticated;
create or replace function private.rt_clock_helper() returns bigint
language sql security definer set search_path = '' as $$
  select (select pg_catalog.count(*) from public.rt_clock_probe_e e
           where e.expired_epoch < extract(epoch from pg_catalog.now()))
$$;
select rt.val('RK30d STATED LIMIT (D): an epoch-integer clock is NOT derived -- by type -- while the TABLE roll refuses the table until classified, which is where a person is made to look',
  $$select (select count(*)::text from private.retention_clock_candidates() where table_name = 'rt_clock_probe_e')
        || '/' || (select string_agg(u, ',') from private.unclassified_retention_subjects() u
                    where u like '%rt_clock_probe_e%')$$,
  '0/rt_clock_probe_e');
select rt.try('RK30d2 ...and the CLOCK roll passes over it (CALLED): the limit is a measurement, not a sentence',
  $$select private.assert_retention_clocks()$$, 'ok(1)');
do $$ begin execute (select def from rt.saved_defs where name = 'sweep_body'); end $$;
drop function private.sweep_rt_wrapper(boolean, integer);
drop function private.sweep_rt_clock_probe(boolean, integer);
drop function private.rt_clock_helper();
drop view public.rt_clock_view;
drop table public.rt_clock_probe_v;
drop table public.rt_clock_probe_e;
drop table private.rt_clock_probe_p;
drop table public.rt_clock_probe;
select rt.val('RK30e the m-N1 probes are gone, the sweep body is restored byte-identically, and the roll passes',
  $$select (select count(*)::text from pg_class where relname like 'rt_clock_probe%' or relname = 'rt_clock_view')
        || '/' || (pg_get_functiondef('private.retention_sweep_body(boolean,integer)'::regprocedure)
                   = (select def from rt.saved_defs where name = 'sweep_body'))::text
        || '/' || (select 'ok' from (select private.assert_retention_clocks()) t)$$, '0/true/ok');
delete from rt.saved_defs where name in ('sweep_body', 'clock_roll');

-- THE STANDING MUTATION: A NEW SWEEP WHOSE CLOCK A CLIENT CAN WRITE. A table
-- with a client-writable timestamp, a sweep that reads it, and the sweep body
-- rewritten to call that sweep -- which is exactly what the next phase's
-- retention work will look like. First with the column unclassified, then
-- classified as a clock with no guard. Both must refuse. Everything is
-- restored byte-identically afterwards and RK34 proves it.
create table public.rt_clock_probe (id uuid primary key default gen_random_uuid(), expired_at timestamptz);
grant select, insert, update on public.rt_clock_probe to authenticated;
create function private.sweep_rt_clock_probe(p_dry boolean, p_limit integer) returns jsonb
language sql security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('rt_clock_probe.rows',
    (select pg_catalog.count(*) from public.rt_clock_probe p where p.expired_at < pg_catalog.now()))
$$;
insert into rt.saved_defs values
  ('sweep_body', pg_get_functiondef('private.retention_sweep_body(boolean,integer)'::regprocedure)),
  ('clock_roll', pg_get_functiondef('private.retention_clock_columns()'::regprocedure));
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'sweep_body');
  v_new := pg_catalog.replace(v_def, 'return query select v_swept, v_refused;',
             'v_swept := v_swept || private.sweep_rt_clock_probe(p_dry, p_limit);' || chr(10) ||
             '  return query select v_swept, v_refused;');
  if v_new = v_def then
    raise exception 'RK31 could not inject the new sweep -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.try_hint('RK31 MUTATION: a NEW SWEEP reading an unclassified timestamp column REFUSES the job',
  $$select private.assert_retention_clocks()$$, 'denied(55000:undeclared_retention_clock)');
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'clock_roll');
  v_new := pg_catalog.regexp_replace(v_def, 'values',
             'values (''public'', ''rt_clock_probe'', ''expired_at'', ''clock'', null, ''mutation probe''),', '');
  if v_new = v_def then
    raise exception 'RK32 could not inject the roll entry -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
select rt.try_hint('RK32 MUTATION: ...and classifying it as a clock is NOT ENOUGH while a client can write it',
  $$select private.assert_retention_clocks()$$, 'denied(55000:forgeable_retention_clock)');

-- A GUARD THAT CANNOT FIRE ON THE CLOCK COLUMN IS NOT A GUARD (fix round 2,
-- m-N2, the re-review's probes H and I). The existence check used to read
-- tgtype alone, so a trigger declared `BEFORE UPDATE OF <another column>`
-- or `WHEN (false)` counted as present. Named now, with each shape planted.
create function private.rt_clock_guard() returns trigger language plpgsql as $$
begin return new; end $$;
do $$
declare v_def text; v_new text;
begin
  v_def := (select def from rt.saved_defs where name = 'clock_roll');
  v_new := pg_catalog.regexp_replace(v_def, 'values',
             'values (''public'', ''rt_clock_probe'', ''expired_at'', ''clock'', ''trigger:private.rt_clock_guard'', ''mutation probe''),', '');
  if v_new = v_def then
    raise exception 'RK32a could not inject the guarded roll entry -- the probe would have proved nothing';
  end if;
  execute v_new;
end $$;
-- INSERT OR UPDATE OF <another column>: every other test the existence check
-- makes passes, so the column list is the ONLY thing that can fail it here.
create trigger rt_guard before insert or update of id on public.rt_clock_probe
  for each row execute function private.rt_clock_guard();
select rt.val('RK32a MUTATION: a guard declared BEFORE INSERT OR UPDATE OF <another column> is reported MISSING',
  $$select guard_missing from private.retention_clock_exposure()
     where table_name = 'rt_clock_probe' and column_name = 'expired_at'$$, 'trigger:private.rt_clock_guard');
drop trigger rt_guard on public.rt_clock_probe;
create trigger rt_guard before insert or update on public.rt_clock_probe
  for each row when (false) execute function private.rt_clock_guard();
select rt.val('RK32b MUTATION: ...and so is one declared WHEN (false)',
  $$select guard_missing from private.retention_clock_exposure()
     where table_name = 'rt_clock_probe' and column_name = 'expired_at'$$, 'trigger:private.rt_clock_guard');
select rt.try_hint('RK32c ...and the clock roll refuses the job for it',
  $$select private.assert_retention_clocks()$$, 'denied(55000:forgeable_retention_clock)');
drop trigger rt_guard on public.rt_clock_probe;
create trigger rt_guard before insert or update on public.rt_clock_probe
  for each row execute function private.rt_clock_guard();
select rt.val('RK32d CONTROL: the same guard with no column list and no WHEN clause is present, and the roll passes',
  $$select coalesce((select guard_missing from private.retention_clock_exposure()
                      where table_name = 'rt_clock_probe' and column_name = 'expired_at'), 'none')
        || '/' || (select 'ok' from (select private.assert_retention_clocks()) t)$$, 'none/ok');
select rt.val('RK33 ...and RK29''s own query names it as having no probe',
  $$select coalesce(string_agg(c, ',' order by c), 'none')
      from (select schema_name || '.' || table_name || '.' || column_name as c
              from private.retention_clock_exposure() where client_insert or client_update
            except
            select substring(label from '^CLOCK ([a-z_.]+) ') from rt.results
             where label like 'CLOCK %' and pass) x$$, 'public.rt_clock_probe.expired_at');
do $$ begin
  execute (select def from rt.saved_defs where name = 'sweep_body');
  execute (select def from rt.saved_defs where name = 'clock_roll');
end $$;
drop function private.sweep_rt_clock_probe(boolean, integer);
drop table public.rt_clock_probe;
drop function private.rt_clock_guard();
select rt.val('RK34 the sweep body and the clock roll are restored byte-identically, and the refusal passes again',
  $$select (pg_get_functiondef('private.retention_sweep_body(boolean,integer)'::regprocedure)
            = (select def from rt.saved_defs where name = 'sweep_body'))::text || '/' ||
           (pg_get_functiondef('private.retention_clock_columns()'::regprocedure)
            = (select def from rt.saved_defs where name = 'clock_roll'))::text || '/' ||
           (select count(*)::text from private.retention_clock_exposure()
             where (client_insert or client_update) and (guard is null or guard_missing is not null))$$,
  'true/true/0');


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

-- ---------------------------------------------------------------------------
-- RR8: THE ROLL REFUSES A RUN -- IN THREE PLACES, EACH ASKED DIRECTLY (C2).
--
-- As shipped, RR8 was one assertion: start a run and sweep it with an
-- unclassified table planted, and step 0 refuses. True, and blind to the
-- finding: the runner DELETES OBJECTS between those two calls, so a refusal
-- at step 0 arrives after the bytes are gone. psql cannot see a bucket, but
-- it CAN ask each of the three gates on its own, in the order the runner
-- meets them -- and it has to ask them separately, because the first one
-- refusing hides the other two from any end-to-end probe.
--
-- The run is opened BEFORE the table is planted for RR8/RR8a, which is also
-- the real race they exist for: a migration landing between the start and the
-- manifest.
-- ---------------------------------------------------------------------------
create table rt.run_ids (name text primary key, id uuid);
insert into rt.run_ids select 'rr8', (public.start_retention_run(false)).id;
select rt.val('RR8-0 DENOMINATOR: the run opened before the table appeared is `running`',
  $$select status from public.retention_runs where id = (select id from rt.run_ids where name = 'rr8')$$,
  'running');
create table public.rt_unclassified_probe (id uuid primary key default gen_random_uuid());
select rt.try_hint('RR8 GATE 3: an unclassified table stops the SWEEP at step 0, before a row moves',
  $$select public.run_retention_sweep((select id from rt.run_ids where name = 'rr8'), 500)$$,
  'denied(55000:unclassified_retention_subject)');
select rt.try_hint('RR8a GATE 2: ...and the MANIFEST names no object for that run -- the gate that protects the BYTES',
  $$select count(*) from public.retention_object_manifest((select id from rt.run_ids where name = 'rr8'), 500)$$,
  'denied(55000:unclassified_retention_subject)');
select public.fail_retention_run((select id from rt.run_ids where name = 'rr8'), 'rt probe');
select rt.val('RR8b GATE 1: ...and a NEW run is never opened at all: it is RECORDED as refused, with the reason',
  $$select (r).status || '/' || ((r).refused->>'*') from (select public.start_retention_run(false) as r) t$$,
  'refused/unclassified_retention_subject');
select rt.val('RR8c ...and that refused run is in the log, finished, for /super/health to render',
  $$select status || '/' || (finished_at is not null)::text || '/' || (refused->>'*')
      from public.retention_runs order by started_at desc, id desc limit 1$$,
  'refused/true/unclassified_retention_subject');
drop table public.rt_unclassified_probe;

-- THE MANIFEST'S OTHER REFUSALS. Each used to be asked only by the sweep --
-- after the objects were gone.
select rt.try_hint('RR8d the manifest refuses a run id that does not exist',
  $$select count(*) from public.retention_object_manifest('00000000-0000-4000-9000-00000000dead', 500)$$,
  'denied(22023:unknown_retention_run)');
select rt.try_hint('RR8e ...and a run that is not `running` (the failed rr8)',
  $$select count(*) from public.retention_object_manifest((select id from rt.run_ids where name = 'rr8'), 500)$$,
  'denied(22023:retention_run_is_not_running)');
insert into rt.run_ids select 'rr8f', (public.start_retention_run(false)).id;
update public.retention_settings set enabled = false where id;
select rt.try_hint('RR8f ...and a run whose KILL SWITCH was thrown after it started: stop means before the next object',
  $$select count(*) from public.retention_object_manifest((select id from rt.run_ids where name = 'rr8f'), 500)$$,
  'denied(55000:retention_disabled)');
update public.retention_settings set enabled = true where id;
select rt.try_hint('RR8g ...and `replica`',
  $$set local session_replication_role = replica;
    select count(*) from public.retention_object_manifest((select id from rt.run_ids where name = 'rr8f'), 500)$$,
  'denied(55000:replication_role_must_be_origin)');
select rt.try_hint('RR8h ...and START refuses `replica` too, so it is asked before the runner holds anything',
  $$set local session_replication_role = replica;
    select public.start_retention_run(false)$$,
  'denied(55000:replication_role_must_be_origin)');
select rt.val('RR8i CONTROL: for a healthy running run the manifest ANSWERS (or every refusal above is a broken function)',
  $$select (select count(*) >= 0 from public.retention_object_manifest(
              (select id from rt.run_ids where name = 'rr8f'), 10))::text$$, 'true');
select public.fail_retention_run((select id from rt.run_ids where name = 'rr8f'), 'rt probe');
select rt.val('RR8j the one-argument manifest -- keys with no gate in front of them -- no longer exists',
  $$select count(*)::text from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'retention_object_manifest'
       and pg_get_function_identity_arguments(oid) <> 'p_run_id uuid, p_limit integer'$$, '0');

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
-- ASKED OF THE SWEEP ITSELF: the run is opened under `origin` and only the
-- sweep is called under `replica`. (start_retention_run() refuses `replica`
-- first now -- RR8h -- so the shipped form of this probe would be answered by
-- the wrong gate and go on passing if this one were deleted.)
insert into rt.run_ids select 'rr12', (public.start_retention_run(true)).id;
select rt.try_hint('RR12 the SWEEP refuses `replica` at its own outermost gate',
  $$set local session_replication_role = replica;
    select public.run_retention_sweep((select id from rt.run_ids where name = 'rr12'), 500)$$,
  'denied(55000:replication_role_must_be_origin)');
select public.fail_retention_run((select id from rt.run_ids where name = 'rr12'), 'rt probe');
-- ---------------------------------------------------------------------------
-- ONE RUN AT A TIME (fix round 1, review finding I2). Two starts used to give
-- two `running` rows, which defeats the per-run ceiling, the sanity ceiling
-- and the before/after totals -- all three are arithmetic over ONE run. This
-- is the single-session half; the REAL race, two sessions each holding a
-- transaction open, is supabase/tests/retention_concurrency_probe.sh, which
-- run-rls-tests.sh runs straight after this suite.
-- ---------------------------------------------------------------------------
select rt.val('RR16 the serialisation is a PARTIAL UNIQUE INDEX over the running state, not a check in a function',
  $$select (indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%WHERE (status = ''running''::text)%')::text
      from pg_indexes where schemaname = 'public' and indexname = 'retention_runs_one_running_idx'$$, 'true');
insert into rt.run_ids select 'rr17', (public.start_retention_run(false)).id;
select rt.val('RR17 with a run `running`, a SECOND start is recorded as refused -- live or dry alike',
  $$select (a).status || '/' || ((a).refused->>'*') || ',' || (b).status || '/' || ((b).refused->>'*')
      from (select public.start_retention_run(false) as a, public.start_retention_run(true) as b) t$$,
  'refused/retention_run_in_progress,refused/retention_run_in_progress');
select rt.val('RR18 ...and there is still exactly ONE `running` row, the first',
  $$select count(*)::text || '/' || bool_and(id = (select id from rt.run_ids where name = 'rr17'))::text
      from public.retention_runs where status = 'running'$$, '1/true');
select rt.try('RR19 the index refuses a second `running` row to a DIRECT insert too -- it is not the function''s rule',
  $$insert into public.retention_runs (correlation_id, mode, status) values (gen_random_uuid(), 'live', 'running')$$,
  'denied(23505)');
-- AN ABANDONED RUN MUST NOT WEDGE THE JOB FOR EVER. The index makes the
-- reaper load-bearing: without it a crashed run would refuse every later one.
update public.retention_runs set started_at = now() - interval '2 hours'
 where id = (select id from rt.run_ids where name = 'rr17');
insert into rt.run_ids select 'rr20', (public.start_retention_run(false)).id;
select rt.val('RR20 a run abandoned two hours ago is REAPED by the next start, which then opens normally',
  $$select (select status || '/' || (refused->>'*') from public.retention_runs
             where id = (select id from rt.run_ids where name = 'rr17'))
        || ',' ||
           (select status from public.retention_runs
             where id = (select id from rt.run_ids where name = 'rr20'))$$,
  'failed/run_abandoned,running');
select public.fail_retention_run((select id from rt.run_ids where name = 'rr20'), 'rt probe');

select rt.val('RR13 no run this section opened was left `running`',
  $$select count(*)::text from public.retention_runs where status = 'running'$$, '0');

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
-- RN  A REFUSED RUN IS NEVER SILENT, AND A PREVIEW POSTPONES NOTHING
--     (fix round 1: review findings m5 and m6, Q182)
-- ===========================================================================
-- By this point the section above has produced, as a side effect of its own
-- probes: two `retention_disabled` refusals (RR7), one LIVE structural refusal
-- (RR8b), three failed probe runs, two `retention_run_in_progress` refusals
-- (RR17) and one reaped run (RR20) -- and then completed live runs. So the
-- first half of this section READS what the trigger made of all that, which
-- is a better test than staging it again: nothing here was arranged to suit
-- the raiser.
-- ===========================================================================

select rt.val('RN1 DENOMINATOR: the section above left chosen-state and overlap refusals in the run log',
  $$select string_agg(distinct refused->>'*', ',' order by refused->>'*')
      from public.retention_runs
     where refused->>'*' in ('retention_disabled', 'retention_run_in_progress')$$,
  'retention_disabled,retention_run_in_progress');
select rt.val('RN2 ...and NEITHER filed an alert: a switch somebody chose and an overlap are not faults',
  $$select count(*)::text from public.incident_alerts
     where alert_type = 'retention_run_refused'
       and details->>'reason' in ('retention_disabled', 'retention_run_in_progress')$$, '0');
select rt.val('RN3 the LIVE structural refusal (RR8b) DID file one, naming the whole run and the hint -- and nothing else',
  $$select count(*)::text || '/' || string_agg(details->>'sweep', ',') || '/' ||
           string_agg(details->>'run_status', ',')
      from public.incident_alerts
     where alert_type = 'retention_run_refused'
       and details->>'reason' = 'unclassified_retention_subject'
       -- THIS SUITE'S OWN RUN, not any alert of that reason: the storage
       -- integration test plants an unclassified table too, and on a database
       -- it has run against its (resolved) alert is still there. Measured:
       -- this read 2 the first time the two were run back to back.
       and (details->>'run_id')::uuid in (select id from public.retention_runs)$$, '1/*/refused');
select rt.val('RN4 ...and the completed live runs after it RESOLVED it, as the SYSTEM, with nobody named',
  $$select (resolved_at is not null)::text || '/' || coalesce(auto_resolved_reason, '-') || '/' ||
           (resolved_by is null)::text
      from public.incident_alerts
     where alert_type = 'retention_run_refused'
       and details->>'reason' = 'unclassified_retention_subject'
       and (details->>'run_id')::uuid in (select id from public.retention_runs)$$,
  'true/retention_run_recovered/true');
-- THE SECTION ABOVE ALSO LEFT TWO ALERTS OPEN, and they are worth reading
-- rather than tidying away: rr17 was REAPED (`run_abandoned` -- a crashed run
-- is a fault) and rr20 was failed by this suite with the reason 'rt probe',
-- which has a SPACE in it and is therefore not a code -- so it was recorded as
-- `unknown`. Nothing arranged that; it is the sanitiser working on the
-- suite's own carelessness.
select rt.val('RN4a the two faults still open are the reaped run and a reason that was not a code',
  $$select string_agg(details->>'reason', ',' order by details->>'reason')
      from public.incident_alerts
     where alert_type = 'retention_run_refused' and resolved_at is null$$, 'run_abandoned,unknown');
-- THE RUN AND THE COUNT ARE TWO STATEMENTS, for RA10's reason: both halves of
-- one `select` share a snapshot, so a count beside the run reads the alerts as
-- they were BEFORE it. (This probe's first cut did exactly that and read 2.)
select rt.val('RN4b a clean live run completes with nothing refused',
  $$with r as (select public.start_retention_run(false) as run)
    select ((public.run_retention_sweep((r.run).id, 500))->'refused')::text from r$$, '{}');
select rt.val('RN4c ...and resolved both',
  $$select count(*)::text from public.incident_alerts
     where alert_type = 'retention_run_refused' and resolved_at is null$$, '0');
select rt.val('RN5 a DRY run''s refusal files nothing -- a preview is the founder looking, not the job failing',
  $$select count(*)::text from public.incident_alerts a
      join public.retention_runs r on r.id = (a.details->>'run_id')::uuid
     where a.alert_type = 'retention_run_refused' and r.mode = 'dry'$$, '0');

-- THE REVIEWER'S CASE: the sanity ceiling, which CANNOT DRAIN ITSELF. 1200
-- rows past the period against a table that is mostly them. The purge refuses
-- (RA15 asked that of the purge directly); what matters here is that the RUN
-- says so where somebody will read it, ONCE, however often it repeats.
delete from public.audit_events where action = 'rt.recent';
insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, created_at)
select null, private.erased_user_id(), 'rt.flood', 'platform', gen_random_uuid(), now() - interval '2 years'
  from generate_series(1, greatest(1200, (select count(*) from public.audit_events)::integer));
select rt.val('RN6 DENOMINATOR: the flood is more than a thousand rows and more than a fifth of the table',
  $$select ((select count(*) from public.audit_events where action = 'rt.flood') > 1000
            and (select count(*) from public.audit_events where action = 'rt.flood')::numeric
                / (select count(*) from public.audit_events)::numeric > 0.20)::text$$, 'true');
select rt.val('RN7 a LIVE run COMPLETES with the audit purge refused -- the other sweeps are not held hostage',
  $$with r as (select public.start_retention_run(false) as run)
    select (public.run_retention_sweep((r.run).id, 500))->'refused'->>'audit_events' from r$$,
  'audit_purge_over_ceiling');
select rt.val('RN8 ...and that files ONE alert, carrying the two COUNTS an operator needs and no content',
  $$select count(*)::text || '/' || string_agg(details->>'sweep', ',') || '/' ||
           bool_and((details->>'audit_rows_past_period')::bigint >= 1200
                    and (details->>'audit_rows_total')::bigint >= 1200)::text || '/' ||
           bool_and(summary like '%audit_events: audit_purge_over_ceiling%')::text
      from public.incident_alerts
     where alert_type = 'retention_run_refused' and resolved_at is null$$, '1/audit_events/true/true');
select rt.val('RN9 the NEXT run refuses the same way',
  $$with r as (select public.start_retention_run(false) as run)
    select (public.run_retention_sweep((r.run).id, 500))->'refused'->>'audit_events' from r$$,
  'audit_purge_over_ceiling');
select rt.val('RN9a ...and files NOTHING NEW: one open alert per fault, not one per hour (two alerts in all would be 2/2)',
  $$select (select count(*)::text from public.incident_alerts
             where alert_type = 'retention_run_refused' and resolved_at is null) || '/' ||
           (select count(*)::text from public.incident_alerts
             where alert_type = 'retention_run_refused'
               and details->>'reason' = 'audit_purge_over_ceiling')$$, '1/1');
select rt.val('RN10 THE STATED LIMIT: the ceiling cannot drain itself -- not one flood row went in two runs',
  $$select ((select count(*) from public.audit_events where action = 'rt.flood')
          = (select (details->>'audit_rows_past_period')::bigint from public.incident_alerts
              where alert_type = 'retention_run_refused' and resolved_at is null))::text$$, 'true');
delete from public.audit_events where action = 'rt.flood';
select rt.val('RN11 with the cause gone, the next completed live run RESOLVES the alert as the system',
  $$with r as (select public.start_retention_run(false) as run),
         s as (select public.run_retention_sweep((r.run).id, 500) as out from r)
    select (select (out->'refused')::text from s)$$, '{}');
select rt.val('RN12 ...leaving no open retention alert at all, and the ceiling one marked recovered',
  $$select (select count(*)::text from public.incident_alerts
             where alert_type = 'retention_run_refused' and resolved_at is null) || '/' ||
           (select count(*)::text from public.incident_alerts
             where alert_type = 'retention_run_refused'
               and details->>'reason' = 'audit_purge_over_ceiling'
               and auto_resolved_reason = 'retention_run_recovered')$$, '0/1');

-- THE TRIGGER, ASKED DIRECTLY, with a `refused` value no function of this
-- product would write: anything that is not a code is recorded as `unknown`
-- and never reaches an operator surface.
insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
values (gen_random_uuid(), 'live', 'failed', now(), 0,
        '{"*": "Jane Doe <jane@example.test> said: DROP TABLE"}'::jsonb);
select rt.val('RN13 a `refused` value that is not a code is recorded as `unknown`, and its text appears NOWHERE in the alert',
  $$select string_agg(details->>'reason', ',') || '/' ||
           bool_or(summary like '%Jane%' or details::text like '%Jane%')::text
      from public.incident_alerts
     where alert_type = 'retention_run_refused' and resolved_at is null$$, 'unknown/false');

-- ---- m6: A PREVIEW MUST NOT MOVE THE LIVE JOB'S CLOCK -----------------------
-- The poster's only other observable effect is an HTTP request an unconfigured
-- stack never makes, so the throttle is a function that can be ASKED.
delete from public.retention_runs;
select rt.val('RN14 with no run at all, the live sweep is due',
  $$select private.retention_sweep_is_due()::text$$, 'true');
select public.fail_retention_run((public.start_retention_run(true)).id, 'rt probe');
select rt.val('RN15 DENOMINATOR: a DRY run began a moment ago',
  $$select count(*)::text || '/' || string_agg(mode, ',') from public.retention_runs
     where started_at > now() - interval '1 minute'$$, '1/dry');
select rt.val('RN16 ...and the live sweep is STILL due: a preview postpones nothing',
  $$select private.retention_sweep_is_due()::text$$, 'true');
insert into public.retention_runs (correlation_id, mode, status, finished_at, duration_ms, refused)
values (gen_random_uuid(), 'live', 'refused', now(), 0, '{"*": "retention_run_in_progress"}'::jsonb);
select rt.val('RN17 ...nor does a live wake that merely COLLIDED with a preview',
  $$select private.retention_sweep_is_due()::text$$, 'true');
select public.fail_retention_run((public.start_retention_run(false)).id, 'rt probe');
select rt.val('RN18 a LIVE run that began a moment ago is what holds the next one back',
  $$select private.retention_sweep_is_due()::text$$, 'false');
update public.retention_runs set started_at = now() - interval '2 hours' where mode = 'live';
select rt.val('RN19 ...until the interval has passed',
  $$select private.retention_sweep_is_due()::text$$, 'true');
select rt.val('RN20 and the poster consults THAT function and no longer reads max(started_at) over every run',
  $$select (pg_get_functiondef('private.deliver_retention_sweep()'::regprocedure) like '%private.retention_sweep_is_due()%')::text
        || '/' ||
           (pg_get_functiondef('private.deliver_retention_sweep()'::regprocedure) like '%max(r.started_at)%')::text$$,
  'true/false');


-- ===========================================================================
-- RZ  HOUSEKEEPING
-- ===========================================================================
-- Every row this suite made, removed -- so a second run over the same database
-- measures the same thing, and no other suite inherits a sweep's leavings.

delete from public.audit_events where action in ('rt.recent','rt.old','rt.edge','rt.flood','retention.swept');
delete from public.audit_events where action = 'organisation.erased'
   and target_id = '00000000-0000-4000-9000-0000000067b2';
delete from public.retention_runs;
delete from public.audit_events where actor_user_id = '00000000-0000-4000-9000-0000000067a3';
delete from public.feedback where route = '/rt';
delete from public.incident_alerts where summary like 'rt %';
delete from public.incident_alerts where alert_type = 'retention_run_refused';
alter table public.erasure_jobs disable trigger user;
delete from public.erasure_jobs where failure_reason in ('rt probe')
   or id in ('00000000-0000-4000-9000-0000000067f3', '00000000-0000-4000-9000-0000000067f4');
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
select rt.try('RZ6 BOTH derivations still pass on the schema this suite leaves behind (CALLED)',
  $$select private.assert_retention_roll(), private.assert_retention_clocks()$$, 'ok(1)');

\echo ''
\echo '--- PHASE 8 RETENTION: failures ---'
select seq, label, expected, actual from rt.results where not pass order by seq;
select count(*) as failed from rt.results where not pass;
select count(*) as recorded from rt.results;
