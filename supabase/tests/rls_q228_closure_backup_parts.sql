-- ===========================================================================
-- Q228 -- A CLOSURE BACKUP OF ANY SIZE, IN PARTS (founder 2026-10-10).
--
-- Task 1 (20261101000000_closure_backup_parts.sql):
--   QT  the parts table and the job columns: shape, constraints, grants
--   QR  who reads a part, and the forged writes a client cannot make
--   QG  the part guard: server only, closure only, running only, in order,
--       never deleted while its backup is kept, and the cascade
--   QJ  the job transitions: the closure-only re-queue, the part count on a
--       success (never on a failure), and the queue's fairness
--   QK  the stuck-job reaper never fails a healthy multi-part backup
--   QE  the Owner's erasure still waits for a backup with parts stored
--
-- Task 3 (20261101001000_closure_backup_parts_download_and_purge.sql):
--   QD  the per-part download audit: the part check, the IDOR term, the
--       payload, and that a refusal writes nothing
--   QX  a delete without a succeeded backup (spec section 7)
--   QO  Q229 holds the purge until EVERY part is downloaded by the requester
--   QM  the retention manifest: every part of an expired backup is named, no
--       part of a kept or re-queued one is, and a failed one's parts are
--       orphans
--
-- Final review I1 (20261101002000_closure_backup_stops_when_reopened.sql):
--   QV  a closure backup's reads stop once the workspace is reopened or its
--       closer is no longer an Owner; a 'deleted' workspace still reads
--
--   QZ  housekeeping
--
-- Every scenario that must leave nothing behind runs inside qp.undo() or
-- qp.sc(): the statements execute in a subtransaction that is then rolled
-- back by a sentinel, and the outcome travels out in a variable (the RW5a
-- pattern, without a psql-level transaction whose record() row could vanish
-- with it). Re-runnable on one database: every fixture is a fresh uuid, and
-- QZ removes them.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists qp cascade;
create schema qp;

create table qp.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function qp.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into qp.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

-- The text of a refusal: SQLSTATE, then the hint (or, for a CHECK/unique
-- violation with no hint, the constraint's name, so a refusal by the WRONG
-- constraint is red).
create function qp.denied(p_state text, p_hint text, p_constraint text)
returns text language sql immutable set search_path = '' as $$
  select 'denied(' || p_state
         || coalesce(':' || case when p_hint like 'Grant the required privileges%' then 'missing_grant'
                                 else coalesce(nullif(p_hint, ''), nullif(p_constraint, '')) end, '')
         || ')';
$$;

-- Runs p_sql and records its single text result, or denied(...).
create function qp.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text; v_con text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    v_actual := qp.denied(sqlstate, v_hint, v_con);
  end;
  perform qp.record(p_label, p_expected, v_actual);
end $$;

-- One statement, no result: `ok` when it ran, denied(...) when it raised.
-- A SELECT step returns its value instead of `ok`.
create function qp.t(p_sql text)
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v text; v_hint text; v_con text;
begin
  begin
    if pg_catalog.lower(pg_catalog.ltrim(p_sql)) like 'select%' then
      execute p_sql into v;
      return coalesce(v, '<null>');
    end if;
    execute p_sql;
    return 'ok';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    return qp.denied(sqlstate, v_hint, v_con);
  end;
end $$;

-- PERSISTENT: runs p_sql and keeps what it did.
create function qp.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  perform qp.record(p_label, p_expected, qp.t(p_sql));
end $$;

-- A SCENARIO, UNDONE: each step runs in order (its outcome, `ok` or its
-- value or its refusal, joined with `|`), and the whole is then rolled back
-- by a sentinel, so the scenario's writes -- and any GUC it set locally --
-- are gone and only its outcome survives.
create function qp.sc_text(p_steps text[])
returns text language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_out text := ''; v_s text; v_hint text; v_con text;
begin
  begin
    foreach v_s in array p_steps loop
      v_out := v_out || case when v_out = '' then '' else '|' end || qp.t(v_s);
    end loop;
    raise exception using errcode = 'P0001', message = 'qp_undo';
  exception when others then
    if sqlerrm = 'qp_undo' then return v_out; end if;
    get stacked diagnostics v_hint = pg_exception_hint, v_con = constraint_name;
    return v_out || '|' || qp.denied(sqlstate, v_hint, v_con);
  end;
end $$;

create function qp.sc(p_label text, p_steps text[], p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  perform qp.record(p_label, p_expected, qp.sc_text(p_steps));
end $$;

-- One statement, UNDONE: `ok` (it would have landed) or its refusal.
create function qp.undo(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
begin
  perform qp.record(p_label, p_expected, qp.sc_text(array[p_sql]));
end $$;

grant usage on schema qp to authenticated, anon, service_role;
grant execute on all functions in schema qp to authenticated, anon, service_role;
create table qp.ids (k text primary key, v text);
grant select, insert on qp.ids to authenticated;

-- ---------------------------------------------------------------------------
-- FIXTURES (as postgres, no claims = a server session, unless stated)
--   P (Starter): Owner P (aal2), Admin P2, Manager P3. Closed -> J.
--   Q: Owner Q.
--   R: Owner R. Closed -> J2, built to SUCCESS in two parts.
--   S: Owner S, Admin S2. Closed -> J3 (the transitions; then, for Task 3,
--      finished as a SUCCEEDED 3-part backup in the legal order).
--   T: Owner T. Closed -> J4 (the legacy success; the failure with a part).
--   K: Owner P's ordinary SUCCEEDED account export (plantReadyAccountExport).
--   O: Admin P2's ordinary QUEUED account export.
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as owner_p \gset
select gen_random_uuid()::text as admin_p2 \gset
select gen_random_uuid()::text as mgr_p3  \gset
select gen_random_uuid()::text as owner_q \gset
select gen_random_uuid()::text as owner_r \gset
select gen_random_uuid()::text as owner_s \gset
select gen_random_uuid()::text as owner_t \gset
select gen_random_uuid()::text as admin_s2 \gset
select gen_random_uuid()::text as su_u    \gset
select gen_random_uuid()::text as org_p   \gset
select gen_random_uuid()::text as org_q   \gset
select gen_random_uuid()::text as org_r   \gset
select gen_random_uuid()::text as org_s   \gset
select gen_random_uuid()::text as org_t   \gset
select 'qp-p-' || left(:'org_p', 8) as slug_p \gset
select 'qp-r-' || left(:'org_r', 8) as slug_r \gset
select 'qp-s-' || left(:'org_s', 8) as slug_s \gset
select 'qp-t-' || left(:'org_t', 8) as slug_t \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_p')  as owner_p_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'admin_p2') as admin_p2_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'mgr_p3')   as mgr_p3_c   \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_q')  as owner_q_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_r')  as owner_r_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_s')  as owner_s_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_t')  as owner_t_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'admin_s2') as admin_s2_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'su_u')     as su_c       \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'owner_p'::uuid,  'qp-owner-p-'  || :'owner_p'  || '@test.local'),
               (:'admin_p2'::uuid, 'qp-admin-p2-' || :'admin_p2' || '@test.local'),
               (:'mgr_p3'::uuid,   'qp-mgr-p3-'   || :'mgr_p3'   || '@test.local'),
               (:'owner_q'::uuid,  'qp-owner-q-'  || :'owner_q'  || '@test.local'),
               (:'owner_r'::uuid,  'qp-owner-r-'  || :'owner_r'  || '@test.local'),
               (:'owner_s'::uuid,  'qp-owner-s-'  || :'owner_s'  || '@test.local'),
               (:'owner_t'::uuid,  'qp-owner-t-'  || :'owner_t'  || '@test.local'),
               (:'admin_s2'::uuid, 'qp-admin-s2-' || :'admin_s2' || '@test.local'),
               (:'su_u'::uuid,     'qp-su-'       || :'su_u'     || '@test.local')) v(u, e);
