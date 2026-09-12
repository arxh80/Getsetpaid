-- ===========================================================================
-- Phase 7 Task 6b (Full CRM write auditing) suite.
--
-- Covers 20260912000000_audit_crm_inserts_and_updates.sql and
-- 20260912001000_crm_bulk_audit_thread.sql:
--   private.audit_crm_value_columns()      THE allowlist, one place, per table
--   private.audit_crm_project()            values -> allowlisted keys only
--   private.audit_crm_change()             the AFTER INSERT OR UPDATE writer
--   22 triggers                            audit_insert/audit_update x 11 tables
--   private.begin/end_crm_bulk_audit()     the member-level correlation thread
--   private.log_audit_event()              the four-step correlation coalesce
--   public.merge_records / set_contact_primary_company /
--   set_artist_primary_representation / set_custom_field_values
--                                          the threaded wrappers
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs LAST of the psql suites, after rls_phase7_feedback.sql, and reuses
--   the SAME fixtures (the twelve Phase 2 users, orgs ALPHA and BETA, `super`).
--   It plants its own CRM rows as postgres (sessionless, so no audit rows), acts
--   on them as pmanager / padmin, and § CZ deletes every row and audit event it
--   created, so the HTTP block below runs against the state it was written
--   against.
--
-- IT USES ITS OWN `ca` SCHEMA. Helpers are rls_phase7_feedback.sql's `fb.*`,
-- verbatim, with the schema renamed.
--
-- ===========================================================================
-- WHAT THIS SUITE PROVES
-- ===========================================================================
-- The most important assertion in this task is § CU's no-content-leak: for
-- every one of the eleven tables, an UPDATE that changes a free-text/content
-- column produces an audit row that names the column and does NOT carry the
-- old or new value, measured by searching the row's before/after jsonb for a
-- sentinel string that appears nowhere else in the database. For every
-- allowlisted structural column, the row DOES carry old and new. Both halves
-- from a real member's position (`set role authenticated` + a session's
-- claims, what a PostgREST request becomes). The same property is measured
-- over a real PostgREST connection by
-- tests/integration/security/crm-audit-no-content-leak.test.ts.
--
-- SECTIONS:
--   CA  fixtures, the trigger census, the allowlist, the wrappers' placement
--   CI  INSERT is audited: id, org, actor, structural values, no content
--   CU  UPDATE: changed names, values for the allowlist only, NO CONTENT LEAK
--   CD  soft-delete and restore are their own actions
--   CX  the exemption: sessionless / SECURITY DEFINER / service_role / no-op
--   CB  bulk paths share one correlation id, and the thread closes
--   CZ  housekeeping
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists ca cascade;
create schema ca;

create table ca.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function ca.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into ca.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function ca.try(p_label text, p_sql text, p_expected text)
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
  perform ca.record(p_label, p_expected, v_actual);
end $$;

create function ca.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform ca.record(p_label, p_expected, v_actual);
end $$;

