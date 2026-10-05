-- ===========================================================================
-- PHASE 8 TASK 9c, JOB 1 -- AN OWNER CLOSES THEIR OWN WORKSPACE
-- (20261021000000; founder 2026-09-30, Q176/Q178 changed, reversing Q104).
--
--   CF  fixtures and their positive controls (every write below succeeds
--       BEFORE the closure, so a refusal after it is the closure's doing)
--   CG  the guards: grant, session, aal2, Owner, confirmation, reason
--   CD  the direct UPDATE of the lifecycle columns is still refused
--   CC  the closure itself, its audit row and its backup
--   CW  closed = read-only: one write per phase refused, reads still work
--   CB  the backup: not client-insertable, refused outside the RPC,
--       immutable, retained to the workspace's own retention clock
--   CP  the Q88 60-day purge still reaches a closed workspace
--   CS  job 2: the superuser's decision item, queue and the decisions' gates
--   CQ  job 2, Q206: the closing Owner erases their account; the backup stays
--   CR  job 2: reassign to an active member reopens the workspace, notified
--   CX  job 2: permanent delete reuses the Q88 purge, notified
--   CZ  housekeeping
--
-- Self-contained: its own users, two workspaces and their rows, removed in CZ.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists cw cascade;
create schema cw;

create table cw.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function cw.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into cw.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function cw.try(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_rows bigint; v_actual text; v_hint text;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_actual := 'ok(' || v_rows || ')';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint like 'Grant the required privileges%' then v_hint := 'missing_grant'; end if;
    v_actual := 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
  perform cw.record(p_label, p_expected, v_actual);
end $$;

create function cw.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text; v_hint text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    v_actual := 'denied(' || sqlstate || coalesce(':' || nullif(v_hint, ''), '') || ')';
  end;
  perform cw.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema cw to authenticated, anon, service_role;
grant execute on function cw.record(text,text,text) to authenticated, anon, service_role;
grant execute on function cw.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function cw.val(text,text,text)    to authenticated, anon, service_role;
create table cw.ids (k text primary key, v text);
grant usage on schema cw to authenticated;
grant select, insert on cw.ids to authenticated;

-- ---------------------------------------------------------------------------
-- FIXTURES
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as owner_u  \gset
select gen_random_uuid()::text as mgr_u    \gset
select gen_random_uuid()::text as other_u  \gset
select gen_random_uuid()::text as org_a    \gset
select gen_random_uuid()::text as org_b    \gset
select gen_random_uuid()::text as comp_a   \gset
select gen_random_uuid()::text as comp_b   \gset
select gen_random_uuid()::text as comp_a2  \gset
select gen_random_uuid()::text as prof_a   \gset
select gen_random_uuid()::text as prof_a2  \gset
select gen_random_uuid()::text as prof_b   \gset
select gen_random_uuid()::text as event_a  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'owner_u') as owner_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'owner_u') as owner_c1 \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'mgr_u')   as mgr_c    \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'other_u') as other_c  \gset
\o

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'owner_u', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cw-owner@test.local', now(), now(), now()),
       (:'mgr_u',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cw-mgr@test.local',   now(), now(), now()),
       (:'other_u', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cw-other@test.local', now(), now(), now());

insert into public.organisations (id, name, slug) values
  (:'org_a', 'Closure Alpha', 'cw-closure-alpha'),
  (:'org_b', 'Closure Beta',  'cw-closure-beta');
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'org_a', 'pro', 'monthly', 3, 'active', now() + interval '30 days'),
       (:'org_b', 'pro', 'monthly', 3, 'active', now() + interval '30 days')
on conflict (organisation_id) do update set plan_id = 'pro', status = 'active';
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at) values
  (:'org_a', :'owner_u', 'owner',   'active', now()),
  (:'org_a', :'mgr_u',   'manager', 'active', now()),
  (:'org_b', :'other_u', 'owner',   'active', now());

set session_replication_role = replica;
insert into public.companies (id, organisation_id, name) values
  (:'comp_a', :'org_a', 'CW Venue Co'), (:'comp_a2', :'org_a', 'CW Venue Two'), (:'comp_b', :'org_b', 'CW Other Co');
insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, display_name, status, published_at) values
  (:'prof_a',  :'org_a', 'company', :'comp_a', 'CW Alpha',       'published', now()),
  (:'prof_a2', :'org_a', 'company', :'comp_a2', 'CW Alpha draft', 'draft',     null),
  (:'prof_b',  :'org_b', 'company', :'comp_b', 'CW Beta',        'published', now());
insert into public.events (id, organisation_id, name, starts_at)
values (:'event_a', :'org_a', 'CW Night', now() + interval '10 days');
set session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- § CF POSITIVE CONTROLS -- every write § CW refuses, succeeding while ACTIVE.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'owner_c';
select cw.try('CF1 ACTIVE: the Owner creates a contact',
  format($$insert into public.contacts (organisation_id, name) values (%L, 'CW before')$$, :'org_a'), 'ok(1)');
select cw.try('CF2 ACTIVE: the Owner creates an event',
  format($$insert into public.events (organisation_id, name, starts_at) values (%L, 'CW before', now())$$, :'org_a'), 'ok(1)');
select cw.try('CF3 ACTIVE: the Owner creates a task',
  format($$insert into public.tasks (organisation_id, title) values (%L, 'CW before')$$, :'org_a'), 'ok(1)');
select cw.try('CF4 ACTIVE: the Owner writes a note',
  format($$insert into public.notes (organisation_id, body) values (%L, 'CW before')$$, :'org_a'), 'ok(1)');
select cw.try('CF5 ACTIVE: the Owner registers a document upload (the row the upload path writes first)',
  format($$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes)
           values (%L, 'cw.pdf', %L, 'application/pdf', 1)$$, :'org_a', :'org_a' || '/cw-before.pdf'), 'ok(1)');
