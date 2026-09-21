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
--   the five RPCs                           the only write paths
--   private.raise_dsr_deadline_alerts()     overdue and approaching, never two open
--
-- ...and fix round 1 (20260925000000 / 001000 / 002000), each section marked:
--   the seam guard asked WITHOUT the missing grant to hide behind (§ DF9*)
--   one dormant predicate per job, and a recorded seam ADMITTED (§ DF11-DF19)
--   a closed row immutable; a seam write moving only the seam (§ DI)
--   the routed-workspace FK's own nulling; re-routing; the handover note (§ DO)
--   the delete guards against a TRIGGER's delete, account alive (§ DX)
--   re-raise after a resolve, auto-resolve on close, the tick's two halves (§ DD13+)
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
--   DI  invariants the status-unchanged writes may not bypass (fix round 1)
--   DO  the routed workspace: re-route, handover note, the FK's nulling (fix round 1)
--   DN  notes: the requester cannot read them; append-only
--   DX  the delete guards against a trigger's delete (fix round 1)
--   DM  the submission meter, and that withdrawal is never metered
--   DA  audit: one row per event, carrying no free text
--   DD  the deadline alerts: raise, re-raise, auto-resolve, the tick
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

-- As try_hint, for a write a DEFERRED constraint trigger judges (the handover
-- note, 20260925000000 § 7). Left alone it would answer at the end of the
-- statement, OUTSIDE this exception block, and abort the run instead of
-- recording a refusal -- so the constraints are made immediate inside the block.
create function dsr.try_hint_commit(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql;
    set constraints all immediate;
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

-- As dsr.outcome, but a success says how many rows it touched: an UPDATE
-- that matched nothing never reached the trigger it was meant to test, and
-- 'ok' would hide that.
create function dsr.outcome_rows(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_hint text; v_rows bigint;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    return 'ok(' || v_rows || ')';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    return 'denied(' || sqlstate || ':' || coalesce(v_hint, '') || ')';
  end;
end $$;

grant usage on schema dsr to authenticated, anon, service_role;
grant execute on function dsr.outcome_rows(text) to authenticated, anon, service_role;
grant execute on function dsr.record(text,text,text)    to authenticated, anon, service_role;
grant execute on function dsr.try(text,text,text)       to authenticated, anon, service_role;
grant execute on function dsr.try_hint(text,text,text)  to authenticated, anon, service_role;
grant execute on function dsr.try_hint_commit(text,text,text) to authenticated, anon, service_role;
grant execute on function dsr.val(text,text,text)       to authenticated, anon, service_role;
grant execute on function dsr.retry_hint_shape(text)    to authenticated, anon, service_role;
grant execute on function dsr.outcome(text)             to authenticated, anon, service_role;

\o /dev/null
select count(*)::text as audit_before  from public.audit_events \gset
select count(*)::text as alerts_before from public.incident_alerts \gset
select id::text as alpha_org from public.organisations where slug = 'org-alpha' \gset
select id::text as beta_org  from public.organisations where slug = 'org-beta' \gset
select name as alpha_name from public.organisations where slug = 'org-alpha' \gset
select name as beta_name  from public.organisations where slug = 'org-beta' \gset
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
select dsr.val('DF3a FIXTURE: org-beta exists too, to RE-route to',
  format($$select count(*)::text from public.organisations where id=%L$$, :'beta_org'), '1');
-- ONE LINE PER JOB, AND THEY MOVE INDEPENDENTLY -- which is the whole point
-- of I5a and is now MEASURED rather than argued: Phase 8 Task 4 woke the
-- EXPORT line (20260927003000) and the erasure line did not move. Had this
-- stayed a single boolean, that migration would have made every account
-- ERASURE request impossible to close until Task 5 shipped.
-- BOTH LINES ARE AWAKE SINCE PHASE 8 TASK 5 (20260930004000). The
-- independence I5a bought is STILL the thing being measured, and it is still
-- measurable: `nonsense` -- a right with no job -- stays false, and the
-- rolled-back probes below flip each line alone. The predicate was
-- deliberately not collapsed to `true` when its second line woke, so a NINTH
-- right type added later still starts dormant.
select dsr.val('DF8 BOTH lines are awake (Task 4, Task 5) and a right with no job is still false (I5a)',
  $$select private.dsr_fulfilment_job_ready('export')::text || '|' ||
           private.dsr_fulfilment_job_ready('erasure')::text || '|' ||
           private.dsr_fulfilment_job_ready('nonsense')::text$$, 'true|true|false');
select dsr.val('DF8a the single-boolean predicate is GONE, not left behind for Task 4 to flip by mistake',
  $$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'dsr_fulfilment_jobs_ready'$$, '0');

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
select dsr.val('DG6 NO CLIENT ROLE holds a write privilege, at table or column level',
  $$select count(*)::text from (
      select grantee from information_schema.role_table_grants
       where table_schema='public' and table_name in ('data_subject_requests','data_subject_request_notes')
         and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'
      union all
      select grantee from information_schema.column_privileges
       where table_schema='public' and table_name in ('data_subject_requests','data_subject_request_notes')
         and grantee in ('anon','authenticated') and privilege_type <> 'SELECT') x$$, '0');
-- service_role IS NOT A CLIENT ROLE, and since Phase 8 Task 4 it holds a
-- deliberate, column-level write: the export job records its outcome on the
-- register as `service_role` through a two-column UPDATE grant
-- (20260927003000 § 1), which is what finally gives § DF9h a positive control
-- rather than a refusal by a missing privilege. Asserted as the EXACT set, so
-- a third column arriving is red.
select dsr.val('DG6a service_role''s write is EXACTLY the two seam columns, on the register alone',
  $$select coalesce(string_agg(table_name || '.' || column_name || ':' || privilege_type,
                               ',' order by table_name, column_name), '<none>')
      from information_schema.column_privileges
     where table_schema='public' and table_name in ('data_subject_requests','data_subject_request_notes')
       and grantee='service_role' and privilege_type <> 'SELECT'$$,
  'data_subject_requests.fulfilment_kind:UPDATE,data_subject_requests.fulfilment_reference:UPDATE');
select dsr.val('DG6b ...and fulfilment_recorded_at is NOT in it -- the clock stays the database''s',
  $$select (not has_column_privilege('service_role','public.data_subject_requests',
                                     'fulfilment_recorded_at','update'))::text$$, 'true');
select dsr.val('DG7 every trigger on the register is present, the two fix-round ones included',
  $$select string_agg(tgname::text, ',' order by tgname) from pg_trigger
     where tgrelid = 'public.data_subject_requests'::regclass and not tgisinternal$$,
  'data_subject_requests_alerts_on_close,'
  'data_subject_requests_audit_submitted,data_subject_requests_audit_transition,'
  'data_subject_requests_before_insert,data_subject_requests_before_update,'
  'data_subject_requests_delete_guard,data_subject_requests_routing_handover_note,'
  'data_subject_requests_truncate_guard');
select dsr.val('DG8 the RPCs are executable by authenticated and by nobody else',
  $$select string_agg(p.proname || ':' ||
            coalesce((select string_agg(g, ',' order by g) from unnest(array['anon','authenticated','service_role']) g
                       where has_function_privilege(g, p.oid, 'execute')), '-'), ';' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname in
       ('submit_data_subject_request','withdraw_data_subject_request',
        'transition_data_subject_request','route_data_subject_request',
        'add_data_subject_request_note','data_subject_request_note_counts',
        'data_subject_request_recent_notes')$$,
  'add_data_subject_request_note:authenticated;data_subject_request_note_counts:authenticated;'
  'data_subject_request_recent_notes:authenticated;route_data_subject_request:authenticated;'
  'submit_data_subject_request:authenticated;'
  'transition_data_subject_request:authenticated;withdraw_data_subject_request:authenticated');
select dsr.val('DG8a transition_data_subject_request has ONE signature -- the four-argument one is gone',
  $$select string_agg(pg_get_function_identity_arguments(p.oid), ';') from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='transition_data_subject_request'$$,
  'p_request_id uuid, p_status text, p_rejection_reason text');
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
select dsr.val('DG13 the alert types now include both DSR stages and the writer-failed one',
  $$select (pg_get_constraintdef(oid) like '%dsr_overdue%'
            and pg_get_constraintdef(oid) like '%dsr_alert_writer_failed%'
            and pg_get_constraintdef(oid) like '%dsr_deadline_approaching%'
            and pg_get_constraintdef(oid) like '%rate_limit_tripped%')::text
      from pg_constraint where conname = 'incident_alerts_alert_type_known'$$, 'true');
select dsr.val('DG14 exactly one cron job still, and it runs the ONE tick function (M3)',
  $$select count(*) || ':' || max(command) from cron.job$$,
  '1:select private.run_incident_alert_tick()');
select dsr.val('DG14a ...and the tick raises the alerts BEFORE delivering them',
  $$select (position('raise_dsr_deadline_alerts' in prosrc) > 0
            and position('raise_dsr_deadline_alerts' in prosrc)
                < position('perform private.deliver_incident_alerts' in prosrc))::text
      from pg_proc where oid = 'private.run_incident_alert_tick()'::regprocedure$$, 'true');
select dsr.val('DG15 the register no longer goes with the account: user_id has NO delete action (Q158)',
  $$select confdeltype::text from pg_constraint
     where conname = 'data_subject_requests_user_id_fkey'$$, 'a');
select dsr.val('DG16 the routed workspace is still ON DELETE SET NULL -- and § DO proves it can now execute',
  $$select confdeltype::text from pg_constraint
     where conname = 'data_subject_requests_routed_to_organisation_id_fkey'$$, 'n');

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

-- FIX ROUND 1: THIS ASSERTION HAD NEVER RUN. Its LIKE pattern ended `everything%'`
-- inside format(), and `%'` is not a format specifier, so the statement raised
-- ("unrecognized format() type specifier") before dsr.val() was ever called --
-- DW10 did not fail, it was ABSENT from the report, the same way DF11-DF13 once
-- were. `%%` is format()'s literal percent. The runner now also fails on any
-- psql ERROR line in this suite's output (run-rls-tests.sh), so an assertion
-- that vanishes is red rather than invisible.
select dsr.val('DW10 the DW2 row is pstd1''s, with their real email, open, and due in 30 days',
  format($$select (user_id = %L)::text || '|' || user_email || '|' || status || '|' ||
                  (due_by - requested_at)::text
             from public.data_subject_requests where detail like 'Please send me everything%%'$$, :'pstd1'),
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
  format($$select * from public.route_data_subject_request(%L,%L,'Emailed the owner.')$$,
         :'req_access', :'alpha_org'),
  'denied(22023:not_a_processor_request)');
select dsr.try_hint('DT10 routing that names no workspace is refused',
  format($$select * from public.route_data_subject_request(%L,null,'Emailed the owner.')$$, :'req_erasure'),
  'denied(22023:routing_needs_workspace)');
select dsr.try_hint('DT10a routing that does not say HOW the workspace was told is refused (Q160a)',
  format($$select * from public.route_data_subject_request(%L,%L,'   ')$$, :'req_erasure', :'alpha_org'),
  'denied(22023:handover_note_required)');
select dsr.try_hint('DT10b routing to a workspace that does not exist is refused by name, not by a foreign key',
  format($$select * from public.route_data_subject_request(%L,%L,'Emailed somebody.')$$, :'req_erasure', :'ghost'),
  'denied(22023:unknown_workspace)');
select dsr.try_hint('DT10c the general transition function no longer routes -- it points at the one that records the handover',
  format($$select * from public.transition_data_subject_request(%L,'routed')$$, :'req_erasure'),
  'denied(22023:use_route_data_subject_request)');
select dsr.val('DT10d none of those refusals routed anything',
  format($$select status from public.data_subject_requests where id=%L$$, :'req_erasure'), 'open');
select dsr.try('DT11 POSITIVE: the workspace-scope request is routed to org-alpha, with its handover note (Q132/Q160)',
  format($$select * from public.route_data_subject_request(%L,%L,
            'Emailed the workspace owner on the address on file; asked them to answer within the deadline.')$$,
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
select dsr.val('DT13n ...and SNAPSHOTTED the workspace''s name onto the row, from the database (I4/I7)',
  format($$select (routed_to_organisation_name = %L)::text from public.data_subject_requests where id = %L$$,
         :'alpha_name', :'req_erasure'), 'true');
select dsr.val('DT13o ...and the handover note landed in the SAME statement, in the table the requester cannot read',
  format($$select count(*)::text from public.data_subject_request_notes where request_id = %L$$, :'req_erasure'), '1');

-- ---------------------------------------------------------------------------
-- THE TRIGGER'S OWN who-may-do-it CHECK, asked directly.
--
-- DT1 and DT12 above go through the RPCs, and each RPC carries its own guard
-- (has_platform_permission for the operator's function, an explicit refusal of
-- `withdrawn` in it) -- so they cannot tell whether the TRIGGER's check is
-- there at all. A mutation that replaced the trigger's two-branch rule with
-- `v_is_owner or v_operator` -- letting the requester close their own request
-- and the operator withdraw on the requester's behalf -- left the whole suite
-- GREEN. These two ask the trigger itself, with the update issued as postgres
-- (which bypasses RLS) under each principal's session, exactly as DT15 does.
-- ---------------------------------------------------------------------------
set request.jwt.claims = :'pstd1_c';
select dsr.try('DT13a the TRIGGER refuses the REQUESTER closing their own request',
  format($$update public.data_subject_requests set status='fulfilled' where id=%L$$, :'req_access'),
  'denied(42501)');
reset request.jwt.claims;

set request.jwt.claims = :'super_c';
select dsr.try('DT13b the TRIGGER refuses the OPERATOR withdrawing on the requester''s behalf',
  format($$update public.data_subject_requests set status='withdrawn' where id=%L$$, :'req_erasure'),
  'denied(42501)');
reset request.jwt.claims;

select dsr.val('DT13c neither attempt moved anything',
  format($$select (select status from public.data_subject_requests where id=%L) || '|' ||
                  (select status from public.data_subject_requests where id=%L)$$,
         :'req_access', :'req_erasure'), 'in_progress|routed');

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
-- THE TASK 4/5 SEAM (rewritten in fix round 1: I1, I5).
--
-- THE SHIPPED DF9 WAS ANSWERED BY A MISSING GRANT. It asked `authenticated` to
-- UPDATE the seam and expected 42501 -- which the absent UPDATE privilege
-- produces on its own, before any trigger runs. The guard behind it read
-- row_security_active() inside a SECURITY DEFINER function, which is false for
-- every caller, and the review deleted it outright with the suite still 113/0.
--
-- So DF9 is kept, labelled as the GRANT's answer (Postgres's own "Grant the
-- required privileges" hint), and the GUARD is
-- asked where the grant cannot answer for it: as postgres under a person's
-- claims (DF9a/DF9b -- the DT13 shape), and with an UPDATE grant and a
-- permissive policy opened inside a rolled-back transaction (DF9c-DF9g -- the
-- review's own reproduction). The guard's refusals carry ITS hint; the grant's
-- carries none. Phase 7 shipped a refusal that wore the guard's SQLSTATE and
-- was caused by something else; the hint is what tells them apart here.
-- --------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.record('DF9 the operator cannot write the seam over PostgREST''s role -- and it is THE GRANT that answers, not the guard',
  'the missing grant',
  (select case when o like 'denied(42501:Grant the required privileges%' then 'the missing grant' else o end
     from dsr.outcome(format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(),
                  fulfilment_recorded_at=now() where id=%L$$, :'req_access')) o));
reset role; reset request.jwt.claims;

-- THE GUARD, LEG ONE: a person's claims are on the session. Issued as postgres,
-- so neither a grant nor a policy is in the picture.
set request.jwt.claims = :'super_c';
select dsr.try_hint('DF9a THE GUARD refuses the OPERATOR declaring that an export ran',
  format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(),
                  fulfilment_recorded_at=now() where id=%L$$, :'req_access'),
  'denied(42501:fulfilment_seam_is_server_only)');
reset request.jwt.claims;
set request.jwt.claims = :'pstd1_c';
select dsr.try_hint('DF9b THE GUARD refuses the REQUESTER declaring that their own export ran',
  format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(),
                  fulfilment_recorded_at=now() where id=%L$$, :'req_access'),
  'denied(42501:fulfilment_seam_is_server_only)');
reset request.jwt.claims;

-- THE REVIEW'S REPRODUCTION: open the grant and a permissive policy, so the
-- guard is the ONLY thing left between a client role and the seam.
\o /dev/null
begin;
grant select, update on public.data_subject_requests to authenticated, anon, service_role;
create policy dsr_probe_all on public.data_subject_requests
  for all to authenticated, anon, service_role using (true) with check (true);

set local role authenticated;
set local request.jwt.claims = :'pstd1_c';
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(), fulfilment_recorded_at=now()
 where id=%L$$, :'req_access')) as seam_client \gset
reset role;

-- LEG TWO ALONE: the session role with NO person's claims on it at all.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(), fulfilment_recorded_at=now()
 where id=%L$$, :'req_access')) as seam_role_only \gset