-- The audit row a session write just produced for one target: the newest one.
-- SECURITY DEFINER so a member's position can ask about the trail without
-- being able to read audit_events (which is the point of § FR's predecessor).
create function ca.last_row(p_target uuid)
returns table (action text, before jsonb, after jsonb, correlation_id uuid)
language sql security definer set search_path = '' as $$
  select e.action, e.before, e.after, e.correlation_id
    from public.audit_events e
   where e.target_id = p_target
   order by e.created_at desc, e.id desc
   limit 1;
$$;

create function ca.rows_for(p_target uuid)
returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.audit_events e where e.target_id = p_target;
$$;

-- Does the newest row for this target carry the sentinel ANYWHERE in its
-- before/after payload? The leak probe.
create function ca.leaks(p_target uuid, p_sentinel text)
returns boolean language sql security definer set search_path = '' as $$
  select (coalesce(r.before::text, '') || coalesce(r.after::text, '')) like ('%' || p_sentinel || '%')
    from ca.last_row(p_target) r;
$$;

grant usage on schema ca to authenticated, anon, service_role;
grant execute on function ca.record(text,text,text) to authenticated, anon, service_role;
grant execute on function ca.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function ca.val(text,text,text)    to authenticated, anon, service_role;
grant execute on function ca.last_row(uuid)         to authenticated, anon, service_role;
grant execute on function ca.rows_for(uuid)         to authenticated, anon, service_role;
grant execute on function ca.leaks(uuid,text)       to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select now()::text as ca_t0 \gset
-- Fixed ids, so the labels below can name them.
\set ca_co  '''ca000000-0000-4000-8000-000000000001'''
\set ca_co2 '''ca000000-0000-4000-8000-000000000002'''
\set ca_co3 '''ca000000-0000-4000-8000-000000000003'''
\set ca_ct  '''ca000000-0000-4000-8000-000000000011'''
\set ca_ct2 '''ca000000-0000-4000-8000-000000000012'''
\set ca_ag  '''ca000000-0000-4000-8000-000000000021'''
\set ca_ar  '''ca000000-0000-4000-8000-000000000031'''
\set ca_ve  '''ca000000-0000-4000-8000-000000000041'''
\set ca_ve2 '''ca000000-0000-4000-8000-000000000042'''
\set ca_rm  '''ca000000-0000-4000-8000-000000000051'''
\set ca_rp  '''ca000000-0000-4000-8000-000000000061'''
\set ca_fe  '''ca000000-0000-4000-8000-000000000071'''
\set ca_cc  '''ca000000-0000-4000-8000-000000000081'''
\set ca_cc2 '''ca000000-0000-4000-8000-000000000082'''
\set ca_cc3 '''ca000000-0000-4000-8000-000000000083'''
\set ca_fd  '''ca000000-0000-4000-8000-000000000091'''
\set ca_fv  '''ca000000-0000-4000-8000-000000000092'''
\set ca_new '''ca000000-0000-4000-8000-0000000000a1'''
\o

-- ===========================================================================
-- § CA  FIXTURES (sessionless, so none of these INSERTs is audited -- CA10
-- measures that), THE CENSUS, THE ALLOWLIST, THE WRAPPERS
-- ===========================================================================
insert into public.companies (id, organisation_id, owner_user_id, name, type)
values (:ca_co,  :'alpha_org', :'pmanager', 'CA Co One',   array['promoter']),
       (:ca_co2, :'alpha_org', :'pmanager', 'CA Co Two',   array['venue']),
       (:ca_co3, :'alpha_org', :'pmanager', 'CA Co Three', '{}');
insert into public.contacts (id, organisation_id, owner_user_id, name, email, phone)
values (:ca_ct,  :'alpha_org', :'pmanager', 'CA Contact Winner', 'ca.winner@alpha.test', null),
       (:ca_ct2, :'alpha_org', :'pmanager', 'CA Contact Loser',  null, 'ZQXV-LOSER-PHONE');
insert into public.agencies (id, organisation_id, owner_user_id, name)
values (:ca_ag, :'alpha_org', :'pmanager', 'CA Agency');
insert into public.artists (id, organisation_id, owner_user_id, name)
values (:ca_ar, :'alpha_org', :'pmanager', 'CA Artist');
insert into public.venues (id, organisation_id, owner_user_id, name)
values (:ca_ve,  :'alpha_org', :'pmanager', 'CA Venue'),
       (:ca_ve2, :'alpha_org', :'pmanager', 'CA Venue Two');
insert into public.venue_rooms (id, organisation_id, venue_id, name)
values (:ca_rm, :'alpha_org', :ca_ve, 'CA Room');
insert into public.artist_representations
  (id, organisation_id, artist_id, agency_id, role, is_primary)
values (:ca_rp, :'alpha_org', :ca_ar, :ca_ag, 'booking agent', true);
insert into public.artist_fee_history
  (id, organisation_id, artist_id, occurred_on, currency, amount_minor, note)
values (:ca_fe, :'alpha_org', :ca_ar, date '2026-01-10', 'GBP', 150000, 'seed');
insert into public.contact_companies (id, organisation_id, contact_id, company_id, is_primary)
values (:ca_cc,  :'alpha_org', :ca_ct,  :ca_co,  true),
       (:ca_cc2, :'alpha_org', :ca_ct,  :ca_co2, false),
       (:ca_cc3, :'alpha_org', :ca_ct2, :ca_co3, false);
insert into public.custom_field_definitions
  (id, organisation_id, entity_type, key, label, field_type)
values (:ca_fd, :'alpha_org', 'contact', 'ca_probe', 'CA probe', 'text');
insert into public.custom_field_values
  (id, organisation_id, field_id, entity_type, entity_id, value)
values (:ca_fv, :'alpha_org', :ca_fd, 'contact', :ca_ct, '"seed"'::jsonb);

select ca.val('CA1 FIXTURE: pmanager is an ACTIVE manager of ALPHA',
  format($$select role from public.organisation_memberships
            where organisation_id=%L and user_id=%L and status='active'$$, :'alpha_org', :'pmanager'),
  'manager');
select ca.val('CA2 CENSUS: exactly 22 audit_insert/audit_update triggers over the eleven tables',
  $$select count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
     where c.relnamespace='public'::regnamespace and not t.tgisinternal
       and t.tgname in ('audit_insert','audit_update')
       and c.relname in ('companies','contacts','contact_companies','agencies','artists',
                         'artist_representations','artist_fee_history','venues','venue_rooms',
                         'custom_field_definitions','custom_field_values')$$, '22');
select ca.val('CA2b ...every one of them bound to private.audit_crm_change',
  $$select count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
     where c.relnamespace='public'::regnamespace and not t.tgisinternal
       and t.tgname in ('audit_insert','audit_update')
       and c.relname in ('companies','contacts','contact_companies','agencies','artists',
                         'artist_representations','artist_fee_history','venues','venue_rooms',
                         'custom_field_definitions','custom_field_values')
       and n.nspname='private' and p.proname='audit_crm_change'$$, '22');
select ca.val('CA2c merges keeps its 20260828141000 audit_insert (records.merged) and gains no audit_update',
  $$select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
     where t.tgrelid='public.merges'::regclass and not t.tgisinternal and t.tgname like 'audit_%'$$,
  'audit_insert');
select ca.val('CA2d the two hard-DELETE triggers are still there beside the new pair',
  $$select count(*)::text from pg_trigger t
     where t.tgrelid in ('public.contact_companies'::regclass,'public.custom_field_values'::regclass)
       and t.tgname='audit_delete'$$, '2');
select ca.val('CA3 the trigger function is SECURITY DEFINER (it must reach log_audit_event)',
  $$select prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='audit_crm_change'$$, 'true');
select ca.val('CA3b ...and keys its exemption on auth.uid(), NOT row_security_active() (Task 5 I4)',
  $$select ((pg_get_functiondef(p.oid) ~ 'auth\.uid\(\)')
        and (pg_get_functiondef(p.oid) !~ 'row_security_active'))::text
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='audit_crm_change'$$, 'true');

-- THE ALLOWLIST, read back. These eleven expectations ARE the allowlist's
-- statement of record; a change to the function without a change here is
-- a red assertion, which is the intended friction.
select ca.val('CA4a allowlist company',                $$select array_to_string(private.audit_crm_value_columns('company'), ',')$$, 'owner_user_id,type,deleted_at');
select ca.val('CA4b allowlist contact',                $$select array_to_string(private.audit_crm_value_columns('contact'), ',')$$, 'owner_user_id,deleted_at');
select ca.val('CA4c allowlist contact_company',        $$select array_to_string(private.audit_crm_value_columns('contact_company'), ',')$$, 'contact_id,company_id,is_primary');
select ca.val('CA4d allowlist agency',                 $$select array_to_string(private.audit_crm_value_columns('agency'), ',')$$, 'owner_user_id,deleted_at');
select ca.val('CA4e allowlist artist',                 $$select array_to_string(private.audit_crm_value_columns('artist'), ',')$$, 'owner_user_id,deleted_at');
select ca.val('CA4f allowlist artist_representation',  $$select array_to_string(private.audit_crm_value_columns('artist_representation'), ',')$$, 'artist_id,agency_id,contact_id,is_exclusive,is_primary,started_at,ended_at,deleted_at');
select ca.val('CA4g allowlist artist_fee',             $$select array_to_string(private.audit_crm_value_columns('artist_fee'), ',')$$, 'artist_id,event_id,occurred_on,currency,deleted_at');
select ca.val('CA4h allowlist venue',                  $$select array_to_string(private.audit_crm_value_columns('venue'), ',')$$, 'owner_user_id,deleted_at');
select ca.val('CA4i allowlist venue_room',             $$select array_to_string(private.audit_crm_value_columns('venue_room'), ',')$$, 'venue_id,deleted_at');
select ca.val('CA4j allowlist custom_field_definition',$$select array_to_string(private.audit_crm_value_columns('custom_field_definition'), ',')$$, 'entity_type,field_type,deleted_at');
select ca.val('CA4k allowlist custom_field_value',     $$select array_to_string(private.audit_crm_value_columns('custom_field_value'), ',')$$, 'field_id,entity_type,entity_id');
select ca.val('CA4l an UNKNOWN target type is name-only: the allowlist is empty, not an error',
  $$select cardinality(private.audit_crm_value_columns('future_table'))::text$$, '0');
-- The allowlist names no content column on any table -- asserted by NAME so a
-- later "just add notes" is a red line here, not a code review.
select ca.val('CA5 NO allowlist entry is a content column, on any table',
  $$select count(*)::text from (
      select unnest(private.audit_crm_value_columns(t)) c
        from unnest(array['company','contact','contact_company','agency','artist',
                          'artist_representation','artist_fee','venue','venue_room',
                          'custom_field_definition','custom_field_value']) t) s
     where c in ('name','email','phone','title','location','website','socials','tags',
                 'genres','country','city','notes','address','capacity','technical_info',
                 'role','territory','amount_minor','note','key','label','options','value')$$, '0');
-- Every allowlisted column really EXISTS on its table (a typo would be a silent
-- name-only demotion, which fails safe but not visibly).
select ca.val('CA5b every allowlisted column exists on its table',
  $$select count(*)::text from (
      values ('company','companies'),('contact','contacts'),('contact_company','contact_companies'),
             ('agency','agencies'),('artist','artists'),('artist_representation','artist_representations'),
             ('artist_fee','artist_fee_history'),('venue','venues'),('venue_room','venue_rooms'),
             ('custom_field_definition','custom_field_definitions'),('custom_field_value','custom_field_values')
    ) m(target, tbl)
    cross join lateral unnest(private.audit_crm_value_columns(m.target)) c
    where not exists (select 1 from information_schema.columns ic
                       where ic.table_schema='public' and ic.table_name=m.tbl and ic.column_name=c)$$, '0');

-- The wrappers and the moved bodies.
select ca.val('CA6 the four client RPCs are still in `public` (routable) ...',
  $$select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     where p.pronamespace='public'::regnamespace
       and p.proname in ('merge_records','set_contact_primary_company',
                         'set_artist_primary_representation','set_custom_field_values')$$,
  'merge_records,set_artist_primary_representation,set_contact_primary_company,set_custom_field_values');
select ca.val('CA6b ...their bodies moved to `private` under *_unthreaded (unroutable)',
  $$select string_agg(p.proname, ',' order by p.proname) from pg_proc p
     where p.pronamespace='private'::regnamespace and p.proname like '%\_unthreaded'$$,
  'merge_records_unthreaded,set_artist_primary_representation_unthreaded,set_contact_primary_company_unthreaded,set_custom_field_values_unthreaded');
select ca.val('CA6c every wrapper is SECURITY INVOKER (RLS unchanged) and opens AND closes the thread',
  $$select count(*)::text from pg_proc p
     where p.pronamespace='public'::regnamespace
       and p.proname in ('merge_records','set_contact_primary_company',
                         'set_artist_primary_representation','set_custom_field_values')
       and not p.prosecdef
       and pg_get_functiondef(p.oid) ~ 'begin_crm_bulk_audit'
       and pg_get_functiondef(p.oid) ~ 'end_crm_bulk_audit'$$, '4');
select ca.val('CA6d log_audit_event consults the CRM thread AFTER the lifecycle one',
  $$select (position('bulk_audit_correlation_id()' in b) < position('crm_bulk_correlation_id()' in b))::text
      from (select pg_get_functiondef(p.oid) b from pg_proc p
             where p.pronamespace='private'::regnamespace and p.proname='log_audit_event') s$$, 'true');
select ca.val('CA6e the CRM thread is read by NO policy (it grants nothing)',
  $$select count(*)::text from pg_policy p
     where (coalesce(pg_get_expr(p.polqual, p.polrelid),'') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid),''))
           ~ 'crm_bulk_correlation_id'$$, '0');