select cw.try('CF6 ACTIVE: the Owner books a finance entry',
  format($$insert into public.financial_entries (organisation_id, event_id, category, amount_minor) values (%L, %L, 'fee', 100)$$,
    :'org_a', :'event_a'), 'ok(1)');
select cw.try('CF7 ACTIVE: the Owner publishes a draft network profile',
  format($$update public.network_profiles set status = 'published', published_at = now() where id = %L$$, :'prof_a2'), 'ok(1)');
select cw.try('CF8 ACTIVE: the Owner sends a connection request',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
           values (%L, %L, %L, %L)$$, :'org_a', :'prof_a', :'org_b', :'prof_b'), 'ok(1)');
select cw.try('CF9 ACTIVE: an ordinary workspace export is queued (the closure must not collide with it)',
  format($$insert into public.export_jobs (kind, organisation_id) values ('workspace', %L)$$, :'org_a'), 'ok(1)');
select cw.try('CF10 ACTIVE: the Owner flips the draft back (re-arm CW7)',
  format($$update public.network_profiles set status = 'draft', published_at = null where id = %L$$, :'prof_a2'), 'ok(1)');
reset role; reset request.jwt.claims;
-- The pending request would make CW8 a unique-pair refusal, not the closure's.
delete from public.network_connection_requests where from_organisation_id = :'org_a';
select cw.val('CF11 FIXTURE: no live request left between the two workspaces',
  format($$select count(*)::text from public.network_connection_requests where from_organisation_id = %L$$, :'org_a'), '0');

-- ---------------------------------------------------------------------------
-- § CG THE GUARDS
-- ---------------------------------------------------------------------------
set role anon;
select cw.try('CG1 anon holds no EXECUTE',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'x')$$, :'org_a'), 'denied(42501)');
reset role;
set role authenticated;
select cw.try('CG2 a session-less authenticated call is refused',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'x')$$, :'org_a'), 'denied(42501:close_needs_a_session)');
set request.jwt.claims = :'owner_c1';
select cw.try('CG3 the Owner at aal1 is refused: step-up first',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'x')$$, :'org_a'), 'denied(42501:close_needs_step_up)');
set request.jwt.claims = :'mgr_c';
select cw.try('CG4 an aal2 MANAGER of the workspace is refused: Owners only',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'x')$$, :'org_a'), 'denied(42501:close_needs_an_owner)');
set request.jwt.claims = :'other_c';
select cw.try('CG5 the aal2 Owner of ANOTHER workspace is refused',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'x')$$, :'org_a'), 'denied(42501:close_needs_an_owner)');
select cw.try('CG5b ...and an unknown workspace id answers the same refusal (no existence oracle)',
  $$select public.close_my_workspace(gen_random_uuid(), 'cw-closure-alpha', 'x')$$, 'denied(42501:close_needs_an_owner)');
set request.jwt.claims = :'owner_c';
select cw.try('CG6 the confirmation must be the slug, not the name',
  format($$select public.close_my_workspace(%L, 'Closure Alpha', 'x')$$, :'org_a'), 'denied(22023:close_confirmation_mismatch)');
select cw.try('CG6b ...exactly: an upper-cased slug is refused',
  format($$select public.close_my_workspace(%L, 'CW-CLOSURE-ALPHA', 'x')$$, :'org_a'), 'denied(22023:close_confirmation_mismatch)');
select cw.try('CG6c ...and a null confirmation is refused',
  format($$select public.close_my_workspace(%L, null, 'x')$$, :'org_a'), 'denied(22023:close_confirmation_mismatch)');
