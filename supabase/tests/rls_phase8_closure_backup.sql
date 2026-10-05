-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1 -- A CLOSURE BACKUP IS COMPLETE (C1, I2).
--
-- The closure backup is built by the export runner AFTER close_my_workspace()
-- has committed, i.e. after `deleted_at` is set. Read under the Owner's own
-- RLS, every SELECT policy that keys on a permission that does not survive
-- suspension (view_finance, view_network) went dark at that moment, and an
-- Owner who erased their account before the job ran had it built as the
-- tombstone (no membership, every file empty).
--
-- This suite measures it the only way that means anything: the SAME read
-- engine (public.export_read_page, which the runner calls page by page), the
-- SAME workspace, the SAME requester, once through an ordinary workspace
-- export taken while the workspace was live and once through the closure
-- backup -- and the per-table row counts must be equal. The pre-closure
-- export is the contract (it already excludes a colleague's private note,
-- Q54), so "equal" means "complete" AND "no wider".
--
--   KS  seeding: every exported table of a workspace export has >= 1 row
--       visible to the Owner (the denominator, measured -- not assumed)
--   KA  scenario A: close, then build the backup -- counts equal, per table
--   KE  scenario B: close, then erase the Owner BEFORE the backup runs --
--       the erasure waits; once the backup is built it proceeds
--   KT  the belt: a closure backup whose requester IS the tombstone is
--       refused by the read engine, loudly, rather than built empty
--   KZ  housekeeping
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ck cascade;
create schema ck;

create table ck.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ck.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ck.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function ck.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint like 'Grant the required privileges%' then v_hint := 'missing_grant'; end if;
    v_actual := 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
  perform ck.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema ck to authenticated, service_role;
grant execute on function ck.record(text,text,text) to authenticated, service_role;
grant execute on function ck.val(text,text,text)    to authenticated, service_role;
create table ck.ids (k text primary key, v text);
grant select, insert on ck.ids to authenticated;

-- Per-table row counts of one RUNNING job, read the way lib/export/runner.ts
-- reads: page after page of public.export_read_page() on the catalogue's key
-- column until a short page. Run as postgres with no person on the session
-- (the engine refuses anything else).
create table ck.counts (job text, tbl text, n bigint, primary key (job, tbl));
create function ck.count_job(p_label text, p_job uuid)
returns void language plpgsql set search_path = '' as $$
declare v_t record; v_after text; v_page jsonb; v_n bigint; v_lim int := 500;
begin
  for v_t in
    select c.table_name, c.key_column
      from private.export_catalogue() c
      join public.export_jobs j on j.id = p_job and j.kind = c.export_kind
     where c.disposition = 'exported'
  loop
    v_after := ''; v_n := 0;
    loop
      v_page := public.export_read_page(p_job, v_t.table_name, v_after, v_lim);
      v_n := v_n + pg_catalog.jsonb_array_length(v_page);
      exit when pg_catalog.jsonb_array_length(v_page) < v_lim;
      v_after := v_page -> (pg_catalog.jsonb_array_length(v_page) - 1) ->> v_t.key_column;
    end loop;
    insert into ck.counts values (p_label, v_t.table_name, v_n);
  end loop;
end $$;

-- One row in every table a workspace export carries, all in p_org. The
-- colleague (p_mgr) owns a PRIVATE note, which the Owner's export must not
-- carry before or after: the backup is no wider than the export contract.
create function ck.seed(p_org uuid, p_owner uuid, p_mgr uuid, p_su uuid,
                        p_other_org uuid, p_other_prof uuid)
returns void language plpgsql set search_path = '' as $$
declare
  v_comp uuid := gen_random_uuid(); v_comp2 uuid := gen_random_uuid();
  v_con uuid := gen_random_uuid(); v_con2 uuid := gen_random_uuid();
  v_art uuid := gen_random_uuid(); v_ag uuid := gen_random_uuid();
  v_ven uuid := gen_random_uuid(); v_ev uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid(); v_note uuid := gen_random_uuid();
  v_meet uuid := gen_random_uuid(); v_doc uuid := gen_random_uuid();
  v_prof uuid := gen_random_uuid(); v_cfd uuid := gen_random_uuid();