select ca.val('CA7 the viewer''s action-filtered keyset index exists on (action, created_at desc, id desc)',
  $$select pg_get_indexdef('public.audit_events_action_created_at_id_desc_idx'::regclass) ~ '\(action, created_at DESC, id DESC\)'$$, 'true');

select ca.val('CA10 the sessionless fixture INSERTs above emitted NO audit rows (the exemption, INSERT half)',
  format($$select count(*)::text from public.audit_events
            where target_id in (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)$$,
         :ca_co, :ca_co2, :ca_co3, :ca_ct, :ca_ct2, :ca_ag, :ca_ar, :ca_ve, :ca_ve2, :ca_rm,
         :ca_rp, :ca_fe, :ca_cc, :ca_cc2, :ca_cc3, :ca_fd, :ca_fv), '0');

-- ===========================================================================
-- § CI  INSERT IS AUDITED: id, org, actor, structural values, no content
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select ca.try('CI1 pmanager creates a contact carrying a sentinel name, email and title',
  format($$insert into public.contacts (id, organisation_id, owner_user_id, name, email, title)
           values (%s, %L, %L, 'ZQXV-NAME Person', 'zqxv-email@alpha.test', 'ZQXV-TITLE')$$,
         :ca_new, :'alpha_org', :'pmanager'), 'ok(1)');