-- The aal2 platform superuser of QX/QO (the workspace closure suite's CH1).
insert into public.platform_admins (user_id) values (:'su_u');

insert into public.organisations (id, name, slug) values
  (:'org_p', 'Parts P', :'slug_p'),
  (:'org_q', 'Parts Q', 'qp-q-' || left(:'org_q', 8)),
  (:'org_r', 'Parts R', :'slug_r'),
  (:'org_s', 'Parts S', :'slug_s'),
  (:'org_t', 'Parts T', :'slug_t');
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, 'starter', 'monthly', 3, 'active', now() + interval '30 days'
  from unnest(array[:'org_p', :'org_q', :'org_r', :'org_s', :'org_t']::uuid[]) o
on conflict (organisation_id) do update set plan_id = 'starter', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_p', :'owner_p',  'owner',   'active', now()),
  (:'org_p', :'admin_p2', 'admin',   'active', now()),
  (:'org_p', :'mgr_p3',   'manager', 'active', now()),
  (:'org_q', :'owner_q',  'owner',   'active', now()),
  (:'org_r', :'owner_r',  'owner',   'active', now()),
  (:'org_s', :'owner_s',  'owner',   'active', now()),
  (:'org_s', :'admin_s2', 'admin',   'active', now()),
  (:'org_t', :'owner_t',  'owner',   'active', now());

-- The closure backups, each made by its Owner closing the workspace under
-- aal2 claims (tests/e2e/support/fixtures.ts plantOwnerClosedWorkspace).
set role authenticated;
set request.jwt.claims = :'owner_p_c';
insert into qp.ids select 'j',  public.close_my_workspace(:'org_p', :'slug_p', 'qp closing')::text;
set request.jwt.claims = :'owner_r_c';
insert into qp.ids select 'j2', public.close_my_workspace(:'org_r', :'slug_r', 'qp closing')::text;
set request.jwt.claims = :'owner_s_c';
insert into qp.ids select 'j3', public.close_my_workspace(:'org_s', :'slug_s', 'qp closing')::text;
set request.jwt.claims = :'owner_t_c';
insert into qp.ids select 'j4', public.close_my_workspace(:'org_t', :'slug_t', 'qp closing')::text;
reset role;
reset request.jwt.claims;
select v as j  from qp.ids where k = 'j'  \gset
select v as j2 from qp.ids where k = 'j2' \gset
select v as j3 from qp.ids where k = 'j3' \gset
select v as j4 from qp.ids where k = 'j4' \gset

-- K: an ordinary account export of Owner P's, SUCCEEDED the
-- plantReadyAccountExport way. O: Admin P2's, left QUEUED.
set request.jwt.claims = :'owner_p_c';
with x as (insert into public.export_jobs (kind) values ('account') returning id) insert into qp.ids select 'k', id::text from x;
set request.jwt.claims = :'admin_p2_c';
with x as (insert into public.export_jobs (kind) values ('account') returning id) insert into qp.ids select 'o', id::text from x;
reset request.jwt.claims;
select v as k from qp.ids where k = 'k' \gset
select v as o from qp.ids where k = 'o' \gset
update public.export_jobs set status = 'running' where id = :'k';
update public.export_jobs
   set status = 'succeeded', storage_key = 'exports/' || id::text || '.zip', byte_size = 22, row_count = 0,
       table_count = 0, manifest = '{}'::jsonb
 where id = :'k';

-- J2: built to success in the legal order -- claim, part 1, re-queue, claim,
-- part 2, succeed with part_count 2.
update public.export_jobs set status = 'running' where id = :'j2';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j2', 1, 'exports/' || :'j2' || '.zip', 100, 10);
update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = :'j2';
update public.export_jobs set status = 'running' where id = :'j2';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j2', 2, 'exports/' || :'j2' || '-part-0002.zip', 100, 10);
update public.export_jobs
   set status = 'succeeded', part_count = 2, resume_cursor = null,
       storage_key = 'exports/' || id::text || '.zip', byte_size = 200, row_count = 20,
       table_count = 1, manifest = '{}'::jsonb
 where id = :'j2';

-- J: parts 1 and 2 in the same legal order, left RUNNING at part_count 1
-- (part 2 stored, its re-queue not yet made).
update public.export_jobs set status = 'running' where id = :'j';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j', 1, 'exports/' || :'j' || '.zip', 100, 10);
update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = :'j';
update public.export_jobs set status = 'running' where id = :'j';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j', 2, 'exports/' || :'j' || '-part-0002.zip', 100, 10);

-- ===========================================================================
-- § QV A CLOSURE BACKUP STOPS WHEN ITS WORKSPACE IS REOPENED (final review
--      I1, Q242). J is RUNNING here (part 2 stored), in P, which Owner P
--      closed. Every probe is undone. (The claims steps are spelled out:
--      qp.as_person()/qp.as_server() are defined further down, with QD.)
-- ===========================================================================
select qp.undo('QV1 DENOMINATOR: J reads while P is closed and Owner P is an active Owner',
  format($$select coalesce(jsonb_typeof(public.export_read_page(%L, 'contacts', '', 5)), 'null')$$, :'j'),
  'array');
select qp.sc('QV2 the aal2 superuser reassigns P to Admin P2 (undone): J''s next read is closure_backup_workspace_reopened',
  array[format($f$select pg_catalog.set_config('request.jwt.claims', %L, true) is not null$f$, :'su_c'),
        'set local role authenticated',
        format($$select (public.reassign_closed_workspace(%L, %L, 'qp reopening') is not null)::text$$, :'slug_p', :'admin_p2')]
  || array['reset role', $f$select pg_catalog.set_config('request.jwt.claims', '', true) is not null$f$,
           format($$select coalesce(jsonb_typeof(public.export_read_page(%L, 'contacts', '', 5)), 'null')$$, :'j')],
  'true|ok|true|ok|true|denied(55000:closure_backup_workspace_reopened)');
select qp.sc('QV3 Owner P is no longer an Owner (planted, undone): J''s next read is closure_backup_requester_not_owner',
  array['set local session_replication_role = replica',
        format($$update public.organisation_memberships set role = 'admin' where organisation_id = %L and user_id = %L$$, :'org_p', :'owner_p'),
        'set local session_replication_role = origin',
        format($$select coalesce(jsonb_typeof(public.export_read_page(%L, 'contacts', '', 5)), 'null')$$, :'j')],
  'ok|ok|ok|denied(55000:closure_backup_requester_not_owner)');
select qp.sc('QV4 Owner P''s membership is revoked (planted, undone): the same refusal',
  array['set local session_replication_role = replica',
        format($$update public.organisation_memberships set status = 'revoked' where organisation_id = %L and user_id = %L$$, :'org_p', :'owner_p'),
        'set local session_replication_role = origin',
        format($$select coalesce(jsonb_typeof(public.export_read_page(%L, 'contacts', '', 5)), 'null')$$, :'j')],
  'ok|ok|ok|denied(55000:closure_backup_requester_not_owner)');
select qp.sc('QV5 the superuser DELETES P, no backup acknowledged (undone): ''deleted'' is still closed, so J still reads',
  array[format($f$select pg_catalog.set_config('request.jwt.claims', %L, true) is not null$f$, :'su_c'),
        'set local role authenticated',
        format($$select (public.delete_closed_workspace(%L, 'qp deleting', true) is not null)::text$$, :'slug_p')]
  || array['reset role', $f$select pg_catalog.set_config('request.jwt.claims', '', true) is not null$f$,
           format($$select lifecycle_state from public.organisations where id = %L$$, :'org_p'),
           format($$select coalesce(jsonb_typeof(public.export_read_page(%L, 'contacts', '', 5)), 'null')$$, :'j')],
  'true|ok|true|ok|true|deleted|array');

-- ===========================================================================
-- § QT THE SHAPE AND THE GRANTS
-- ===========================================================================
select qp.val('QT1 public.export_job_parts exists with RLS on',
  $$select relrowsecurity::text from pg_class where oid = 'public.export_job_parts'::regclass$$, 'true');
select qp.val('QT2a the primary key is (job_id, part_no)',
  $$select string_agg(a.attname, ',' order by k.ord)
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.conrelid = 'public.export_job_parts'::regclass and c.contype = 'p'$$, 'job_id,part_no');
select qp.val('QT2b the one FK is to export_jobs(id), ON DELETE CASCADE',
  $$select string_agg(c.confrelid::regclass::text || ':' || c.confdeltype::text, ',')
      from pg_constraint c where c.conrelid = 'public.export_job_parts'::regclass and c.contype = 'f'$$,
  'public.export_jobs:c');
select qp.val('QT3 authenticated holds SELECT and no INSERT/UPDATE/DELETE/TRUNCATE, at table or column level',
  $$select has_table_privilege('authenticated', 'public.export_job_parts', 'SELECT')::text || '/' ||
           (select count(*) from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
             where has_table_privilege('authenticated', 'public.export_job_parts', p))::text || '/' ||
           (select count(*) from unnest(array['INSERT','UPDATE']) p
             where has_any_column_privilege('authenticated', 'public.export_job_parts', p))::text$$,
  'true/0/0');
select qp.val('QT4 anon holds nothing at all (table or column)',
  $$select ((select count(*) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
             where has_table_privilege('anon', 'public.export_job_parts', p))
          + (select count(*) from unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p
             where has_any_column_privilege('anon', 'public.export_job_parts', p)))::text$$, '0');
select qp.val('QT5 service_role holds SELECT, INSERT, DELETE -- and no UPDATE (any column) and no TRUNCATE',
  $$select string_agg(has_table_privilege('service_role', 'public.export_job_parts', p)::text, ',' order by o) || '/' ||
           has_any_column_privilege('service_role', 'public.export_job_parts', 'UPDATE')::text || '/' ||
           has_table_privilege('service_role', 'public.export_job_parts', 'TRUNCATE')::text
      from unnest(array['SELECT','INSERT','DELETE']) with ordinality u(p, o)$$, 'true,true,true/false/false');

-- The CHECKs, reached directly: `replica` turns the guard off (a BEFORE
-- trigger runs ahead of a CHECK and would refuse first), never a CHECK.
select qp.sc('QT6a part_no 0 is refused by export_job_parts_part_no',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 0, 'exports/' || %L || '.zip', 1, 1)$$, :'j', :'j')],
  'ok|denied(23514:export_job_parts_part_no)');