begin
  insert into public.companies (id, organisation_id, name) values
    (v_comp, p_org, 'CK Co'), (v_comp2, p_org, 'CK Co Two');
  insert into public.contacts (id, organisation_id, name) values
    (v_con, p_org, 'CK Contact'), (v_con2, p_org, 'CK Contact Two');
  insert into public.contact_companies (organisation_id, contact_id, company_id) values (p_org, v_con, v_comp);
  insert into public.artists (id, organisation_id, name) values (v_art, p_org, 'CK Artist');
  insert into public.agencies (id, organisation_id, name) values (v_ag, p_org, 'CK Agency');
  insert into public.artist_representations (organisation_id, artist_id, agency_id) values (p_org, v_art, v_ag);
  insert into public.artist_fee_history (organisation_id, artist_id, occurred_on, amount_minor)
    values (p_org, v_art, current_date, 50000);
  insert into public.venues (id, organisation_id, name) values (v_ven, p_org, 'CK Venue');
  insert into public.venue_rooms (organisation_id, venue_id, name) values (p_org, v_ven, 'CK Room');
  insert into public.events (id, organisation_id, name, starts_at, venue_id)
    values (v_ev, p_org, 'CK Night', now() + interval '10 days', v_ven);
  insert into public.event_lineup (organisation_id, event_id, artist_id) values (p_org, v_ev, v_art);
  insert into public.event_status_changes (organisation_id, event_id, to_status) values (p_org, v_ev, 'planned');
  insert into public.financial_entries (organisation_id, event_id, category, amount_minor) values
    (p_org, v_ev, 'fee', 120000), (p_org, v_ev, 'income', 300000), (p_org, v_ev, 'cost', 4000);
  insert into public.tasks (id, organisation_id, title) values (v_task, p_org, 'CK Task');
  insert into public.task_links (organisation_id, parent_id, entity_type, entity_id) values (p_org, v_task, 'event', v_ev);
  insert into public.notes (id, organisation_id, owner_user_id, body, visibility) values
    (v_note, p_org, p_owner, 'CK owner private', 'private');
  insert into public.notes (organisation_id, owner_user_id, body, visibility) values
    (p_org, p_mgr, 'CK colleague company', 'company'),
    (p_org, p_mgr, 'CK colleague PRIVATE', 'private');
  insert into public.note_links (organisation_id, parent_id, entity_type, entity_id) values (p_org, v_note, 'event', v_ev);
  insert into public.meetings (id, organisation_id, title, starts_at) values (v_meet, p_org, 'CK Meeting', now());
  insert into public.meeting_links (organisation_id, parent_id, entity_type, entity_id) values (p_org, v_meet, 'event', v_ev);
  insert into public.documents (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes)
    values (v_doc, p_org, p_owner, 'ck.pdf', p_org::text || '/' || v_doc::text, 'application/pdf', 10);
  insert into public.document_links (organisation_id, parent_id, entity_type, entity_id) values (p_org, v_doc, 'event', v_ev);
  insert into public.document_versions (organisation_id, document_id, version_number, storage_key, mime_type, size_bytes)
    values (p_org, v_doc, 1, p_org::text || '/' || v_doc::text, 'application/pdf', 10);
  insert into public.custom_field_definitions (id, organisation_id, entity_type, key, label, field_type)
    values (v_cfd, p_org, 'contact', 'ck_field', 'CK Field', 'text');
  insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
    values (p_org, v_cfd, 'contact', v_con, '"x"');
  insert into public.merge_candidates (organisation_id, entity_type, keep_id, duplicate_id, label, reason)
    values (p_org, 'contact', v_con, v_con2, 'CK', 'fuzzy_name');
  insert into public.merges (organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
    values (p_org, 'company', v_comp, v_comp2, p_owner, '{}');
  insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, display_name, status, published_at)
    values (v_prof, p_org, 'company', v_comp, 'CK Profile', 'published', now());
  insert into public.network_links (organisation_id, network_profile_id, private_entity_type, private_entity_id)
    values (p_org, p_other_prof, 'company', v_comp);
  insert into public.network_connection_requests
    (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
    values (p_org, v_prof, p_other_org, p_other_prof);
  insert into public.organisation_feature_overrides (organisation_id, flag_key, reason, granted_by, expires_at)
    values (p_org, 'early_access_preview', 'CK', p_su, now() + interval '30 days');
  insert into public.organisation_billing_overrides (organisation_id, override_tier, reason, granted_by, expires_at)
    values (p_org, 'pro', 'CK', p_su, now() + interval '30 days');
  insert into public.impersonation_sessions
    (superuser_user_id, target_organisation_id, reason, status, declined_by, declined_at)
    values (p_su, p_org, 'CK support', 'declined', p_owner, now());
end $$;

-- ---------------------------------------------------------------------------
-- FIXTURES
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as owner_a \gset
select gen_random_uuid()::text as mgr_a   \gset
select gen_random_uuid()::text as owner_b \gset
select gen_random_uuid()::text as mgr_b   \gset
select gen_random_uuid()::text as su_u    \gset
select gen_random_uuid()::text as x_u     \gset
select gen_random_uuid()::text as org_a   \gset
select gen_random_uuid()::text as org_b   \gset
select gen_random_uuid()::text as org_x   \gset
select gen_random_uuid()::text as comp_x  \gset
select gen_random_uuid()::text as prof_x  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_a') as owner_a_c \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_b') as owner_b_c \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, now(), now(), now()
  from (values (:'owner_a'::uuid, 'ck-owner-a@test.local'), (:'mgr_a'::uuid, 'ck-mgr-a@test.local'),
               (:'owner_b'::uuid, 'ck-owner-b@test.local'), (:'mgr_b'::uuid, 'ck-mgr-b@test.local'),
               (:'su_u'::uuid, 'ck-su@test.local'), (:'x_u'::uuid, 'ck-x@test.local')) v(u, e);

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Backup Alpha', 'ck-backup-alpha'),
  (:'org_b', 'Backup Beta',  'ck-backup-beta'),
  (:'org_x', 'Backup Other', 'ck-backup-other');
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
select o, 'pro', 'monthly', 3, 'active', now() + interval '30 days'
  from unnest(array[:'org_a', :'org_b', :'org_x']::uuid[]) o
