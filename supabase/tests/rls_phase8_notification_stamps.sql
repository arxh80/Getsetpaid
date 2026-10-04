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
--   NL  (job 3, 20261016000000) the connection-request / task-reminder
--       ledger, private.notification_deliveries: no grant to anybody, the
--       sender's RPC only, written once, never updated, db clock, right state
--   NX  (job 3) recipients: the requested org's active owners/admins, the
--       sender or the fallback, a reminder only for a live, open, due task to
--       its CURRENT active assignee, and no private column returned
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

-- ===========================================================================
-- JOB 3 (20261016000000): THE CONNECTION-REQUEST AND TASK-REMINDER STAMPS.
--
--   NL  the ledger (private.notification_deliveries): nobody but the sender's
--       RPC writes it, once, to the db clock, never updated, only for a
--       subject in the state its email is about
--   NX  recipient and content resolution: the right org's owners/admins, the
--       sender (or the fallback), active members only; a reminder only for a
--       live, open, due, assigned task -- its CURRENT assignee
-- ===========================================================================
\o /dev/null
select gen_random_uuid()::text as oa \gset
select gen_random_uuid()::text as ob \gset
select gen_random_uuid()::text as ua_owner \gset
select gen_random_uuid()::text as ua_sender \gset
select gen_random_uuid()::text as ua_left \gset
select gen_random_uuid()::text as ub_owner \gset
select gen_random_uuid()::text as ub_admin \gset
select gen_random_uuid()::text as ub_manager \gset
select gen_random_uuid()::text as ub_revoked \gset
select gen_random_uuid()::text as pa \gset
select gen_random_uuid()::text as pb1 \gset
select gen_random_uuid()::text as pb2 \gset
select gen_random_uuid()::text as pb3 \gset
select gen_random_uuid()::text as r_pend \gset
select gen_random_uuid()::text as r_acc \gset
select gen_random_uuid()::text as r_dec \gset
select gen_random_uuid()::text as r_dec_left \gset
select gen_random_uuid()::text as r_old \gset
select gen_random_uuid()::text as t_due \gset
select gen_random_uuid()::text as t_due2 \gset
select gen_random_uuid()::text as t_done \gset
select gen_random_uuid()::text as t_cancelled \gset
select gen_random_uuid()::text as t_deleted \gset
select gen_random_uuid()::text as t_future \gset
select gen_random_uuid()::text as t_unassigned \gset
select gen_random_uuid()::text as t_left \gset
select gen_random_uuid()::text as t_old \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select v.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, now(), now(), now()
  from (values (:'ua_owner', 'nl-a-owner@test.local'), (:'ua_sender', 'nl-a-sender@test.local'),
               (:'ua_left', 'nl-a-left@test.local'), (:'ub_owner', 'nl-b-owner@test.local'),
               (:'ub_admin', 'nl-b-admin@test.local'), (:'ub_manager', 'nl-b-manager@test.local'),
               (:'ub_revoked', 'nl-b-revoked@test.local')) v(id, email);

set session_replication_role = replica;
insert into public.organisations (id, name, slug) values
  (:'oa', 'NL Org A', 'nl-a-' || left(:'oa', 8)), (:'ob', 'NL Org B', 'nl-b-' || left(:'ob', 8));
insert into public.organisation_memberships (organisation_id, user_id, role, status)
values (:'oa', :'ua_owner', 'owner', 'active'), (:'oa', :'ua_sender', 'manager', 'active'),
       (:'oa', :'ua_left', 'manager', 'revoked'),
       (:'ob', :'ub_owner', 'owner', 'active'), (:'ob', :'ub_admin', 'admin', 'active'),
       (:'ob', :'ub_manager', 'manager', 'active'), (:'ob', :'ub_revoked', 'admin', 'revoked');
insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, status, display_name, published_at)
values (:'pa',  :'oa', 'venue', gen_random_uuid(), 'published', 'NL Sender Venue', now()),
       (:'pb1', :'ob', 'venue', gen_random_uuid(), 'published', 'NL Receiver One', now()),
       (:'pb2', :'ob', 'venue', gen_random_uuid(), 'published', 'NL Receiver Two', now()),
       (:'pb3', :'ob', 'venue', gen_random_uuid(), 'published', 'NL Receiver Three', now());
insert into public.network_connection_requests
  (id, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id,
   status, requested_by, responded_by, requested_at, responded_at)
