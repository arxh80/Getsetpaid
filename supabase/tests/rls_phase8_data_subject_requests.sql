-- ===========================================================================
-- Phase 8 Task 3 (data subject requests) RLS suite.
--
-- Covers 20260924000000_data_subject_requests.sql and 20260924001000
-- (the deadline alerts):
--   public.data_subject_requests            the register, with a generated due_by
--   public.data_subject_request_notes       operator notes the requester cannot read
--   the two/one SELECT policies             own rows; superuser oversight at aal2
--   private.data_subject_requests_before_insert()   attribution, catalogue, meter
--   private.data_subject_requests_before_update()   the transition table, the
--                                           who-may-do-it check, the stamper,
--                                           and the dormant Task 4/5 constraint
--   the delete / truncate / note guards     for EVERY role, postgres included
--   the four RPCs                           the only write paths
--   private.raise_dsr_deadline_alerts()     overdue and approaching, exactly once
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh (after the consent suite, on
-- the same P7VARS fixtures). § DZ removes every request, note, counter, alert
-- and audit row this suite made.
--
-- THE DENOMINATOR RULE (progress.md, standing lesson 1). Every "X cannot read
-- Y's request" is preceded by proof that Y's request EXISTS and that somebody
-- CAN read it; every refused write is paired with the same write succeeding
-- for the right caller; and the overdue alert's POSITIVE case is asserted
-- before the "and not for a closed one" case.
--
-- SECTIONS:
--   DF  fixtures and the dormant fulfilment constraint
--   DG  the catalogue: RLS, policies, grants, triggers, function grants
--   DW  writing: the one path, attribution, the catalogue, the clock
--   DR  reading: own rows only; superuser oversight at aal2; anon nothing
--   DT  transitions: the table, who may make them, the stamps
--   DN  notes: the requester cannot read them; append-only
--   DM  the submission meter, and that withdrawal is never metered
--   DA  audit: one row per event, carrying no free text
--   DD  the deadline alerts
--   DZ  housekeeping
-- ===========================================================================

drop schema if exists dsr cascade;
create schema dsr;

create table dsr.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function dsr.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into dsr.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function dsr.try(p_label text, p_sql text, p_expected text)
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
  perform dsr.record(p_label, p_expected, v_actual);
end $$;

create function dsr.try_hint(p_label text, p_sql text, p_expected text)
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
  perform dsr.record(p_label, p_expected, v_actual);
end $$;

create function dsr.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform dsr.record(p_label, p_expected, v_actual);
end $$;