on conflict (organisation_id) do update set plan_id = 'pro', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'owner_a', 'owner',   'active', now()),
  (:'org_a', :'mgr_a',   'manager', 'active', now()),
  (:'org_b', :'owner_b', 'owner',   'active', now()),
  (:'org_b', :'mgr_b',   'manager', 'active', now()),
  (:'org_x', :'x_u',     'owner',   'active', now());

set session_replication_role = replica;
insert into public.companies (id, organisation_id, name) values (:'comp_x', :'org_x', 'CK Other Co');
insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, display_name, status, published_at)
values (:'prof_x', :'org_x', 'company', :'comp_x', 'CK Other', 'published', now());
select ck.seed(:'org_a', :'owner_a', :'mgr_a', :'su_u', :'org_x', :'prof_x');
select ck.seed(:'org_b', :'owner_b', :'mgr_b', :'su_u', :'org_x', :'prof_x');
set session_replication_role = origin;

-- The pre-closure workspace export of each, through the real INSERT path.
set role authenticated;
set request.jwt.claims = :'owner_a_c';
with j as (insert into public.export_jobs (kind, organisation_id) values ('workspace', :'org_a') returning id)
insert into ck.ids select 'pre_a', id::text from j;
set request.jwt.claims = :'owner_b_c';
with j as (insert into public.export_jobs (kind, organisation_id) values ('workspace', :'org_b') returning id)
insert into ck.ids select 'pre_b', id::text from j;
reset role;
reset request.jwt.claims;
select v as pre_a from ck.ids where k = 'pre_a' \gset
select v as pre_b from ck.ids where k = 'pre_b' \gset