select cw.try('CG7 a blank reason is refused',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', '   ')$$, :'org_a'), 'denied(22023:close_reason_required)');
select cw.try('CG7b a null reason is refused',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', null)$$, :'org_a'), 'denied(22023:close_reason_required)');
select cw.try('CG7c a 501-character reason is refused',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', repeat('r', 501))$$, :'org_a'), 'denied(22023:close_reason_too_long)');
reset role; reset request.jwt.claims;
select cw.val('CG8 every refusal above left the workspace ACTIVE and wrote no closure audit row',
  format($$select (o.lifecycle_state = 'active' and o.deleted_at is null
                   and not exists (select 1 from public.audit_events a
                                    where a.organisation_id = o.id and a.action = 'organisation.closed_by_owner'))::text
             from public.organisations o where o.id = %L$$, :'org_a'), 'true');

-- ---------------------------------------------------------------------------
-- § CD THE DIRECT UPDATE IS STILL REFUSED (the RPC is the only way to close)
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'owner_c';
select cw.try('CD1 the aal2 Owner cannot UPDATE lifecycle_state directly',
  format($$update public.organisations set lifecycle_state = 'owner_closed', deleted_at = now(),
             lifecycle_reason = 'direct' where id = %L$$, :'org_a'), 'denied(42501:organisation_lifecycle_is_the_rpcs)');
select cw.try('CD2 ...nor deleted_at alone (the pre-Task-3 self-suspension path)',
  format($$update public.organisations set deleted_at = now() where id = %L$$, :'org_a'), 'denied(42501:organisation_lifecycle_is_the_rpcs)');
select cw.try('CD3 POSITIVE CONTROL: the same Owner may still rename the workspace (the policy admits the row)',
  format($$update public.organisations set name = 'Closure Alpha' where id = %L$$, :'org_a'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- § CC THE CLOSURE
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'owner_c';
select cw.try('CC1 the aal2 Owner closes with the slug and a padded reason',
  format($$insert into cw.ids select 'job', public.close_my_workspace(%L, 'cw-closure-alpha', '  moving to another tool  ')::text$$, :'org_a'),
  'ok(1)');
select cw.try('CC2 a second close is refused: the workspace is not active',
  format($$select public.close_my_workspace(%L, 'cw-closure-alpha', 'again')$$, :'org_a'), 'denied(22023:workspace_not_active)');
reset role; reset request.jwt.claims;
\o /dev/null
select v as job from cw.ids where k = 'job' \gset
\o
select cw.val('CC3 the state is owner_closed, deleted_at set, reason trimmed',
  format($$select lifecycle_state || '/' || (deleted_at is not null)::text || '/' || lifecycle_reason
             from public.organisations where id = %L$$, :'org_a'), 'owner_closed/true/moving to another tool');
select cw.val('CC4 the Q88 clock runs: retention_expires_at = lifecycle_changed_at + 60 days',
  format($$select (retention_expires_at - lifecycle_changed_at = make_interval(days => private.organisation_retention_days()))::text
             from public.organisations where id = %L$$, :'org_a'), 'true');
select cw.val('CC5 the backup: a queued WORKSPACE export of this org, closure_backup, requested by the Owner at aal2',
  format($$select kind || '/' || status || '/' || closure_backup::text || '/' || (requested_by = %L)::text || '/' || requested_aal
             from public.export_jobs where id = %L and organisation_id = %L$$, :'owner_u', :'job', :'org_a'),
  'workspace/queued/true/true/aal2');
select cw.val('CC5b ...beside the ordinary export CF9 queued (the one-live-job index exempts it)',
  format($$select count(*)::text from public.export_jobs where organisation_id = %L and status = 'queued'$$, :'org_a'), '2');
select cw.val('CC6 one organisation.closed_by_owner row: actor = the Owner, reason and backup id in the payload',
  format($$select count(*)::text || '/' || bool_and(actor_user_id = %L)::text || '/' ||
                  bool_and(after ->> 'reason' = 'moving to another tool')::text || '/' ||
                  bool_and(after ->> 'backup_export_job_id' = %L)::text || '/' ||
                  bool_and(before ->> 'lifecycle_state' = 'active')::text
             from public.audit_events where organisation_id = %L and action = 'organisation.closed_by_owner'$$,
    :'owner_u', :'job', :'org_a'), '1/true/true/true/true');
select cw.val('CC7 the closure and the backup''s export_job.requested share one correlation thread',
  format($$select (a.correlation_id = b.correlation_id)::text
             from public.audit_events a, public.audit_events b
            where a.organisation_id = %L and a.action = 'organisation.closed_by_owner'
              and b.target_id = %L and b.action = 'export_job.requested'$$, :'org_a', :'job'), 'true');
select cw.val('CC8 the closure is findable the way job 2 will look: latest closure_backup row of the org',
  format($$select id::text from public.export_jobs where organisation_id = %L and closure_backup
            order by requested_at desc limit 1$$, :'org_a'), :'job');

-- ---------------------------------------------------------------------------
-- § CW CLOSED = READ-ONLY. One write per phase, each succeeding in § CF.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'owner_c';
select cw.try('CW1 CLOSED: the Owner cannot create a contact (Phase 2)',
  format($$insert into public.contacts (organisation_id, name) values (%L, 'CW after')$$, :'org_a'), 'denied(42501)');
select cw.try('CW2 CLOSED: ...nor an event (Phase 3)',
  format($$insert into public.events (organisation_id, name, starts_at) values (%L, 'CW after', now())$$, :'org_a'), 'denied(42501)');
select cw.try('CW3 CLOSED: ...nor a task (Phase 4)',
  format($$insert into public.tasks (organisation_id, title) values (%L, 'CW after')$$, :'org_a'), 'denied(42501)');
select cw.try('CW4 CLOSED: ...nor a note (Phase 4)',
  format($$insert into public.notes (organisation_id, body) values (%L, 'CW after')$$, :'org_a'), 'denied(42501)');
select cw.try('CW5 CLOSED: ...nor register a document upload (Phase 4)',
  format($$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes)
           values (%L, 'cw.pdf', %L, 'application/pdf', 1)$$, :'org_a', :'org_a' || '/cw-after.pdf'), 'denied(42501)');
select cw.try('CW6 CLOSED: ...nor book a finance entry (Phase 5)',
  format($$insert into public.financial_entries (organisation_id, event_id, category, amount_minor) values (%L, %L, 'fee', 100)$$,
    :'org_a', :'event_a'), 'denied(42501)');
select cw.try('CW7 CLOSED: ...nor publish a network profile (Phase 6) -- the row is out of the UPDATE policy''s reach',
  format($$update public.network_profiles set status = 'published', published_at = now() where id = %L$$, :'prof_a2'), 'ok(0)');
select cw.try('CW8 CLOSED: ...nor send a connection request (Phase 6)',
  format($$insert into public.network_connection_requests
             (from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
           values (%L, %L, %L, %L)$$, :'org_a', :'prof_a', :'org_b', :'prof_b'), 'denied(42501)');
select cw.try('CW9 CLOSED: ...nor edit an existing contact',
  format($$update public.contacts set name = 'CW edited' where organisation_id = %L$$, :'org_a'), 'ok(0)');
select cw.try('CW10 CLOSED: ...nor reopen it by clearing deleted_at (policy USING: the row is out of reach)',
  format($$update public.organisations set deleted_at = null where id = %L$$, :'org_a'), 'ok(0)');
-- The finance figure is 0, not 1, and that is the PRE-EXISTING suspension
-- rule, not this task's: private.finance_module_organisations() gates the
-- finance READ on deleted_at, so a suspended workspace has always hidden its
-- finance lines from members. A closed one inherits it (DECISIONS-QUEUE Q205;
-- the closure backup still carries them). Pinned so a change is a decision.
select cw.val('CW11 READS STILL WORK: the Owner reads the contact, event, task and note rows (finance: hidden, Q205)',
  format($$select (select count(*) from public.contacts where organisation_id = %1$L) || '/' ||
                  (select count(*) from public.events where organisation_id = %1$L) || '/' ||
                  (select count(*) from public.tasks where organisation_id = %1$L) || '/' ||
                  (select count(*) from public.notes where organisation_id = %1$L) || '/' ||
                  (select count(*) from public.financial_entries where organisation_id = %1$L)$$, :'org_a'),
  '1/2/1/1/0');
-- EACH GATE ON ITS OWN. The writes above are refused by TWO gates at once
-- (the permission catalogue's survives_suspension join AND the CRM/network
-- write gate), so a mutant that opens ONE of them leaves CW1-CW8 green
-- (measured: 20f-crm-writes-ignore-closure went 0/58 red before these). Each
-- gate is therefore asserted separately, as the Owner, after the closure.
select cw.val('CW14a GATE: the closed workspace is NOT in private.crm_write_organisations()',
  format($$select (%L::uuid in (select private.crm_write_organisations()))::text$$, :'org_a'), 'false');
select cw.val('CW14b GATE: ...NOT in permitted_organisations(manage_contacts) (the catalogue join)',
  format($$select (%L::uuid in (select private.permitted_organisations('manage_contacts')))::text$$, :'org_a'), 'false');
select cw.val('CW14c GATE: ...NOT live for private.organisation_is_live()',
  format($$select private.organisation_is_live(%L)::text$$, :'org_a'), 'false');
select cw.val('CW14d GATE: ...NOT in private.network_publish_organisations()',
  format($$select (%L::uuid in (select private.network_publish_organisations()))::text$$, :'org_a'), 'false');
select cw.val('CW14e GATE: ...NOT in private.finance_module_organisations()',
  format($$select (%L::uuid in (select private.finance_module_organisations()))::text$$, :'org_a'), 'false');
select cw.val('CW14f READ GATE: ...but STILL in permitted_organisations(view_crm)',
  format($$select (%L::uuid in (select private.permitted_organisations('view_crm')))::text$$, :'org_a'), 'true');
set request.jwt.claims = :'mgr_c';
select cw.val('CW12 READS STILL WORK for a non-Owner member, and their write is refused too',
  format($$select (select count(*) from public.contacts where organisation_id = %L)::text$$, :'org_a'), '1');
select cw.try('CW12b the Manager cannot create a contact in the closed workspace',
  format($$insert into public.contacts (organisation_id, name) values (%L, 'CW mgr')$$, :'org_a'), 'denied(42501)');
reset role; reset request.jwt.claims;
select cw.val('CW13 nothing a refused write tried landed (the closed workspace still holds exactly the CF rows)',
  format($$select (select count(*) from public.contacts where organisation_id = %1$L) || '/' ||
                  (select count(*) from public.network_connection_requests where from_organisation_id = %1$L) || '/' ||
                  (select status from public.network_profiles where id = %2$L) || '/' ||
                  (select lifecycle_state from public.organisations where id = %1$L)$$, :'org_a', :'prof_a2'),
  '1/0/draft/owner_closed');

-- ---------------------------------------------------------------------------
-- § CB THE BACKUP'S FENCES
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'other_c';
select cw.try('CB1 a client cannot even name closure_backup on INSERT (column-level grant)',
  format($$insert into public.export_jobs (kind, organisation_id, closure_backup) values ('workspace', %L, true)$$, :'org_b'),
  'denied(42501:missing_grant)');
reset role;
-- A writer with every grant (postgres) and a valid session, OUTSIDE the RPC.
set request.jwt.claims = :'other_c';
select cw.try('CB2 outside close_my_workspace() the trigger refuses a closure backup, even for a fully-privileged writer',
  format($$insert into public.export_jobs (kind, organisation_id, closure_backup) values ('workspace', %L, true)$$, :'org_b'),
  'denied(42501:closure_backup_is_the_rpcs)');
select set_config('app.workspace_closure_backup', :'org_b', false) \g /dev/null
select cw.try('CB3 ...and the marker alone is not enough: the workspace was not closed in this transaction',
  format($$insert into public.export_jobs (kind, organisation_id, closure_backup) values ('workspace', %L, true)$$, :'org_b'),
  'denied(42501:closure_backup_is_the_rpcs)');
select set_config('app.workspace_closure_backup', '', false) \g /dev/null
reset request.jwt.claims;
select cw.try('CB4 closure_backup is immutable (an ordinary job cannot be turned into a backup)',
  format($$update public.export_jobs set closure_backup = true where organisation_id = %L and not closure_backup$$, :'org_a'),
  'denied(42501:export_request_is_immutable)');
select cw.try('CB5 ...nor a backup into an ordinary job',
  format($$update public.export_jobs set closure_backup = false where id = %L$$, :'job'),
  'denied(42501:export_request_is_immutable)');
\o /dev/null
update public.export_jobs set status = 'running' where id = :'job';
update public.export_jobs set status = 'succeeded', storage_key = 'exports/' || :'job' || '.zip',
       byte_size = 1, row_count = 1, table_count = 1, manifest = '{}'::jsonb where id = :'job';
\o
select cw.val('CB6 a finished backup is kept until the closed workspace''s own retention clock, not 7 days',
  format($$select (j.expires_at = o.retention_expires_at)::text
             from public.export_jobs j join public.organisations o on o.id = j.organisation_id
            where j.id = %L$$, :'job'), 'true');

-- ---------------------------------------------------------------------------
-- § CP THE 60-DAY PURGE STILL APPLIES (its selection is state-agnostic)
-- ---------------------------------------------------------------------------
\o /dev/null
select (private.sweep_expired_workspaces(true, 100000) ->> 'organisations.purged')::int as before_n \gset
begin;
set local session_replication_role = replica;
update public.organisations set retention_expires_at = now() - interval '1 day' where id = :'org_a';
select (private.sweep_expired_workspaces(true, 100000) ->> 'organisations.purged')::int as after_n \gset
rollback;
\o
select cw.val('CP1 a closed workspace past its clock is one more workspace the purge would take',
  format($$select (%s - %s)::text$$, :'after_n', :'before_n'), '1');

-- ---------------------------------------------------------------------------
-- § CS THE SUPERUSER'S DECISION ITEM AND ITS GATES (Task 9c job 2,
--      20261022001000). Org A is owner_closed here; org B is still active.
-- ---------------------------------------------------------------------------
\o /dev/null
select gen_random_uuid()::text as su_u \gset
select gen_random_uuid()::text as view_u \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal2"}', :'su_u') as su_c  \gset
select format('{"sub":"%s","role":"authenticated","aal":"aal1"}', :'su_u') as su_c1 \gset
select private.erased_user_id()::text as tomb_u \gset
\o
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'su_u', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cw-su@test.local', now(), now(), now());
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values (:'view_u', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cw-viewer@test.local', now(), now(), now());
insert into public.platform_admins (user_id) values (:'su_u');
-- A NON-admin member of org B: the decision notice must NOT address them.
insert into public.organisation_memberships (organisation_id, user_id, role, status, joined_at)
values (:'org_b', :'view_u', 'manager', 'active', now());

select cw.val('CS1 the closure is on the superuser''s email queue: slug, name, closed-at, nothing else',
  format($$select organisation_slug || '/' || organisation_name || '/' || (closed_at is not null)::text
             from public.pending_workspace_closure_notifications(30) q
             join public.audit_events a on a.id = q.audit_event_id
            where a.organisation_id = %L$$, :'org_a'), 'cw-closure-alpha/Closure Alpha/true');

set role authenticated;
set request.jwt.claims = :'su_c';
select cw.val('CS2 the aal2 superuser''s dashboard list shows the closed workspace with its backup''s status',
  format($$select slug || '/' || active_members::text || '/' || backup_status || '/' || (backup_export_job_id = %L)::text
             from public.closed_workspaces_awaiting_decision(null, null, 25) where organisation_id = %L$$, :'job', :'org_a'),
  'cw-closure-alpha/2/succeeded/true');
select cw.val('CS2b ...and only owner_closed workspaces (the active org B is not on it)',
  format($$select count(*)::text from public.closed_workspaces_awaiting_decision(null, null, 50) where organisation_id = %L$$, :'org_b'), '0');
set request.jwt.claims = :'su_c1';
select cw.try('CS3 the list refuses the superuser at aal1',
  $$select * from public.closed_workspaces_awaiting_decision(null, null, 25)$$, 'denied(42501:decision_needs_superuser)');
set request.jwt.claims = :'mgr_c';
select cw.try('CS3b ...and a member of the closed workspace',
  $$select * from public.closed_workspaces_awaiting_decision(null, null, 25)$$, 'denied(42501:decision_needs_superuser)');
select cw.try('CS3c a member cannot read the superuser''s email queue (service_role only)',
  $$select * from public.pending_workspace_closure_notifications(30)$$, 'denied(42501)');

-- THE GATES, both RPCs, each refusal leaving org A owner_closed.
set request.jwt.claims = :'mgr_c';
select cw.try('CS4 an aal2 MEMBER of the closed workspace cannot reassign it (superuser gate)',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'take it')$$, :'mgr_u'), 'denied(42501:decision_needs_superuser)');
select cw.try('CS4b ...nor delete it',
  $$select public.delete_closed_workspace('cw-closure-alpha', 'gone')$$, 'denied(42501:decision_needs_superuser)');
set request.jwt.claims = :'su_c1';
select cw.try('CS5 the superuser at aal1 cannot reassign (step-up)',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'take it')$$, :'mgr_u'), 'denied(42501:decision_needs_step_up)');
select cw.try('CS5b ...nor delete',
  $$select public.delete_closed_workspace('cw-closure-alpha', 'gone')$$, 'denied(42501:decision_needs_step_up)');
set request.jwt.claims = :'su_c';
select cw.try('CS6 a blank reason is refused (reassign)',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, '  ')$$, :'mgr_u'), 'denied(22023:decision_reason_required)');
select cw.try('CS6b a null reason is refused (delete)',
  $$select public.delete_closed_workspace('cw-closure-alpha', null)$$, 'denied(22023:decision_reason_required)');