reset role;
set local role anon;
set local request.jwt.claims = :'anon_c';
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(), fulfilment_recorded_at=now()
 where id=%L$$, :'req_access')) as seam_anon \gset
reset role;

-- THE DENOMINATOR: with the grant open, a write the trigger PERMITS does land
-- from that same client session -- so the three refusals above were the
-- guard's judgement and not a grant that never opened. (A second request, so
-- req_access is left as it was for DF10.)
set local role authenticated;
set local request.jwt.claims = :'pstd1_c';
select dsr.outcome($$select * from public.submit_data_subject_request('access','account','Grant probe.')$$)
  as seam_probe_made \gset
select dsr.outcome_rows($$update public.data_subject_requests set status='withdrawn'
                           where detail = 'Grant probe.'$$) as seam_grant_open \gset
reset role;

-- THE JOB'S PATH: service_role, no person on the session.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(), fulfilment_recorded_at=now()
 where id=%L$$, :'req_access')) as seam_service \gset
reset role; reset request.jwt.claims;
rollback;
\o

select dsr.record('DF9c THE GUARD, grant and policy OPEN: the requester''s seam write is refused BY THE GUARD (the review''s reproduction)',
  'denied(42501:fulfilment_seam_is_server_only)', :'seam_client');
select dsr.record('DF9d ...and the session ROLE alone is enough -- authenticated with no person''s claims',
  'denied(42501:fulfilment_seam_is_server_only)', :'seam_role_only');