select ca.val('CI2 CONTROL: the member who wrote it reads 0 rows of audit_events (RLS filters, the definer helper is how this suite reads the trail)',
  format($$select count(*)::text from public.audit_events where target_id=%s$$, :ca_new),
  '0');
reset role; reset request.jwt.claims;
select ca.val('CI2b exactly one audit row, action contact.created',
  format($$select ca.rows_for(%s)::text || '/' || (select action from ca.last_row(%s))$$, :ca_new, :ca_new),
  '1/contact.created');
select ca.val('CI3 it carries the org, the actor, the target id and the target type',
  format($$select (organisation_id=%L and actor_user_id=%L and target_type='contact')::text
            from public.audit_events where target_id=%s$$, :'alpha_org', :'pmanager', :ca_new), 'true');
select ca.val('CI4 after.values carries EXACTLY the allowlisted keys for a contact',
  format($$select string_agg(k, ',' order by k) from ca.last_row(%s) r, jsonb_object_keys(r.after->'values') k$$, :ca_new),
  'deleted_at,owner_user_id');
select ca.val('CI4b ...with the owner id as its value and deleted_at null',
  format($$select (r.after->'values'->>'owner_user_id' = %L and (r.after->'values'->'deleted_at') = 'null'::jsonb)::text
            from ca.last_row(%s) r$$, :'pmanager', :ca_new), 'true');
select ca.val('CI5 NO CONTENT: the sentinel name/email/title appear nowhere in the row',
  format($$select ca.leaks(%s, 'ZQXV')::text$$, :ca_new), 'false');
select ca.val('CI5b ...and `before` is null on an INSERT row',
  format($$select (r.before is null)::text from ca.last_row(%s) r$$, :ca_new), 'true');
select ca.val('CI6 an INSERT row has no `changed` list (there is nothing it changed FROM)',
  format($$select (r.after ? 'changed')::text from ca.last_row(%s) r$$, :ca_new), 'false');

-- ===========================================================================
-- § CU  UPDATE: changed column NAMES, values for the allowlist ONLY, and the
-- no-content-leak property on EVERY table. Each table gets (a) a content-column
-- change with a sentinel -> named, not valued; (b) a structural change -> old
-- and new values present. Definitions need padmin (manage_custom_fields).
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';

-- contacts ------------------------------------------------------------------
select ca.try('CU1a contacts: pmanager changes title and phone to sentinels',
  format($$update public.contacts set title='ZQXV-T1', phone='ZQXV-P1' where id=%s$$, :ca_ct), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU1b action contact.updated; changed names EXACTLY phone,title (updated_at excluded)',
  format($$select r.action || ' ' || (r.after->'changed')::text from ca.last_row(%s) r$$, :ca_ct),
  'contact.updated ["phone", "title"]');
select ca.val('CU1c NO CONTENT: neither sentinel in before or after',
  format($$select ca.leaks(%s, 'ZQXV')::text$$, :ca_ct), 'false');
select ca.val('CU1d ...and values is EMPTY on both sides (no allowlisted column changed)',
  format($$select (r.before->'values')::text || '/' || (r.after->'values')::text from ca.last_row(%s) r$$, :ca_ct),
  '{}/{}');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU1e contacts: pmanager reassigns the record to pstd1 (structural)',
  format($$update public.contacts set owner_user_id=%L where id=%s$$, :'pstd1', :ca_ct), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU1f ...before.values.owner_user_id = pmanager, after.values.owner_user_id = pstd1, changed = [owner_user_id]',
  format($$select (r.before->'values'->>'owner_user_id' = %L and r.after->'values'->>'owner_user_id' = %L
                   and r.after->'changed' = '["owner_user_id"]'::jsonb)::text from ca.last_row(%s) r$$,
         :'pmanager', :'pstd1', :ca_ct), 'true');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU1g (restore ownership for the sections below)',
  format($$update public.contacts set owner_user_id=%L where id=%s$$, :'pmanager', :ca_ct), 'ok(1)');

-- companies -----------------------------------------------------------------
select ca.try('CU2a companies: name to a sentinel',
  format($$update public.companies set name='ZQXV-CO' where id=%s$$, :ca_co), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU2b company.updated, changed=[name], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_co, :ca_co),
  'company.updated ["name"] false');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU2c companies: type (closed vocabulary) promoter -> promoter+supplier',
  format($$update public.companies set type=array['promoter','supplier'] where id=%s$$, :ca_co), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU2d ...old and new type arrays are carried',
  format($$select (r.before->'values'->'type')::text || '->' || (r.after->'values'->'type')::text from ca.last_row(%s) r$$, :ca_co),
  '["promoter"]->["promoter", "supplier"]');

-- agencies ------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU3a agencies: name to a sentinel',
  format($$update public.agencies set name='ZQXV-AG' where id=%s$$, :ca_ag), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU3b agency.updated, changed=[name], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_ag, :ca_ag),
  'agency.updated ["name"] false');