select qp.sc('QT6b a part n >= 2 (part 3) carrying part 1''s key is refused by export_job_parts_storage_key_shape',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 3, 'exports/' || %L || '.zip', 1, 1)$$, :'j', :'j')],
  'ok|denied(23514:export_job_parts_storage_key_shape)');
select qp.sc('QT6c part 1 carrying a -part-0001 suffix is refused by export_job_parts_storage_key_shape',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 1, 'exports/' || %L || '-part-0001.zip', 1, 1)$$, :'k', :'k')],
  'ok|denied(23514:export_job_parts_storage_key_shape)');
select qp.sc('QT6d a negative byte_size is refused by export_job_parts_counts',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 3, 'exports/' || %L || '-part-0003.zip', -1, 1)$$, :'j', :'j')],
  'ok|denied(23514:export_job_parts_counts)');
select qp.sc('QT6e POSITIVE CONTROL: the same row with a valid key and counts lands (then undone)',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 3, 'exports/' || %L || '-part-0003.zip', 0, 0)$$, :'j', :'j')],
  'ok|ok');
-- QT7: the pad never TRUNCATES. One row with part_no 12345, not 12 345 rows.
select qp.sc('QT7a part 12345 is keyed -part-12345 (accepted by the CHECK)',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 12345, 'exports/' || %L || '-part-12345.zip', 1, 1)$$, :'j', :'j')],
  'ok|ok');
select qp.sc('QT7b ...and NOT -part-1234 (lpad truncation is refused by the CHECK)',
  array['set local session_replication_role = replica',
        format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 12345, 'exports/' || %L || '-part-1234.zip', 1, 1)$$, :'j', :'j')],
  'ok|denied(23514:export_job_parts_storage_key_shape)');
select qp.val('QT7c the CHECK''s own expression: 12345 -> -part-12345, 7 -> -part-0007',
  $$select (select pg_get_constraintdef(c.oid) like '%GREATEST(4, length((part_no)::text))%'
              from pg_constraint c where c.conname = 'export_job_parts_storage_key_shape')::text || '/' ||
           (select string_agg('exports/x-part-' || lpad(n::text, greatest(4, length(n::text)), '0') || '.zip', ',' order by n)
              from unnest(array[7, 12345]) n)$$,
  'true/exports/x-part-0007.zip,exports/x-part-12345.zip');

-- QT8: export_jobs_part_count_shape.
select qp.sc('QT8a part_count < 0 is refused by export_jobs_part_count_shape',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set part_count = -1 where id = %L$$, :'j')],
  'ok|denied(23514:export_jobs_part_count_shape)');
select qp.sc('QT8b part_count > 0 on a non-closure job is refused',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set part_count = 1 where id = %L$$, :'o')],
  'ok|denied(23514:export_jobs_part_count_shape)');
select qp.sc('QT8c a resume_cursor on a non-closure (queued) job is refused',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set resume_cursor = '{"v":1}' where id = %L$$, :'o')],
  'ok|denied(23514:export_jobs_part_count_shape)');
select qp.sc('QT8d a resume_cursor on a SUCCEEDED closure job is refused',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set resume_cursor = '{"v":1}' where id = %L$$, :'j2')],
  'ok|denied(23514:export_jobs_part_count_shape)');
select qp.sc('QT8e POSITIVE CONTROL: a resume_cursor and part_count 1 on a RUNNING closure job are admitted',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set resume_cursor = '{"v":2}', part_count = 2 where id = %L$$, :'j')],
  'ok|ok');
select qp.val('QT9 authenticated holds no INSERT/UPDATE on part_count or resume_cursor; service_role holds UPDATE on both',
  $$select string_agg(has_column_privilege('authenticated', 'public.export_jobs', c, p)::text, ',' order by c, p) || '/' ||
           (select string_agg(has_column_privilege('service_role', 'public.export_jobs', c2, 'UPDATE')::text, ',' order by c2)
              from unnest(array['part_count','resume_cursor']) c2)
      from unnest(array['part_count','resume_cursor']) c, unnest(array['INSERT','UPDATE']) p$$,
  'false,false,false,false/true,true');

-- ===========================================================================
-- § QR WHO READS A PART, AND THE FORGED WRITES (J holds parts 1 and 2)
-- ===========================================================================
select qp.val('QR0 FIXTURE: J is a running closure backup at part_count 1 with parts 1 and 2 stored; J2 succeeded with 2',
  format($$select (select status || ':' || part_count || ':' || closure_backup from public.export_jobs where id = %L) || '/' ||
                  (select string_agg(part_no::text, ',' order by part_no) from public.export_job_parts where job_id = %L) || '/' ||
                  (select status || ':' || part_count from public.export_jobs where id = %L) || '/' ||
                  (select count(*) from public.export_job_parts where job_id = %L)$$, :'j', :'j', :'j2', :'j2'),
  'running:1:true/1,2/succeeded:2/2');
select qp.val('QR0b FIXTURE: a part''s created_at is the database''s (stamped by the guard)',
  format($$select bool_and(created_at <= now() and created_at > now() - interval '10 minutes')::text
             from public.export_job_parts where job_id = %L$$, :'j'), 'true');

set role authenticated;
set request.jwt.claims = :'owner_p_c';
select qp.val('QR1 Owner P (the requester) reads exactly J''s two parts, and nothing else',
  format($$select count(*) filter (where job_id = %L)::text || '/' || count(*)::text from public.export_job_parts$$, :'j'),
  '2/2');
select qp.undo('QR5a a forged INSERT as Owner P is refused (no grant)',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 3, 'exports/' || %L || '-part-0003.zip', 1, 1)$$, :'j', :'j'),
  'denied(42501:missing_grant)');
select qp.undo('QR5b a forged UPDATE as Owner P is refused (no grant)',
  format($$update public.export_job_parts set byte_size = 0 where job_id = %L$$, :'j'),
  'denied(42501:missing_grant)');
select qp.undo('QR5c a forged DELETE as Owner P is refused (no grant)',
  format($$delete from public.export_job_parts where job_id = %L$$, :'j'),
  'denied(42501:missing_grant)');
set request.jwt.claims = :'admin_p2_c';
select qp.val('QR2 Admin P2 of the SAME workspace reads none of them (an archive is one person''s snapshot)',
  $$select count(*)::text from public.export_job_parts$$, '0');
set request.jwt.claims = :'mgr_p3_c';
select qp.val('QR2b Manager P3 of the same workspace reads none either',
  $$select count(*)::text from public.export_job_parts$$, '0');
set request.jwt.claims = :'owner_q_c';
select qp.val('QR3 Owner Q (another workspace) reads none',
  $$select count(*)::text from public.export_job_parts$$, '0');
set request.jwt.claims = :'owner_r_c';
select qp.val('QR3b POSITIVE CONTROL: Owner R reads J2''s two parts (the policy admits a requester)',
  format($$select count(*) filter (where job_id = %L)::text || '/' || count(*)::text from public.export_job_parts$$, :'j2'),
  '2/2');