update public.export_jobs set status = 'running' where id in (:'pre_a', :'pre_b');
select ck.count_job('pre_a', :'pre_a');
select ck.count_job('pre_b', :'pre_b');
update public.export_jobs set status = 'failed', failure_reason = 'ck measurement'
 where id in (:'pre_a', :'pre_b');

-- ===========================================================================
-- § KS THE DENOMINATOR: every exported table carries the Owner's rows.
-- ===========================================================================
select ck.val('KS1 the workspace export exports a pinned number of tables',
  $$select count(*)::text from private.export_catalogue() where export_kind = 'workspace' and disposition = 'exported'$$,
  '35');
select ck.val('KS2 EVERY ONE of them is non-empty in the pre-closure export (none is vacuous)',
  $$select coalesce(string_agg(tbl, ',' order by tbl), '') from ck.counts where job = 'pre_a' and n = 0$$, '');
select ck.val('KS3 ...for the second workspace too',
  $$select coalesce(string_agg(tbl, ',' order by tbl), '') from ck.counts where job = 'pre_b' and n = 0$$, '');
select ck.val('KS4 the finance lines are in the pre-closure export (3 of them)',
  $$select n::text from ck.counts where job = 'pre_a' and tbl = 'financial_entries'$$, '3');
select ck.val('KS5 THE CONTRACT: the pre-closure export carries the Owner''s private note and the colleague''s company one, NOT the colleague''s private one',
  $$select n::text from ck.counts where job = 'pre_a' and tbl = 'notes'$$, '2');

-- ===========================================================================
-- § KA SCENARIO A -- CLOSE, THEN BUILD THE BACKUP.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'owner_a_c';
insert into ck.ids select 'bk_a', public.close_my_workspace(:'org_a', 'ck-backup-alpha', 'ck closing')::text;
reset role;
reset request.jwt.claims;
select v as bk_a from ck.ids where k = 'bk_a' \gset

update public.export_jobs set status = 'running' where id = :'bk_a';
select ck.count_job('bk_a', :'bk_a');

select ck.val('KA0 FIXTURE: the workspace is owner_closed with deleted_at set while the backup is read',
  format($$select lifecycle_state || ':' || (deleted_at is not null)::text from public.organisations where id = %L$$, :'org_a'),
  'owner_closed:true');
select ck.val('KA1 THE BACKUP IS COMPLETE: every table''s row count equals the pre-closure export''s (lists any that differ)',
  $$select coalesce(string_agg(p.tbl || '=' || p.n || '/' || coalesce(b.n::text, 'missing'), ',' order by p.tbl), '')
      from ck.counts p left join ck.counts b on b.job = 'bk_a' and b.tbl = p.tbl
     where p.job = 'pre_a' and b.n is distinct from p.n$$, '');
select ck.val('KA2 ...the finance lines specifically (C1)',
  $$select n::text from ck.counts where job = 'bk_a' and tbl = 'financial_entries'$$, '3');
select ck.val('KA3 ...the network profile, link and request specifically',
  $$select string_agg(tbl || '=' || n, ',' order by tbl) from ck.counts
     where job = 'bk_a' and tbl in ('network_profiles', 'network_links', 'network_connection_requests')$$,
  'network_connection_requests=1,network_links=1,network_profiles=1');
select ck.val('KA4 NO WIDER: the colleague''s private note is still not in it',
  format($$select (public.export_read_page(%L, 'notes', '', 500)::text like '%%CK colleague PRIVATE%%')::text$$, :'bk_a'),
  'false');
set role authenticated;
set request.jwt.claims = :'owner_a_c';
select ck.val('KA5 the admission is a closure_backup read only: the Owner''s own session still cannot read the closed workspace''s finance (Q205 unchanged)',
  format($$select count(*)::text from public.financial_entries where organisation_id = %L$$, :'org_a'), '0');
