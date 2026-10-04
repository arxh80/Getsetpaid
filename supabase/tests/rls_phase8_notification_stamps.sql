-- ===========================================================================
-- PHASE 8 TASK 9b, JOB 2 -- THE DSR, EXPORT AND ERASURE NOTIFICATION SEAMS
-- (20261015000000; founder 2026-09-30, Q157(3)/Q174/Q45).
--
-- Four delivery stamps, each "stamp only after ok:true" (the sender's half is
-- proved in tests/unit/email/requester-notifications.test.ts). What this suite
-- proves is the database half -- that NOBODY BUT THE SENDER can move a stamp,
-- and that the sender can move it only the one honest way:
--
--   NG  the grants: no client role holds UPDATE on any stamp; service_role
--       holds UPDATE on exactly the four
--   NC  a real client session (the requester, and the aal2 superuser) is
--       refused
--   NS  the stamp guard: positive controls, then server-only, written once,
--       moves alone, right state, the database's clock
--   NT  the table guards still run for every update that is not a stamp
--   NR  recipient resolution: service_role only, the CURRENT auth address
--       (never the snapshot), the tombstone excluded, no archive key returned
--   NZ  housekeeping
--
-- Self-contained: it creates its own requester and rows with triggers
-- disabled (session_replication_role = replica -- the fixture shape, not a
-- path any client has) and removes them at the end.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ns cascade;
create schema ns;

create table ns.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ns.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ns.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function ns.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text; v_hint text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    -- A missing privilege and a guard both answer 42501; the hint tells them
    -- apart, so a refusal by the grant is recorded as exactly that.
    if v_hint like 'Grant the required privileges%' then v_hint := 'missing_grant'; end if;
    v_actual := 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
  perform ns.record(p_label, p_expected, v_actual);
end $$;

create function ns.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform ns.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema ns to authenticated, anon, service_role;
grant execute on function ns.record(text,text,text) to authenticated, anon, service_role;
grant execute on function ns.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function ns.val(text,text,text)    to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- FIXTURES
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as req_user \gset
select gen_random_uuid()::text as sup_user \gset
select gen_random_uuid()::text as dsr_open \gset
select gen_random_uuid()::text as dsr_closed \gset
select gen_random_uuid()::text as dsr_erased \gset
select gen_random_uuid()::text as exp_done \gset
select gen_random_uuid()::text as exp_queued \gset
select gen_random_uuid()::text as era_failed \gset
select gen_random_uuid()::text as era_queued \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'req_user', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'ns-current@test.local', now(), now(), now());

set session_replication_role = replica;
insert into public.data_subject_requests
  (id, user_id, user_email, right_type, subject_scope, detail, status, requested_at)
values
  (:'dsr_open',   :'req_user', 'ns-snapshot@test.local', 'access', 'account', 'ns', 'open', now()),
  (:'dsr_erased', private.erased_user_id(), '[erased]', 'erasure', 'account', '[erased]', 'open', now());
insert into public.data_subject_requests
  (id, user_id, user_email, right_type, subject_scope, detail, status, requested_at, withdrawn_at)
values
  (:'dsr_closed', :'req_user', 'ns-snapshot@test.local', 'access', 'account', 'ns', 'withdrawn', now(), now());
insert into public.export_jobs
  (id, kind, requested_by, status, started_at, completed_at, expires_at, storage_key,
   byte_size, row_count, table_count, manifest)
values
  (:'exp_done', 'account', :'req_user', 'succeeded', now(), now(), now() + interval '7 days',
   'exports/' || :'exp_done' || '.zip', 10, 1, 1, '{}'::jsonb);
insert into public.export_jobs (id, kind, requested_by, status)
values (:'exp_queued', 'account', :'req_user', 'queued');
insert into public.erasure_jobs
  (id, kind, subject_user_id, requested_by, status, started_at, completed_at, failure_reason)
values
  (:'era_failed', 'account', :'req_user', :'req_user', 'failed', now(), now(), 'ns fixture');
insert into public.erasure_jobs (id, kind, subject_user_id, requested_by, status)
values (:'era_queued', 'account', null, null, 'queued');
set session_replication_role = origin;

\set req_c '{"sub":"':req_user'","role":"authenticated","aal":"aal1"}'

-- ---------------------------------------------------------------------------
-- NG  THE GRANTS
-- ---------------------------------------------------------------------------
select ns.val('NG1 no client role holds UPDATE on any delivery stamp',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema='public'
       and table_name in ('data_subject_requests','export_jobs','erasure_jobs')
       and column_name like '%notified_at'
       and privilege_type='UPDATE' and grantee in ('anon','authenticated','PUBLIC')$$, '0');