reset role;
reset request.jwt.claims;
set role anon;
select qp.val('QR4 anon is refused outright',
  $$select count(*)::text from public.export_job_parts$$, 'denied(42501:missing_grant)');
reset role;
select qp.val('QR5d the forged writes changed nothing: J still holds 2 parts, unchanged',
  format($$select count(*)::text || ':' || sum(byte_size)::text from public.export_job_parts where job_id = %L$$, :'j'),
  '2:200');

-- ===========================================================================
-- § QG THE PART GUARD
-- ===========================================================================
-- QG1: the guard binds a person's session even where a grant would let the
-- write through. INSERT is LENT to authenticated inside a transaction that is
-- rolled back (rls_phase9_integrations.sql IT14): a BEFORE ROW trigger fires
-- ahead of the RLS WITH CHECK, so the refusal measured is the guard's.
begin;
grant insert on public.export_job_parts to authenticated;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', :'owner_p_c', true) \gset
select qp.val('QG1 an INSERT under Owner P''s claims (INSERT lent) is refused by the guard: server only',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 2, 'exports/' || %L || '-part-0002.zip', 1, 1) returning 'written'$$, :'j', :'j'),
  'denied(42501:export_part_is_server_only)');
reset role;
select label as qg1_label, expected as qg1_expected, actual as qg1_actual from qp.results where label like 'QG1 %' \gset
rollback;
select qp.record(:'qg1_label', :'qg1_expected', :'qg1_actual');

select qp.undo('QG2 a part for K (an ordinary account export) is refused: closure only',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 1, 'exports/' || %L || '.zip', 1, 1)$$, :'k', :'k'),
  'denied(22023:export_parts_are_closure_only)');
select qp.undo('QG2b ...and for O (ordinary, queued) the same',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 1, 'exports/' || %L || '.zip', 1, 1)$$, :'o', :'o'),
  'denied(22023:export_parts_are_closure_only)');
-- J is running at part_count 1 with part 2 already stored: the next part by
-- the guard's count IS 2, so the duplicate passes the guard and meets the PK.
select qp.undo('QG4b a second part 2 while part_count is 1 is refused by the primary key',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 2, 'exports/' || %L || '-part-0002.zip', 1, 1)$$, :'j', :'j'),
  'denied(23505:export_job_parts_pkey)');

-- Re-queue J at part_count 2.
select qp.try('QG-fixture J re-queued at part_count 2',
  format($$update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = '{"v":2}' where id = %L$$, :'j'), 'ok');
select qp.undo('QG3 a part for J while J is QUEUED is refused: running only',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 3, 'exports/' || %L || '-part-0003.zip', 1, 1)$$, :'j', :'j'),
  'denied(22023:export_part_needs_a_running_job)');
select qp.try('QG-fixture J claimed again',
  format($$update public.export_jobs set status = 'running' where id = %L$$, :'j'), 'ok');
select qp.undo('QG4 with J running at part_count 2, part 4 is refused: out of order',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 4, 'exports/' || %L || '-part-0004.zip', 1, 1)$$, :'j', :'j'),
  'denied(22023:export_part_out_of_order)');
select qp.undo('QG4c ...and part 2 again is refused: out of order (behind the count)',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 2, 'exports/' || %L || '-part-0002.zip', 1, 1)$$, :'j', :'j'),
  'denied(22023:export_part_out_of_order)');
select qp.try('QG5 POSITIVE CONTROL: part 3 lands',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 3, 'exports/' || %L || '-part-0003.zip', 100, 10)$$, :'j', :'j'), 'ok');
select qp.val('QG5b ...and J now holds parts 1, 2, 3',
  format($$select string_agg(part_no::text, ',' order by part_no) from public.export_job_parts where job_id = %L$$, :'j'),
  '1,2,3');

-- § QE (here, while J is queued with parts stored)
select qp.try('QE-fixture J re-queued at part_count 3',
  format($$update public.export_jobs set status = 'queued', part_count = 3, resume_cursor = '{"v":3}' where id = %L$$, :'j'), 'ok');
select qp.undo('QE1 Owner P''s erasure WAITS while the backup is queued with parts stored',
  format($$select private.erase_account(%L, null)::text$$, :'owner_p'),
  'denied(55000:closure_backup_not_built)');
select qp.try('QG-fixture J claimed again (running, part_count 3, 3 parts)',
  format($$update public.export_jobs set status = 'running' where id = %L$$, :'j'), 'ok');

select qp.undo('QG6 a part of a SUCCEEDED closure backup (J2) is not deleted',
  format($$delete from public.export_job_parts where job_id = %L and part_no = 2$$, :'j2'),
  'denied(42501:export_part_of_a_kept_backup)');
select qp.undo('QG6c ...nor a part of a RUNNING one (J)',
  format($$delete from public.export_job_parts where job_id = %L and part_no = 1$$, :'j'),
  'denied(42501:export_part_of_a_kept_backup)');
select qp.sc('QG6d ...nor of a QUEUED one (J re-queued in the scenario)',
  array[format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
                 values (%L, 4, 'exports/' || %L || '-part-0004.zip', 1, 1)$$, :'j', :'j'),
        format($$update public.export_jobs set status = 'queued', part_count = 4, resume_cursor = '{"v":4}' where id = %L$$, :'j'),
        format($$delete from public.export_job_parts where job_id = %L and part_no = 1$$, :'j')],
  'ok|ok|denied(42501:export_part_of_a_kept_backup)');
set request.jwt.claims = :'owner_p_c';
select qp.undo('QG6e a DELETE from a person''s session (as postgres with claims, i.e. a definer RPC) is refused: server only',
  format($$delete from public.export_job_parts where job_id = %L and part_no = 1$$, :'j'),
  'denied(42501:export_part_is_server_only)');
reset request.jwt.claims;
select qp.try('QG-fixture J failed with part_count 3 and 3 parts',
  format($$update public.export_jobs set status = 'failed', failure_reason = 'qp: a part failed' where id = %L$$, :'j'), 'ok');
select qp.try('QG6b once J has FAILED, its parts are deleted',
  format($$delete from public.export_job_parts where job_id = %L$$, :'j'), 'ok');
select qp.val('QG6b2 ...all three of them',
  format($$select count(*)::text from public.export_job_parts where job_id = %L$$, :'j'), '0');
select qp.sc('QG7 deleting the job row cascades its parts (the guard admits the cascade): none left',
  array[format($$select count(*)::text from public.export_job_parts where job_id = %L$$, :'j2'),
        format($$delete from public.export_jobs where id = %L$$, :'j2'),
        format($$select count(*)::text from public.export_job_parts where job_id = %L$$, :'j2')],
  '2|ok|0');

-- ===========================================================================
-- § QJ THE JOB TRANSITIONS (J3 in workspace S; J4 in workspace T)
-- ===========================================================================
select qp.try('QJ-fixture J3 claimed',
  format($$update public.export_jobs set status = 'running' where id = %L$$, :'j3'), 'ok');
select qp.try('QJ-fixture J3 part 1 stored',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 1, 'exports/' || %L || '.zip', 100, 10)$$, :'j3', :'j3'), 'ok');
select started_at::text as j3_started from public.export_jobs where id = :'j3' \gset
select qp.try('QJ1 POSITIVE CONTROL: J3 (running, 1 part, part_count 0) is re-queued at part_count 1 with a cursor',
  format($$update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = %L$$, :'j3'), 'ok');
select qp.val('QJ1b ...queued, part_count 1, started_at UNCHANGED, storage_key and completed_at null, the cursor kept',
  format($$select status || '/' || part_count || '/' || (started_at = %L::timestamptz)::text || '/' ||
                  (storage_key is null)::text || '/' || (completed_at is null)::text || '/' || (resume_cursor ->> 'v')
             from public.export_jobs where id = %L$$, :'j3_started', :'j3'),
  'queued/1/true/true/true/1');