select dsr.record('DF9e ...and anon',
  'denied(42501:fulfilment_seam_is_server_only)', :'seam_anon');
select dsr.record('DF9f DENOMINATOR setup: a probe request was made inside that transaction', 'ok', :'seam_probe_made');
select dsr.record('DF9g DENOMINATOR: through the same opened grant, a write the trigger PERMITS landed -- the grant really was open',
  'ok(1)', :'seam_grant_open');
select dsr.record('DF9h POSITIVE: service_role with no person on the session -- the job''s path -- IS admitted',
  'ok(1)', :'seam_service');
select dsr.val('DF9i the probe grant and policy are gone with the rolled-back transaction',
  $$select (select count(*) from pg_policy where polname = 'dsr_probe_all')::text || '|' ||
           has_table_privilege('authenticated', 'public.data_subject_requests', 'update')::text$$, '0|false');

-- THE POSITIVE, PERSISTED: a session with no person on it (postgres, no
-- claims) records that an export ran. As shipped this RAISED 28000 -- the
-- audit trigger sent a seam-only write to log_audit_event(), which refuses a
-- sessionless caller -- so the only session that could write the seam was one
-- the guard exists to refuse.
select dsr.try_hint('DF9j POSITIVE: the sessionless job path records the seam on an open request',
  format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid(),
                  fulfilment_recorded_at = now() - interval '10 years' where id=%L$$, :'req_access'),
  'ok');
select dsr.val('DF9k ...and the recorded-at stamp is the DATABASE''s clock, not the ten-years-ago one supplied',
  format($$select fulfilment_kind || '|' || (fulfilment_recorded_at > now() - interval '1 hour')::text
             from public.data_subject_requests where id=%L$$, :'req_access'), 'export|true');
select dsr.try_hint('DF9l the WRONG kind for the right is refused (an access request is not fulfilled by an erasure)',
  format($$update public.data_subject_requests
              set fulfilment_kind='erasure', fulfilment_reference=gen_random_uuid() where id=%L$$, :'req_access'),
  'denied(22023:fulfilment_kind_mismatch)');
select dsr.try_hint('DF9m the seam cannot be CLEARED once recorded',
  format($$update public.data_subject_requests
              set fulfilment_kind=null, fulfilment_reference=null, fulfilment_recorded_at=null where id=%L$$, :'req_access'),
  'denied(22023:fulfilment_kind_mismatch)');

set role authenticated;
set request.jwt.claims = :'super_c';
-- WAS "POSITIVE (dormant): an account access request CAN be closed by hand
-- today". Since Phase 8 Task 4 woke the export line it cannot -- unless an
-- export has recorded itself on it, which DF9j has just done. The assertion
-- is the same call and now proves the other half of the rule.
select dsr.try('DF10 POSITIVE: with DF9j''s seam recorded, the operator''s fulfilment IS admitted',
  format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'req_access'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ONE PREDICATE PER JOB (I5a), AND A RECORDED SEAM IS ADMITTED (I5c). Each
-- line of private.dsr_fulfilment_job_ready() is flipped ALONE inside a
-- transaction that is rolled back.
\o /dev/null
begin;
create or replace function private.dsr_fulfilment_job_ready(p_kind text)
returns boolean language sql immutable set search_path = '' as $mut$ select p_kind = 'export' $mut$;

set local role authenticated;
set local request.jwt.claims = :'pstd1_c';
select dsr.outcome($$select * from public.submit_data_subject_request('access','account','Seam probe A.')$$) as seam_made \gset
select dsr.outcome($$select * from public.submit_data_subject_request('erasure','account','Seam probe E.')$$) as seam_made_e \gset
select dsr.outcome($$select * from public.submit_data_subject_request('rectification','account','Seam probe R.')$$) as seam_made_r \gset
reset role; reset request.jwt.claims;
select coalesce((select id::text from public.data_subject_requests where detail = 'Seam probe A.'),
                '00000000-0000-0000-0000-000000000000') as seam_a \gset
select coalesce((select id::text from public.data_subject_requests where detail = 'Seam probe E.'),
                '00000000-0000-0000-0000-000000000000') as seam_e \gset
select coalesce((select id::text from public.data_subject_requests where detail = 'Seam probe R.'),
                '00000000-0000-0000-0000-000000000000') as seam_r \gset

set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_a'))
  as seam_refused \gset
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'in_progress')$$, :'seam_a'))
  as seam_allowed \gset
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_e'))
  as seam_erasure_free \gset
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_r'))
  as seam_by_hand_free \gset
reset role; reset request.jwt.claims;

-- The job records the seam (sessionless), and THEN the operator may close it.
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='export', fulfilment_reference=gen_random_uuid() where id=%L$$, :'seam_a'))
  as seam_recorded \gset
set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_a'))
  as seam_admitted \gset
reset role; reset request.jwt.claims;