create function dsr.retry_hint_shape(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_hint text;
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    return sqlstate || ':' || case when v_hint ~ '^[0-9]+$' and v_hint::int between 0 and 86400
                                   then 'seconds' else coalesce(v_hint, '<null>') end;
  end;
end $$;

-- The outcome AS A VALUE, for the one block whose assertions are made inside a
-- transaction that is then rolled back: a dsr.record() there would be rolled
-- back with everything else, and the three assertions would VANISH from the
-- report rather than fail -- which is exactly what the first run of this suite
-- did. \gset captures a value CLIENT-side, so it survives the rollback and is
-- recorded afterwards.
create function dsr.outcome(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_hint text;
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    return 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
  end;
end $$;

grant usage on schema dsr to authenticated, anon, service_role;
grant execute on function dsr.record(text,text,text)    to authenticated, anon, service_role;
grant execute on function dsr.try(text,text,text)       to authenticated, anon, service_role;
grant execute on function dsr.try_hint(text,text,text)  to authenticated, anon, service_role;
grant execute on function dsr.val(text,text,text)       to authenticated, anon, service_role;
grant execute on function dsr.retry_hint_shape(text)    to authenticated, anon, service_role;
grant execute on function dsr.outcome(text)             to authenticated, anon, service_role;

\o /dev/null
select count(*)::text as audit_before  from public.audit_events \gset
select count(*)::text as alerts_before from public.incident_alerts \gset
select id::text as alpha_org from public.organisations where slug = 'org-alpha' \gset
select gen_random_uuid()::text as ghost \gset
\o
\set anon_c '{"role":"anon"}'

-- ===========================================================================
-- § DF  FIXTURES, AND THE DORMANT TASK 4/5 CONSTRAINT
-- ===========================================================================
select dsr.val('DF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');
select dsr.val('DF2 FIXTURE: the register starts empty',
  $$select count(*)::text from public.data_subject_requests$$, '0');
select dsr.val('DF3 FIXTURE: org-alpha exists, to route a processor request to',
  format($$select count(*)::text from public.organisations where id=%L$$, :'alpha_org'), '1');
select dsr.val('DF4 the six rights are exactly PRD §12''s, and three of them name a job',
  $$select string_agg(right_type || ':' || coalesce(fulfilment_kind,'-'), ',' order by right_type)
      from private.dsr_rights()$$,
  'access:export,erasure:erasure,objection:-,portability:export,rectification:-,restriction:-');
select dsr.val('DF5 the response window is 30 days, in one place',
  $$select private.dsr_response_days()::text$$, '30');
select dsr.val('DF6 ...and the generated due_by column agrees with it',
  $$select (pg_get_expr(d.adbin, d.adrelid) like '%30 days%')::text
      from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'public.data_subject_requests'::regclass and a.attname = 'due_by'$$, 'true');
select dsr.val('DF7 the early warning fires 7 days out',
  $$select private.dsr_alert_lead_days()::text$$, '7');
select dsr.val('DF8 the fulfilment constraint is DORMANT, and says so',
  $$select private.dsr_fulfilment_jobs_ready()::text$$, 'false');

-- ===========================================================================
-- § DG  THE CATALOGUE
-- ===========================================================================
select dsr.val('DG1 RLS is enabled on data_subject_requests',
  $$select relrowsecurity::text from pg_class where oid = 'public.data_subject_requests'::regclass$$, 'true');
select dsr.val('DG2 RLS is enabled on data_subject_request_notes',
  $$select relrowsecurity::text from pg_class where oid = 'public.data_subject_request_notes'::regclass$$, 'true');
select dsr.val('DG3 exactly two policies on the register, both SELECT, both authenticated',
  $$select string_agg(polname::text || ':' || polcmd::text || ':' ||
            (select string_agg(r::regrole::text, ',') from unnest(polroles) r), ';' order by polname)
      from pg_policy where polrelid = 'public.data_subject_requests'::regclass$$,
  'data_subject_requests_select_own:r:authenticated;data_subject_requests_select_platform:r:authenticated');
select dsr.val('DG4 exactly ONE policy on the notes, and it is the superuser''s (no own-rows policy)',
  $$select string_agg(polname::text || ':' || polcmd::text, ';' order by polname)
      from pg_policy where polrelid = 'public.data_subject_request_notes'::regclass$$,
  'data_subject_request_notes_select_platform:r');
select dsr.val('DG5 authenticated holds SELECT on the register and nothing else',
  $$select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants
     where table_schema='public' and table_name='data_subject_requests' and grantee='authenticated'$$, 'SELECT');
select dsr.val('DG6 no client role holds a write privilege, at table or column level',
  $$select count(*)::text from (
      select grantee from information_schema.role_table_grants
       where table_schema='public' and table_name in ('data_subject_requests','data_subject_request_notes')
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT'
      union all
      select grantee from information_schema.column_privileges
       where table_schema='public' and table_name in ('data_subject_requests','data_subject_request_notes')
         and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT') x$$, '0');
select dsr.val('DG7 the four triggers on the register are all present',
  $$select string_agg(tgname::text, ',' order by tgname) from pg_trigger
     where tgrelid = 'public.data_subject_requests'::regclass and not tgisinternal$$,
  'data_subject_requests_audit_submitted,data_subject_requests_audit_transition,'
  'data_subject_requests_before_insert,data_subject_requests_before_update,'
  'data_subject_requests_delete_guard,data_subject_requests_truncate_guard');
select dsr.val('DG8 the RPCs are executable by authenticated and by nobody else',
  $$select string_agg(p.proname || ':' ||
            coalesce((select string_agg(g, ',' order by g) from unnest(array['anon','authenticated','service_role']) g
                       where has_function_privilege(g, p.oid, 'execute')), '-'), ';' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname in
       ('submit_data_subject_request','withdraw_data_subject_request',
        'transition_data_subject_request','add_data_subject_request_note')$$,
  'add_data_subject_request_note:authenticated;submit_data_subject_request:authenticated;'
  'transition_data_subject_request:authenticated;withdraw_data_subject_request:authenticated');
select dsr.val('DG9 submit_data_subject_request takes NO user argument',
  $$select (pg_get_function_identity_arguments(
              'public.submit_data_subject_request(text,text,text)'::regprocedure) !~ 'user')::text$$, 'true');
select dsr.val('DG10 the submission budget is 10 per 24 hours per user',
  $$select max_requests || '/' || window_seconds || '/' || subject_scope
      from public.rate_limit_policies where category='data_subject_request'$$, '10/86400/user');
select dsr.val('DG11 no column can hold an IP address or a user agent',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='data_subject_requests'
       and (column_name ~* 'ip_|agent|browser|device')$$, '0');
select dsr.val('DG12 due_by is GENERATED ALWAYS, not merely defaulted',
  $$select attgenerated::text from pg_attribute
     where attrelid='public.data_subject_requests'::regclass and attname='due_by'$$, 's');
select dsr.val('DG13 the alert types now include both DSR stages',
  $$select (pg_get_constraintdef(oid) like '%dsr_overdue%'
            and pg_get_constraintdef(oid) like '%dsr_deadline_approaching%'
            and pg_get_constraintdef(oid) like '%rate_limit_tripped%')::text
      from pg_constraint where conname = 'incident_alerts_alert_type_known'$$, 'true');
select dsr.val('DG14 exactly one cron job still, and it raises the alerts BEFORE delivering them',
  $$select count(*) || ':' ||
           max((command like '%raise_dsr_deadline_alerts%'
                and command like '%deliver_incident_alerts%'
                and position('raise_dsr_deadline_alerts' in command)
                    < position('deliver_incident_alerts' in command))::int)::text
      from cron.job$$, '1:1');

-- ===========================================================================
-- § DW  WRITING
-- ===========================================================================
set role anon;
set request.jwt.claims = :'anon_c';
select dsr.try('DW1 anon cannot make a request',
  $$select * from public.submit_data_subject_request('access','account','from nowhere')$$,
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.try('DW2 POSITIVE: pstd1 makes an access request about their account',
  $$select * from public.submit_data_subject_request('access','account','Please send me everything you hold.')$$,
  'ok(1)');
select dsr.try('DW3 pstd1 cannot INSERT into the register directly (no grant)',
  $$insert into public.data_subject_requests (user_id, user_email, right_type, subject_scope, detail)
    values (auth.uid(), 'x@y.z', 'access', 'account', 'direct')$$, 'denied(42501)');
select dsr.try('DW4 ...nor name another user while doing it',
  format($$insert into public.data_subject_requests (user_id, user_email, right_type, subject_scope, detail)
           values (%L, 'x@y.z', 'access', 'account', 'forged')$$, :'pstd2'), 'denied(42501)');
select dsr.try_hint('DW5 a right outside the six is refused',
  $$select * from public.submit_data_subject_request('compensation','account','nope')$$,
  'denied(22023:unknown_right)');
select dsr.try_hint('DW6 a scope outside the two is refused',
  $$select * from public.submit_data_subject_request('access','everything','nope')$$,
  'denied(22023:unknown_scope)');
select dsr.try_hint('DW7 an empty request is refused',
  $$select * from public.submit_data_subject_request('access','account','   ')$$,
  'denied(22023:detail_required)');
select dsr.try('DW8 a request longer than the column allows is refused',
  $$select * from public.submit_data_subject_request('access','account', repeat('x', 4001))$$,
  'denied(23514)');
select dsr.try('DW9 POSITIVE: pstd1 makes a SECOND request, about a workspace''s records',
  $$select * from public.submit_data_subject_request('erasure','workspace_records',
      'A promoter has me as a contact. Please ask them to delete me.')$$, 'ok(1)');
reset role; reset request.jwt.claims;

select dsr.val('DW10 the DW2 row is pstd1''s, with their real email, open, and due in 30 days',
  format($$select (user_id = %L)::text || '|' || user_email || '|' || status || '|' ||
                  (due_by - requested_at)::text
             from public.data_subject_requests where detail like 'Please send me everything%'$$, :'pstd1'),
  'true|pstd1@test.local|open|30 days');

set role authenticated;
set request.jwt.claims = :'pstd1_c';
-- 428C9, not the 42501 a missing UPDATE grant would give: naming a GENERATED
-- ALWAYS column is refused while the statement is being PREPARED, before
-- privileges or policies are consulted at all. That is the stronger result --
-- the deadline is not something any caller can even ask to move.
select dsr.try('DW11 the requester cannot move their own due_by (GENERATED ALWAYS, refused before RLS)',
  $$update public.data_subject_requests set due_by = now() + interval '90 days'$$, 'denied(428C9)');
select dsr.try('DW12 ...nor rewrite what they asked for',
  $$update public.data_subject_requests set detail = 'something else'$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- As POSTGRES, which bypasses RLS and owns the table: the deadline still
-- cannot be moved, because a generated column is not writable by anyone.
select dsr.try('DW13 not even postgres can write due_by',
  $$update public.data_subject_requests set due_by = now()$$, 'denied(428C9)');
select dsr.try('DW14 not even postgres can rewrite the request itself',
  $$update public.data_subject_requests set detail = 'rewritten'$$, 'denied(42501)');
select dsr.try('DW15 not even postgres can delete a request',
  $$delete from public.data_subject_requests$$, 'denied(42501)');
select dsr.try('DW16 not even postgres can truncate the register',
  $$truncate public.data_subject_requests cascade$$, 'denied(42501)');

-- ===========================================================================
-- § DR  READING
-- ===========================================================================
\o /dev/null
select id::text as req_access from public.data_subject_requests
 where detail like 'Please send me everything%' \gset
select id::text as req_erasure from public.data_subject_requests
 where detail like 'A promoter has me%' \gset
\o

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.val('DR1 POSITIVE: pstd1 reads both of their own requests',
  $$select count(*)::text from public.data_subject_requests$$, '2');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd2_c';
select dsr.val('DR2 pstd2 reads NONE of pstd1''s requests',
  $$select count(*)::text from public.data_subject_requests$$, '0');
select dsr.val('DR3 ...not even by naming the id',
  format($$select count(*)::text from public.data_subject_requests where id=%L$$, :'req_access'), '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select dsr.val('DR4 an Org Owner at aal2 is not the platform operator and reads none',
  $$select count(*)::text from public.data_subject_requests$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c1';
select dsr.val('DR5 the superuser BELOW aal2 reads none',
  $$select count(*)::text from public.data_subject_requests$$, '0');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.val('DR6 POSITIVE: the aal2 superuser reads every request',
  $$select count(*)::text from public.data_subject_requests$$, '2');
reset role; reset request.jwt.claims;

set role anon;
set request.jwt.claims = :'anon_c';
-- anon holds no grant on the table at all, so it is REFUSED rather than
-- filtered to zero rows -- a stronger answer than the count, and the one the
-- HTTP block sees as a 401.
select dsr.val('DR7 anon is refused outright, not merely filtered to nothing',
  $$select count(*)::text from public.data_subject_requests$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § DT  TRANSITIONS
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.try('DT1 the requester cannot progress their own request',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_access'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select dsr.try('DT2 an Org Owner cannot progress anybody''s request',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_access'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c1';
select dsr.try('DT3 the superuser below aal2 cannot progress one either',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_access'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DT4 POSITIVE: the operator takes the access request in hand',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_access'), 'ok(1)');
select dsr.try_hint('DT5 a state that does not follow is refused (in_progress -> open)',
  format($$select * from public.transition_data_subject_request(%L,'open')$$, :'req_access'),
  'denied(22023:illegal_transition)');
select dsr.try_hint('DT6 a no-op is not a transition',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_access'),
  'denied(22023:not_a_transition)');
-- The TRANSITION TABLE answers first -- a BEFORE trigger runs before the CHECK
-- constraint -- so an unknown state reads as "cannot go from in_progress to
-- lost" rather than as a constraint violation. Both refuse; this records WHICH
-- one does, so a later change that dropped the trigger and left the CHECK
-- would show up here rather than pass quietly.
select dsr.try_hint('DT7 a state outside the vocabulary is refused by the transition table',
  format($$select * from public.transition_data_subject_request(%L,'lost')$$, :'req_access'),
  'denied(22023:illegal_transition)');
select dsr.try_hint('DT8 a refusal with no reason is refused',
  format($$select * from public.transition_data_subject_request(%L,'rejected',null)$$, :'req_access'),
  'denied(22023:rejection_needs_reason)');
select dsr.try_hint('DT9 an ACCOUNT-scope request cannot be routed to a workspace',
  format($$select * from public.transition_data_subject_request(%L,'routed',null,%L)$$,
         :'req_access', :'alpha_org'),
  'denied(22023:not_a_processor_request)');
select dsr.try_hint('DT10 routing that names no workspace is refused',
  format($$select * from public.transition_data_subject_request(%L,'routed')$$, :'req_erasure'),
  'denied(22023:routing_needs_workspace)');
select dsr.try('DT11 POSITIVE: the workspace-scope request is routed to org-alpha (Q132)',
  format($$select * from public.transition_data_subject_request(%L,'routed',null,%L)$$,
         :'req_erasure', :'alpha_org'), 'ok(1)');
select dsr.try('DT12 the operator cannot WITHDRAW a request -- that is the requester''s act',
  format($$select * from public.transition_data_subject_request(%L,'withdrawn')$$, :'req_erasure'),
  'denied(42501)');
reset role; reset request.jwt.claims;

select dsr.val('DT13 routing stamped the workspace and the time, and the database set the time',
  format($$select (routed_to_organisation_id = %L)::text || '|' ||
                  (routed_at is not null)::text || '|' || status
             from public.data_subject_requests where id = %L$$, :'alpha_org', :'req_erasure'),
  'true|true|routed');

set role authenticated;
set request.jwt.claims = :'pstd2_c';
select dsr.try('DT14 a stranger cannot withdraw somebody else''s request',
  format($$select public.withdraw_data_subject_request(%L)$$, :'req_erasure'),
  'denied(22023)');
reset role; reset request.jwt.claims;

-- The RPC's WHERE clause makes DT14 a 22023 rather than the trigger's 42501.
-- DT15 asks the TRIGGER itself, with the update issued directly as postgres
-- under a stranger's session: it is the guard, not the convenience filter.
set request.jwt.claims = :'pstd2_c';
select dsr.try('DT15 ...and the TRIGGER refuses it even when the WHERE clause does not',
  format($$update public.data_subject_requests set status='withdrawn' where id=%L$$, :'req_erasure'),
  'denied(42501)');
reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.try('DT16 POSITIVE: the requester withdraws their own routed request',
  format($$select public.withdraw_data_subject_request(%L)$$, :'req_erasure'), 'ok(1)');
select dsr.try_hint('DT17 ...and cannot withdraw it twice',
  format($$select public.withdraw_data_subject_request(%L)$$, :'req_erasure'),
  'denied(22023:not_withdrawable)');
reset role; reset request.jwt.claims;

select dsr.val('DT18 the withdrawal stamped the clock, and the routing SURVIVED as evidence',
  format($$select status || '|' || (withdrawn_at is not null)::text || '|' ||
                  (routed_at is not null)::text
             from public.data_subject_requests where id = %L$$, :'req_erasure'),
  'withdrawn|true|true');

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try_hint('DT19 a terminal request is terminal, for the operator too',
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'req_erasure'),
  'denied(22023:illegal_transition)');
reset role; reset request.jwt.claims;

-- --------------------------------------------------------------------------
-- THE TASK 4/5 SEAM. Two halves: a client can never claim a job ran, and the
-- constraint that will bite once one exists is proved NOW by flipping the
-- dormant predicate inside a transaction that is rolled back.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DF9 the operator cannot declare that an export ran',
  format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(),
                  fulfilment_recorded_at=now() where id=%L$$, :'req_access'),
  'denied(42501)');
select dsr.try('DF10 POSITIVE (dormant): an account access request CAN be closed by hand today',
  format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'req_access'), 'ok(1)');
reset role; reset request.jwt.claims;

\o /dev/null
begin;
create or replace function private.dsr_fulfilment_jobs_ready()
returns boolean language sql immutable set search_path = '' as $mut$ select true $mut$;
-- A fresh account-scope access request to close, made by the requester.
set local role authenticated;
set local request.jwt.claims = :'pstd1_c';
select dsr.outcome($$select * from public.submit_data_subject_request('access','account','Seam probe.')$$)
  as seam_made \gset
reset role; reset request.jwt.claims;
select coalesce((select id::text from public.data_subject_requests where detail = 'Seam probe.'),
                '00000000-0000-0000-0000-000000000000') as seam_new \gset
set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(
  format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_new'))
  as seam_refused \gset
select dsr.outcome(
  format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'seam_new'))
  as seam_allowed \gset
reset role; reset request.jwt.claims;
rollback;
\o

-- Recorded AFTER the rollback, from the values \gset captured client-side.
select dsr.record('DF11 SETUP: a new access request exists to test the live constraint against',
  'ok', :'seam_made');
select dsr.record('DF12 with the jobs READY, an access request cannot be closed without one',
  'denied(22023:fulfilment_not_recorded)', :'seam_refused');
select dsr.record('DF13 ...while a transition that is not `fulfilled` is untouched by the rule',
  'ok', :'seam_allowed');

select dsr.val('DF14 the dormant predicate is dormant again after the rollback',
  $$select private.dsr_fulfilment_jobs_ready()::text$$, 'false');
select dsr.val('DF15 ...and the seam probe row is gone with the rolled-back transaction',
  $$select count(*)::text from public.data_subject_requests where detail = 'Seam probe.'$$, '0');

-- ===========================================================================
-- § DN  OPERATOR NOTES -- Q103, THE WHOLE POINT
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DN1 POSITIVE: the operator adds a working note',
  format($$select public.add_data_subject_request_note(%L,
            'Checked the audit trail; nothing to disclose beyond the export.')$$, :'req_access'), 'ok(1)');
select dsr.val('DN2 POSITIVE: the operator can read it back',
  $$select count(*)::text from public.data_subject_request_notes$$, '1');
select dsr.try_hint('DN3 an empty note is refused',
  format($$select public.add_data_subject_request_note(%L,'  ')$$, :'req_access'),
  'denied(22023:body_required)');
select dsr.try_hint('DN4 a note on a request that does not exist is refused',
  format($$select public.add_data_subject_request_note(%L,'ghost')$$, :'ghost'),
  'denied(22023:unknown_request)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.val('DN5 THE REQUESTER READS ZERO NOTES ON THEIR OWN REQUEST',
  format($$select count(*)::text from public.data_subject_request_notes where request_id=%L$$, :'req_access'),
  '0');
select dsr.val('DN6 ...and the register row they CAN read carries no note column to leak one',
  $$select count(*)::text from information_schema.columns
     where table_schema='public' and table_name='data_subject_requests' and column_name ~* 'note'$$, '0');
select dsr.try('DN7 the requester cannot add a note either',
  format($$select public.add_data_subject_request_note(%L,'let me in')$$, :'req_access'),
  'denied(42501)');
reset role; reset request.jwt.claims;

select dsr.try('DN8 a note cannot be edited, by any role including postgres',
  $$update public.data_subject_request_notes set body = 'rewritten'$$, 'denied(42501)');
select dsr.try('DN9 a note cannot be deleted either',
  $$delete from public.data_subject_request_notes$$, 'denied(42501)');
select dsr.try('DN10 the notes table cannot be truncated',
  $$truncate public.data_subject_request_notes$$, 'denied(42501)');

-- ===========================================================================
-- § DM  THE METER
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pbooker_c';
do $$
declare i integer;
begin
  -- pbooker holds no counter yet (asserted below from zero). Eight more
  -- submissions take them to the ceiling of ten.
  for i in 1..10 loop
    begin
      perform * from public.submit_data_subject_request('restriction','account','meter ' || i);
    exception when others then null;
    end;
  end loop;
end $$;
-- Read AFTER the role is reset: rate_limit_counters is readable only by the
-- aal2 platform superuser, so asking it as pbooker returns null whatever the
-- counter holds. That is how the first run of this suite reported "<null>"
-- while the meter was working perfectly -- DM2 and DM5 below are the proof it
-- was, and they are why this is a wrong QUESTION rather than a wrong answer.
reset role; reset request.jwt.claims;
select dsr.val('DM1 the counter stopped at the limit',
  format($$select request_count::text from public.rate_limit_counters
            where category='data_subject_request' and subject_id=%L$$, :'pbooker'), '10');
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select dsr.record('DM2 the eleventh is PT429 with the seconds left in the hint', 'PT429:seconds',
  dsr.retry_hint_shape($$select * from public.submit_data_subject_request('restriction','account','eleven')$$));
select dsr.val('DM3 ...and it landed no row',
  $$select count(*)::text from public.data_subject_requests where detail = 'eleven'$$, '0');
select dsr.try('DM4 WITHDRAWAL IS NEVER METERED, even with the budget spent',
  $$select public.withdraw_data_subject_request(
      (select id from public.data_subject_requests where detail = 'meter 1'))$$, 'ok(1)');
reset role; reset request.jwt.claims;
select dsr.val('DM5 the crossing filed exactly one alert, naming no workspace',
  $$select count(*) || ':' || coalesce(max((organisation_id is null)::int)::text,'-')
      from public.incident_alerts where details->>'category' = 'data_subject_request'$$, '1:1');

-- ===========================================================================
-- § DA  AUDIT -- IDENTIFIERS ONLY
-- ===========================================================================
select dsr.val('DA1 every event wrote exactly one audit row, and the actions are the states',
  $$select string_agg(distinct action, ',' order by action) from public.audit_events
     where target_type = 'data_subject_request'$$,
  'data_subject_request.fulfilled,data_subject_request.in_progress,'
  'data_subject_request.note_added,data_subject_request.routed,'
  'data_subject_request.submitted,data_subject_request.withdrawn');
select dsr.val('DA2 NO audit row carries what the requester wrote',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request'
       and (before::text || after::text) like '%Please send me everything%'$$, '0');
select dsr.val('DA3 NO audit row carries a note''s body',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request'
       and (before::text || after::text) like '%nothing to disclose%'$$, '0');
select dsr.val('DA4 the submission audit carries the length instead of the text',
  format($$select after->>'detail_length' from public.audit_events
            where target_type='data_subject_request' and action='data_subject_request.submitted'
              and target_id=%L$$, :'req_access'), '35');
select dsr.val('DA5 the routing audit names the workspace, so it shows on that workspace''s filter',
  format($$select (organisation_id = %L)::text from public.audit_events
            where target_type='data_subject_request' and action='data_subject_request.routed'
              and target_id=%L$$, :'alpha_org', :'req_erasure'), 'true');
select dsr.val('DA6 a closing transition records whether it was inside the 30 days',
  format($$select after->>'on_time' from public.audit_events
            where target_type='data_subject_request' and action='data_subject_request.fulfilled'
              and target_id=%L$$, :'req_access'), 'true');
select dsr.val('DA7 every audit row names a real actor (no unattributed transition)',
  $$select count(*)::text from public.audit_events
     where target_type='data_subject_request' and actor_user_id is null$$, '0');

-- ===========================================================================
-- § DD  THE DEADLINE ALERTS -- THE POSITIVE FIRST
-- ===========================================================================
-- Backdating a request needs the INSERT trigger out of the way: it forces
-- requested_at = now() for every writer, which is what makes the deadline
-- unmovable, and is therefore also what stops a fixture from making an old
-- one. Disabling a trigger as the table's owner is the deliberate DBA escape
-- hatch 20260923000000's own header names; it is re-enabled immediately and
-- DD0 asserts it is back on before anything else is measured.
alter table public.data_subject_requests disable trigger data_subject_requests_before_insert;
alter table public.data_subject_requests disable trigger data_subject_requests_audit_submitted;
insert into public.data_subject_requests (user_id, user_email, right_type, subject_scope, detail, requested_at)
values (:'pstd2', 'pstd2@test.local', 'access', 'account', 'DD overdue',      now() - interval '31 days'),
       (:'pstd2', 'pstd2@test.local', 'erasure','account', 'DD due soon',     now() - interval '25 days'),
       (:'pstd2', 'pstd2@test.local', 'objection','account','DD plenty',      now()),
       (:'pstd2', 'pstd2@test.local', 'access', 'account', 'DD closed late',  now() - interval '40 days');
alter table public.data_subject_requests enable trigger data_subject_requests_before_insert;
alter table public.data_subject_requests enable trigger data_subject_requests_audit_submitted;

select dsr.val('DD0 the insert trigger is ENABLED again',
  $$select tgenabled::text from pg_trigger
     where tgrelid='public.data_subject_requests'::regclass
       and tgname='data_subject_requests_before_insert'$$, 'O');

-- Close the fourth one, so "a closed request raises nothing" has a subject
-- that WOULD otherwise be forty days overdue.
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DD1 SETUP: the operator closes the forty-day-old one',
  $$select * from public.transition_data_subject_request(
      (select id from public.data_subject_requests where detail='DD closed late'),'fulfilled')$$, 'ok(1)');
reset role; reset request.jwt.claims;

select dsr.val('DD2 POSITIVE: the run writes an alert for the overdue one and the due-soon one',
  $$select private.raise_dsr_deadline_alerts()::text$$, '2');
select dsr.val('DD3 the overdue alert names the overdue request and says OVERDUE',
  $$select (summary like '%OVERDUE%')::text from public.incident_alerts
     where alert_type='dsr_overdue'
       and details->>'request_id' = (select id::text from public.data_subject_requests where detail='DD overdue')$$,
  'true');
select dsr.val('DD4 the early warning named the one 5 days from its deadline',
  $$select (details->>'request_id' =
            (select id::text from public.data_subject_requests where detail='DD due soon'))::text
      from public.incident_alerts where alert_type='dsr_deadline_approaching'$$, 'true');
select dsr.val('DD5 NOTHING was written for the request with weeks left',
  $$select count(*)::text from public.incident_alerts
     where details->>'request_id' = (select id::text from public.data_subject_requests where detail='DD plenty')$$,
  '0');
select dsr.val('DD6 NOTHING was written for the CLOSED one, though it is 40 days old',
  $$select count(*)::text from public.incident_alerts
     where details->>'request_id' = (select id::text from public.data_subject_requests where detail='DD closed late')$$,
  '0');
select dsr.val('DD7 a second run writes nothing -- exactly once per request per stage',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');
select dsr.val('DD8 ...and that is a UNIQUE INDEX, not a not-exists check that two ticks could race',
  $$select count(*)::text from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'incident_alerts_dsr_stage_once_idx' and i.indisunique$$, '1');
select dsr.val('DD9 no alert carries anything the requester wrote',
  $$select count(*)::text from public.incident_alerts
     where alert_type like 'dsr\_%' and (summary || details::text) like '%DD overdue%'$$, '0');
select dsr.val('DD10 the alerts are undelivered, so the existing digest picks them up',
  $$select count(*)::text from public.incident_alerts
     where alert_type like 'dsr\_%' and notified_at is not null$$, '0');

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.val('DD11 the operator sees both on the health surface''s own read path',
  $$select count(*)::text from public.incident_alerts where alert_type like 'dsr\_%'$$, '2');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.val('DD12 an ordinary user sees no alert at all',
  $$select count(*)::text from public.incident_alerts$$, '0');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § DZ  HOUSEKEEPING
-- ===========================================================================
\o /dev/null
set session_replication_role = replica;
delete from public.audit_events where target_type = 'data_subject_request';
delete from public.data_subject_request_notes;
delete from public.data_subject_requests;
set session_replication_role = default;
delete from public.incident_alerts
 where alert_type like 'dsr\_%' or details->>'category' = 'data_subject_request';
delete from public.rate_limit_counters where category = 'data_subject_request';
\o
select dsr.val('DZ1 the register is empty again',
  $$select count(*)::text from public.data_subject_requests$$, '0');
select dsr.val('DZ2 the notes are gone with it',
  $$select count(*)::text from public.data_subject_request_notes$$, '0');
select dsr.val('DZ3 the audit table is back to its size before this suite',
  format($$select ((select count(*) from public.audit_events) - %s)::text$$, :audit_before), '0');
select dsr.val('DZ4 the alert table is back to its size before this suite',
  format($$select ((select count(*) from public.incident_alerts) - %s)::text$$, :alerts_before), '0');
select dsr.val('DZ5 the guards are ENABLED again (replica mode was reset)',
  $$select current_setting('session_replication_role')$$, 'origin');

-- ===========================================================================
-- REPORT
-- ===========================================================================
\echo
\echo '=== Phase 8 data subject requests suite ==='
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
from dsr.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed
from dsr.results;