-- QJ6: FAIRNESS. Inside the scenario: every other queued job is removed (so
-- the run is measured on these two alone), J3's request is backdated to 3
-- minutes ago and its last claim set to NOW, and O's request to 1 minute ago.
-- By request time J3 would come first; by last claim O does.
select qp.sc('QJ6 a re-queued closure backup claimed just now waits behind an ordinary job requested a minute ago',
  array['set local session_replication_role = replica',
        format($$delete from public.export_jobs where status = 'queued' and id not in (%L, %L)$$, :'j3', :'o'),
        format($$update public.export_jobs set requested_at = now() - interval '3 minutes', started_at = now() where id = %L$$, :'j3'),
        format($$update public.export_jobs set requested_at = now() - interval '1 minute' where id = %L$$, :'o'),
        'set local session_replication_role = origin',
        format($$select case (select c.id from public.claim_export_job() c) when %L then 'closure' when %L then 'ordinary' else 'other' end$$, :'j3', :'o')],
  'ok|ok|ok|ok|ok|ordinary');
select qp.sc('QJ6b THE DENOMINATOR: claimed 2 minutes ago, the closure backup is served first (not simply "ordinary first")',
  array['set local session_replication_role = replica',
        format($$delete from public.export_jobs where status = 'queued' and id not in (%L, %L)$$, :'j3', :'o'),
        format($$update public.export_jobs set requested_at = now() - interval '3 minutes', started_at = now() - interval '2 minutes' where id = %L$$, :'j3'),
        format($$update public.export_jobs set requested_at = now() - interval '1 minute' where id = %L$$, :'o'),
        'set local session_replication_role = origin',
        format($$select case (select c.id from public.claim_export_job() c) when %L then 'closure' when %L then 'ordinary' else 'other' end$$, :'j3', :'o')],
  'ok|ok|ok|ok|ok|closure');

-- § QK THE REAPER (plan Spec correction 4), each run in a scenario.
select qp.sc('QK1 a closure backup QUEUED between claims, requested and last claimed 3 hours ago, is not reaped',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set requested_at = now() - interval '3 hours', started_at = now() - interval '3 hours' where id = %L$$, :'j3'),
        'set local session_replication_role = origin',
        'select (private.reap_stuck_jobs(false, 50) is not null)::text',
        format($$select status from public.export_jobs where id = %L$$, :'j3')],
  'ok|ok|ok|true|queued');
select qp.sc('QK4 claiming a queued job re-stamps started_at to now()',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set started_at = now() - interval '3 hours' where id = %L$$, :'j3'),
        'set local session_replication_role = origin',
        format($$update public.export_jobs set status = 'running' where id = %L$$, :'j3'),
        format($$select (started_at = now())::text from public.export_jobs where id = %L$$, :'j3')],
  'ok|ok|ok|ok|true');
select qp.try('QJ-fixture J3 claimed again (running, part_count 1, 1 part, cursor kept)',
  format($$update public.export_jobs set status = 'running' where id = %L$$, :'j3'), 'ok');
select qp.sc('QK2 a RUNNING closure backup requested 3 hours ago but claimed 1 minute ago is not reaped (a whole backup may take hours)',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set requested_at = now() - interval '3 hours', started_at = now() - interval '1 minute' where id = %L$$, :'j3'),
        'set local session_replication_role = origin',
        'select (private.reap_stuck_jobs(false, 50) is not null)::text',
        format($$select status from public.export_jobs where id = %L$$, :'j3')],
  'ok|ok|ok|true|running');
select qp.sc('QK3 POSITIVE CONTROL: claimed 2 hours ago (and carrying a cursor), it IS failed with the reaper''s reason, the cursor cleared',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set started_at = now() - interval '2 hours' where id = %L$$, :'j3'),
        'set local session_replication_role = origin',
        format($$select (resume_cursor is not null)::text from public.export_jobs where id = %L$$, :'j3'),
        'select (private.reap_stuck_jobs(false, 50) is not null)::text',
        format($$select status || ':' || (failure_reason like 'This export was interrupted%%')::text || ':' || (resume_cursor is null)::text
                   from public.export_jobs where id = %L$$, :'j3')],
  'ok|ok|ok|true|true|failed:true:true');

select qp.sc('QJ2 running -> queued on a running ORDINARY job (O, claimed in the scenario) is an illegal transition',
  array[format($$update public.export_jobs set status = 'running' where id = %L$$, :'o'),
        format($$update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = %L$$, :'o')],
  'ok|denied(22023:illegal_export_transition)');
select qp.undo('QJ2b ...and a finished ordinary job (K) is not re-queued either',
  format($$update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = %L$$, :'k'),
  'denied(22023:export_job_is_finished)');
select qp.undo('QJ3 a re-queue claiming part_count 2 with only 1 part row is refused',
  format($$update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = '{"v":2}' where id = %L$$, :'j3'),
  'denied(22023:export_part_count_mismatch)');
select qp.undo('QJ3b a re-queue with NO cursor is an illegal transition',
  format($$update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = null where id = %L$$, :'j3'),
  'denied(22023:illegal_export_transition)');
select qp.undo('QJ3c a re-queue that does not advance part_count by exactly one is an illegal transition',
  format($$update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":2}' where id = %L$$, :'j3'),
  'denied(22023:illegal_export_transition)');
select qp.sc('QJ4 the same re-queue under Owner P''s claims is refused: the outcome is the server''s',
  array[format($$select set_config('request.jwt.claims', %L, true) is not null$$, :'owner_p_c'),
        format($$update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = '{"v":2}' where id = %L$$, :'j3')],
  'true|denied(42501:export_outcome_is_server_only)');
select qp.try('QJ-fixture J3 part 2 stored (running, part_count 1, 2 parts)',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 2, 'exports/' || %L || '-part-0002.zip', 100, 10)$$, :'j3', :'j3'), 'ok');
select qp.undo('QJ5 a success at part_count 1 with 2 part rows is refused: the count must match',
  format($$update public.export_jobs set status = 'succeeded', part_count = 1, resume_cursor = null,
                  storage_key = 'exports/' || id::text || '.zip', byte_size = 200, row_count = 20, table_count = 1, manifest = '{}'::jsonb
            where id = %L$$, :'j3'),
  'denied(22023:export_part_count_mismatch)');
select qp.sc('QJ5a POSITIVE CONTROL: at part_count 2, part 1''s key and no cursor, it succeeds',
  array[format($$update public.export_jobs set status = 'succeeded', part_count = 2, resume_cursor = null,
                        storage_key = 'exports/' || id::text || '.zip', byte_size = 200, row_count = 20, table_count = 1, manifest = '{}'::jsonb
                  where id = %L$$, :'j3'),
        format($$select status || ':' || part_count || ':' || (expires_at is not null)::text from public.export_jobs where id = %L$$, :'j3')],
  'ok|succeeded:2:true');
select qp.undo('QJ5b a success still carrying a resume_cursor is refused by export_jobs_part_count_shape',
  format($$update public.export_jobs set status = 'succeeded', part_count = 2, resume_cursor = '{"v":2}',
                  storage_key = 'exports/' || id::text || '.zip', byte_size = 200, row_count = 20, table_count = 1, manifest = '{}'::jsonb
            where id = %L$$, :'j3'),
  'denied(23514:export_jobs_part_count_shape)');
select qp.sc('QJ7c a running closure backup one part behind (2 rows, part_count 1) carrying a cursor CAN be failed; the cursor is cleared',
  array[format($$update public.export_jobs set status = 'failed', failure_reason = 'qp: the re-queue failed' where id = %L$$, :'j3'),
        format($$select status || ':' || part_count || ':' || (resume_cursor is null)::text from public.export_jobs where id = %L$$, :'j3')],
  'ok|failed:1:true');

-- J4: the legacy shape, then a failure one part behind.
select qp.try('QJ-fixture J4 claimed',
  format($$update public.export_jobs set status = 'running' where id = %L$$, :'j4'), 'ok');
select qp.sc('QJ5c a LEGACY-shaped success (0 parts, part_count 0, one archive at storage_key) still succeeds',
  array[format($$update public.export_jobs set status = 'succeeded', storage_key = 'exports/' || id::text || '.zip',
                        byte_size = 1, row_count = 1, table_count = 1, manifest = '{}'::jsonb where id = %L$$, :'j4'),
        format($$select status || ':' || part_count from public.export_jobs where id = %L$$, :'j4')],
  'ok|succeeded:0');
select qp.try('QJ-fixture J4 part 1 stored, re-queue never made (running, part_count 0, 1 part)',
  format($$insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
           values (%L, 1, 'exports/' || %L || '.zip', 100, 10)$$, :'j4', :'j4'), 'ok');