-- artists -------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU4a artists: notes, genres, city and socials to sentinels',
  format($$update public.artists set notes='ZQXV-NOTES', genres=array['ZQXV-GENRE'], city='ZQXV-CITY',
             socials='{"instagram":"ZQXV-IG"}'::jsonb where id=%s$$, :ca_ar), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU4b artist.updated, changed = [city, genres, notes, socials], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_ar, :ca_ar),
  'artist.updated ["city", "genres", "notes", "socials"] false');

-- venues --------------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU5a venues: address, technical_info and capacity',
  format($$update public.venues set address='ZQXV-ADDR', technical_info='ZQXV-TECH', capacity=4321 where id=%s$$, :ca_ve), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU5b venue.updated, changed = [address, capacity, technical_info], no leak -- and capacity 4321 is NOT carried',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text || ' ' || ca.leaks(%s,'4321')::text
            from ca.last_row(%s) r$$, :ca_ve, :ca_ve, :ca_ve),
  'venue.updated ["address", "capacity", "technical_info"] false false');

-- venue_rooms ---------------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU6a venue_rooms: name to a sentinel',
  format($$update public.venue_rooms set name='ZQXV-ROOM' where id=%s$$, :ca_rm), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU6b venue_room.updated, changed=[name], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_rm, :ca_rm),
  'venue_room.updated ["name"] false');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU6c venue_rooms: moved to the second venue (structural)',
  format($$update public.venue_rooms set venue_id=%s where id=%s$$, :ca_ve2, :ca_rm), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU6d ...old and new venue_id carried',
  format($$select (r.before->'values'->>'venue_id' = %L and r.after->'values'->>'venue_id' = %L)::text from ca.last_row(%s) r$$,
         trim(both '''' from :'ca_ve'), trim(both '''' from :'ca_ve2'), :ca_rm), 'true');

-- artist_representations ----------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU7a artist_representations: role and territory to sentinels, ended_at set',
  format($$update public.artist_representations set role='ZQXV-ROLE', territory='ZQXV-TERR', ended_at=date '2026-12-31' where id=%s$$, :ca_rp), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU7b artist_representation.updated, changed=[ended_at, role, territory], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_rp, :ca_rp),
  'artist_representation.updated ["ended_at", "role", "territory"] false');
select ca.val('CU7c ...ended_at (a date) IS carried, null -> 2026-12-31; role/territory are not in values',
  format($$select (r.before->'values')::text || '->' || (r.after->'values')::text from ca.last_row(%s) r$$, :ca_rp),
  '{"ended_at": null}->{"ended_at": "2026-12-31"}');

-- artist_fee_history --------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU8a artist_fee_history: amount and note change',
  format($$update public.artist_fee_history set amount_minor=987654, note='ZQXV-NOTE' where id=%s$$, :ca_fe), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU8b artist_fee.updated, changed=[amount_minor, note], no sentinel and NO AMOUNT (987654 absent)',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text || ' ' || ca.leaks(%s,'987654')::text
            from ca.last_row(%s) r$$, :ca_fe, :ca_fe, :ca_fe),
  'artist_fee.updated ["amount_minor", "note"] false false');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU8c artist_fee_history: occurred_on and currency (structural)',
  format($$update public.artist_fee_history set occurred_on=date '2026-02-02', currency='EUR' where id=%s$$, :ca_fe), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU8d ...both carried old -> new',
  format($$select (r.before->'values')::text || '->' || (r.after->'values')::text from ca.last_row(%s) r$$, :ca_fe),
  '{"currency": "GBP", "occurred_on": "2026-01-10"}->{"currency": "EUR", "occurred_on": "2026-02-02"}');

-- contact_companies ---------------------------------------------------------
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU9a contact_companies: is_primary true -> false (every column here is structural)',
  format($$update public.contact_companies set is_primary=false where id=%s$$, :ca_cc), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU9b contact_company.updated with is_primary true -> false',
  format($$select r.action || ' ' || (r.before->'values')::text || '->' || (r.after->'values')::text from ca.last_row(%s) r$$, :ca_cc),
  'contact_company.updated {"is_primary": true}->{"is_primary": false}');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CU9c (put it back)',
  format($$update public.contact_companies set is_primary=true where id=%s$$, :ca_cc), 'ok(1)');

-- custom_field_values -------------------------------------------------------
select ca.try('CU10a custom_field_values: the value to a sentinel',
  format($$update public.custom_field_values set value='"ZQXV-VALUE"'::jsonb where id=%s$$, :ca_fv), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU10b custom_field_value.updated, changed=[value], no leak, values empty',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text || ' ' || (r.after->'values')::text
            from ca.last_row(%s) r$$, :ca_fv, :ca_fv),
  'custom_field_value.updated ["value"] false {}');

-- custom_field_definitions (padmin: manage_custom_fields) -------------------
set role authenticated;
set request.jwt.claims = :'padmin_c';
select ca.try('CU11a custom_field_definitions: label and options to sentinels (padmin)',
  format($$update public.custom_field_definitions set label='ZQXV-LABEL', options=null where id=%s$$, :ca_fd), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CU11b custom_field_definition.updated, changed=[label], no leak, actor is padmin',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text
              || ' ' || (select (actor_user_id=%L)::text from public.audit_events where target_id=%s order by created_at desc limit 1)
            from ca.last_row(%s) r$$, :ca_fd, :'padmin', :ca_fd, :ca_fd),
  'custom_field_definition.updated ["label"] false true');

-- THE SWEEP: not one row written by this section carries the sentinel.
select ca.val('CU20 SWEEP: no audit row written since the suite began carries the sentinel anywhere',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L
              and (coalesce(before::text,'') || coalesce(after::text,'')) like '%%ZQXV%%'$$, :'ca_t0'), '0');