select ck.val('KA6 ...and a forged marker row is not the Owner''s to write',
  format($$insert into private.closure_backup_reads (xact, organisation_id) values (pg_catalog.pg_current_xact_id(), %L) returning 'written'$$, :'org_a'),
  'denied(42501:missing_grant)');
reset role;
reset request.jwt.claims;
select ck.val('KA7 the engine leaves no marker row behind',
  $$select count(*)::text from private.closure_backup_reads$$, '0');

-- ===========================================================================
-- § KM THE MARKER ITSELF (Q227, controller 2026-10-05, pending founder). The
-- marker sits inside permitted_organisations()/has_permission(), which the
-- masking views call, so network_leakage_phase6.sql § LF5 allowlists it by
-- name. These are the two facts that allowlist rests on: no API role can
-- touch the table at all, and a marker row admits its own transaction only.
-- ===========================================================================
select ck.val('KM1 no API role holds SELECT/INSERT/UPDATE/DELETE on the marker table (12 checks, 0 held)',
  $$select count(*)::text || ' checks, ' || count(*) filter (where pg_catalog.has_table_privilege(r, 'private.closure_backup_reads', p))::text || ' held'
      from unnest(array['anon','authenticated','service_role']) r,
           unnest(array['SELECT','INSERT','UPDATE','DELETE']) p$$,
  '12 checks, 0 held');
select ck.val('KM1b ...nor on any column of it (a column grant would slip past the table check)',
  $$select count(*)::text from information_schema.column_privileges
     where table_schema = 'private' and table_name = 'closure_backup_reads'
       and grantee in ('anon','authenticated','service_role','PUBLIC')$$, '0');
-- ISOLATION. Transaction X plants a marker for org A and commits it (the
-- engine never commits one; this is the worst case: a row left behind).
begin;
insert into private.closure_backup_reads (xact, organisation_id, export_job_id)
values (pg_catalog.pg_current_xact_id(), :'org_a', :'bk_a');
select ck.val('KM2a POSITIVE CONTROL: in transaction X the marker admits org A',
  format($$select private.closure_backup_read_admits(%L)::text$$, :'org_a'), 'true');
select ck.val('KM2b ...and only org A, even in X',
  format($$select private.closure_backup_read_admits(%L)::text$$, :'org_x'), 'false');
commit;
begin;
-- Y has its own transaction id assigned BEFORE the probe, so the probe is
-- not false merely because pg_current_xact_id_if_assigned() is null.
select pg_catalog.pg_current_xact_id() is not null as y_assigned \gset
select ck.val('KM2c ISOLATION: in transaction Y, X''s committed marker admits nothing',
  format($$select (%L::boolean and pg_catalog.pg_current_xact_id_if_assigned() is not null
                   and not private.closure_backup_read_admits(%L))::text$$, :'y_assigned', :'org_a'), 'true');
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', :'owner_a_c', true) \gset
select ck.val('KM2d ...so the closed workspace is NOT live for the Owner''s finance read in Y',
  format($$select (%L::uuid in (select private.permitted_organisations('view_finance')))::text || '/' ||
                  public.has_permission(%L, 'view_finance')::text$$, :'org_a', :'org_a'), 'false/false');
commit;
delete from private.closure_backup_reads;

-- ===========================================================================
-- § KE SCENARIO B -- CLOSE, THEN ERASE THE OWNER BEFORE THE BACKUP RUNS.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'owner_b_c';
insert into ck.ids select 'bk_b', public.close_my_workspace(:'org_b', 'ck-backup-beta', 'ck closing')::text;
reset role;
reset request.jwt.claims;
select v as bk_b from ck.ids where k = 'bk_b' \gset

select ck.val('KE1 the erasure WAITS while the closure backup is queued (I2)',
  format($$select private.erase_account(%L, null)::text$$, :'owner_b'),
  'denied(55000:closure_backup_not_built)');
update public.export_jobs set status = 'running' where id = :'bk_b';
select ck.val('KE2 ...and while it is running',
  format($$select private.erase_account(%L, null)::text$$, :'owner_b'),
  'denied(55000:closure_backup_not_built)');