select qp.sc('QJ7 a running closure backup with 1 part row and part_count 0 can still be marked failed',
  array[format($$update public.export_jobs set status = 'failed', failure_reason = 'qp: the re-queue failed' where id = %L$$, :'j4'),
        format($$select status || ':' || part_count from public.export_jobs where id = %L$$, :'j4')],
  'ok|failed:0');
select qp.sc('QJ7b ...and the reaper fails it when it was claimed 2 hours ago (no raise aborts the run)',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set started_at = now() - interval '2 hours' where id = %L$$, :'j4'),
        'set local session_replication_role = origin',
        'select (private.reap_stuck_jobs(false, 50) is not null)::text',
        format($$select status || ':' || (failure_reason like 'This export was interrupted%%')::text from public.export_jobs where id = %L$$, :'j4')],
  'ok|ok|ok|true|failed:true');

-- ===========================================================================
-- TASK 3 FIXTURES (20261101001000). Everything above left J3 RUNNING at
-- part_count 1 with parts 1 and 2 stored (every later QJ step was undone),
-- and J4 RUNNING at part_count 0 with part 1 stored.
--   J3 is finished in the legal order: re-queue at 2, claim, part 3, succeed
--      with part_count 3 -- a SUCCEEDED 3-part closure backup of closed S,
--      requested by Owner S (the brief's J3).
--   J4 is taken to QUEUED with 2 parts stored: re-queue at 1, claim, part 2,
--      re-queue at 2 (the brief's "T's backup, re-queued with 2 parts").
--   F  is Owner S's own FAILED account export (QD6's no-archive refusal).
--   LJ is a uuid for QO4's planted legacy backup; RK a random part key no
--      row names (QM5).
-- ===========================================================================
update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = '{"v":2}' where id = :'j3';
update public.export_jobs set status = 'running' where id = :'j3';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j3', 3, 'exports/' || :'j3' || '-part-0003.zip', 100, 10);
update public.export_jobs
   set status = 'succeeded', part_count = 3, resume_cursor = null,
       storage_key = 'exports/' || id::text || '.zip', byte_size = 300, row_count = 30,
       table_count = 1, manifest = '{}'::jsonb
 where id = :'j3';

update public.export_jobs set status = 'queued', part_count = 1, resume_cursor = '{"v":1}' where id = :'j4';
update public.export_jobs set status = 'running' where id = :'j4';
insert into public.export_job_parts (job_id, part_no, storage_key, byte_size, row_count)
values (:'j4', 2, 'exports/' || :'j4' || '-part-0002.zip', 100, 10);
update public.export_jobs set status = 'queued', part_count = 2, resume_cursor = '{"v":2}' where id = :'j4';

set role authenticated;
set request.jwt.claims = :'owner_s_c';
with x as (insert into public.export_jobs (kind) values ('account') returning id) insert into qp.ids select 'f', id::text from x;
reset role;
reset request.jwt.claims;
select v as f from qp.ids where k = 'f' \gset
update public.export_jobs set status = 'running' where id = :'f';
update public.export_jobs set status = 'failed', failure_reason = 'qp: failed' where id = :'f';
\o /dev/null
select gen_random_uuid()::text as lj \gset
select 'exports/' || gen_random_uuid()::text || '-part-0002.zip' as rk \gset
\o

select qp.val('Q3-fixture J3 is SUCCEEDED with part_count 3 and parts 1,2,3; J4 is QUEUED with part_count 2 and parts 1,2; F is failed',
  format($$select (select status || ':' || part_count || ':' ||
                          (select string_agg(part_no::text, ',' order by part_no) from public.export_job_parts where job_id = j.id)
                     from public.export_jobs j where j.id = %L) || '/' ||
                  (select status || ':' || part_count || ':' ||
                          (select string_agg(part_no::text, ',' order by part_no) from public.export_job_parts where job_id = j.id)
                     from public.export_jobs j where j.id = %L) || '/' ||
                  (select status from public.export_jobs where id = %L)$$, :'j3', :'j4', :'f'),
  'succeeded:3:1,2,3/queued:2:1,2/failed');

-- Helpers for Task 3. Steps that change who is speaking, inside a scenario
-- (the SET LOCALs die with the scenario's sentinel rollback).
create function qp.as_person(p_claims text) returns text[]
language sql immutable set search_path = '' as $$
  select array[pg_catalog.format($f$select pg_catalog.set_config('request.jwt.claims', %L, true) is not null$f$, p_claims),
               'set local role authenticated'];
$$;
create function qp.as_server() returns text[]
language sql immutable set search_path = '' as $$
  select array['reset role', $f$select pg_catalog.set_config('request.jwt.claims', '', true) is not null$f$];
$$;
-- One download: `called` when the audit RPC returned, else its refusal.
create function qp.dl(p_job text, p_part integer) returns text
language sql immutable set search_path = '' as $$
  select case when p_part is null
              then pg_catalog.format($f$select 'called' from (select public.audit_export_download(%L)) x$f$, p_job)
              else pg_catalog.format($f$select 'called' from (select public.audit_export_download(%L, %s)) x$f$, p_job, p_part) end;
$$;
-- The newest download audit row for a job: its key set / kind / part.
create function qp.last_dl(p_job uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce((select pg_catalog.string_agg(k, ',' order by k) from pg_catalog.jsonb_object_keys(a.after) k), '')
           || '/' || coalesce(a.after ->> 'kind', '') || '/' || coalesce(a.after ->> 'part', '<none>')
      from public.audit_events a
     where a.action = 'export_job.downloaded' and a.target_id = p_job
     order by a.created_at desc, a.id desc limit 1), '<none>');
$$;
-- How many download audit rows name any of these jobs.
create function qp.dl_count(p_jobs uuid[]) returns text
language sql stable security definer set search_path = '' as $$
  select pg_catalog.count(*)::text from public.audit_events a
   where a.action = 'export_job.downloaded' and a.target_id = any(p_jobs);
$$;
-- The workspace closure suite's cw.live_sweep_probe(): a LIVE sweep, read,
-- then rolled back. Returns `<org rows>/<job rows>` left.
create function qp.live_sweep_probe(p_org uuid, p_job uuid) returns text
language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v text;
begin
  begin
    perform private.sweep_expired_workspaces(false, 100000);
    v := (select count(*) from public.organisations where id = p_org)::text || '/' ||
         (select count(*) from public.export_jobs where id = p_job)::text;
    raise exception 'qp_rollback' using detail = v;
  exception when others then
    if sqlerrm = 'qp_rollback' then
      get stacked diagnostics v = pg_exception_detail;
      return v;
    end if;
    return 'error(' || sqlstate || ':' || sqlerrm || ')';
  end;
end $$;
-- THE MANIFEST PROBE (rls_phase8_retention.sql RW5a's pattern): run the setup
-- statements, plant an `exports` object two days old (past the 1-day orphan
-- grace) for every key that has none, open a DRY run, read the manifest, and
-- roll ALL of it back -- the objects, the run, the setup. Returns, per key in
-- order, the reasons the manifest named it for (`-` when it did not name it;
-- `a,a` when it named it twice).
create function qp.mprobe(p_setup text[], p_keys text[]) returns text
language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v text; v_s text; v_run public.retention_runs%rowtype; v_m jsonb;
begin
  begin
    foreach v_s in array coalesce(p_setup, '{}'::text[]) loop
      execute v_s;
    end loop;
    insert into storage.objects (bucket_id, name, created_at)
    select 'exports', k, now() - interval '2 days' from unnest(p_keys) k
     where not exists (select 1 from storage.objects s where s.bucket_id = 'exports' and s.name = k);
    v_run := public.start_retention_run(true);
    if v_run.status <> 'running' then
      raise exception 'qp_probe' using detail = 'run_' || v_run.status || ':' || v_run.refused::text;
    end if;
    select coalesce(jsonb_agg(jsonb_build_array(m.object_key, m.reason)), '[]'::jsonb) into v_m
      from public.retention_object_manifest(v_run.id, 500) m
     where m.bucket = 'exports' and m.object_key = any(p_keys);
    select string_agg(coalesce((select string_agg(e ->> 1, ',' order by e ->> 1)
                                  from jsonb_array_elements(v_m) e where e ->> 0 = k.key), '-'),
                      '|' order by k.ord) into v
      from unnest(p_keys) with ordinality k(key, ord);
    raise exception 'qp_probe' using detail = v;
  exception when others then
    if sqlerrm = 'qp_probe' then
      get stacked diagnostics v = pg_exception_detail;
      return v;
    end if;
    return 'error(' || sqlstate || ':' || sqlerrm || ')';
  end;
end $$;
grant execute on function qp.as_person(text), qp.as_server(), qp.dl(text, integer),
  qp.last_dl(uuid), qp.dl_count(uuid[]) to authenticated;

-- ===========================================================================
-- § QD THE DOWNLOAD AUDIT, PER PART (as Owner S unless stated). The
--      successes are scenarios (undone), so no download row survives to
--      release QO's hold or to reach another suite's count.
-- ===========================================================================
select qp.sc('QD1 Owner S downloads J3 with no part: it succeeds, and the newest audit row is {kind: workspace, part: 1}',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', null), format($$select qp.last_dl(%L)$$, :'j3')],
  'true|ok|called|kind,part/workspace/1');
select qp.sc('QD2 ...part 2 succeeds, with after.part = 2',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 2), format($$select qp.last_dl(%L)$$, :'j3')],
  'true|ok|called|kind,part/workspace/2');