-- ===========================================================================
-- § CD  SOFT-DELETE AND RESTORE ARE THEIR OWN ACTIONS
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CD1a contact: soft delete', format($$update public.contacts set deleted_at=now() where id=%s$$, :ca_ct), 'ok(1)');
select ca.try('CD2a company: soft delete', format($$update public.companies set deleted_at=now() where id=%s$$, :ca_co), 'ok(1)');
select ca.try('CD3a agency: soft delete',  format($$update public.agencies set deleted_at=now() where id=%s$$, :ca_ag), 'ok(1)');
select ca.try('CD4a artist: soft delete',  format($$update public.artists set deleted_at=now() where id=%s$$, :ca_ar), 'ok(1)');
select ca.try('CD5a venue: soft delete',   format($$update public.venues set deleted_at=now() where id=%s$$, :ca_ve), 'ok(1)');
select ca.try('CD6a venue_room: soft delete', format($$update public.venue_rooms set deleted_at=now() where id=%s$$, :ca_rm), 'ok(1)');
select ca.try('CD7a artist_representation: soft delete', format($$update public.artist_representations set deleted_at=now() where id=%s$$, :ca_rp), 'ok(1)');
select ca.try('CD8a artist_fee: soft delete', format($$update public.artist_fee_history set deleted_at=now() where id=%s$$, :ca_fe), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select ca.try('CD9a custom_field_definition: soft delete (padmin)', format($$update public.custom_field_definitions set deleted_at=now() where id=%s$$, :ca_fd), 'ok(1)');
reset role; reset request.jwt.claims;

select ca.val('CD1b contact.soft_deleted, before deleted_at null, after non-null, changed=[deleted_at]',
  format($$select r.action || ' ' || ((r.before->'values'->'deleted_at') = 'null'::jsonb)::text || ' ' || ((r.after->'values'->>'deleted_at') is not null)::text || ' ' || (r.after->'changed')::text
            from ca.last_row(%s) r$$, :ca_ct), 'contact.soft_deleted true true ["deleted_at"]');
select ca.val('CD2b-9b every other soft-deletable table names .soft_deleted',
  format($$select string_agg(a, ',' order by a) from (
            select (select action from ca.last_row(t)) a
              from unnest(array[%s,%s,%s,%s,%s,%s,%s,%s]::uuid[]) t) s$$,
         :ca_co, :ca_ag, :ca_ar, :ca_ve, :ca_rm, :ca_rp, :ca_fe, :ca_fd),
  'agency.soft_deleted,artist.soft_deleted,artist_fee.soft_deleted,artist_representation.soft_deleted,company.soft_deleted,custom_field_definition.soft_deleted,venue.soft_deleted,venue_room.soft_deleted');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CD10a contact: restore', format($$update public.contacts set deleted_at=null where id=%s$$, :ca_ct), 'ok(1)');
select ca.try('CD10b company: restore', format($$update public.companies set deleted_at=null where id=%s$$, :ca_co), 'ok(1)');
select ca.try('CD10c agency: restore',  format($$update public.agencies set deleted_at=null where id=%s$$, :ca_ag), 'ok(1)');
select ca.try('CD10d artist: restore',  format($$update public.artists set deleted_at=null where id=%s$$, :ca_ar), 'ok(1)');
select ca.try('CD10e venue: restore',   format($$update public.venues set deleted_at=null where id=%s$$, :ca_ve), 'ok(1)');
select ca.try('CD10f venue_room: restore', format($$update public.venue_rooms set deleted_at=null where id=%s$$, :ca_rm), 'ok(1)');
select ca.try('CD10g artist_representation: restore', format($$update public.artist_representations set deleted_at=null where id=%s$$, :ca_rp), 'ok(1)');
select ca.try('CD10h artist_fee: restore', format($$update public.artist_fee_history set deleted_at=null where id=%s$$, :ca_fe), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select ca.try('CD10i custom_field_definition: restore (padmin)', format($$update public.custom_field_definitions set deleted_at=null where id=%s$$, :ca_fd), 'ok(1)');
reset role; reset request.jwt.claims;

select ca.val('CD11 every restore names .restored, with before deleted_at non-null and after null',
  format($$select string_agg(a, ',' order by a) from (
            select (select r.action || case when (r.before->'values'->>'deleted_at') is not null
                                                and (r.after->'values'->'deleted_at') = 'null'::jsonb then '' else '!' end
                      from ca.last_row(t) r) a
              from unnest(array[%s,%s,%s,%s,%s,%s,%s,%s,%s]::uuid[]) t) s$$,
         :ca_ct, :ca_co, :ca_ag, :ca_ar, :ca_ve, :ca_rm, :ca_rp, :ca_fe, :ca_fd),
  'agency.restored,artist.restored,artist_fee.restored,artist_representation.restored,company.restored,contact.restored,custom_field_definition.restored,venue.restored,venue_room.restored');
-- CD12: a soft-delete that ALSO changes content is still .soft_deleted (the
-- transition wins the name) and still leaks nothing.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CD12a contact: soft delete AND rename in one statement',
  format($$update public.contacts set deleted_at=now(), name='ZQXV-GONE' where id=%s$$, :ca_ct), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CD12b ...contact.soft_deleted, changed=[deleted_at, name], no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || ca.leaks(%s,'ZQXV')::text from ca.last_row(%s) r$$, :ca_ct, :ca_ct),
  'contact.soft_deleted ["deleted_at", "name"] false');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CD12c (restore for § CB)', format($$update public.contacts set deleted_at=null, name='CA Contact Winner' where id=%s$$, :ca_ct), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- § CX  THE EXEMPTION, FROM EVERY POSITION