-- Now wake the ERASURE line too. Under Q158 (keep the row, anonymised) the
-- register row SURVIVES the erasure, so there is a row to record the seam on
-- and a row to mark fulfilled.
create or replace function private.dsr_fulfilment_job_ready(p_kind text)
returns boolean language sql immutable set search_path = '' as $mut$ select p_kind in ('export','erasure') $mut$;
set local role authenticated;
set local request.jwt.claims = :'pstd1_c';
select dsr.outcome($$select * from public.submit_data_subject_request('erasure','account','Seam probe E2.')$$) as seam_made_e2 \gset
reset role; reset request.jwt.claims;
select coalesce((select id::text from public.data_subject_requests where detail = 'Seam probe E2.'),
                '00000000-0000-0000-0000-000000000000') as seam_e2 \gset
set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_e2'))
  as seam_erasure_refused \gset
reset role; reset request.jwt.claims;
select dsr.outcome_rows(format($$update public.data_subject_requests
   set fulfilment_kind='erasure', fulfilment_reference=gen_random_uuid() where id=%L$$, :'seam_e2'))
  as seam_erasure_recorded \gset
set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(format($$select * from public.transition_data_subject_request(%L,'fulfilled')$$, :'seam_e2'))
  as seam_erasure_admitted \gset
reset role; reset request.jwt.claims;
rollback;
\o

-- Recorded AFTER the rollback, from the values \gset captured client-side.
select dsr.record('DF11 SETUP: an access, an erasure and a rectification request exist to test the live constraint against',
  'ok|ok|ok', :'seam_made' || '|' || :'seam_made_e' || '|' || :'seam_made_r');
select dsr.record('DF12 with the EXPORT job ready, an access request cannot be closed without it having run',
  'denied(22023:fulfilment_not_recorded)', :'seam_refused');
select dsr.record('DF13 ...while a transition that is not `fulfilled` is untouched by the rule',
  'ok', :'seam_allowed');
select dsr.record('DF14 I5a: waking the EXPORT line leaves an ERASURE request closable by hand',
  'ok', :'seam_erasure_free');
select dsr.record('DF15 ...and a right no job fulfils (rectification) is never gated',
  'ok', :'seam_by_hand_free');
select dsr.record('DF16 I5c POSITIVE: the sessionless job records the seam...',
  'ok(1)', :'seam_recorded');
select dsr.record('DF17 I5c POSITIVE: ...and the operator''s fulfilment IS then admitted',
  'ok', :'seam_admitted');
select dsr.record('DF18 with the ERASURE line awake too, an erasure request is refused without its job',
  'ok|denied(22023:fulfilment_not_recorded)', :'seam_made_e2' || '|' || :'seam_erasure_refused');
select dsr.record('DF19 I5b: the erasure half IS satisfiable -- the row survives, the job records, the operator closes',
  'ok(1)|ok', :'seam_erasure_recorded' || '|' || :'seam_erasure_admitted');

select dsr.val('DF20 the rollback put the real function back: both halves awake',
  $$select private.dsr_fulfilment_job_ready('export')::text || '|' ||
           private.dsr_fulfilment_job_ready('erasure')::text$$, 'true|true');
select dsr.val('DF21 ...and the seam probe rows are gone with the rolled-back transaction',
  $$select count(*)::text from public.data_subject_requests where detail like 'Seam probe%'$$, '0');