select qp.sc('QD3 Owner P''s ordinary account export K, no part: after.part = 1',
  qp.as_person(:'owner_p_c') || array[qp.dl(:'k', null), format($$select qp.last_dl(%L)$$, :'k')],
  'true|ok|called|kind,part/account/1');

select qp.dl_count(array[:'j3', :'k', :'f']::uuid[]) as qd_before \gset
set role authenticated;
set request.jwt.claims = :'owner_s_c';
select qp.try('QD4a J3 part 4 (it has 3) is export_part_not_found', qp.dl(:'j3', 4), 'denied(22023:export_part_not_found)');
select qp.try('QD4b J3 part 0 is export_part_not_found', qp.dl(:'j3', 0), 'denied(22023:export_part_not_found)');
select qp.try('QD4c J3 part -1 is export_part_not_found', qp.dl(:'j3', -1), 'denied(22023:export_part_not_found)');
select qp.try('QD4d J3 with p_part => null is export_part_not_found',
  format($$select 'called' from (select public.audit_export_download(%L, p_part => null)) x$$, :'j3'),
  'denied(22023:export_part_not_found)');
set request.jwt.claims = :'owner_p_c';
select qp.try('QD4e Owner P''s ordinary K, part 2 (an ordinary export has no parts) is export_part_not_found',
  qp.dl(:'k', 2), 'denied(22023:export_part_not_found)');
set request.jwt.claims = :'admin_s2_c';
select qp.try('QD5 Admin S2 of the SAME workspace, J3 part 2: not_your_export (the IDOR term, not the part check)',
  qp.dl(:'j3', 2), 'denied(42501:not_your_export)');
reset role;
reset request.jwt.claims;
select qp.sc('QD6a an EXPIRED J3 (undone): export_archive_expired',
  array['set local session_replication_role = replica',
        format($$update public.export_jobs set expires_at = now() - interval '1 day' where id = %L$$, :'j3'),
        'set local session_replication_role = origin']
  || qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 1)],
  'ok|ok|ok|true|ok|denied(22023:export_archive_expired)');
select qp.sc('QD6b Owner S''s own FAILED export F: export_has_no_archive',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'f', 1)],
  'true|ok|denied(22023:export_has_no_archive)');
select qp.val('QD7 no refusal in QD4-QD6 wrote a download audit row (the count is unchanged)',
  format($$select (qp.dl_count(array[%L, %L, %L]::uuid[]) = %L)::text$$, :'j3', :'k', :'f', :'qd_before'), 'true');
select qp.val('QD8 EXECUTE on audit_export_download(uuid, integer) is authenticated''s alone, and the (uuid) overload is gone',
  $$select coalesce((select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role','public']) r
                      where to_regprocedure('public.audit_export_download(uuid,integer)') is not null
                        and has_function_privilege(r, 'public.audit_export_download(uuid,integer)', 'EXECUTE')), '<none>')
           || '/' || (to_regprocedure('public.audit_export_download(uuid)') is null)::text$$,
  'authenticated/true');

-- ===========================================================================
-- § QX DELETE WITHOUT A BACKUP (spec section 7): T is closed, its closure
--      backup J4 QUEUED with 2 parts stored.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'su_c';
select qp.try('QX1 the aal2 superuser''s delete of T, unacknowledged, is decision_backup_not_succeeded',
  format($$select public.delete_closed_workspace(%L, 'r')::text$$, :'slug_t'),
  'denied(22023:decision_backup_not_succeeded)');
reset role;
reset request.jwt.claims;
select qp.sc('QX2 ...acknowledged (undone), it proceeds; the audit row says backup_status queued, acknowledged_no_backup true',
  qp.as_person(:'su_c')
  || array[format($$select (public.delete_closed_workspace(%L, 'r', true) is not null)::text$$, :'slug_t')]
  || qp.as_server()
  || array[format($$select (after ->> 'backup_status') || ':' || (after ->> 'acknowledged_no_backup')
                      from public.audit_events where action = 'organisation.closure_deleted' and organisation_id = %L$$, :'org_t')],
  'true|ok|true|ok|true|queued:true');
select qp.sc('QX3 ...and J4''s expires_at was NOT raised (the raise is for a succeeded backup only)',
  array[format($$select coalesce(expires_at::text, 'none') from public.export_jobs where id = %L$$, :'j4')]
  || qp.as_person(:'su_c')
  || array[format($$select (public.delete_closed_workspace(%L, 'r', true) is not null)::text$$, :'slug_t')]
  || qp.as_server()
  || array[format($$select coalesce(expires_at::text, 'none') || ':' || status from public.export_jobs where id = %L$$, :'j4')],
  'none|true|ok|true|ok|true|none:queued');

-- ===========================================================================
-- § QO Q229 WAITS FOR EVERY PART. S is deleted through
--      delete_closed_workspace() by the aal2 superuser (CH1's pattern); its
--      latest closure backup J3 has 3 parts.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'su_c';
select qp.try('QO-fixture the aal2 superuser deletes S (J3 succeeded: no acknowledgement)',
  format($$select (public.delete_closed_workspace(%L, 'no successor') is not null)::text$$, :'slug_s'), 'true');
reset role;
reset request.jwt.claims;
select qp.val('QO1 no part downloaded: closure_backup_owed(S) is true',
  format($$select private.closure_backup_owed(%L)::text$$, :'org_s'), 'true');
select qp.sc('QO2 after Owner S downloads parts 1 and 2 (undone): STILL owed (M12)',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 1), qp.dl(:'j3', 2)] || qp.as_server()
  || array[format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'true|ok|called|called|ok|true|true');
select qp.sc('QO3 ...after part 3 as well (undone): no longer owed',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 1), qp.dl(:'j3', 2), qp.dl(:'j3', 3)] || qp.as_server()
  || array[format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'true|ok|called|called|called|ok|true|false');
select qp.sc('QO3b in any order: part 3 alone does not release it; then parts 2 and 1 do',
  qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 3)] || qp.as_server()
  || array[format($$select private.closure_backup_owed(%L)::text$$, :'org_s')]
  || qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 2), qp.dl(:'j3', 1)] || qp.as_server()
  || array[format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'true|ok|called|ok|true|true|true|ok|called|called|ok|true|false');