select cw.try('CS6c a 501-character reason is refused',
  $$select public.delete_closed_workspace('cw-closure-alpha', repeat('r', 501))$$, 'denied(22023:decision_reason_too_long)');
select cw.try('CS7 an ACTIVE workspace is not awaiting a decision (reassign)',
  format($$select public.reassign_closed_workspace('cw-closure-beta', %L, 'x')$$, :'other_u'), 'denied(22023:decision_workspace_not_owner_closed)');
select cw.try('CS7b ...nor (delete)',
  $$select public.delete_closed_workspace('cw-closure-beta', 'x')$$, 'denied(22023:decision_workspace_not_owner_closed)');
select cw.try('CS7c an unknown slug is refused',
  $$select public.delete_closed_workspace('cw-no-such-workspace', 'x')$$, 'denied(22023:decision_no_such_workspace)');
select cw.try('CS8 the new Owner must be an ACTIVE MEMBER: an outsider (org B''s Owner) is refused',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'x')$$, :'other_u'), 'denied(22023:new_owner_must_be_active_member)');
select cw.try('CS8b ...and so is the tombstone',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'x')$$, :'tomb_u'), 'denied(22023:new_owner_must_be_active_member)');
reset role; reset request.jwt.claims;
update public.organisation_memberships set status = 'revoked' where organisation_id = :'org_a' and user_id = :'mgr_u';
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CS8c ...and so is a REVOKED member',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'x')$$, :'mgr_u'), 'denied(22023:new_owner_must_be_active_member)');
reset role; reset request.jwt.claims;
update public.organisation_memberships set status = 'active' where organisation_id = :'org_a' and user_id = :'mgr_u';
-- Q222 (fix round 1b, review m2): the platform superuser is never the new
-- Owner. The active Manager is made a platform admin for these three lines
-- only (as postgres), then demoted again; CS8f is the positive control that
-- the exclusion, not something else, removed them from the picker.
insert into public.platform_admins (user_id) values (:'mgr_u');
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CS8d ...and so is an active member who is a PLATFORM SUPERUSER (Q222)',
  format($$select public.reassign_closed_workspace('cw-closure-alpha', %L, 'x')$$, :'mgr_u'), 'denied(22023:new_owner_is_platform_superuser)');