values
  (:'r_pend',     :'oa', :'pa', :'ob', :'pb1', 'pending',  :'ua_sender', null, now(), null),
  (:'r_acc',      :'oa', :'pa', :'ob', :'pb2', 'accepted', :'ua_sender', :'ub_admin', now(), now()),
  (:'r_dec',      :'oa', :'pa', :'ob', :'pb1', 'declined', :'ua_sender', :'ub_admin', now(), now()),
  (:'r_dec_left', :'oa', :'pa', :'ob', :'pb1', 'declined', :'ua_left',   :'ub_admin', now(), now()),
  (:'r_old',      :'oa', :'pa', :'ob', :'pb3', 'pending',  :'ua_sender', null, now() - interval '8 days', null);
insert into public.tasks (id, organisation_id, owner_user_id, title, detail, status, reminder_at, completed_at, deleted_at)
values
  (:'t_due',        :'oa', :'ua_sender', 'NL due',        'NL PRIVATE DETAIL', 'open', now() - interval '1 hour', null, null),
  (:'t_due2',       :'oa', :'ua_sender', 'NL due two',    null, 'in_progress', now() - interval '1 hour', null, null),
  (:'t_done',       :'oa', :'ua_sender', 'NL done',       null, 'done',        now() - interval '1 hour', now(), null),
  (:'t_cancelled',  :'oa', :'ua_sender', 'NL cancelled',  null, 'cancelled',   now() - interval '1 hour', null, null),
  (:'t_deleted',    :'oa', :'ua_sender', 'NL deleted',    null, 'open',        now() - interval '1 hour', null, now()),
  (:'t_future',     :'oa', :'ua_sender', 'NL future',     null, 'open',        now() + interval '1 day',  null, null),
  (:'t_unassigned', :'oa', null,         'NL unassigned', null, 'open',        now() - interval '1 hour', null, null),
  (:'t_left',       :'oa', :'ua_left',   'NL left',       null, 'open',        now() - interval '1 hour', null, null),
  (:'t_old',        :'oa', :'ua_sender', 'NL old',        null, 'open',        now() - interval '8 days', null, null);
set session_replication_role = origin;

\set uas_c '{"sub":"':ua_sender'","role":"authenticated","aal":"aal1"}'

-- ---------------------------------------------------------------------------
-- NL  THE LEDGER'S GRANTS AND WRITE PATH
-- ---------------------------------------------------------------------------
select ns.val('NL1 no client role and not service_role holds ANY privilege on the ledger',
  $$select coalesce(string_agg(r || ':' || p, ',' order by r, p), 'none') from
      (values ('anon'),('authenticated'),('service_role')) g(r)
      cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) q(p)
     where has_table_privilege(r, 'private.notification_deliveries', p)$$, 'none');