select qp.sc('QO4 a LEGACY closure backup (0 parts, planted succeeded, the latest) with one download row with NO part key: not owed',
  array['set local session_replication_role = replica',
        format($$insert into public.export_jobs (id, kind, organisation_id, requested_by, closure_backup, status,
                                                 requested_at, started_at, completed_at, expires_at, storage_key,
                                                 byte_size, row_count, table_count, manifest)
                 values (%1$L, 'workspace', %2$L, %3$L, true, 'succeeded', now() + interval '1 minute', now(), now(),
                         now() + interval '30 days', 'exports/' || %1$L || '.zip', 1, 1, 1, '{}'::jsonb)$$,
               :'lj', :'org_s', :'owner_s'),
        'set local session_replication_role = origin',
        format($$select private.closure_backup_owed(%L)::text$$, :'org_s'),
        format($$insert into public.audit_events (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
                 values (%L, %L, 'export_job.downloaded', 'export_job', %L, gen_random_uuid(), '{"kind":"workspace"}'::jsonb)$$,
               :'org_s', :'owner_s', :'lj'),
        format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'ok|ok|ok|true|ok|false');
select qp.sc('QO5 parts 1-3 "downloaded" by Admin S2 (planted rows, actor S2) do not release it: still owed (M13)',
  array[format($$insert into public.audit_events (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
                 select %L, %L, 'export_job.downloaded', 'export_job', %L, gen_random_uuid(),
                        jsonb_build_object('kind', 'workspace', 'part', n) from generate_series(1, 3) n$$,
               :'org_s', :'admin_s2', :'j3'),
        format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'ok|true');
select qp.sc('QO6 30 days after the decision (backdated the CH8 way), nothing downloaded: not owed',
  array['set local session_replication_role = replica',
        format($$update public.organisations set lifecycle_changed_at = lifecycle_changed_at - interval '30 days',
                        retention_expires_at = retention_expires_at - interval '30 days' where id = %L$$, :'org_s'),
        'set local session_replication_role = origin',
        format($$select private.closure_backup_owed(%L)::text$$, :'org_s')],
  'ok|ok|ok|false');
select qp.sc('QO7 a LIVE sweep (rolled back) HOLDS S while it is owed, and purges it with its backup once every part is downloaded',
  array[format($$select qp.live_sweep_probe(%L, %L)$$, :'org_s', :'j3')]
  || qp.as_person(:'owner_s_c') || array[qp.dl(:'j3', 1), qp.dl(:'j3', 2), qp.dl(:'j3', 3)] || qp.as_server()
  || array[format($$select qp.live_sweep_probe(%L, %L)$$, :'org_s', :'j3')],
  '1/1|true|ok|called|called|called|ok|true|0/0');

-- ===========================================================================
-- § QM THE RETENTION MANIFEST (each probe plants its objects, opens a dry
--      run, reads public.retention_object_manifest(run, 500) and is undone).
-- ===========================================================================
select qp.val('QM1 J3 EXPIRED: all three part keys are named, export_expired, once each (M15)',
  format($$select qp.mprobe(array['set local session_replication_role = replica',
                                  %L,
                                  'set local session_replication_role = origin'],
                            array[%L, %L, %L])$$,
         format($$update public.export_jobs set expires_at = now() - interval '1 day' where id = %L$$, :'j3'),
         'exports/' || :'j3' || '.zip', 'exports/' || :'j3' || '-part-0002.zip', 'exports/' || :'j3' || '-part-0003.zip'),
  'export_expired|export_expired|export_expired');
select qp.val('QM2 CRITICAL: J3 unexpired and succeeded: NONE of its three keys is named, neither expired nor orphan (M14)',
  format($$select qp.mprobe(null, array[%L, %L, %L])$$,
         'exports/' || :'j3' || '.zip', 'exports/' || :'j3' || '-part-0002.zip', 'exports/' || :'j3' || '-part-0003.zip'),
  '-|-|-');
select qp.val('QM3 a RE-QUEUED closure backup''s two part objects (J4) are not named (M14)',
  format($$select qp.mprobe(null, array[%L, %L])$$,
         'exports/' || :'j4' || '.zip', 'exports/' || :'j4' || '-part-0002.zip'),
  '-|-');
select qp.val('QM4 a FAILED closure backup with its 2 part rows left behind (J4 failed in the probe): both keys are orphans (M16)',
  format($$select qp.mprobe(array[%L, %L], array[%L, %L])$$,
         format($$update public.export_jobs set status = 'running' where id = %L$$, :'j4'),
         format($$update public.export_jobs set status = 'failed', failure_reason = 'qp: probe' where id = %L$$, :'j4'),
         'exports/' || :'j4' || '.zip', 'exports/' || :'j4' || '-part-0002.zip'),
  'orphan|orphan');
select qp.val('QM5 POSITIVE CONTROL: a part-shaped object no row names is an orphan (the orphan half still runs)',
  format($$select qp.mprobe(null, array[%L])$$, :'rk'), 'orphan');
do $$
declare v_out text; v_job uuid := gen_random_uuid(); v_j3 text := (select v from qp.ids where k = 'j3');
        v_owner uuid; v_named bigint; v_denominator bigint;
begin
  select requested_by into v_owner from public.export_jobs where id = v_j3::uuid;
  begin
    set local session_replication_role = replica;
    insert into public.erasure_jobs (id, kind, subject_user_id, requested_by, status)
    values (v_job, 'account', v_owner, v_owner, 'queued');
    set local session_replication_role = origin;
    select count(*) into v_denominator from public.export_jobs
     where requested_by = v_owner and storage_key is not null and id = v_j3::uuid;
    select count(*) into v_named from public.erasure_purge_manifest(v_job) m
     where m.object_key in ('exports/' || v_j3 || '.zip', 'exports/' || v_j3 || '-part-0002.zip',
                            'exports/' || v_j3 || '-part-0003.zip');
    raise exception 'qp_probe' using detail = v_denominator || '/' || v_named;
  exception when others then
    if sqlerrm = 'qp_probe' then get stacked diagnostics v_out = pg_exception_detail;
    else v_out := 'error(' || sqlstate || ':' || sqlerrm || ')'; end if;
  end;
  perform qp.record('QM6 Owner S''s ACCOUNT erasure manifest names none of J3''s keys (Q206 unchanged); J3 is theirs, with a key (denominator)',
                    '1/0', v_out);
end $$;

-- ===========================================================================
-- § QZ HOUSEKEEPING (part rows first: `replica` turns off the FK cascade)
-- ===========================================================================
set session_replication_role = replica;
delete from public.export_job_parts where job_id in (:'j', :'j2', :'j3', :'j4', :'k', :'o', :'f');
delete from public.export_jobs where id in (:'j', :'j2', :'j3', :'j4', :'k', :'o', :'f')
   or organisation_id in (:'org_p', :'org_q', :'org_r', :'org_s', :'org_t')
   or requested_by in (:'owner_p', :'admin_p2', :'mgr_p3', :'owner_q', :'owner_r', :'owner_s', :'owner_t', :'admin_s2', :'su_u');
delete from public.audit_events where organisation_id in (:'org_p', :'org_q', :'org_r', :'org_s', :'org_t')
   or actor_user_id in (:'owner_p', :'admin_p2', :'mgr_p3', :'owner_q', :'owner_r', :'owner_s', :'owner_t', :'admin_s2', :'su_u');
delete from public.organisation_memberships where organisation_id in (:'org_p', :'org_q', :'org_r', :'org_s', :'org_t');
delete from public.organisation_subscriptions where organisation_id in (:'org_p', :'org_q', :'org_r', :'org_s', :'org_t');
delete from public.organisations where id in (:'org_p', :'org_q', :'org_r', :'org_s', :'org_t');
set session_replication_role = origin;
delete from public.platform_admins where user_id = :'su_u';
delete from auth.users where id in (:'owner_p', :'admin_p2', :'mgr_p3', :'owner_q', :'owner_r', :'owner_s', :'owner_t', :'admin_s2', :'su_u');
select qp.val('QZ1 no qp fixture row is left in export_jobs, export_job_parts, organisations or storage.objects',
  format($$select (select count(*) from public.export_jobs
                    where id in (%L, %L, %L, %L, %L, %L)
                       or organisation_id in (%L, %L, %L, %L, %L))::text || '/' ||
                  (select count(*) from public.export_job_parts where job_id in (%L, %L, %L, %L, %L, %L))::text || '/' ||
                  (select count(*) from public.organisations where id in (%L, %L, %L, %L, %L) or slug like 'qp-%%')::text || '/' ||
                  (select count(*) from storage.objects where bucket_id = 'exports'
                      and (name like 'exports/' || %L || '%%' or name like 'exports/' || %L || '%%' or name like 'exports/' || %L || '%%'
                           or name like 'exports/' || %L || '%%' or name like 'exports/' || %L || '%%' or name like 'exports/' || %L || '%%'))::text$$,
         :'j', :'j2', :'j3', :'j4', :'k', :'o', :'org_p', :'org_q', :'org_r', :'org_s', :'org_t',
         :'j', :'j2', :'j3', :'j4', :'k', :'o', :'org_p', :'org_q', :'org_r', :'org_s', :'org_t',
         :'j', :'j2', :'j3', :'j4', :'k', :'o'),
  '0/0/0/0');

\echo
\echo ==================== Q228 CLOSURE BACKUP PARTS ====================
select seq, label, expected, actual, pass from qp.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from qp.results;