-- ===========================================================================
\o /dev/null
select ca.rows_for(:ca_ct)::text as ct_rows_before \gset
\o
-- (1) sessionless: postgres, no claims.
update public.contacts set title='sessionless touch' where id=:ca_ct;
select ca.val('CX1 a SESSIONLESS update (migration/seed/DBA shape) emits no row',
  format($$select (ca.rows_for(%s) = %s)::text$$, :ca_ct, :'ct_rows_before'), 'true');

-- (2) inside a SECURITY DEFINER function, as a member: the row IS written,
-- because auth.uid() survives a definer context. The control beside it shows
-- why row_security_active() would NOT have worked (Task 5 I4).
create function ca.definer_touch(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  update public.contacts set title = 'definer touch' where id = p_id;
  return pg_catalog.row_security_active('public.contacts')::text;
end $$;
grant execute on function ca.definer_touch(uuid) to authenticated;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.val('CX2 CONTROL: inside a SECURITY DEFINER function row_security_active() is FALSE for a member',
  format($$select ca.definer_touch(%s)$$, :ca_ct), 'false');
reset role; reset request.jwt.claims;
select ca.val('CX2b ...and the trigger STILL fired from inside it (auth.uid() is what it keys on)',
  format($$select (ca.rows_for(%s) = %s + 1)::text || ' ' || (select action from ca.last_row(%s))$$,
         :ca_ct, :'ct_rows_before', :ca_ct), 'true contact.updated');

-- (3) service_role holds no privilege on any of the eleven, so there is no
-- sessionless CLIENT writer the exemption could be hiding.
select ca.val('CX3 service_role holds no INSERT/UPDATE on any of the eleven tables',
  $$select count(*)::text from unnest(array['companies','contacts','contact_companies','agencies','artists',
      'artist_representations','artist_fee_history','venues','venue_rooms',
      'custom_field_definitions','custom_field_values']) t
     where has_table_privilege('service_role', 'public.' || t, 'INSERT')
        or has_table_privilege('service_role', 'public.' || t, 'UPDATE')$$, '0');

-- (4) a no-op UPDATE (only updated_at moves) writes nothing.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.try('CX4 pmanager issues an UPDATE that changes nothing', format($$update public.contacts set title=title where id=%s$$, :ca_ct), 'ok(1)');
reset role; reset request.jwt.claims;
select ca.val('CX4b ...and no audit row is written for it',
  format($$select (ca.rows_for(%s) = %s + 1)::text$$, :ca_ct, :'ct_rows_before'), 'true');

-- (5) a refused write writes nothing: pstd1 (standard_user, owns none of these)
-- cannot update pmanager's contact -- ok(0), and the trail is untouched.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select ca.try('CX5 pstd1 (record-scoped, not the owner) is filtered out of the UPDATE', format($$update public.contacts set title='x' where id=%s$$, :ca_ct), 'ok(0)');
reset role; reset request.jwt.claims;
select ca.val('CX5b ...and the trail did not move', format($$select (ca.rows_for(%s) = %s + 1)::text$$, :ca_ct, :'ct_rows_before'), 'true');

-- ===========================================================================
-- § CB  BULK PATHS SHARE ONE CORRELATION ID, AND THE THREAD CLOSES
-- ===========================================================================
\o /dev/null
select count(*)::text as audit_before_cb from public.audit_events where created_at >= :'ca_t0' \gset
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.val('CB1 set_contact_primary_company: ca_ct primary moves co1 -> co2',
  format($$select public.set_contact_primary_company(%s, %s, %L)::text$$, :ca_ct, :ca_co2, :'alpha_org'), '1');
reset role; reset request.jwt.claims;
select ca.val('CB1b ...two contact_company.updated rows (demote + promote) on ONE correlation id',
  format($$select count(*)::text || '/' || count(distinct correlation_id)::text
            from public.audit_events
           where target_id in (%s, %s) and action='contact_company.updated'
             and created_at >= %L$$, :ca_cc, :ca_cc2, :'ca_t0'), '2/1');
select ca.val('CB1c ...that id is NOT one any earlier row carries (a fresh thread, not the lifecycle marker)',
  format($$select count(*)::text from public.audit_events e
            where e.correlation_id = (select correlation_id from ca.last_row(%s))
              and e.created_at < %L$$, :ca_cc2, :'ca_t0'), '0');

-- The thread closes inside the transaction, before the wrapper returns: with
-- an explicit transaction open, the GUC is empty right after the call.
begin;
set local role authenticated;
set local request.jwt.claims = :'pmanager_c';
select public.set_contact_primary_company(:ca_ct, :ca_co, :'alpha_org');
reset role;
select ca.val('CB2 the CRM bulk thread is CLOSED before the wrapper returns (same transaction, GUC empty)',
  $$select (private.crm_bulk_correlation_id() is null)::text$$, 'true');
commit;

-- merge_records: the big one. Loser ca_ct2 carries a sentinel phone the winner
-- lacks, so the merge carries it -- the winner's row is an UPDATE naming
-- `phone` and NOT its value; the loser is soft-deleted; ca_cc3 is repointed.
\o /dev/null
select now()::text as ca_t1 \gset
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.val('CB3 merge_records(contact): ca_ct2 into ca_ct returns a merge id',
  format($$select (public.merge_records(%L, 'contact', %s, %s) is not null)::text$$, :'alpha_org', :ca_ct, :ca_ct2), 'true');
reset role; reset request.jwt.claims;
select ca.val('CB3b every audit row the merge wrote shares ONE correlation id, and there are at least five of them',
  format($$select (count(distinct correlation_id) = 1 and count(*) >= 5)::text
            from public.audit_events where created_at >= %L and actor_user_id=%L$$, :'ca_t1', :'pmanager'), 'true');
select ca.val('CB3c ...the thread carries the winner update, the loser soft-delete, the link repoint, the merge and the field summary',
  format($$select string_agg(distinct action, ',' order by action)
            from public.audit_events where created_at >= %L and actor_user_id=%L
              and action in ('contact.updated','contact.soft_deleted','contact_company.updated',
                             'records.merged','records.merged.fields')$$, :'ca_t1', :'pmanager'),
  'contact.soft_deleted,contact.updated,contact_company.updated,records.merged,records.merged.fields');
select ca.val('CB3d the winner''s row names `phone` as changed and carries NO value',
  format($$select (r.after->'changed')::text || ' ' || ca.leaks(%s, 'ZQXV')::text
            from (select * from public.audit_events where target_id=%s and action='contact.updated'
                   order by created_at desc limit 1) r$$, :ca_ct, :ca_ct),
  '["phone"] false');
select ca.val('CB3e the repointed link''s row carries contact_id loser -> winner (structural)',
  format($$select (r.before->'values'->>'contact_id' = %L and r.after->'values'->>'contact_id' = %L)::text
            from ca.last_row(%s) r$$, trim(both '''' from :'ca_ct2'), trim(both '''' from :'ca_ct'), :ca_cc3), 'true');
select ca.val('CB3f NOTHING on the merge''s thread carries the loser''s sentinel phone',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L and actor_user_id=%L
              and (coalesce(before::text,'') || coalesce(after::text,'')) like '%%ZQXV%%'$$, :'ca_t1', :'pmanager'), '0');
select ca.val('CB3g the unthreaded body is NOT callable as a client: private.merge_records_unthreaded is not in an exposed schema',
  $$select (select count(*) from pg_proc p where p.pronamespace='private'::regnamespace and p.proname='merge_records_unthreaded')::text
       || '/' || has_function_privilege('anon', 'private.merge_records_unthreaded(uuid,text,uuid,uuid,jsonb,jsonb)', 'EXECUTE')::text$$,
  '1/false');

-- set_custom_field_values: N upserts + a sweep on one thread. Two definitions
-- so the save both updates one value and inserts another.
insert into public.custom_field_definitions (id, organisation_id, entity_type, key, label, field_type)
values ('ca000000-0000-4000-8000-000000000093', :'alpha_org', 'contact', 'ca_probe_two', 'CA probe two', 'text');
\o /dev/null
select now()::text as ca_t2 \gset
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select ca.val('CB4 set_custom_field_values on the winner: one existing value changed, one new value written',
  format($$select public.set_custom_field_values(%L, 'contact', %s,
             jsonb_build_object(%L, '"ZQXV-CF-ONE"'::jsonb, 'ca000000-0000-4000-8000-000000000093', '"ZQXV-CF-TWO"'::jsonb))::text$$,
         :'alpha_org', :ca_ct, trim(both '''' from :'ca_fd')), '2');
reset role; reset request.jwt.claims;
select ca.val('CB4b ...custom_field_value.updated + .created on ONE correlation id, values absent',
  format($$select string_agg(distinct action, ',' order by action) || ' ' || count(distinct correlation_id)::text
              || ' ' || (bool_and((coalesce(before::text,'') || coalesce(after::text,'')) not like '%%ZQXV%%'))::text
            from public.audit_events where created_at >= %L and actor_user_id=%L
              and target_type='custom_field_value'$$, :'ca_t2', :'pmanager'),
  'custom_field_value.created,custom_field_value.updated 1 true');

-- ===========================================================================
-- § CZ  HOUSEKEEPING -- every row and audit event this suite created goes.
-- Sessionless, so the deletes below are themselves un-audited.
-- ===========================================================================
delete from public.audit_events where created_at >= :'ca_t0'
   and actor_user_id in (:'pmanager', :'padmin');
delete from public.custom_field_values where organisation_id = :'alpha_org'
   and field_id in (:ca_fd, 'ca000000-0000-4000-8000-000000000093');
delete from public.custom_field_definitions where id in (:ca_fd, 'ca000000-0000-4000-8000-000000000093');
delete from public.contact_companies where id in (:ca_cc, :ca_cc2, :ca_cc3);
delete from public.artist_fee_history where id = :ca_fe;
delete from public.artist_representations where id = :ca_rp;
delete from public.venue_rooms where id = :ca_rm;
delete from public.venues where id in (:ca_ve, :ca_ve2);
delete from public.artists where id = :ca_ar;
delete from public.agencies where id = :ca_ag;
delete from public.contacts where id in (:ca_ct, :ca_ct2, :ca_new);
delete from public.companies where id in (:ca_co, :ca_co2, :ca_co3);
delete from public.merges where organisation_id = :'alpha_org' and loser_id = :ca_ct2;
delete from public.merge_candidates where organisation_id = :'alpha_org'
   and (record_a_id in (:ca_ct, :ca_ct2, :ca_new) or record_b_id in (:ca_ct, :ca_ct2, :ca_new));
drop function ca.definer_touch(uuid);

select ca.val('CZ1 no audit rows by this suite''s actors remain from its window',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L and actor_user_id in (%L, %L)$$, :'ca_t0', :'pmanager', :'padmin'), '0');
select ca.val('CZ2 no fixture rows remain',
  format($$select (
      (select count(*) from public.contacts where id in (%s,%s,%s))
    + (select count(*) from public.companies where id in (%s,%s,%s))
    + (select count(*) from public.custom_field_definitions where id in (%s,'ca000000-0000-4000-8000-000000000093'))
    + (select count(*) from public.merges where loser_id = %s))::text$$,
    :ca_ct, :ca_ct2, :ca_new, :ca_co, :ca_co2, :ca_co3, :ca_fd, :ca_ct2), '0');

-- ===========================================================================
-- RESULTS
-- ===========================================================================
\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from ca.results order by seq;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed
  from ca.results;