select ns.val('NG2 service_role holds UPDATE on exactly the four stamps',
  $$select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name)
      from information_schema.column_privileges
     where table_schema='public'
       and table_name in ('data_subject_requests','export_jobs','erasure_jobs')
       and column_name like '%notified_at'
       and privilege_type='UPDATE' and grantee='service_role'$$,
  'data_subject_requests.closed_notified_at,data_subject_requests.received_notified_at,'
  'export_jobs.ready_notified_at');
select ns.val('NG2a erasure_jobs'' stamp has NO column grant (its CHECK makes a direct UPDATE 42501) -- its one path is the service_role-only RPC',
  $$select (not has_column_privilege('service_role','public.erasure_jobs','failure_notified_at','UPDATE')
        and has_function_privilege('service_role','public.mark_erasure_failures_notified(uuid[])','EXECUTE')
        and not has_function_privilege('authenticated','public.mark_erasure_failures_notified(uuid[])','EXECUTE')
        and not has_function_privilege('anon','public.mark_erasure_failures_notified(uuid[])','EXECUTE'))::text$$,
  'true');
select ns.val('NG3 the two resolution functions are executable by service_role and by no client role',
  $$select string_agg(p.proname || ':' ||
        has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' ||
        has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
        has_function_privilege('service_role', p.oid, 'EXECUTE')::text, ';' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('pending_dsr_notifications','pending_export_ready_notifications')$$,
  'pending_dsr_notifications:false/false/true;pending_export_ready_notifications:false/false/true');
select ns.val('NG4 the stamp guard is not callable by anybody',
  $$select (has_function_privilege('service_role','private.notification_stamp_guard()','EXECUTE')
         or has_function_privilege('authenticated','private.notification_stamp_guard()','EXECUTE'))::text$$,
  'false');

-- ---------------------------------------------------------------------------
-- NC  A CLIENT SESSION CANNOT STAMP -- the requester, on their own rows.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'req_c';
select ns.val('NC0 the requester can READ their own request (so the refusals below are about the write)',
  format($$select count(*)::text from public.data_subject_requests where id = %L$$, :'dsr_open'), '1');
select ns.try('NC1 the requester cannot stamp received_notified_at',
  format($$update public.data_subject_requests set received_notified_at = now() where id = %L$$, :'dsr_open'),
  'denied(42501:missing_grant)');
select ns.try('NC2 ...nor closed_notified_at',
  format($$update public.data_subject_requests set closed_notified_at = now() where id = %L$$, :'dsr_closed'),
  'denied(42501:missing_grant)');
select ns.try('NC3 ...nor ready_notified_at on their own export',
  format($$update public.export_jobs set ready_notified_at = now() where id = %L$$, :'exp_done'),
  'denied(42501:missing_grant)');
select ns.try('NC4 ...nor failure_notified_at on their own erasure job',
  format($$update public.erasure_jobs set failure_notified_at = now() where id = %L$$, :'era_failed'),
  'denied(42501:missing_grant)');
select ns.try('NC4a ...nor through the sender''s RPC',
  format($$select public.mark_erasure_failures_notified(array[%L]::uuid[])$$, :'era_failed'),
  'denied(42501)');
select ns.try('NC5 ...nor call the resolver for anybody''s address',
  $$select * from public.pending_dsr_notifications(30)$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- NR  RECIPIENT RESOLUTION -- before anything is stamped.
-- ---------------------------------------------------------------------------
set role service_role;
select ns.val('NR1 the open request is owed a RECEIVED notice, to the CURRENT address (not the snapshot)',
  format($$select string_agg(notice || '=' || email, ',' order by notice)
             from public.pending_dsr_notifications(30) where request_id = %L$$, :'dsr_open'),
  'received=ns-current@test.local');
select ns.val('NR2 the withdrawn request is owed RECEIVED and CLOSED',
  format($$select string_agg(notice, ',' order by notice)
             from public.pending_dsr_notifications(30) where request_id = %L$$, :'dsr_closed'),
  'closed,received');
select ns.val('NR3 the tombstone''s request is owed NOTHING (the tombstone has an address of its own)',
  format($$select count(*)::text from public.pending_dsr_notifications(30) where request_id = %L$$, :'dsr_erased'),
  '0');
select ns.val('NR4 the snapshot address is never a recipient',
  $$select count(*)::text from public.pending_dsr_notifications(30) where email = 'ns-snapshot@test.local'$$, '0');
select ns.val('NR5 the succeeded export is owed a READY notice to the requester; the queued one is not',
  format($$select string_agg(job_id::text || '=' || email, ',')
             from public.pending_export_ready_notifications(30) where job_id in (%L, %L)$$,
         :'exp_done', :'exp_queued'),
  :'exp_done' || '=ns-current@test.local');
select ns.val('NR6 the export resolver returns no archive key and no URL',
  $$select (pg_get_function_result('public.pending_export_ready_notifications(integer)'::regprocedure)
            ~* 'storage|url|key|manifest')::text$$, 'false');
select ns.val('NR7 the resolvers are bounded at 30 rows whatever the caller asks for',
  $$select (pg_get_functiondef('public.pending_dsr_notifications(integer)'::regprocedure)
              like '%least(coalesce(p_limit, 30), 30)%'
        and pg_get_functiondef('public.pending_export_ready_notifications(integer)'::regprocedure)
              like '%least(coalesce(p_limit, 30), 30)%')::text$$, 'true');
reset role;
select ns.val('NR3a ...and the tombstone really does have one, so NR3 is the exclusion and not an empty join',
  $$select (email is not null)::text from auth.users where id = private.erased_user_id()$$, 'true');

-- ---------------------------------------------------------------------------
-- NS  THE STAMP GUARD
-- ---------------------------------------------------------------------------
set role service_role;
select ns.try('NS1 service_role stamps received_notified_at (positive control)',
  format($$update public.data_subject_requests set received_notified_at = '2000-01-01'
            where id = %L and received_notified_at is null$$, :'dsr_open'), 'ok(1)');
select ns.try('NS2 service_role stamps closed_notified_at on a CLOSED request',
  format($$update public.data_subject_requests set closed_notified_at = now()
            where id = %L and closed_notified_at is null$$, :'dsr_closed'), 'ok(1)');
select ns.try('NS3 service_role stamps ready_notified_at on a SUCCEEDED export (a finished row)',
  format($$update public.export_jobs set ready_notified_at = now()
            where id = %L and ready_notified_at is null$$, :'exp_done'), 'ok(1)');
select ns.val('NS4 service_role stamps failure_notified_at on a FAILED erasure through the RPC -- only the failed one of the two ids',
  format($$select public.mark_erasure_failures_notified(array[%L, %L]::uuid[])::text$$, :'era_failed', :'era_queued'), '1');
select ns.val('NS4a ...and a second call stamps nothing (written once)',
  format($$select public.mark_erasure_failures_notified(array[%L]::uuid[])::text$$, :'era_failed'), '0');
reset role;
select ns.val('NS5 the stamp is the DATABASE''s clock -- the caller''s 2000-01-01 was overwritten',
  format($$select (received_notified_at > now() - interval '1 hour')::text
             from public.data_subject_requests where id = %L$$, :'dsr_open'), 'true');
select ns.val('NS6 the stamped rows have left the queues',
  format($$select ((select count(*) from public.pending_dsr_notifications(30) where request_id in (%L, %L)) = 1
               and (select count(*) from public.pending_dsr_notifications(30)
                     where request_id = %L and notice = 'received') = 1
               and (select count(*) from public.pending_export_ready_notifications(30) where job_id = %L) = 0)::text$$,
         :'dsr_open', :'dsr_closed', :'dsr_closed', :'exp_done'), 'true');

set role service_role;
select ns.try('NS7 a stamp is written ONCE: re-stamping is refused',
  format($$update public.data_subject_requests set received_notified_at = now() + interval '1 day' where id = %L$$, :'dsr_open'),
  'denied(22023:notification_stamp_is_written_once)');
select ns.try('NS8 ...and clearing it (the un-stamp a retry would need) is refused',
  format($$update public.export_jobs set ready_notified_at = null where id = %L$$, :'exp_done'),
  'denied(22023:notification_stamp_is_written_once)');
select ns.try('NS9 a stamp on a request that is NOT closed is refused',
  format($$update public.data_subject_requests set closed_notified_at = now() where id = %L$$, :'dsr_open'),
  'denied(22023:notification_stamp_wrong_state)');
select ns.try('NS10 ...a READY stamp on an export that has not succeeded',
  format($$update public.export_jobs set ready_notified_at = now() where id = %L$$, :'exp_queued'),
  'denied(22023:notification_stamp_wrong_state)');
select ns.try('NS12 a stamp moves ALONE: stamp + the fulfilment seam in one update is refused',
  format($$update public.data_subject_requests set received_notified_at = now(),
            fulfilment_kind = 'export', fulfilment_reference = %L where id = %L$$, :'exp_done', :'dsr_closed'),
  'denied(22023:notification_stamp_moves_alone)');
reset role;
-- As postgres (the owner, a server session): the grant is no longer the
-- control, so these are the guard's own refusals.
select ns.try('NS13 even the owner cannot ride a stamp past a finished job''s guard',
  format($$update public.export_jobs set failure_reason = 'x', ready_notified_at = null where id = %L$$, :'exp_done'),
  'denied(22023:notification_stamp_is_written_once)');
select ns.try('NS14 ...nor stamp and rewrite in one update',
  format($$update public.erasure_jobs set failure_notified_at = now(), failure_reason = 'rewritten'
            where id = %L$$, :'era_queued'),
  'denied(22023:notification_stamp_moves_alone)');
select ns.try('NS11 ...a FAILURE stamp on an erasure that has not failed (as the owner: service_role has no direct path to this table at all, NG2a)',
  format($$update public.erasure_jobs set failure_notified_at = now() where id = %L$$, :'era_queued'),
  'denied(22023:notification_stamp_wrong_state)');
set role authenticated;
set request.jwt.claims = :'req_c';
select ns.val('NS15 a client session that DID hold the grant would still be refused by the guard (body check)',
  $$select (pg_get_functiondef('private.notification_stamp_guard()'::regprocedure)
              like '%(select auth.uid()) is not null%notification_stamp_is_server_only%')::text$$, 'true');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- NT  THE TABLE GUARDS STILL RUN FOR EVERYTHING THAT IS NOT A STAMP
-- ---------------------------------------------------------------------------
select ns.try('NT1 a finished export is still not rewritten (the guard ran)',
  format($$update public.export_jobs set byte_size = 11 where id = %L$$, :'exp_done'),
  'denied(22023:export_job_is_finished)');
select ns.try('NT2 a finished erasure job is still not rewritten',
  format($$update public.erasure_jobs set failure_reason = 'rewritten' where id = %L$$, :'era_failed'),
  'denied(22023:erasure_job_is_finished)');
select ns.try('NT3 a no-op update still reaches the register''s guard, as before',
  format($$update public.data_subject_requests set status = status where id = %L$$, :'dsr_open'),
  'denied(22023:not_a_transition)');
select ns.val('NT4 each table guard skips ONLY when a stamp moves (its WHEN names the stamps and nothing else)',
  $$select string_agg(tgname || '=' || (pg_get_triggerdef(oid) ~ 'WHEN \(+NOT \(old\.[a-z_]+notified_at IS DISTINCT FROM')::text,
                      ',' order by tgname)
      from pg_trigger
     where tgname in ('data_subject_requests_before_update','export_jobs_before_update','erasure_jobs_before_update')$$,
  'data_subject_requests_before_update=true,erasure_jobs_before_update=true,export_jobs_before_update=true');
select ns.val('NT5 every stamp has its own guard trigger, enabled',
  $$select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
     where tgname like '%\_stamp\_%' and tgrelid in
       ('public.data_subject_requests'::regclass,'public.export_jobs'::regclass,'public.erasure_jobs'::regclass)$$,
  'data_subject_requests_stamp_closed:O,data_subject_requests_stamp_received:O,erasure_jobs_stamp_failure:O,export_jobs_stamp_ready:O');

-- ---------------------------------------------------------------------------
-- NZ  HOUSEKEEPING
-- ---------------------------------------------------------------------------
set session_replication_role = replica;
delete from public.data_subject_requests where id in (:'dsr_open', :'dsr_closed', :'dsr_erased');
delete from public.export_jobs  where id in (:'exp_done', :'exp_queued');
delete from public.erasure_jobs where id in (:'era_failed', :'era_queued');
delete from public.profiles where id = :'req_user';
delete from auth.users where id = :'req_user';
set session_replication_role = origin;
select ns.val('NZ1 the fixtures are gone',
  format($$select ((select count(*) from public.data_subject_requests where id in (%L,%L,%L))
                 + (select count(*) from public.export_jobs where id in (%L,%L))
                 + (select count(*) from public.erasure_jobs where id in (%L,%L))
                 + (select count(*) from auth.users where id = %L))::text$$,
         :'dsr_open', :'dsr_closed', :'dsr_erased', :'exp_done', :'exp_queued',
         :'era_failed', :'era_queued', :'req_user'), '0');

select label, expected, actual, pass from ns.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ns.results;