select cw.val('CS8e ...and the picker does not offer them',
  format($$select count(*)::text from public.closed_workspace_reassign_candidates(%L) c where c.user_id = %L$$, :'org_a', :'mgr_u'), '0');
reset role; reset request.jwt.claims;
delete from public.platform_admins where user_id = :'mgr_u';
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.val('CS8f POSITIVE CONTROL: demoted again, the same member is offered',
  format($$select count(*)::text from public.closed_workspace_reassign_candidates(%L) c where c.user_id = %L$$, :'org_a', :'mgr_u'), '1');
reset role; reset request.jwt.claims;
-- Q223 (fix round 1b, review m1): the candidates read audits itself. CS8e and
-- CS8f were the two reads; a refused read (org B is ACTIVE) writes nothing.
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CS8g a refused candidates read (an ACTIVE workspace)',
  format($$select * from public.closed_workspace_reassign_candidates(%L)$$, :'org_b'), 'denied(22023:closure_candidates_not_owner_closed)');
reset role; reset request.jwt.claims;
select cw.val('CS8h AUDITED: one organisation.closure_candidates_viewed row per read, actor = superuser, counts only (no member named)',
  format($$select count(*)::text || '/' || bool_and(actor_user_id = %L)::text || '/' ||
                  string_agg(after ->> 'rows_returned', ',' order by created_at, id) || '/' ||
                  bool_and((select array_agg(k order by k) from jsonb_object_keys(after) k) = array['rows_returned'])::text || '/' ||
                  bool_and(after::text not like '%%' || %L || '%%')::text
             from public.audit_events where organisation_id = %L and action = 'organisation.closure_candidates_viewed'$$,
    :'su_u', :'mgr_u', :'org_a'), '2/true/1,2/true/true');