select ck.count_job('bk_b', :'bk_b');
select ck.val('KE3 THE BACKUP IS COMPLETE, built as the closing Owner: every table''s count equals the pre-closure export''s',
  $$select coalesce(string_agg(p.tbl || '=' || p.n || '/' || coalesce(b.n::text, 'missing'), ',' order by p.tbl), '')
      from ck.counts p left join ck.counts b on b.job = 'bk_b' and b.tbl = p.tbl
     where p.job = 'pre_b' and b.n is distinct from p.n$$, '');
update public.export_jobs
   set status = 'succeeded', storage_key = 'exports/' || id::text || '.zip', byte_size = 1, row_count = 1,
       manifest = '{}'::jsonb, expires_at = now() + interval '60 days'
 where id = :'bk_b';
select ck.val('KE3b RETENTION (ephemeral): no marker row survives a completed backup build',
  $$select count(*)::text from private.closure_backup_reads$$, '0');
select ck.val('KE4 once the backup is built, the erasure proceeds (positive control for KE1/KE2)',
  format($$select (private.erase_account(%L, null) ? 'export_jobs.closure_backups_kept')::text$$, :'owner_b'), 'true');
select ck.val('KE5 ...and the built backup row survives, re-pointed at the tombstone (Q206 unchanged)',
  format($$select (requested_by = private.erased_user_id())::text || ':' || status from public.export_jobs where id = %L$$, :'bk_b'),
  'true:succeeded');

-- ===========================================================================
-- § KT THE BELT -- a running closure backup whose requester is the tombstone
-- (reachable only if the KE wait is ever bypassed) is refused, not built empty.
-- Planted under the erasure marker in a transaction that is rolled back.
-- ===========================================================================
begin;
select pg_catalog.set_config('app.erasing_account', requested_by::text, true)
  from public.export_jobs where id = :'bk_a' \gset
update public.export_jobs set requested_by = private.erased_user_id() where id = :'bk_a';
select ck.val('KT1 a closure backup read as the TOMBSTONE is refused by the engine',
  format($$select jsonb_array_length(public.export_read_page(%L, 'contacts', '', 500))::text$$, :'bk_a'),
  'denied(55000:closure_backup_requester_erased)');
select label as kt_label, expected as kt_expected, actual as kt_actual from ck.results where label like 'KT1%' \gset
rollback;
select ck.record(:'kt_label', :'kt_expected', :'kt_actual');

-- ===========================================================================
-- § KZ HOUSEKEEPING (organisations first: memberships and rows cascade)
-- ===========================================================================
set session_replication_role = replica;
delete from public.audit_events where organisation_id in (:'org_a', :'org_b', :'org_x')
   or actor_user_id in (:'owner_a', :'mgr_a', :'mgr_b', :'su_u', :'x_u');
delete from public.export_jobs where organisation_id in (:'org_a', :'org_b', :'org_x');
delete from public.impersonation_sessions where target_organisation_id in (:'org_a', :'org_b');
delete from public.organisation_feature_overrides where organisation_id in (:'org_a', :'org_b');
delete from public.organisation_billing_overrides where organisation_id in (:'org_a', :'org_b');
delete from public.merges where organisation_id in (:'org_a', :'org_b');
delete from public.network_connection_requests where from_organisation_id in (:'org_a', :'org_b');
delete from public.organisations where id in (:'org_a', :'org_b', :'org_x');
set session_replication_role = origin;
delete from auth.users where id in (:'owner_a', :'mgr_a', :'mgr_b', :'su_u', :'x_u');

\echo
\echo ==================== CLOSURE BACKUP COMPLETENESS ====================
select seq, label, expected, actual, pass from ck.results order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from ck.results;
select tbl, max(n) filter (where job = 'pre_a') as pre_a, max(n) filter (where job = 'bk_a') as bk_a,
       max(n) filter (where job = 'pre_b') as pre_b, max(n) filter (where job = 'bk_b') as bk_b
  from ck.counts group by tbl order by tbl;