-- ===========================================================================
-- § DI  THE STATUS-UNCHANGED WRITES BYPASS NOTHING (fix round 1, I5d)
-- ===========================================================================
-- As shipped, a seam-only write took an early `return new` above every later
-- rule. As postgres the review wrote routed_at + a workspace onto an `open`
-- row and moved a closed row's fulfilled_at back ten years, each riding on a
-- seam write. All as postgres with NO session here -- the most privileged
-- caller there is, because these are the row's invariants and not anybody's
-- permissions.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.try('DI0 SETUP: an OPEN account-scope request to attack',
  $$select * from public.submit_data_subject_request('access','account','DI open probe.')$$, 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
select id::text as req_di from public.data_subject_requests where detail = 'DI open probe.' \gset
select fulfilled_at::text as closed_stamp from public.data_subject_requests where id = :'req_access' \gset
\o
select dsr.val('DI1 DENOMINATOR: req_access is CLOSED (fulfilled) and carries a stamp to move',
  format($$select status || '|' || (fulfilled_at is not null)::text
             from public.data_subject_requests where id=%L$$, :'req_access'), 'fulfilled|true');
select dsr.try_hint('DI2 a closed row''s stamp cannot be moved',
  format($$update public.data_subject_requests set fulfilled_at = now() - interval '10 years' where id=%L$$, :'req_access'),
  'denied(22023:not_a_transition)');
select dsr.try_hint('DI3 ...NOT EVEN RIDING ON A SEAM WRITE -- the review''s attack',
  format($$update public.data_subject_requests
              set fulfilled_at = now() - interval '10 years', fulfilment_reference = gen_random_uuid()
            where id=%L$$, :'req_access'),
  'denied(42501:seam_write_moves_only_the_seam)');
select dsr.try_hint('DI4 a closed row takes no seam write at all',
  format($$update public.data_subject_requests set fulfilment_reference = gen_random_uuid() where id=%L$$, :'req_access'),
  'denied(22023:request_is_closed)');
select dsr.val('DI5 the closed row''s stamp is exactly what it was',
  format($$select (fulfilled_at::text = %L)::text from public.data_subject_requests where id=%L$$,
         :'closed_stamp', :'req_access'), 'true');
select dsr.try_hint('DI6 a "routing" with no transition cannot ride a seam write onto an OPEN row -- the review''s other attack',
  format($$update public.data_subject_requests
              set routed_at = now(), routed_to_organisation_id = %L, routed_to_organisation_name = 'x',
                  fulfilment_kind = 'export', fulfilment_reference = gen_random_uuid()
            where id=%L$$, :'alpha_org', :'req_di'),
  'denied(42501:seam_write_moves_only_the_seam)');
select dsr.try_hint('DI7 ...nor arrive on its own',
  format($$update public.data_subject_requests
              set routed_at = now(), routed_to_organisation_id = %L, routed_to_organisation_name = 'x'
            where id=%L$$, :'alpha_org', :'req_di'),
  'denied(22023:not_a_transition)');
select dsr.val('DI8 the open row is untouched by all of it',
  format($$select status || '|' || (routed_at is null)::text || '|' || (fulfilment_kind is null)::text
             from public.data_subject_requests where id=%L$$, :'req_di'), 'open|true|true');

-- ===========================================================================
-- § DO  THE ROUTED WORKSPACE (fix round 1: I4, I7/Q160)
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.try('DO1 SETUP: two processor-scope requests',
  $$select * from public.submit_data_subject_request('access','workspace_records','DO probe one.')
    union all
    select * from public.submit_data_subject_request('access','workspace_records','DO probe two.')$$, 'ok(2)');
reset role; reset request.jwt.claims;
\o /dev/null
select id::text as req_do1 from public.data_subject_requests where detail = 'DO probe one.' \gset
select id::text as req_do2 from public.data_subject_requests where detail = 'DO probe two.' \gset
\o

select dsr.try_hint('DO1a a request the platform does not fulfil ITSELF (workspace scope) takes no seam, even from the job''s path',
  format($$update public.data_subject_requests
              set fulfilment_kind='export', fulfilment_reference=gen_random_uuid() where id=%L$$, :'req_do2'),
  'denied(22023:fulfilment_kind_mismatch)');

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DO2 SETUP: the operator passes the first to org-alpha',
  format($$select * from public.route_data_subject_request(%L,%L,'Emailed alpha''s owner.')$$,
         :'req_do1', :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- THE HANDOVER NOTE IS THE DATABASE'S RULE, not the RPC's. A direct writer --
-- postgres, under the operator's session so the who-may-do-it check passes --
-- routes with no note, and the DEFERRED constraint trigger refuses the commit.
set request.jwt.claims = :'super_c';
select dsr.try_hint_commit('DO3 a routing with NO handover note does not commit, for a direct writer either (Q160a)',
  format($$update public.data_subject_requests set status='routed', routed_to_organisation_id=%L where id=%L$$,
         :'alpha_org', :'req_do2'),
  'denied(22023:routing_needs_handover_note)');
reset request.jwt.claims;
select dsr.val('DO4 ...and nothing was routed',
  format($$select status || '|' || (routed_at is null)::text from public.data_subject_requests where id=%L$$,
         :'req_do2'), 'open|true');

-- A WRONG WORKSPACE IS CORRECTABLE (Q160c).
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try_hint('DO5 the SAME workspace again is not a re-route',
  format($$select * from public.route_data_subject_request(%L,%L,'Again.')$$, :'req_do1', :'alpha_org'),
  'denied(22023:not_a_transition)');
select dsr.try('DO6 POSITIVE: the operator RE-ROUTES the routed request to org-beta',
  format($$select * from public.route_data_subject_request(%L,%L,'Alpha was the wrong business; emailed beta''s owner.')$$,
         :'req_do1', :'beta_org'), 'ok(1)');
reset role; reset request.jwt.claims;
select dsr.val('DO7 the row names org-beta now, still `routed`, with BOTH handover notes kept',
  format($$select (routed_to_organisation_id = %L)::text || '|' || (routed_to_organisation_name = %L)::text
                  || '|' || status || '|' ||
                  (select count(*) from public.data_subject_request_notes n where n.request_id = d.id)
             from public.data_subject_requests d where id=%L$$, :'beta_org', :'beta_name', :'req_do1'),
  'true|true|routed|2');
select dsr.val('DO8 the re-route is AUDITED as its own action, naming both workspaces and no names',
  format($$select (organisation_id = %L)::text || '|' || (before->>'routed_to_organisation_id' = %L)::text
                  || '|' || (after->>'routed_to_organisation_id' = %L)::text
                  || '|' || ((before::text || after::text) not like '%%' || %L || '%%')::text
             from public.audit_events
            where action = 'data_subject_request.rerouted' and target_id = %L$$,
         :'beta_org', :'alpha_org', :'beta_org', :'beta_name', :'req_do1'), 'true|true|true|true');
set request.jwt.claims = :'super_c';
select dsr.try_hint_commit('DO9 a RE-route with no handover note does not commit either',
  format($$update public.data_subject_requests set routed_to_organisation_id=%L where id=%L$$,
         :'alpha_org', :'req_do1'),
  'denied(22023:routing_needs_handover_note)');
reset request.jwt.claims;
set request.jwt.claims = :'pstd1_c';
select dsr.try_hint('DO10 the REQUESTER cannot re-route their own request (asked of the trigger, as DT13a is)',
  format($$update public.data_subject_requests set routed_to_organisation_id=%L where id=%L$$,
         :'alpha_org', :'req_do1'),
  'denied(42501:)');
reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.val('DO11 THE REQUESTER IS TOLD WHICH BUSINESS: the name is on their own row (Q160b)',
  format($$select routed_to_organisation_name from public.data_subject_requests where id=%L$$, :'req_do1'),
  :'beta_name');
reset role; reset request.jwt.claims;

-- I4. THE FOREIGN KEY'S OWN ON DELETE SET NULL CAN EXECUTE. As shipped, hard-
-- deleting a workspace that had ever been routed a request raised
-- `routed is not a transition`. A throwaway workspace, routed to and then
-- hard-deleted as postgres (its user triggers off, standing in for Task 6's
-- purge), all inside a transaction that is rolled back.
\o /dev/null
begin;
insert into public.organisations (id, name, slug)
values ('d5d5d5d5-0000-4000-8000-00000000d5d5', 'DSR Purge Probe Ltd', 'dsr-purge-probe');
set local role authenticated;
set local request.jwt.claims = :'super_c';
select dsr.outcome(format($$select * from public.route_data_subject_request(%L,
   'd5d5d5d5-0000-4000-8000-00000000d5d5','Emailed the probe workspace.')$$, :'req_do2')) as purge_routed \gset
reset role; reset request.jwt.claims;

-- FIRST the attack: a TRIGGER nulling the routing of a workspace that still
-- EXISTS is not the foreign key's action, whatever its depth.
create table public.dsr_probe_null_t (x int);
create function public.dsr_probe_null_f() returns trigger language plpgsql as
  $f$ begin update public.data_subject_requests set routed_to_organisation_id = null
             where detail = 'DO probe two.'; return new; end $f$;
create trigger dsr_probe_null_trg after insert on public.dsr_probe_null_t
  for each row execute function public.dsr_probe_null_f();
select dsr.outcome_rows($$insert into public.dsr_probe_null_t values (1)$$) as purge_live_refused \gset

alter table public.organisations disable trigger user;
select dsr.outcome_rows($$delete from public.organisations
                           where id = 'd5d5d5d5-0000-4000-8000-00000000d5d5'$$) as purge_deleted \gset
alter table public.organisations enable trigger user;
select status || '|' || (routed_to_organisation_id is null)::text || '|' || (routed_at is not null)::text
       || '|' || routed_to_organisation_name as purge_row
  from public.data_subject_requests where id = :'req_do2' \gset
rollback;
\o
select dsr.record('DO12 SETUP: the second request was routed to a throwaway workspace', 'ok', :'purge_routed');
select dsr.record('DO13 a TRIGGER nulling the routing of a workspace that still EXISTS is refused -- depth alone admits nothing',
  'denied(22023:not_a_transition)', :'purge_live_refused');
select dsr.record('DO14 I4 POSITIVE: the routed workspace can be HARD-DELETED -- its foreign key''s SET NULL executes',
  'ok(1)', :'purge_deleted');
select dsr.record('DO15 ...and the evidence survives the workspace: still routed, id nulled, routed_at and the NAME kept',
  'routed|true|true|DSR Purge Probe Ltd', :'purge_row');
select dsr.val('DO16 the throwaway workspace and its routing are gone with the rolled-back transaction',
  format($$select (select count(*) from public.organisations where slug = 'dsr-purge-probe')::text || '|' ||
                  (select status from public.data_subject_requests where id=%L)$$, :'req_do2'), '0|open');

-- ===========================================================================
-- § DN  OPERATOR NOTES -- Q103, THE WHOLE POINT
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DN1 POSITIVE: the operator adds a working note',
  format($$select public.add_data_subject_request_note(%L,
            'Checked the audit trail; nothing to disclose beyond the export.')$$, :'req_access'), 'ok(1)');
select dsr.val('DN2 POSITIVE: the operator can read it back',
  format($$select count(*)::text from public.data_subject_request_notes where request_id=%L$$, :'req_access'), '1');
select dsr.val('DN2a POSITIVE: the bounded COUNT read answers for the operator (M9)',
  format($$select note_count::text from public.data_subject_request_note_counts(array[%L]::uuid[])$$, :'req_access'), '1');
select dsr.val('DN2b POSITIVE: the per-request RECENT read returns the note''s body for the operator (M9)',
  format($$select (body like 'Checked the audit trail%%')::text
             from public.data_subject_request_recent_notes(array[%L]::uuid[], 5)$$, :'req_access'), 'true');
select dsr.val('DN2c PER REQUEST, not across the page: asked for ONE note each, two requests give two notes',
  format($$select count(*)::text from public.data_subject_request_recent_notes(array[%L,%L]::uuid[], 1)$$,
         :'req_access', :'req_do1'), '2');
select dsr.try_hint('DN2d more than 50 requests at a time is refused, not clamped',
  $$select * from public.data_subject_request_note_counts(
      (select array_agg(gen_random_uuid()) from generate_series(1,51)))$$, 'denied(22023:too_many_requests)');
select dsr.try_hint('DN2e more than 20 notes per request is refused, not clamped',
  format($$select * from public.data_subject_request_recent_notes(array[%L]::uuid[], 21)$$, :'req_access'),
  'denied(22023:per_request_out_of_range)');
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
select dsr.val('DN5a ...and the bounded COUNT read tells them nothing (it reads as the caller)',
  format($$select count(*)::text from public.data_subject_request_note_counts(array[%L]::uuid[])$$, :'req_access'), '0');
select dsr.val('DN5b ...nor does the RECENT read',
  format($$select count(*)::text from public.data_subject_request_recent_notes(array[%L]::uuid[], 20)$$, :'req_access'), '0');
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
-- § DX  THE DELETE GUARDS, AGAINST A TRIGGER'S DELETE (fix round 1, I2)
-- ===========================================================================
-- DW15 and DN9 ask a DELETE statement (depth 1). The shipped guards let ANY
-- delete through at pg_trigger_depth() >= 2 -- the consent ledger's PRE-fix
-- rule -- and the review emptied the register (3 -> 0) from a throwaway
-- table's trigger with the requester's account alive. The same attack, here.
\o /dev/null
select count(*)::text as reg_before   from public.data_subject_requests \gset
select count(*)::text as notes_before from public.data_subject_request_notes \gset
begin;
create table public.dsr_probe_del_t (x int);
create function public.dsr_probe_del_f() returns trigger language plpgsql as
  $f$ begin
        if new.x = 1 then delete from public.data_subject_requests; end if;
        if new.x = 2 then delete from public.data_subject_request_notes; end if;
        return new;
      end $f$;
create trigger dsr_probe_del_trg after insert on public.dsr_probe_del_t
  for each row execute function public.dsr_probe_del_f();
select dsr.outcome_rows($$insert into public.dsr_probe_del_t values (1)$$) as del_register \gset
select dsr.outcome_rows($$insert into public.dsr_probe_del_t values (2)$$) as del_notes \gset
select (select count(*) from public.data_subject_requests)::text || '|' ||
       (select count(*) from public.data_subject_request_notes)::text as del_after \gset

-- THE NOTES' CASCADE IS STILL ADMITTED when the parent really is gone, so the
-- refusal above is a judgement and not a blanket. No request can be deleted
-- today, so the register's own guard is switched off for this one statement
-- (the owner's escape hatch), standing in for the day Task 6's retention purge
-- re-issues it.
alter table public.data_subject_requests disable trigger data_subject_requests_delete_guard;
select dsr.outcome_rows(format($$delete from public.data_subject_requests where id=%L$$, :'req_access')) as del_cascade \gset
alter table public.data_subject_requests enable trigger data_subject_requests_delete_guard;
select count(*)::text as del_cascade_notes from public.data_subject_request_notes
 where request_id = :'req_access' \gset
rollback;
\o
select dsr.val('DX0 DENOMINATOR: there are requests AND notes to delete, and the requester''s account is alive',
  format($$select ((select count(*) from public.data_subject_requests) > 0)::text || '|' ||
                  ((select count(*) from public.data_subject_request_notes) > 0)::text || '|' ||
                  (select count(*) from auth.users where id=%L)$$, :'pstd1'), 'true|true|1');
select dsr.record('DX1 a TRIGGER''s delete of the register is refused -- the review''s attack',
  'denied(42501:register_rows_are_never_deleted)', :'del_register');
select dsr.record('DX2 a TRIGGER''s delete of the notes of LIVE requests is refused',
  'denied(42501:note_outlives_nothing_but_its_request)', :'del_notes');
select dsr.record('DX3 neither table lost a row to either',
  :'reg_before' || '|' || :'notes_before', :'del_after');
select dsr.record('DX4 POSITIVE: with the parent request really gone, the notes'' cascade IS admitted',
  'ok(1)|0', :'del_cascade' || '|' || :'del_cascade_notes');
select dsr.val('DX5 the rolled-back probe left the register guard ENABLED and both tables whole',
  format($$select (select tgenabled::text from pg_trigger
                    where tgrelid='public.data_subject_requests'::regclass
                      and tgname='data_subject_requests_delete_guard') || '|' ||
                  ((select count(*) from public.data_subject_requests)::text = %L)::text || '|' ||
                  ((select count(*) from public.data_subject_request_notes)::text = %L)::text$$,
         :'reg_before', :'notes_before'), 'O|true|true');

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
  'data_subject_request.note_added,data_subject_request.rerouted,'
  'data_subject_request.routed,'
  'data_subject_request.submitted,data_subject_request.withdrawn');
select dsr.val('DA1a the sessionless seam write (DF9j) wrote NO audit row of its own -- nobody acted, so nobody is named',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request' and action = 'data_subject_request.fulfilment_recorded'$$, '0');
select dsr.val('DA1b ...and the CLOSING audit row carries the fulfilment the operator relied on, so it is not lost',
  format($$select after->>'fulfilment_kind' || '|' || (after->>'fulfilment_reference' is not null)::text
             from public.audit_events
            where action='data_subject_request.fulfilled' and target_id=%L$$, :'req_access'), 'export|true');
select dsr.val('DA2 NO audit row carries what the requester wrote',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request'
       and (coalesce(before::text,'') || coalesce(after::text,'')) like '%Please send me everything%'$$, '0');
select dsr.val('DA2a DENOMINATOR: that search CAN see a submitted row (its `before` is NULL, and NULL || text is NULL)',
  $$select (count(*) > 0)::text from public.audit_events
     where target_type = 'data_subject_request' and action = 'data_subject_request.submitted'
       and (coalesce(before::text,'') || coalesce(after::text,'')) like '%detail_length%'$$, 'true');
select dsr.val('DA3 NO audit row carries a note''s body',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request'
       and (coalesce(before::text,'') || coalesce(after::text,'')) like '%nothing to disclose%'$$, '0');
select dsr.val('DA3a ...a handover note''s included',
  $$select count(*)::text from public.audit_events
     where target_type = 'data_subject_request'
       and (coalesce(before::text,'') || coalesce(after::text,'')) like '%Emailed%'$$, '0');
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
       (:'pstd2', 'pstd2@test.local', 'objection','account','DD overdue two', now() - interval '33 days'),
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
--
-- CLOSED AS REJECTED, NOT FULFILLED, SINCE PHASE 8 TASK 4. It is an
-- account-scope ACCESS request, and the export half of the fulfilment
-- constraint is awake (DF8), so `fulfilled` now needs an export job to have
-- run for this requester -- which is exactly the rule and not a bug. A
-- refusal is a closure too, and asserting BOTH here keeps the deadline
-- section honest about which one it used.
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try_hint('DD1a THE TASK 4 CONSTRAINT REACHES HERE: the operator cannot mark it ANSWERED, because no export ran',
  $$select * from public.transition_data_subject_request(
      (select id from public.data_subject_requests where detail='DD closed late'),'fulfilled')$$,
  'denied(22023:fulfilment_not_recorded)');
select dsr.try('DD1 SETUP: the operator closes the forty-day-old one, by REFUSING it with a reason',
  $$select * from public.transition_data_subject_request(
      (select id from public.data_subject_requests where detail='DD closed late'),'rejected',
      'Closed for the deadline-alert fixture.')$$, 'ok(1)');
reset role; reset request.jwt.claims;

select dsr.val('DD2 POSITIVE: the run writes an alert for each of the two overdue ones and the due-soon one',
  $$select private.raise_dsr_deadline_alerts()::text$$, '3');
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
select dsr.val('DD7 a second run writes nothing -- never two OPEN alerts for one request and stage',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');
select dsr.val('DD8 ...and that is a UNIQUE INDEX, not a not-exists check that two ticks could race',
  $$select count(*)::text from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'incident_alerts_dsr_stage_open_once_idx' and i.indisunique$$, '1');
select dsr.val('DD8a ...whose uniqueness is among UNRESOLVED alerts only (Q159) -- the shipped index had no such term',
  $$select (pg_get_indexdef(i.indexrelid) ~* 'resolved_at is null')::text
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'incident_alerts_dsr_stage_open_once_idx'$$, 'true');
select dsr.val('DD8b ...and the shipped once-ever index is gone',
  $$select count(*)::text from pg_class where relname = 'incident_alerts_dsr_stage_once_idx'$$, '0');
select dsr.val('DD9 no alert carries anything the requester wrote',
  $$select count(*)::text from public.incident_alerts
     where alert_type like 'dsr\_%' and (summary || details::text) like '%DD overdue%'$$, '0');
select dsr.val('DD10 the alerts are undelivered, so the existing digest picks them up',
  $$select count(*)::text from public.incident_alerts
     where alert_type like 'dsr\_%' and notified_at is not null$$, '0');

set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.val('DD11 the operator sees both on the health surface''s own read path',
  $$select count(*)::text from public.incident_alerts where alert_type like 'dsr\_%'$$, '3');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pstd1_c';
select dsr.val('DD12 an ordinary user sees no alert at all',
  $$select count(*)::text from public.incident_alerts$$, '0');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Q159 (fix round 1, I3): AN OVERDUE ALERT THAT IS RESOLVED COMES BACK WHILE
-- THE REQUEST IS STILL OPEN. As shipped: one Resolve click and an open request
-- 75 days overdue had zero unresolved alerts and nothing left to be emailed.
-- ---------------------------------------------------------------------------
\o /dev/null
select id::text as req_dd_overdue from public.data_subject_requests where detail = 'DD overdue' \gset
select id::text as req_dd_two     from public.data_subject_requests where detail = 'DD overdue two' \gset
select id::text as req_dd_soon    from public.data_subject_requests where detail = 'DD due soon' \gset
select id::text as alert_first from public.incident_alerts
 where alert_type = 'dsr_overdue' and details->>'request_id' = :'req_dd_overdue' \gset
select id::text as alert_soon from public.incident_alerts
 where alert_type = 'dsr_deadline_approaching' and details->>'request_id' = :'req_dd_soon' \gset
\o

-- The ordinary column-level UPDATE /super/health issues, as the operator.
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DD13 SETUP: the operator RESOLVES the overdue alert and the early warning from the health page',
  format($$update public.incident_alerts set resolved_at = now(), resolved_by = %L
            where id in (%L, %L)$$, :'super', :'alert_first', :'alert_soon'), 'ok(2)');
reset role; reset request.jwt.claims;
select dsr.val('DD14 DENOMINATOR: both requests are STILL OPEN, and the overdue one has no unresolved alert left',
  format($$select (select status from public.data_subject_requests where id=%L) || '|' ||
                  (select status from public.data_subject_requests where id=%L) || '|' ||
                  (select count(*) from public.incident_alerts
                    where alert_type='dsr_overdue' and details->>'request_id'=%L and resolved_at is null)$$,
         :'req_dd_overdue', :'req_dd_soon', :'req_dd_overdue'), 'open|open|0');
select dsr.val('DD15 a tick straight after the resolve writes nothing -- a resolve is a one-week SNOOZE',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');
select dsr.val('DD15a ...and the snooze is the number the database declares, in one place',
  $$select private.dsr_alert_reraise_days()::text$$, '7');

-- Eight days pass: the resolutions are aged, as postgres (the operator's
-- browser cannot back-date one -- the health page stamps now()).
update public.incident_alerts set resolved_at = now() - interval '8 days'
 where id in (:'alert_first', :'alert_soon');
select dsr.val('DD16 I3 POSITIVE: a week after the resolve, with the request still open, the overdue alert is RAISED AGAIN -- and ONLY it',
  $$select private.raise_dsr_deadline_alerts()::text$$, '1');
select dsr.val('DD17 the request has exactly ONE unresolved overdue alert, two in all, and the new one is undelivered so the digest emails it',
  format($$select count(*) filter (where resolved_at is null) || '|' || count(*) || '|' ||
                  count(*) filter (where resolved_at is null and notified_at is null)
             from public.incident_alerts
            where alert_type='dsr_overdue' and details->>'request_id'=%L$$, :'req_dd_overdue'), '1|2|1');
select dsr.val('DD18 the re-raised alert SAYS it was raised again, how late the request is, and nothing the requester wrote',
  format($$select (summary like '%%Raised AGAIN%%')::text || '|' || (summary like '%%OVERDUE by 1 day%%')::text
                  || '|' || (details->>'earlier_alerts') || '|' || (summary not like '%%DD overdue%%')::text
             from public.incident_alerts
            where alert_type='dsr_overdue' and details->>'request_id'=%L and resolved_at is null$$,
         :'req_dd_overdue'), 'true|true|1|true');
select dsr.val('DD19 the EARLY WARNING was not re-raised: it is one stage, written once per request',
  format($$select count(*)::text from public.incident_alerts
            where alert_type='dsr_deadline_approaching' and details->>'request_id'=%L$$, :'req_dd_soon'), '1');
select dsr.val('DD20 and the next tick writes nothing -- never two unresolved alerts for one request and stage',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');

-- ---------------------------------------------------------------------------
-- R1 (fix round 2, Q162): THE RESOLUTION CLOCK IS THE DATABASE'S.
--
-- Everything above hangs off `resolved_at`, and `authenticated` holds a
-- COLUMN-LEVEL UPDATE on it (20260919000000). Nothing pinned its VALUE: the
-- shape constraint says a resolution carries a timestamp, not which one. So a
-- resolution dated into the future was a permanent snooze -- the scoped
-- re-reviewer measured `open / 75 days overdue / 0 unresolved alerts`, the
-- original finding I3's sentence word for word -- and on the ordinary path
-- lib/admin/health-actions.ts was filling the column from the OPERATOR'S
-- BROWSER. 20260926000000 makes the guard overwrite it with now().
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DD20a SETUP: the operator reopens the early warning, so there is a live resolution to forge',
  format($$update public.incident_alerts set resolved_at = null, resolved_by = null where id = %L$$,
         :'alert_soon'), 'ok(1)');
select dsr.try('DD20b the operator resolves it and NAMES THE YEAR 2999 -- ACCEPTED, because the guard corrects rather than refuses',
  format($$update public.incident_alerts set resolved_at = timestamptz '2999-01-01', resolved_by = %L
            where id = %L$$, :'super', :'alert_soon'), 'ok(1)');
reset role; reset request.jwt.claims;
select dsr.val('DD20c ...and what LANDED is now(): a client session cannot buy itself a 973-year snooze from the Q159 re-raise',
  format($$select (resolved_at > now() - interval '1 minute')::text || '|' ||
                  (resolved_at < now() + interval '1 minute')::text || '|' ||
                  (date_part('year', resolved_at) <> 2999)::text
             from public.incident_alerts where id = %L$$, :'alert_soon'), 'true|true|true');
select dsr.val('DD20c2 ...so the snooze this resolution bought expires within the week Q159 declares, rather than in the year 3006',
  format($$select ((resolved_at + make_interval(days => private.dsr_alert_reraise_days()))
                    <= now() + make_interval(days => private.dsr_alert_reraise_days()))::text
             from public.incident_alerts where id = %L$$, :'alert_soon'), 'true');
-- DENOMINATOR. The column really does take a year-2999 value, and the write
-- above really was capable of landing one: it is the CLIENT path the guard
-- pins, and the system writers (row security inactive -> the early return)
-- keep stamping their own clock, which is what DD24 measures.
update public.incident_alerts set resolved_at = timestamptz '2999-01-01' where id = :'alert_soon';
select dsr.val('DD20d DENOMINATOR: the same write from a session the guard exempts DOES land 2999 -- so DD20c measures the pin, not the column',
  format($$select date_part('year', resolved_at)::int::text from public.incident_alerts where id = %L$$,
         :'alert_soon'), '2999');
update public.incident_alerts set resolved_at = now() where id = :'alert_soon';
select dsr.val('DD20e ...and with the resolution back at now(), the tick is silent again -- the snooze is a WEEK, and the week is measured from the database''s clock',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');

-- ---------------------------------------------------------------------------
-- M1: CLOSING A REQUEST RESOLVES ITS OPEN ALERTS -- ATTRIBUTED TO THE SYSTEM.
-- ---------------------------------------------------------------------------
select dsr.val('DD21 DENOMINATOR: each of the two overdue requests has an OPEN alert to resolve',
  format($$select (select count(*) from public.incident_alerts where alert_type='dsr_overdue'
                     and details->>'request_id'=%L and resolved_at is null) || '|' ||
                  (select count(*) from public.incident_alerts where alert_type='dsr_overdue'
                     and details->>'request_id'=%L and resolved_at is null)$$,
         :'req_dd_overdue', :'req_dd_two'), '1|1');
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select dsr.try('DD22 the REQUESTER withdraws the first overdue request',
  format($$select public.withdraw_data_subject_request(%L)$$, :'req_dd_overdue'), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DD23 the OPERATOR refuses the second, with a reason',
  format($$select * from public.transition_data_subject_request(%L,'rejected','Manifestly unfounded: DD fixture.')$$,
         :'req_dd_two'), 'ok(1)');
reset role; reset request.jwt.claims;
select dsr.val('DD24 both open alerts were resolved BY THE SYSTEM: a time, a reason, and NOBODY named',
  format($$select string_agg((resolved_at is not null)::text || ':' || (resolved_by is null)::text || ':' ||
                             coalesce(auto_resolved_reason,'-'), '|' order by details->>'request_id' = %L desc)
             from public.incident_alerts
            where alert_type='dsr_overdue' and details->>'request_id' in (%L, %L)
              and auto_resolved_reason is not null$$, :'req_dd_overdue', :'req_dd_overdue', :'req_dd_two'),
  'true:true:data_subject_request_closed|true:true:data_subject_request_closed');
select dsr.val('DD25 no unresolved DSR alert names a closed request any more',
  $$select count(*)::text from public.incident_alerts a
      join public.data_subject_requests d on d.id::text = a.details->>'request_id'
     where a.alert_type like 'dsr\_%' and a.resolved_at is null
       and d.status in ('fulfilled','rejected','withdrawn')$$, '0');
select dsr.val('DD26 DENOMINATOR: the operator''s OWN resolve (DD13) WAS audited as theirs...',
  format($$select count(*)::text from public.audit_events
            where action='incident_alert.resolved' and target_id=%L and actor_user_id=%L$$,
         :'alert_first', :'super'), '1');
select dsr.val('DD27 ...and the SYSTEM''s was audited as NOBODY''s: not the requester who withdrew, not the operator who refused',
  format($$select count(*)::text from public.audit_events e
            where e.action like 'incident_alert.%%'
              and e.target_id in (select id from public.incident_alerts
                                   where auto_resolved_reason is not null
                                     and details->>'request_id' in (%L, %L))$$,
         :'req_dd_overdue', :'req_dd_two'), '0');
set role authenticated;
set request.jwt.claims = :'super_c';
select dsr.try('DD28 a person cannot REOPEN a system resolution (the CHECK: a reason with no time)',
  $$update public.incident_alerts set resolved_at = null, resolved_by = null
     where auto_resolved_reason is not null$$, 'denied(23514)');
select dsr.try('DD29 ...nor CLAIM one as their own (the CHECK: a person AND a reason)',
  format($$update public.incident_alerts set resolved_by = %L where auto_resolved_reason is not null$$, :'super'),
  'denied(23514)');
reset role; reset request.jwt.claims;
select dsr.val('DD30 closed is closed: nothing more is ever raised for either, however much later',
  $$select private.raise_dsr_deadline_alerts()::text$$, '0');

-- ---------------------------------------------------------------------------
-- M3: THE TICK'S TWO HALVES ARE INDEPENDENT. As shipped the cron command was
-- two statements in one implicit transaction, so a raiser that threw would
-- also have stopped Phase 7's digest and the lockout notices.
-- ---------------------------------------------------------------------------
select dsr.try_hint('DD31 POSITIVE: the real tick runs clean (locally the delivery half is a true no-op: no Vault entries)',
  $$select private.run_incident_alert_tick()$$, 'ok');
\o /dev/null
begin;
create or replace function private.raise_dsr_deadline_alerts()
returns integer language plpgsql security definer set search_path = '' as
  $mut$ begin raise exception 'boom: DD overdue secret text' using errcode = 'P0001'; end $mut$;
create or replace function private.deliver_incident_alerts()
returns void language plpgsql security definer set search_path = '' as
  $mut$ begin perform pg_catalog.set_config('dsrprobe.delivered',
          (coalesce(nullif(pg_catalog.current_setting('dsrprobe.delivered', true), ''), '0')::int + 1)::text, true); end $mut$;
select dsr.outcome($$select private.run_incident_alert_tick()$$) as tick_survived \gset
select dsr.outcome($$select private.run_incident_alert_tick()$$) as tick_survived_twice \gset
select coalesce(current_setting('dsrprobe.delivered', true), '0') as tick_delivered \gset
select count(*) filter (where resolved_at is null) || '|' || count(*) || '|' ||
       bool_and(summary like '%P0001%')::text || '|' ||
       bool_and((summary || details::text) not like '%secret text%')::text as tick_failed_alert
  from public.incident_alerts where alert_type = 'dsr_alert_writer_failed' \gset
-- ...and it recovers: a raiser that runs cleanly closes that alert.
create or replace function private.raise_dsr_deadline_alerts()
returns integer language plpgsql security definer set search_path = '' as
  $mut$ begin return 0; end $mut$;
select dsr.outcome($$select private.run_incident_alert_tick()$$) as tick_recovered \gset
select count(*) filter (where resolved_at is null) || '|' ||
       coalesce(max(auto_resolved_reason), '-') || '|' || bool_and(resolved_by is null)::text as tick_recovered_alert
  from public.incident_alerts where alert_type = 'dsr_alert_writer_failed' \gset
rollback;
\o
select dsr.record('DD32 M3: a raiser that THROWS does not take the tick down, twice running',
  'ok|ok', :'tick_survived' || '|' || :'tick_survived_twice');
select dsr.record('DD33 M3 POSITIVE: the DIGEST half was still reached, on both ticks',
  '2', :'tick_delivered');
select dsr.record('DD34 the failure is NOT swallowed: exactly ONE writer-failed alert while it stays broken, carrying the SQLSTATE and never the error''s text',
  '1|1|true|true', :'tick_failed_alert');
select dsr.record('DD35 ...and the next clean run resolves it, as the system', 'ok', :'tick_recovered');
select dsr.record('DD36 ...reason alert_writer_recovered, nobody named',
  '0|alert_writer_recovered|true', :'tick_recovered_alert');
select dsr.val('DD37 the real raiser and the real digest are back after the rollback',
  $$select (position('boom' in (select prosrc from pg_proc where oid='private.raise_dsr_deadline_alerts()'::regprocedure)) = 0)::text
           || '|' ||
           (position('net.http_post' in (select prosrc from pg_proc where oid='private.deliver_incident_alerts()'::regprocedure)) > 0)::text$$,
  'true|true');

-- ===========================================================================
-- § DZ  HOUSEKEEPING
-- ===========================================================================
\o /dev/null
set session_replication_role = replica;
delete from public.audit_events where target_type = 'data_subject_request';
delete from public.audit_events e
 where e.target_type = 'incident_alert'
   and e.target_id in (select a.id from public.incident_alerts a where a.alert_type like 'dsr\_%');
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