select cw.val('CS8i ...and the refused read wrote none',
  format($$select count(*)::text from public.audit_events where organisation_id = %L and action = 'organisation.closure_candidates_viewed'$$, :'org_b'), '0');
-- § CL (fix round 1, I1): the Phase 7 lifecycle RPCs refuse owner_closed --
-- the decision is reassign/delete above, never a one-click reinstate/suspend/
-- delete from /super/organisations. Positive controls on org B (ACTIVE here),
-- put back to active before § CX closes it.
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CL1 reinstate_organisation refuses an owner_closed workspace',
  $$select public.reinstate_organisation('cw-closure-alpha', 'bypass')$$, 'denied(22023:owner_closed_is_decided_at_super_closures)');
select cw.try('CL2 suspend_organisation refuses it',
  $$select public.suspend_organisation('cw-closure-alpha', 'bypass')$$, 'denied(22023:owner_closed_is_decided_at_super_closures)');
select cw.try('CL3 delete_organisation refuses it',
  $$select public.delete_organisation('cw-closure-alpha', 'bypass')$$, 'denied(22023:owner_closed_is_decided_at_super_closures)');
select cw.try('CL4 POSITIVE: the same superuser suspends an ACTIVE workspace',
  $$select public.suspend_organisation('cw-closure-beta', 'cl control')$$, 'ok(1)');
select cw.try('CL5 POSITIVE: ...reinstates it',
  $$select public.reinstate_organisation('cw-closure-beta', 'cl control')$$, 'ok(1)');
select cw.try('CL6 POSITIVE: ...deletes (closes) it',
  $$select public.delete_organisation('cw-closure-beta', 'cl control')$$, 'ok(1)');
select cw.try('CL7 POSITIVE: ...and reinstates it again',
  $$select public.reinstate_organisation('cw-closure-beta', 'cl control')$$, 'ok(1)');
reset role; reset request.jwt.claims;
select cw.val('CL8 org B is active again for § CX',
  format($$select lifecycle_state from public.organisations where id = %L$$, :'org_b'), 'active');
select cw.val('CS9 every refusal above left org A owner_closed and wrote no decision audit row',
  format($$select (o.lifecycle_state = 'owner_closed' and o.deleted_at is not null
                   and not exists (select 1 from public.audit_events a where a.organisation_id = o.id
                                    and a.action in ('organisation.closure_reassigned', 'organisation.closure_deleted')))::text
             from public.organisations o where o.id = %L$$, :'org_a'), 'true');

-- ---------------------------------------------------------------------------
-- § CQ Q206 -- THE CLOSING OWNER ERASES THEIR ACCOUNT; THE BACKUP SURVIVES.
-- ---------------------------------------------------------------------------
select cw.val('CQ0 FIXTURE: the erasure purge manifest would not name the closure backup''s archive',
  format($$select count(*)::text from public.export_jobs e
            where e.requested_by = %L and e.storage_key is not null and not e.closure_backup$$, :'owner_u'), '0');