select ns.val('NL2 the stamp RPC and both resolvers are executable by service_role and by no client role',
  $$select string_agg(p.proname || ':' ||
        has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' ||
        has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
        has_function_privilege('service_role', p.oid, 'EXECUTE')::text, ';' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('mark_notices_delivered','pending_connection_request_notifications',
                         'pending_task_reminder_notifications')$$,
  'mark_notices_delivered:false/false/true;pending_connection_request_notifications:false/false/true;'
  'pending_task_reminder_notifications:false/false/true');
select ns.val('NL3 the ledger guard is not callable by anybody',
  $$select (has_function_privilege('service_role','private.notification_delivery_guard()','EXECUTE')
         or has_function_privilege('authenticated','private.notification_delivery_guard()','EXECUTE'))::text$$,
  'false');

set role authenticated;
set request.jwt.claims = :'uas_c';
select ns.val('NL4 the sender can READ their task (so the refusals below are about the write)',
  format($$select count(*)::text from public.tasks where id = %L$$, :'t_due'), '1');
select ns.try('NL5 a member cannot stamp through the RPC',
  format($$select public.mark_notices_delivered('task_reminder', array[%L]::uuid[])$$, :'t_due'),
  'denied(42501)');
select ns.try('NL6 ...nor write the ledger directly',
  format($$insert into private.notification_deliveries (notice, task_id) values ('task_reminder', %L)$$, :'t_due'),
  'denied(42501:missing_grant)');
select ns.try('NL7 ...nor ask the reminder resolver for anybody''s address',
  $$select * from public.pending_task_reminder_notifications(30)$$, 'denied(42501)');
select ns.try('NL7a ...nor the connection resolver',
  $$select * from public.pending_connection_request_notifications(30)$$, 'denied(42501)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- NX  RECIPIENTS AND CONTENT -- before anything is stamped.
-- ---------------------------------------------------------------------------
set role service_role;
select ns.val('NX1 RECEIVED goes to the requested org''s active owner and admin -- not its manager, not a revoked admin, nobody in the sending org',
  format($$select array_to_string(emails, ',') || '|' || organisation_slug || '|' || counterparty_name
             from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_pend'),
  'nl-b-admin@test.local,nl-b-owner@test.local|nl-b-' || left(:'ob', 8) || '|NL Sender Venue');
select ns.val('NX2 ACCEPTED goes to the sender alone, links the SENDING org, and names the requested profile',
  format($$select notice || '|' || array_to_string(emails, ',') || '|' || organisation_slug || '|' || counterparty_name
             from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_acc'),
  'connection_accepted|nl-a-sender@test.local|nl-a-' || left(:'oa', 8) || '|NL Receiver Two');
select ns.val('NX3 DECLINED goes to the sender alone',
  format($$select notice || '|' || array_to_string(emails, ',')
             from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_dec'),
  'connection_declined|nl-a-sender@test.local');
select ns.val('NX4 ...and to the sending org''s owners/admins when the sender has left it',
  format($$select array_to_string(emails, ',')
             from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_dec_left'),
  'nl-a-owner@test.local');
select ns.val('NX5 a request older than the seven-day window is owed nothing',
  format($$select count(*)::text from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_old'),
  '0');
select ns.val('NX6 the connection resolver returns exactly five columns -- no organisation name, no member, no responder, no profile field',
  $$select string_agg(a, ',' order by n) from unnest(
      (select proargnames from pg_proc where proname = 'pending_connection_request_notifications'))
      with ordinality u(a, n) where a <> 'p_limit'$$,
  'request_id,notice,emails,organisation_slug,counterparty_name');
select ns.val('NX7 a reminder is owed for each live, open, due, assigned task, to its assignee',
  format($$select string_agg(email || '|' || title, ',' order by title)
             from public.pending_task_reminder_notifications(30) where task_id in (%L, %L)$$, :'t_due', :'t_due2'),
  'nl-a-sender@test.local|NL due,nl-a-sender@test.local|NL due two');
select ns.val('NX8 NO reminder for a done, cancelled, deleted, future, unassigned, departed-assignee or stale task',
  format($$select count(*)::text from public.pending_task_reminder_notifications(30)
            where task_id in (%L,%L,%L,%L,%L,%L,%L)$$,
         :'t_done', :'t_cancelled', :'t_deleted', :'t_future', :'t_unassigned', :'t_left', :'t_old'),
  '0');
select ns.val('NX9 the task resolver returns no detail column',
  $$select string_agg(a, ',' order by n) from unnest(
      (select proargnames from pg_proc where proname = 'pending_task_reminder_notifications'))
      with ordinality u(a, n) where a <> 'p_limit'$$,
  'task_id,email,organisation_slug,title,due_at');
reset role;

-- A REASSIGNMENT before the reminder fires: away to a departed member -> not
-- owed; to the owner -> owed to the OWNER.
set session_replication_role = replica;
update public.tasks set owner_user_id = :'ua_left' where id = :'t_due2';
set session_replication_role = origin;
set role service_role;
select ns.val('NX10 a task reassigned to somebody who is not an active member is not reminded',
  format($$select count(*)::text from public.pending_task_reminder_notifications(30) where task_id = %L$$, :'t_due2'), '0');
reset role;
set session_replication_role = replica;
update public.tasks set owner_user_id = :'ua_owner' where id = :'t_due2';
update public.network_profiles set status = 'draft', published_at = null where id = :'pb2';
set session_replication_role = origin;
set role service_role;
select ns.val('NX11 ...and reassigned to the owner, it is the OWNER who is reminded',
  format($$select email from public.pending_task_reminder_notifications(30) where task_id = %L$$, :'t_due2'),
  'nl-a-owner@test.local');
select ns.val('NX12 an UNPUBLISHED counterparty is not named at all',
  format($$select coalesce(counterparty_name, '<none>') from public.pending_connection_request_notifications(30)
            where request_id = %L$$, :'r_acc'), '<none>');

-- ---------------------------------------------------------------------------
-- NL (cont.)  STAMPING, as the sender
-- ---------------------------------------------------------------------------
select ns.val('NL8 the sender stamps a pending request''s RECEIVED notice: 1',
  format($$select public.mark_notices_delivered('connection_received', array[%L]::uuid[])::text$$, :'r_pend'), '1');
select ns.val('NL9 ...and a second stamp is a no-op: 0 (written once)',
  format($$select public.mark_notices_delivered('connection_received', array[%L]::uuid[])::text$$, :'r_pend'), '0');
select ns.val('NL10 ...after which the RECEIVED notice is no longer owed',
  format($$select count(*)::text from public.pending_connection_request_notifications(30) where request_id = %L$$, :'r_pend'), '0');
select ns.val('NL11 RIGHT STATE: an ACCEPTED stamp on a still-PENDING request lands on nothing (it cannot silence a future email)',
  format($$select public.mark_notices_delivered('connection_accepted', array[%L]::uuid[])::text$$, :'r_pend'), '0');
select ns.val('NL12 RIGHT STATE: a reminder stamp on a done, a deleted or a not-yet-due task lands on nothing',
  format($$select public.mark_notices_delivered('task_reminder', array[%L,%L,%L]::uuid[])::text$$,
         :'t_done', :'t_deleted', :'t_future'), '0');
select ns.val('NL13 a live, due task''s reminder stamps: 1',
  format($$select public.mark_notices_delivered('task_reminder', array[%L]::uuid[])::text$$, :'t_due'), '1');
select ns.val('NL13a ...and is then not owed (while its sibling still is)',
  format($$select string_agg(task_id::text, ',') from public.pending_task_reminder_notifications(30)
            where task_id in (%L, %L)$$, :'t_due', :'t_due2'), :'t_due2');
select ns.try('NL14 an unknown notice is refused by name',
  format($$select public.mark_notices_delivered('connection_ignored', array[%L]::uuid[])$$, :'r_pend'),
  'denied(22023:notification_notice_unknown)');
reset role;

select ns.val('NL15 the ledger holds exactly the two stamps written, each on the database''s clock',
  format($$select string_agg(notice || ':' || (notified_at > now() - interval '5 minutes')::text, ',' order by notice)
             from private.notification_deliveries where request_id = %L or task_id = %L$$, :'r_pend', :'t_due'),
  'connection_received:true,task_reminder:true');
select ns.try('NL16 even the owner cannot UPDATE a stamp (never cleared or rewritten)',
  format($$update private.notification_deliveries set notified_at = now() where task_id = %L$$, :'t_due'),
  'denied(22023:notification_stamp_is_written_once)');
select ns.try('NL17 a direct server insert with a chosen time is admitted...',
  format($$insert into private.notification_deliveries (notice, request_id, notified_at)
             values ('connection_declined', %L, '2000-01-01')$$, :'r_dec'), 'ok(1)');
select ns.val('NL17a ...on the database''s clock, not the one it named',
  format($$select (notified_at > '2001-01-01')::text from private.notification_deliveries where request_id = %L$$, :'r_dec'),
  'true');
select ns.try('NL18 the ledger''s one-subject CHECK refuses a reminder row naming a request',
  format($$insert into private.notification_deliveries (notice, request_id) values ('task_reminder', %L)$$, :'r_acc'),
  'denied(23514)');
select ns.val('NL19 both ledger guards are present and enabled',
  $$select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) from pg_trigger
     where tgrelid = 'private.notification_deliveries'::regclass and not tgisinternal$$,
  'notification_deliveries_guard_insert:O,notification_deliveries_guard_update:O');
select ns.val('NL20 the tenant tables are NOT altered: no *notified* column on tasks or connection requests',
  $$select count(*)::text from information_schema.columns
     where table_schema = 'public' and table_name in ('tasks','network_connection_requests')
       and column_name like '%notified%'$$, '0');

-- Job-3 housekeeping: the ledger rows go explicitly, because the fixture
-- deletes run in replica mode, where the FK cascade does not fire.
set session_replication_role = replica;
delete from private.notification_deliveries
 where request_id in (:'r_pend', :'r_acc', :'r_dec', :'r_dec_left', :'r_old')
    or task_id in (:'t_due', :'t_due2', :'t_done', :'t_cancelled', :'t_deleted', :'t_future',
                   :'t_unassigned', :'t_left', :'t_old');
delete from public.tasks where organisation_id in (:'oa', :'ob');
delete from public.network_connection_requests where from_organisation_id in (:'oa', :'ob');
delete from public.network_profiles where organisation_id in (:'oa', :'ob');
delete from public.organisation_memberships where organisation_id in (:'oa', :'ob');
delete from public.organisations where id in (:'oa', :'ob');
delete from public.profiles where id in (:'ua_owner', :'ua_sender', :'ua_left', :'ub_owner', :'ub_admin', :'ub_manager', :'ub_revoked');
delete from auth.users where id in (:'ua_owner', :'ua_sender', :'ua_left', :'ub_owner', :'ub_admin', :'ub_manager', :'ub_revoked');
set session_replication_role = origin;
select ns.val('NL21 the job-3 fixtures are gone',
  format($$select ((select count(*) from public.organisations where id in (%L,%L))
                 + (select count(*) from auth.users where id in (%L,%L))
                 + (select count(*) from private.notification_deliveries where request_id = %L or task_id = %L))::text$$,
         :'oa', :'ob', :'ua_sender', :'ub_admin', :'r_pend', :'t_due'), '0');

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