select cw.try('CQ1 the closing Owner''s account is erased (a closed workspace no longer blocks it)',
  format($$select private.erase_account(%L, null)$$, :'owner_u'), 'ok(1)');
select cw.val('CQ2 the closure backup row is still there, its requester re-pointed at the tombstone',
  format($$select closure_backup::text || '/' || status || '/' || (requested_by = private.erased_user_id())::text
             from public.export_jobs where id = %L$$, :'job'), 'true/succeeded/true');
select cw.val('CQ3 ...and findable the way the decision item looks: the latest closure_backup row of the org',
  format($$select id::text from public.export_jobs where organisation_id = %L and closure_backup
            order by requested_at desc limit 1$$, :'org_a'), :'job');
select cw.val('CQ4 the Owner''s ORDINARY export (CF9) still went with the account (only the backup is kept)',
  format($$select count(*)::text from public.export_jobs where organisation_id = %L and not closure_backup$$, :'org_a'), '0');
select cw.try('CQ5 requested_by is still immutable otherwise: no re-point to a person',
  format($$update public.export_jobs set requested_by = %L where id = %L$$, :'mgr_u', :'job'),
  'denied(42501:export_request_is_immutable)');
\o /dev/null
set request.jwt.claims = :'other_c';
insert into public.export_jobs (kind, organisation_id) values ('workspace', :'org_b') returning id as job_b \gset
reset request.jwt.claims;
\o
select set_config('app.erasing_account', :'other_u', false) \g /dev/null
select cw.try('CQ6 ...nor, under the erasure marker, an ORDINARY job re-pointed at the tombstone',
  format($$update public.export_jobs set requested_by = private.erased_user_id() where id = %L$$, :'job_b'),
  'denied(42501:export_request_is_immutable)');
select set_config('app.erasing_account', '', false) \g /dev/null
delete from public.export_jobs where id = :'job_b';
select cw.val('CQ7 the decision item still lists the workspace after the Owner is gone (1 active member left)',
  format($$select count(*)::text from public.organisations o where o.id = %L and o.lifecycle_state = 'owner_closed'$$, :'org_a'), '1');

-- ---------------------------------------------------------------------------
-- § CR REASSIGN: the remaining Manager becomes Owner; the workspace reopens.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CR1 the aal2 superuser reassigns org A to its active Manager',
  format($$insert into cw.ids select 'reassign', public.reassign_closed_workspace('CW-Closure-Alpha ', %L, '  owner left; manager takes over ')::text$$, :'mgr_u'),
  'ok(1)');
select cw.try('CR2 a second decision is refused: it is no longer owner_closed',
  $$select public.delete_closed_workspace('cw-closure-alpha', 'too late')$$, 'denied(22023:decision_workspace_not_owner_closed)');
reset role; reset request.jwt.claims;
\o /dev/null
select coalesce((select v from cw.ids where k = 'reassign'), '00000000-0000-0000-0000-000000000000') as reassign_audit \gset
\o
select cw.val('CR3 reopened: active, deleted_at, reason and BOTH clocks cleared (the purge no longer selects it)',
  format($$select lifecycle_state || '/' || (deleted_at is null)::text || '/' || (lifecycle_reason is null)::text || '/' ||
                  (retention_expires_at is null)::text || '/' || (lifecycle_changed_at is null)::text
             from public.organisations where id = %L$$, :'org_a'), 'active/true/true/true/true');
select cw.val('CR4 the Manager is now an active Owner',
  format($$select role || '/' || status from public.organisation_memberships where organisation_id = %L and user_id = %L$$,
    :'org_a', :'mgr_u'), 'owner/active');
select cw.val('CR5 one organisation.closure_reassigned row: actor = superuser, who, previous role, trimmed reason, backup, recipients',
  format($$select count(*)::text || '/' || bool_and(actor_user_id = %L)::text || '/' ||
                  bool_and(after ->> 'new_owner_user_id' = %L)::text || '/' ||
                  bool_and(before ->> 'new_owner_previous_role' = 'manager')::text || '/' ||
                  bool_and(after ->> 'reason' = 'owner left; manager takes over')::text || '/' ||
                  bool_and(after ->> 'backup_export_job_id' = %L)::text || '/' ||
                  bool_and(after -> 'notify_user_ids' = jsonb_build_array(%L::uuid))::text || '/' ||
                  bool_and(id = %L)::text
             from public.audit_events where organisation_id = %L and action = 'organisation.closure_reassigned'$$,
    :'su_u', :'mgr_u', :'job', :'mgr_u', :'reassign_audit', :'org_a'), '1/true/true/true/true/true/true/true');
select cw.val('CR6 the remaining Admins are notified: the decision is on the queue, addressed to the new Owner',
  format($$select notice || '/' || array_to_string(emails, ',') || '/' || organisation_slug
             from public.pending_workspace_decision_notifications(30) where audit_event_id = %L$$, :'reassign_audit'),
  'workspace_reassigned/cw-mgr@test.local/cw-closure-alpha');
select cw.val('CR7 the stamp RPC stamps it once, only for its own action, and it leaves the queue',
  format($$select public.mark_notices_delivered('workspace_reassigned', array[%1$L]::uuid[])::text || '/' ||
                  public.mark_notices_delivered('workspace_reassigned', array[%1$L]::uuid[])::text || '/' ||
                  public.mark_notices_delivered('workspace_deleted', array[%1$L]::uuid[])::text$$,
    :'reassign_audit'), '1/0/0');
select cw.val('CR7b ...and it has left the queue',
  format($$select count(*)::text from public.pending_workspace_decision_notifications(30) where audit_event_id = %L$$,
    :'reassign_audit'), '0');
select cw.val('CR8 the superuser closure email stamps the same way (and only the closed_by_owner row)',
  format($$select public.mark_notices_delivered('workspace_closed',
             array(select id from public.audit_events where organisation_id = %L
                    and action in ('organisation.closed_by_owner', 'organisation.closure_reassigned')))::text$$, :'org_a'), '1');
set role authenticated;
set request.jwt.claims = :'su_c';
select cw.try('CR9 a stamp from a session is refused, even the superuser''s',
  format($$select public.mark_notices_delivered('workspace_reassigned', array[%L]::uuid[])$$, :'reassign_audit'),
  'denied(42501)');
reset role; reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- § CX PERMANENT DELETE: org B is closed by its Owner, then deleted. The
--      decision reuses the Q88 purge: due NOW, purged by the existing sweep.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'other_c';
select cw.try('CX0 FIXTURE: org B''s aal2 Owner closes it',
  format($$select public.close_my_workspace(%L, 'cw-closure-beta', 'shutting down')$$, :'org_b'), 'ok(1)');
set request.jwt.claims = :'su_c';
select cw.try('CX1 the aal2 superuser deletes the closed workspace permanently',
  format($$insert into cw.ids select 'delete', public.delete_closed_workspace('cw-closure-beta', ' no successor ')::text$$), 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
select coalesce((select v from cw.ids where k = 'delete'), '00000000-0000-0000-0000-000000000000') as delete_audit \gset
\o
select cw.val('CX2 lifecycle deleted, still soft (deleted_at set) and DUE for the purge now',
  format($$select lifecycle_state || '/' || (deleted_at is not null)::text || '/' || (retention_expires_at < now())::text
             from public.organisations where id = %L$$, :'org_b'), 'deleted/true/true');
select cw.val('CX3 one organisation.closure_deleted row with the reason and ONLY the remaining Owner/Admins (not the Manager) as recipients',
  format($$select count(*)::text || '/' || bool_and(after ->> 'reason' = 'no successor')::text || '/' ||
                  bool_and(after -> 'notify_user_ids' = jsonb_build_array(%L::uuid))::text
             from public.audit_events where organisation_id = %L and action = 'organisation.closure_deleted'$$,
    :'other_u', :'org_b'), '1/true/true');
\o /dev/null
select (private.sweep_expired_workspaces(true, 100000) ->> 'organisations.purged')::int as due_n \gset
\o
select cw.val('CX4 the EXISTING sweep selects it (no second engine): its dry run counts it',
  format($$select (exists (select 1 from public.organisations o where o.id = %L and o.deleted_at is not null
                    and o.retention_expires_at < now()) and %s >= 1)::text$$, :'org_b', :'due_n'), 'true');
select cw.val('CX5 ...and the sweep''s own primitive purges it, the decision''s audit row and notice surviving',
  format($$select (private.erase_organisation(%1$L, null, true) ->> 'organisations') || '/' ||
                  (select notice || ':' || array_to_string(emails, ',') || ':' || organisation_slug
                     from public.pending_workspace_decision_notifications(30) where audit_event_id = %2$L)$$,
    :'org_b', :'delete_audit'), '1/workspace_deleted:cw-other@test.local:cw-closure-beta');
select cw.val('CX5b ...the workspace row is gone',
  format($$select count(*)::text from public.organisations where id = %L$$, :'org_b'), '0');
\o /dev/null
select public.mark_notices_delivered('workspace_deleted', array[:'delete_audit']::uuid[]);
\o
select cw.val('CX6 a never-decided closure still runs on the Q88 clock: nothing here changed close_my_workspace''s 60 days',
  format($$select (count(*) = 0)::text from public.organisations o
            where o.lifecycle_state = 'owner_closed' and o.retention_expires_at is distinct from
                  o.lifecycle_changed_at + make_interval(days => private.organisation_retention_days())$$), 'true');

delete from public.platform_admins where user_id = :'su_u';

-- ---------------------------------------------------------------------------
-- § CZ HOUSEKEEPING -- nothing of this suite survives it.
-- ---------------------------------------------------------------------------
\o /dev/null
-- ORIGIN mode, so the foreign keys CASCADE every row this suite made (replica
-- mode would skip the RI triggers and orphan them). The export jobs go first:
-- the HTTP block below must never find a queued job of ours to claim.
delete from public.export_jobs where organisation_id in (:'org_a', :'org_b');
delete from public.organisations where id in (:'org_a', :'org_b');
-- The users are referenced by the closure's own audit rows (append-only,
-- actor FK without an action): removed in replica mode, the fixture shape
-- every self-contained suite here uses for auth.users.
set session_replication_role = replica;
delete from auth.users where id in (:'owner_u', :'mgr_u', :'other_u', :'su_u', :'view_u');
set session_replication_role = origin;
\o
select cw.val('CZ1 the fixture workspaces, their export jobs, users AND their child rows are gone',
  format($$select ((select count(*) from public.organisations where id in (%1$L, %2$L)) +
                   (select count(*) from public.contacts where organisation_id in (%1$L, %2$L)) +
                   (select count(*) from public.network_profiles where organisation_id in (%1$L, %2$L)) +
                   (select count(*) from public.documents where organisation_id in (%1$L, %2$L)) +
                   (select count(*) from public.export_jobs where organisation_id in (%1$L, %2$L)) +
                   (select count(*) from auth.users where id in (%3$L, %4$L, %5$L)))::text$$,
    :'org_a', :'org_b', :'owner_u', :'mgr_u', :'other_u'), '0');

select label, expected, actual from cw.results where not pass order by seq;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from cw.results;
