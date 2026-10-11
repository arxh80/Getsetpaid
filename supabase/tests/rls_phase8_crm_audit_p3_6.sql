-- ===========================================================================
-- Phase 8 Task 7 (CRM write auditing for the Phase 3-6 tables, Q122) suite.
--
-- Covers 20261006000000_audit_phase3_to_6_crm_writes.sql:
--   private.audit_crm_value_columns()   the ONE allowlist, sixteen new branches
--   private.audit_crm_change()          UNCHANGED body, on 32 more triggers
--   private.audit_crm_row()             a membership.deleted trigger, and the
--                                       payload projection's membership branch
--   private.audit_network_row()         .withdrawn and the name-only .updated
--   private.platform_audit_actions()    the five network_connection.* names
--   private.audit_coverage()            the derived coverage census
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh
--   It runs right after rls_phase7_crm_audit.sql on the SAME fixtures (the
--   twelve Phase 2 users, ALPHA and BETA, `super`). It plants its own rows as
--   postgres (sessionless, so un-audited -- PA10 measures that), writes to
--   them as pmanager / padmin / pbowner / super, and § PZ deletes every row
--   and audit event it created, so the later suites and the HTTP block run
--   against the state they were written against.
--
-- IT USES ITS OWN `c7` SCHEMA. Helpers are rls_phase7_crm_audit.sql's `ca.*`,
-- verbatim, with the schema renamed.
--
-- ===========================================================================
-- WHAT THIS SUITE PROVES
-- ===========================================================================
-- For EVERY one of the sixteen new tables: each verb writes exactly one audit
-- row carrying the right actor, organisation, target type and target id;
-- after.values carries EXACTLY the allowlisted keys and nothing else; and --
-- the assertion that matters most -- a sentinel written into EVERY free-text
-- column of that table appears ZERO times in any audit row, measured AFTER
-- proving the sentinel really is in the table row (standing lesson 1: a
-- no-leak test against an empty table is a green test of nothing).
--
-- SECTIONS:
--   PA  fixtures, the trigger census, the allowlist read back, no content
--       column named anywhere, every allowlisted column exists
--   PC  the coverage census: pinned roll, the one excusal, the planted-table
--       denominator (inside a rolled-back subtransaction)
--   PI  INSERT per table: one .created row, keys exactly the allowlist,
--       sentinel in the ROW (denominator) and not in the audit row
--   PU  UPDATE per table: content columns NAMED and not VALUED, structural
--       columns carried old -> new
--   PD  soft-delete and restore per soft-deletable table
--   PN  the network pair: a publish is TWO rows; connection requests are
--       filed against the acting side, .withdrawn and .updated included
--   PM  membership / subscription / merge_candidate -- the three the
--       derivation found; membership.deleted
--   PX  the exemption: sessionless SET NULL shape, no-op, refused write
--   PS  the sweep: no audit row since t0 carries the sentinel; the
--       sentinel IS in every planted row
--   PO  organisation.updated (Q189): a rename and a slug move are one row
--       each; no-op, sessionless and lifecycle-only edits write none; the
--       lifecycle reason never travels; other columns named, not valued
--   PZ  housekeeping
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists c7 cascade;
create schema c7;

create table c7.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function c7.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into c7.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function c7.try(p_label text, p_sql text, p_expected text)
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
  perform c7.record(p_label, p_expected, v_actual);
end $$;

create function c7.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform c7.record(p_label, p_expected, v_actual);
end $$;

-- The newest audit row for one target. SECURITY DEFINER so a member's
-- position can ask about the trail without being able to read audit_events.
create function c7.last_row(p_target uuid)
returns table (action text, before jsonb, after jsonb, correlation_id uuid,
               actor_user_id uuid, organisation_id uuid, target_type text)
language sql security definer set search_path = '' as $$
  select e.action, e.before, e.after, e.correlation_id, e.actor_user_id, e.organisation_id, e.target_type
    from public.audit_events e
   where e.target_id = p_target
   order by e.created_at desc, e.id desc
   limit 1;
$$;

create function c7.rows_for(p_target uuid)
returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.audit_events e where e.target_id = p_target;
$$;

-- Every action ever written for one target, oldest first.
create function c7.actions_for(p_target uuid)
returns text language sql security definer set search_path = '' as $$
  select coalesce(string_agg(e.action, ',' order by e.created_at, e.id), '<none>')
    from public.audit_events e where e.target_id = p_target;
$$;

-- Does the newest row for this target carry the sentinel ANYWHERE in its
-- before/after payload? The leak probe.
create function c7.leaks(p_target uuid, p_sentinel text)
returns boolean language sql security definer set search_path = '' as $$
  select (coalesce(r.before::text, '') || coalesce(r.after::text, '')) like ('%' || p_sentinel || '%')
    from c7.last_row(p_target) r;
$$;

-- The sorted key list of the newest row's after.values, or '<none>'.
create function c7.value_keys(p_target uuid)
returns text language sql security definer set search_path = '' as $$
  select coalesce((select string_agg(k, ',' order by k collate "C")
                     from c7.last_row(p_target) r, jsonb_object_keys(r.after -> 'values') k), '<none>');
$$;

-- "One row, this action, this actor, this org, this target type" in one string.
create function c7.shape(p_target uuid, p_actor uuid, p_org uuid, p_type text)
returns text language sql security definer set search_path = '' as $$
  select c7.rows_for(p_target)::text || ' ' || r.action
         || ' ' || (r.actor_user_id = p_actor)::text
         || ' ' || (r.organisation_id = p_org)::text
         || ' ' || (r.target_type = p_type)::text
    from c7.last_row(p_target) r;
$$;

grant usage on schema c7 to authenticated, anon, service_role;
grant execute on function c7.record(text,text,text) to authenticated, anon, service_role;
grant execute on function c7.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function c7.val(text,text,text)    to authenticated, anon, service_role;
grant execute on function c7.last_row(uuid)         to authenticated, anon, service_role;
grant execute on function c7.rows_for(uuid)         to authenticated, anon, service_role;
grant execute on function c7.actions_for(uuid)      to authenticated, anon, service_role;
grant execute on function c7.leaks(uuid,text)       to authenticated, anon, service_role;
grant execute on function c7.value_keys(uuid)       to authenticated, anon, service_role;
grant execute on function c7.shape(uuid,uuid,uuid,text) to authenticated, anon, service_role;

\o /dev/null
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset
select now()::text as c7_t0 \gset
-- Fixed ids, so the labels below can name them.
\set p_ve   '''c7000000-0000-4000-8000-000000000001'''
\set p_ar   '''c7000000-0000-4000-8000-000000000002'''
\set p_ct   '''c7000000-0000-4000-8000-000000000003'''
\set p_ct2  '''c7000000-0000-4000-8000-000000000004'''
\set p_co   '''c7000000-0000-4000-8000-000000000005'''
\set p_co2  '''c7000000-0000-4000-8000-000000000006'''
\set p_bco  '''c7000000-0000-4000-8000-000000000007'''
\set p_bpr  '''c7000000-0000-4000-8000-000000000008'''
\set p_ev   '''c7000000-0000-4000-8000-000000000011'''
\set p_lu   '''c7000000-0000-4000-8000-000000000012'''
\set p_tk   '''c7000000-0000-4000-8000-000000000021'''
\set p_mt   '''c7000000-0000-4000-8000-000000000022'''
\set p_nt   '''c7000000-0000-4000-8000-000000000023'''
\set p_dc   '''c7000000-0000-4000-8000-000000000024'''
\set p_tl   '''c7000000-0000-4000-8000-000000000025'''
\set p_ml   '''c7000000-0000-4000-8000-000000000026'''
\set p_nl   '''c7000000-0000-4000-8000-000000000027'''
\set p_dl   '''c7000000-0000-4000-8000-000000000028'''
\set p_fe   '''c7000000-0000-4000-8000-000000000031'''
\set p_np   '''c7000000-0000-4000-8000-000000000041'''
\set p_nk   '''c7000000-0000-4000-8000-000000000042'''
\set p_cr1  '''c7000000-0000-4000-8000-000000000043'''
\set p_cr2  '''c7000000-0000-4000-8000-000000000044'''
\set p_cr3  '''c7000000-0000-4000-8000-000000000045'''
\set p_mb   '''c7000000-0000-4000-8000-000000000051'''
\set p_sb   '''c7000000-0000-4000-8000-000000000052'''
\set p_mc   '''c7000000-0000-4000-8000-000000000053'''
\o

-- ===========================================================================
-- § PA  FIXTURES (sessionless), THE CENSUS, THE ALLOWLIST
-- ===========================================================================
-- ALPHA has no subscription row by the time this suite runs (see
-- rls_phase7_crm_audit.sql § CA), and crm_write_organisations() refuses every
-- member write without one. finance_module_organisations() needs Pro. SAVE,
-- PLANT Pro, RESTORE at § PZ. BETA is left without one: a workspace with no
-- subscription may publish (network_publish_organisations' first arm) and
-- may answer connection requests, which is all § PN needs of it.
\o /dev/null
create table c7.saved_sub as
  select * from public.organisation_subscriptions where organisation_id in (:'alpha_org', :'beta_org');
delete from public.organisation_subscriptions where organisation_id in (:'alpha_org', :'beta_org');
insert into public.organisation_subscriptions
  (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
values (:'alpha_org', 'pro', 'monthly', 3, 'active', now() + interval '30 days');
-- The connection-request budget is per organisation per hour; earlier suites
-- and this one share the window. Clear both tenants' counters so § PN's three
-- sends cannot be refused by an earlier suite's spend (the retention job
-- sweeps stale counters anyway; nothing reads them after this).
delete from public.rate_limit_counters where category = 'network_connection_request'
   and subject_id in (:'alpha_org', :'beta_org');
\o
insert into public.venues (id, organisation_id, owner_user_id, name)
values (:p_ve, :'alpha_org', :'pmanager', 'C7 Venue');
insert into public.artists (id, organisation_id, owner_user_id, name)
values (:p_ar, :'alpha_org', :'pmanager', 'C7 Artist');
insert into public.contacts (id, organisation_id, owner_user_id, name)
values (:p_ct,  :'alpha_org', :'pmanager', 'C7 Supplier'),
       (:p_ct2, :'alpha_org', :'pmanager', 'C7 Supplier Dup');
insert into public.companies (id, organisation_id, owner_user_id, name)
values (:p_co,  :'alpha_org', :'pmanager', 'C7 Company'),
       (:p_co2, :'alpha_org', :'pmanager', 'C7 Company Two');
-- BETA's published profile (sessionless): the counterparty for § PN.
insert into public.companies (id, organisation_id, owner_user_id, name)
values (:p_bco, :'beta_org', :'pbowner', 'C7 Beta Company');
insert into public.network_profiles
  (id, organisation_id, entity_kind, entity_id, status, field_visibility, display_name, published_at)
values (:p_bpr, :'beta_org', 'company', :p_bco, 'published', '{}'::jsonb, 'C7 Beta Co', now());
-- A flagged duplicate pair, sessionless, with a free-text label.
insert into public.merge_candidates
  (id, organisation_id, entity_type, keep_id, duplicate_id, keep_owner_user_id, duplicate_owner_user_id,
   label, reason, similarity)
values (:p_mc, :'alpha_org', 'contact', :p_ct, :p_ct2, :'pmanager', :'pmanager',
        'ZQ7-LABEL possible duplicate', 'fuzzy_name', 0.91);

select c7.val('PA1 FIXTURE: pmanager is an ACTIVE manager of ALPHA',
  format($$select role from public.organisation_memberships
            where organisation_id=%L and user_id=%L and status='active'$$, :'alpha_org', :'pmanager'),
  'manager');
select c7.val('PA1b FIXTURE: padmin is an ACTIVE admin of ALPHA at aal2 (finance, members)',
  format($$select role from public.organisation_memberships
            where organisation_id=%L and user_id=%L and status='active'$$, :'alpha_org', :'padmin'),
  'admin');
select c7.val('PA1c FIXTURE: pbowner is NOT a member of ALPHA (the invite target for § PM)',
  format($$select count(*)::text from public.organisation_memberships
            where organisation_id=%L and user_id=%L$$, :'alpha_org', :'pbowner'), '0');

select c7.val('PA2 CENSUS: exactly 54 audit_insert/audit_update triggers over the twenty-seven tables',
  $$select count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
     where c.relnamespace='public'::regnamespace and not t.tgisinternal
       and t.tgname in ('audit_insert','audit_update')
       and n.nspname='private' and p.proname='audit_crm_change'$$, '54');
select c7.val('PA2b ...the sixteen new tables each carry BOTH, under their own target argument',
  $$select string_agg(c.relname || '=' || replace(t.tgargs, '\000', ''), ',' order by c.relname)
      from (select tgrelid, min(encode(tgargs,'escape')) tgargs, count(*) n from pg_trigger
             where tgname in ('audit_insert','audit_update') and not tgisinternal group by tgrelid) t
      join pg_class c on c.oid=t.tgrelid
     where t.n = 2 and c.relname in ('events','event_lineup','tasks','meetings','notes','documents',
       'task_links','meeting_links','note_links','document_links','financial_entries',
       'network_profiles','network_links','organisation_memberships','organisation_subscriptions','merge_candidates')$$,
  'document_links=document_link,documents=document,event_lineup=event_lineup,events=event,financial_entries=financial_entry,meeting_links=meeting_link,meetings=meeting,merge_candidates=merge_candidate,network_links=network_link,network_profiles=network_profile,note_links=note_link,notes=note,organisation_memberships=membership,organisation_subscriptions=subscription,task_links=task_link,tasks=task');
select c7.val('PA2c organisation_memberships carries audit_delete -> audit_crm_row(membership.deleted, membership)',
  $$select replace(encode(t.tgargs,'escape'), '\000', '/') from pg_trigger t
     where t.tgrelid='public.organisation_memberships'::regclass and t.tgname='audit_delete'$$,
  'membership.deleted/membership/');
select c7.val('PA2d network_profiles keeps its audit_network trigger BESIDE the new pair (two writers, deliberately)',
  $$select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
     where t.tgrelid='public.network_profiles'::regclass and not t.tgisinternal and t.tgname like 'audit_%'$$,
  'audit_insert,audit_network,audit_update');
select c7.val('PA2e network_connection_requests has NO generic pair -- one writer, audit_network',
  $$select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
     where t.tgrelid='public.network_connection_requests'::regclass and not t.tgisinternal and t.tgname like 'audit_%'$$,
  'audit_network');
select c7.val('PA3 the trigger function body is UNCHANGED -- its latest definition is still 20260912000000''s (auth.uid() exemption, no row_security_active)',
  $$select ((b ~ 'auth\.uid\(\)') and (b !~ 'row_security_active') and (b ~ 'audit_crm_value_columns\(v_target\)'))::text
     from (select regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') as b
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='private' and p.proname='audit_crm_change') s$$, 'true');

-- THE ALLOWLIST, read back. These sixteen expectations ARE the allowlist's
-- statement of record for the new targets; a change to the function without
-- a change here is a red assertion, which is the intended friction.
select c7.val('PA4a allowlist event',            $$select array_to_string(private.audit_crm_value_columns('event'), ',')$$,            'owner_user_id,event_type,status,starts_at,ends_at,venue_id,venue_room_id,deleted_at');
select c7.val('PA4b allowlist event_lineup',     $$select array_to_string(private.audit_crm_value_columns('event_lineup'), ',')$$,     'event_id,artist_id,position,billing,set_starts_at,set_ends_at,deleted_at');
select c7.val('PA4c allowlist task',             $$select array_to_string(private.audit_crm_value_columns('task'), ',')$$,             'owner_user_id,status,priority,due_at,reminder_at,completed_at,deleted_at');
select c7.val('PA4d allowlist meeting',          $$select array_to_string(private.audit_crm_value_columns('meeting'), ',')$$,          'owner_user_id,starts_at,ends_at,status,deleted_at');
select c7.val('PA4e allowlist note -- owner, visibility, deleted_at and NEVER body',
                                                  $$select array_to_string(private.audit_crm_value_columns('note'), ',')$$,             'owner_user_id,visibility,deleted_at');
select c7.val('PA4f allowlist document -- never filename, never storage_key',
                                                  $$select array_to_string(private.audit_crm_value_columns('document'), ',')$$,         'owner_user_id,mime_type,size_bytes,scan_status,scanned_at,deleted_at,bytes_purged_at,retention_class');
select c7.val('PA4g allowlist task_link',        $$select array_to_string(private.audit_crm_value_columns('task_link'), ',')$$,        'parent_id,entity_type,entity_id,deleted_at');
select c7.val('PA4h allowlist meeting_link',     $$select array_to_string(private.audit_crm_value_columns('meeting_link'), ',')$$,     'parent_id,entity_type,entity_id,deleted_at');
select c7.val('PA4i allowlist note_link',        $$select array_to_string(private.audit_crm_value_columns('note_link'), ',')$$,        'parent_id,entity_type,entity_id,deleted_at');
select c7.val('PA4j allowlist document_link',    $$select array_to_string(private.audit_crm_value_columns('document_link'), ',')$$,    'parent_id,entity_type,entity_id,deleted_at');
select c7.val('PA4k allowlist financial_entry -- never amount_minor, never description',
                                                  $$select array_to_string(private.audit_crm_value_columns('financial_entry'), ',')$$, 'event_id,category,status,currency,occurred_on,supplier_contact_id,artist_id,created_by,deleted_at');
select c7.val('PA4l allowlist network_profile -- the visibility map, never a published value',
                                                  $$select array_to_string(private.audit_crm_value_columns('network_profile'), ',')$$,  'entity_kind,entity_id,status,field_visibility,published_at,created_by,deleted_at');
select c7.val('PA4m allowlist network_link',     $$select array_to_string(private.audit_crm_value_columns('network_link'), ',')$$,     'network_profile_id,private_entity_type,private_entity_id,created_by,deleted_at');
select c7.val('PA4n allowlist membership',       $$select array_to_string(private.audit_crm_value_columns('membership'), ',')$$,       'user_id,role,status,invited_by,invited_at,joined_at');
select c7.val('PA4o allowlist subscription',     $$select array_to_string(private.audit_crm_value_columns('subscription'), ',')$$,     'plan_id,billing_cycle,seat_count,status,comp_expires_at,current_period_end');
select c7.val('PA4p allowlist merge_candidate -- reason (CHECK vocabulary) yes, label no',
                                                  $$select array_to_string(private.audit_crm_value_columns('merge_candidate'), ',')$$,  'entity_type,keep_id,duplicate_id,keep_owner_user_id,duplicate_owner_user_id,reason,resolution,resolved_by,deleted_at');
select c7.val('PA4q the eleven Phase 2 branches are VERBATIM (rebuilt from the latest definition, nothing lost)',
  $$select (array_to_string(private.audit_crm_value_columns('company'), ',') || '|'
         || array_to_string(private.audit_crm_value_columns('artist_representation'), ',') || '|'
         || array_to_string(private.audit_crm_value_columns('custom_field_value'), ','))$$,
  'owner_user_id,type,deleted_at|artist_id,agency_id,contact_id,is_exclusive,is_primary,started_at,ended_at,deleted_at|field_id,entity_type,entity_id');
-- The allowlist names no content column on ANY target -- asserted by NAME so
-- a later "just add body" is a red line here, not a code review. The list is
-- every free-text / money / typed column across all twenty-seven tables.
select c7.val('PA5 NO allowlist entry is a content column, on any of the twenty-seven targets',
  $$select count(*)::text from (
      select unnest(private.audit_crm_value_columns(t)) c
        from unnest(array['company','contact','contact_company','agency','artist',
                          'artist_representation','artist_fee','venue','venue_room',
                          'custom_field_definition','custom_field_value',
                          'event','event_lineup','task','meeting','note','document',
                          'task_link','meeting_link','note_link','document_link',
                          'financial_entry','network_profile','network_link',
                          'membership','subscription','merge_candidate']) t) s
     where c in ('name','email','phone','title','location','website','socials','tags',
                 'genres','country','city','notes','address','capacity','technical_info',
                 'role_text','territory','amount_minor','note','key','label','options','value',
                 'body','detail','attendees','meeting_url','ticket_link','description',
                 'filename','storage_key','display_name','headline','bio','region',
                 'website_url','contact_email','similarity','lifecycle_reason','reason_text')$$, '0');
select c7.val('PA5b every allowlisted column exists on its table (a typo is a silent name-only demotion)',
  $$select count(*)::text from (
      values ('event','events'),('event_lineup','event_lineup'),('task','tasks'),('meeting','meetings'),
             ('note','notes'),('document','documents'),('task_link','task_links'),('meeting_link','meeting_links'),
             ('note_link','note_links'),('document_link','document_links'),('financial_entry','financial_entries'),
             ('network_profile','network_profiles'),('network_link','network_links'),
             ('membership','organisation_memberships'),('subscription','organisation_subscriptions'),
             ('merge_candidate','merge_candidates')
    ) m(target, tbl)
    cross join lateral unnest(private.audit_crm_value_columns(m.target)) c
    where not exists (select 1 from information_schema.columns ic
                       where ic.table_schema='public' and ic.table_name=m.tbl and ic.column_name=c)$$, '0');
-- 96 = event 8 + lineup 7 + task 7 + meeting 5 + note 3 + document 8 + four
-- links x 4 + financial_entry 9 + network_profile 7 + network_link 5 +
-- membership 6 + subscription 6 + merge_candidate 9.
select c7.val('PA5c ...and the count of allowlisted columns over the sixteen is 96, so PA5b is not vacuous',
  $$select sum(cardinality(private.audit_crm_value_columns(t)))::text
      from unnest(array['event','event_lineup','task','meeting','note','document','task_link','meeting_link',
                        'note_link','document_link','financial_entry','network_profile','network_link',
                        'membership','subscription','merge_candidate']) t$$, '96');

select c7.val('PA6 the five network_connection.* names are in the database catalogue (three had been written since 20260904005000 and were on neither side)',
  $$select string_agg(a, ',' order by a collate "C") from private.platform_audit_actions() a
     where a like 'network_connection.%'$$,
  'network_connection.accepted,network_connection.declined,network_connection.requested,network_connection.updated,network_connection.withdrawn');
select c7.val('PA6b membership.deleted is in it too',
  $$select (exists (select 1 from private.platform_audit_actions() a where a = 'membership.deleted'))::text$$, 'true');
select c7.val('PA6c the whole derived catalogue is 171 names (162 + retention.audit_ceiling_released, Q184, + organisation.closed_by_owner, Task 9c, + organisation.closure_reassigned/.closure_deleted, Task 9c job 2, + organisation.closure_candidates_viewed, Q223, + the four integration.* actions, Phase 9 Task 2, + organisation.updated, Q189), none duplicated',
  $$select count(*)::text || '/' || count(distinct a)::text from private.audit_action_catalogue() a$$, '172/172');
select c7.val('PA6d ...and every <target>.<verb> the new triggers can produce is in it',
  $$select count(*)::text from (
      select t || '.' || v as a
        from unnest(array['event','event_lineup','task','meeting','note','document','task_link','meeting_link',
                          'note_link','document_link','financial_entry','network_profile','network_link',
                          'merge_candidate']) t,
             unnest(array['created','updated','soft_deleted','restored']) v
      union all
      select t || '.' || v from unnest(array['membership','subscription']) t, unnest(array['created','updated']) v) x
     where x.a not in (select a from private.audit_action_catalogue() a)$$, '0');

select c7.val('PA10 the sessionless fixture INSERTs above emitted NO audit rows (the exemption, INSERT half)',
  format($$select count(*)::text from public.audit_events
            where target_id in (%L,%L,%L,%L,%L,%L,%L,%L,%L)$$,
         :p_ve, :p_ar, :p_ct, :p_ct2, :p_co, :p_co2, :p_bco, :p_bpr, :p_mc), '0');

-- ===========================================================================
-- § PC  THE COVERAGE CENSUS -- derived, pinned, and its denominator planted
-- ===========================================================================
select c7.val('PC1 the derived roll: 27 generic / 6 dedicated / 2 rpc_only / 0 unaudited (organisations moved to dedicated, Q189)',
  $$select string_agg(coverage || '=' || n, ' ' order by coverage) from
      (select coverage, count(*) n from private.audit_coverage() group by coverage) s$$,
  'dedicated=6 generic=27 rpc_only=2');
select c7.val('PC2 no table is unaudited -- organisations was the last, closed by Q189 (20261031000000)',
  $$select string_agg(table_name || ':' || array_to_string(uncovered_ops, '/'), ',')
      from private.audit_coverage() where coverage = 'unaudited'$$, '<null>');
select c7.val('PC3 the generic set is exactly the twenty-seven',
  $$select count(*)::text from private.audit_coverage() where coverage = 'generic' and target_type is not null$$, '27');
select c7.val('PC4 the dedicated set, by name',
  $$select string_agg(table_name, ',' order by table_name) from private.audit_coverage() where coverage = 'dedicated'$$,
  'erasure_jobs,export_jobs,feedback,incident_alerts,network_connection_requests,organisations');
select c7.val('PC5 the rpc_only set, by name',
  $$select string_agg(table_name, ',' order by table_name) from private.audit_coverage() where coverage = 'rpc_only'$$,
  'organisation_billing_overrides,organisation_feature_overrides');
select c7.val('PC6 the two tables the brief names with NO client write are outside the denominator',
  $$select count(*)::text from private.audit_coverage() where table_name in ('event_status_changes','document_versions','merges')$$, '0');
select c7.val('PC7 the census is executable by no client role',
  $$select count(*)::text from unnest(array['anon','authenticated','service_role']) r
     where has_function_privilege(r, 'private.audit_coverage()', 'execute')$$, '0');

-- THE DENOMINATOR, PLANTED. A subtransaction creates a tenant-owned table
-- with a client grant and no trigger, reads the census, and carries the
-- answer OUT through the exception that rolls it back (the Task 6 fix-round
-- shape), so nothing is left behind and the record() row survives.
create function c7.probe_planted(p_mode text) returns text
language plpgsql security definer set search_path = 'pg_catalog, public' as $$
declare v text;
begin
  begin
    create table public.zz_c7_planted (
      id uuid primary key default gen_random_uuid(),
      organisation_id uuid not null references public.organisations(id) on delete cascade,
      body text);
    alter table public.zz_c7_planted enable row level security;
    grant insert (organisation_id, body), update (body) on public.zz_c7_planted to authenticated;
    if p_mode in ('half', 'pair') then
      create trigger audit_insert after insert on public.zz_c7_planted
        for each row execute function private.audit_crm_change('zz_planted');
    end if;
    if p_mode in ('pair', 'pair_disabled', 'pair_replica') then
      create trigger audit_update after update on public.zz_c7_planted
        for each row execute function private.audit_crm_change('zz_planted');
    end if;
    if p_mode in ('pair_disabled', 'pair_replica') then
      create trigger audit_insert after insert on public.zz_c7_planted
        for each row execute function private.audit_crm_change('zz_planted');
    end if;
    -- Fix round 1, M1: a trigger that exists but does not fire.
    if p_mode = 'pair_disabled' then
      alter table public.zz_c7_planted disable trigger audit_update;
    elsif p_mode = 'pair_replica' then
      alter table public.zz_c7_planted enable replica trigger audit_update;
    end if;
    -- ...and the same for a DEDICATED writer (any AFTER ROW private.audit_*).
    if p_mode in ('dedicated', 'dedicated_disabled') then
      create trigger zz_c7_dedicated after insert or update on public.zz_c7_planted
        for each row execute function private.audit_crm_row('zz.x', 'zz_planted');
    end if;
    if p_mode = 'dedicated_disabled' then
      alter table public.zz_c7_planted disable trigger zz_c7_dedicated;
    end if;
    -- Fix round 1, M2a: marker-guarded policies, with row security on or off.
    if p_mode in ('rpc_rls_on', 'rpc_rls_off') then
      create policy zz_c7_ins on public.zz_c7_planted for insert to authenticated
        with check (private.override_transition_in_progress());
      create policy zz_c7_upd on public.zz_c7_planted for update to authenticated
        using (private.override_transition_in_progress())
        with check (private.override_transition_in_progress());
    end if;
    if p_mode = 'rpc_rls_off' then
      alter table public.zz_c7_planted disable row level security;
    end if;
    select coalesce(string_agg(coverage || ':' || array_to_string(uncovered_ops, '/') || ':' || coalesce(target_type, '-'), ','), '<absent>')
      into v from private.audit_coverage() where table_name = 'zz_c7_planted';
    raise exception using message = v, errcode = 'P7777';
  exception when sqlstate 'P7777' then
    return sqlerrm;
  end;
end $$;
select c7.val('PC8 PLANTED: a tenant-owned table with a column-level client grant and no trigger is `unaudited` on both ops',
  $$select c7.probe_planted('none')$$, 'unaudited:INSERT/UPDATE:-');
-- The target argument is still reported for half a pair (the census names
-- WHICH generic writer is half-attached); the coverage is what says hole.
select c7.val('PC8b ...with HALF the pair it is still unaudited on UPDATE (half a trigger is a hole)',
  $$select c7.probe_planted('half')$$, 'unaudited:UPDATE:zz_planted');
select c7.val('PC8c ...with the pair it is generic under its own argument',
  $$select c7.probe_planted('pair')$$, 'generic::zz_planted');
-- FIX ROUND 1, M1: a DISABLED or REPLICA-ONLY trigger does not fire, so it
-- is not coverage. Before 20261007001000 all three of PC8e-PC8g read
-- `generic::zz_planted` / `dedicated::-` (the reviewer's O2, measured).
select c7.val('PC8e M1 ...with the pair but audit_update DISABLED it is unaudited on UPDATE again',
  $$select c7.probe_planted('pair_disabled')$$, 'unaudited:UPDATE:zz_planted');
select c7.val('PC8f M1 ...and with audit_update REPLICA-ONLY (never fires for a client) likewise',
  $$select c7.probe_planted('pair_replica')$$, 'unaudited:UPDATE:zz_planted');
select c7.val('PC8g positive control: a DEDICATED AFTER ROW writer on both ops is `dedicated`',
  $$select c7.probe_planted('dedicated')$$, 'dedicated::-');
select c7.val('PC8h M1 ...and DISABLED it covers nothing',
  $$select c7.probe_planted('dedicated_disabled')$$, 'unaudited:INSERT/UPDATE:-');
-- M2a: the marker-guarded policy set is only a gate while row security is on.
select c7.val('PC8i positive control: marker-only policies with RLS ON are `rpc_only`',
  $$select c7.probe_planted('rpc_rls_on')$$, 'rpc_only::-');
select c7.val('PC8j M2a ...and with RLS OFF every policy is ignored: unaudited',
  $$select c7.probe_planted('rpc_rls_off')$$, 'unaudited:INSERT/UPDATE:-');
select c7.val('PC8d ...and the planted table is gone (the subtransaction rolled back)',
  $$select (to_regclass('public.zz_c7_planted') is null)::text$$, 'true');

-- M2b / M2c: the two shapes outside the first census's denominator. Each
-- probe plants its relation in a subtransaction and carries the census's
-- answer out through the exception that rolls it back.
create function c7.probe_shape(p_mode text) returns text
language plpgsql security definer set search_path = 'pg_catalog, public' as $$
declare v text;
begin
  begin
    if p_mode = 'orgcol' then
      -- an organisation_id column with NO foreign key at all
      create table public.zz_c7_shape (
        id uuid primary key default gen_random_uuid(),
        organisation_id uuid not null,
        body text);
      alter table public.zz_c7_shape enable row level security;
      grant update (body) on public.zz_c7_shape to authenticated;
    elsif p_mode in ('view', 'view_nogrant') then
      create table public.zz_c7_shape_base (
        id uuid primary key default gen_random_uuid(),
        organisation_id uuid not null references public.organisations(id) on delete cascade,
        body text);
      alter table public.zz_c7_shape_base enable row level security;
      create view public.zz_c7_shape as select id, organisation_id, body from public.zz_c7_shape_base;
      if p_mode = 'view' then
        grant insert, update on public.zz_c7_shape to authenticated;
      end if;
    end if;
    select coalesce(string_agg(table_name || ':' || coverage || ':' || array_to_string(uncovered_ops, '/'), ',' order by table_name), '<absent>')
      into v from private.audit_coverage() where table_name like 'zz\_c7\_shape%';
    raise exception using message = v, errcode = 'P7777';
  exception when sqlstate 'P7777' then
    return sqlerrm;
  end;
end $$;
select c7.val('PC8k M2b an organisation_id column with no FK is in the denominator, unaudited',
  $$select c7.probe_shape('orgcol')$$, 'zz_c7_shape:unaudited:UPDATE');
select c7.val('PC8l positive control: an auto-updatable view with NO client grant is outside it',
  $$select c7.probe_shape('view_nogrant')$$, '<absent>');
select c7.val('PC8m M2c ...granted, the VIEW is in and unaudited, and its un-granted base table is not',
  $$select c7.probe_shape('view')$$, 'zz_c7_shape:unaudited:INSERT/UPDATE');
select c7.val('PC8n ...and nothing the shape probes planted is left',
  $$select (to_regclass('public.zz_c7_shape') is null and to_regclass('public.zz_c7_shape_base') is null)::text$$, 'true');

-- ===========================================================================
-- § PI  INSERT IS AUDITED, per table: one .created row, allowlisted keys only,
-- sentinel in the ROW and not in the audit row. Every free-text column on
-- every table carries the sentinel `ZQ7`.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select c7.try('PI1a events: pmanager creates an event with sentinel name, location, ticket_link, notes',
  format($$insert into public.events (id, organisation_id, owner_user_id, name, event_type, status, starts_at, venue_id, location, ticket_link, notes)
           values (%L, %L, %L, 'ZQ7-EVENT Night', 'club_night', 'draft', now() + interval '10 days', %L, 'ZQ7-LOCATION', 'https://zq7-tickets.test/x', 'ZQ7-EVENT-NOTES')$$,
         :p_ev, :'alpha_org', :'pmanager', :p_ve), 'ok(1)');
select c7.try('PI2a event_lineup: the artist on the bill, with sentinel notes',
  format($$insert into public.event_lineup (id, organisation_id, event_id, artist_id, position, billing, notes)
           values (%L, %L, %L, %L, 1, 'headliner', 'ZQ7-LINEUP-NOTES')$$, :p_lu, :'alpha_org', :p_ev, :p_ar), 'ok(1)');
select c7.try('PI3a tasks: sentinel title and detail',
  format($$insert into public.tasks (id, organisation_id, owner_user_id, title, detail, status, priority, due_at, reminder_at)
           values (%L, %L, %L, 'ZQ7-TASK title', 'ZQ7-TASK-DETAIL', 'open', 'normal', now() + interval '5 days', now() + interval '4 days')$$,
         :p_tk, :'alpha_org', :'pmanager'), 'ok(1)');
select c7.try('PI4a meetings: sentinel title, location, meeting_url, attendees, notes',
  format($$insert into public.meetings (id, organisation_id, owner_user_id, title, starts_at, ends_at, location, meeting_url, attendees, notes, status)
           values (%L, %L, %L, 'ZQ7-MEETING', now() + interval '1 day', now() + interval '1 day 1 hour', 'ZQ7-MEET-LOCATION', 'https://zq7-meet.test/room', 'ZQ7-ATTENDEE One, ZQ7-ATTENDEE Two', 'ZQ7-MEET-NOTES', 'scheduled')$$,
         :p_mt, :'alpha_org', :'pmanager'), 'ok(1)');
select c7.try('PI5a notes: a PRIVATE note whose body is the sentinel',
  format($$insert into public.notes (id, organisation_id, owner_user_id, body, visibility)
           values (%L, %L, %L, 'ZQ7-PRIVATE-NOTE-BODY the thing nobody else may read', 'private')$$,
         :p_nt, :'alpha_org', :'pmanager'), 'ok(1)');
select c7.try('PI6a documents: sentinel filename and a storage_key carrying it (the column-level INSERT grant)',
  format($$insert into public.documents (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes)
           values (%L, %L, %L, 'ZQ7-Contract - J Smith.pdf', %L || '/ZQ7-KEY', 'application/pdf', 12345)$$,
         :p_dc, :'alpha_org', :'pmanager', trim(both '''' from :'alpha_org')), 'ok(1)');
select c7.try('PI7a task_links: the task linked to the event',
  format($$insert into public.task_links (id, organisation_id, parent_id, entity_type, entity_id)
           values (%L, %L, %L, 'event', %L)$$, :p_tl, :'alpha_org', :p_tk, :p_ev), 'ok(1)');
select c7.try('PI8a meeting_links: the meeting linked to the contact',
  format($$insert into public.meeting_links (id, organisation_id, parent_id, entity_type, entity_id)
           values (%L, %L, %L, 'contact', %L)$$, :p_ml, :'alpha_org', :p_mt, :p_ct), 'ok(1)');
select c7.try('PI9a note_links: the note linked to the company',
  format($$insert into public.note_links (id, organisation_id, parent_id, entity_type, entity_id)
           values (%L, %L, %L, 'company', %L)$$, :p_nl, :'alpha_org', :p_nt, :p_co), 'ok(1)');
select c7.try('PI10a document_links: the document linked to the event',
  format($$insert into public.document_links (id, organisation_id, parent_id, entity_type, entity_id)
           values (%L, %L, %L, 'event', %L)$$, :p_dl, :'alpha_org', :p_dc, :p_ev), 'ok(1)');
select c7.try('PI12a network_profiles: a DRAFT profile of the company, every published field a sentinel, all visible',
  format($$insert into public.network_profiles (id, organisation_id, entity_kind, entity_id, status, field_visibility,
             display_name, headline, bio, city, region, country, website_url, contact_email)
           values (%L, %L, 'company', %L, 'draft',
             '{"headline":"network","bio":"network","city":"network","region":"network","country":"network","website_url":"network","contact_email":"network"}'::jsonb,
             'ZQ7-DISPLAY', 'ZQ7-HEADLINE', 'ZQ7-BIO', 'ZQ7-CITY', 'ZQ7-REGION', 'ZQ7-COUNTRY', 'https://zq7-site.test', 'zq7-mail@alpha.test')$$,
         :p_np, :'alpha_org', :p_co), 'ok(1)');
select c7.try('PI13a network_links: ALPHA links BETA''s published profile to its own second company (no free text on this table)',
  format($$insert into public.network_links (id, organisation_id, network_profile_id, private_entity_type, private_entity_id)
           values (%L, %L, %L, 'company', %L)$$, :p_nk, :'alpha_org', :p_bpr, :p_co2), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PI11a financial_entries: padmin (finance) books a sentinel description and a sentinel amount',
  format($$insert into public.financial_entries (id, organisation_id, event_id, category, status, amount_minor, currency, occurred_on, description, supplier_contact_id)
           values (%L, %L, %L, 'cost', 'budgeted', 987654321, 'GBP', date '2026-10-10', 'ZQ7-DESCRIPTION', %L)$$,
         :p_fe, :'alpha_org', :p_ev, :p_ct), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- AT  ATTRIBUTION IS THE SESSION'S (Phase 8 final review A, m1;
--     private.stamp_row_attribution(), 20261029001000)
-- ===========================================================================
-- Before the trigger, each forged write below landed (created_by is only a
-- column default under a table-level grant). The denominator is PI11a/PI12a/
-- PI13a above: the same session's honest INSERT on the same table landed.
set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('AT1 financial_entries: padmin files a line "created by" pmanager -- refused',
  format($$insert into public.financial_entries (organisation_id, event_id, category, status, amount_minor, currency, occurred_on, created_by)
           values (%L, %L, 'cost', 'budgeted', 1, 'GBP', date '2026-10-10', %L)$$,
         :'alpha_org', :p_ev, :'pmanager'), 'denied(23514)');
select c7.try('AT2 financial_entries: ...or back-dates created_at a year -- refused',
  format($$insert into public.financial_entries (organisation_id, event_id, category, status, amount_minor, currency, occurred_on, created_at)
           values (%L, %L, 'cost', 'budgeted', 1, 'GBP', date '2026-10-10', now() - interval '1 year')$$,
         :'alpha_org', :p_ev), 'denied(23514)');
select c7.try('AT3 financial_entries: re-attributing an existing line to pmanager -- refused',
  format($$update public.financial_entries set created_by = %L where id = %L$$, :'pmanager', :p_fe), 'denied(23514)');
select c7.try('AT4 financial_entries: re-dating an existing line -- refused',
  format($$update public.financial_entries set created_at = now() - interval '1 year' where id = %L$$, :p_fe), 'denied(23514)');
select c7.try('AT4a CONTROL financial_entries: an ordinary edit naming its own created_by (as lib/crm/finance.ts does) still lands',
  format($$update public.financial_entries set description = 'ZQ7-DESCRIPTION', created_by = %L where id = %L$$, :'padmin', :p_fe), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('AT5 network_profiles: pmanager creates a profile "created by" padmin -- refused',
  format($$insert into public.network_profiles (organisation_id, entity_kind, entity_id, status, field_visibility, display_name, created_by)
           values (%L, 'company', %L, 'draft', '{}'::jsonb, 'AT5', %L)$$, :'alpha_org', :p_co2, :'padmin'), 'denied(23514)');
select c7.try('AT6 network_profiles: re-attributing the existing profile -- refused',
  format($$update public.network_profiles set created_by = %L where id = %L$$, :'padmin', :p_np), 'denied(23514)');
select c7.try('AT7 network_links: pmanager links a profile "created by" padmin -- refused',
  format($$insert into public.network_links (organisation_id, network_profile_id, private_entity_type, private_entity_id, created_by)
           values (%L, %L, 'company', %L, %L)$$, :'alpha_org', :p_bpr, :p_co, :'padmin'), 'denied(23514)');
select c7.try('AT8 network_links: ...or back-dates it',
  format($$insert into public.network_links (organisation_id, network_profile_id, private_entity_type, private_entity_id, created_at)
           values (%L, %L, 'company', %L, now() - interval '1 year')$$, :'alpha_org', :p_bpr, :p_co), 'denied(23514)');
reset role; reset request.jwt.claims;

select c7.val('AT9 the honest rows carry their own session''s attribution and a database clock',
  format($$select ((select created_by from public.financial_entries where id = %L) = %L::uuid)::text || '/' ||
                  ((select created_by from public.network_profiles  where id = %L) = %L::uuid)::text || '/' ||
                  ((select created_by from public.network_links     where id = %L) = %L::uuid)::text || '/' ||
                  ((select created_at from public.financial_entries where id = %L) >= %L::timestamptz)::text$$,
         :p_fe, :'padmin', :p_np, :'pmanager', :p_nk, :'pmanager', :p_fe, :'c7_t0'), 'true/true/true/true');

-- CONTROL: a member's own session cannot read the trail at all (the definer
-- helpers are how this suite reads it).
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.val('PI0 CONTROL: pmanager''s own session reads 0 audit rows for the event it just created',
  format($$select count(*)::text from public.audit_events where target_id=%L$$, :p_ev), '0');
reset role; reset request.jwt.claims;

-- One .created row each, attributed, typed, org'd.
select c7.val('PI1b events: 1 event.created, actor pmanager, org ALPHA, target_type event',
  format($$select c7.shape(%L, %L, %L, 'event')$$, :p_ev, :'pmanager', :'alpha_org'), '1 event.created true true true');
select c7.val('PI1c ...after.values keys are EXACTLY the event allowlist',
  format($$select c7.value_keys(%L)$$, :p_ev), 'deleted_at,ends_at,event_type,owner_user_id,starts_at,status,venue_id,venue_room_id');
select c7.val('PI1d ...carrying status draft, the venue id, and NO sentinel',
  format($$select (r.after->'values'->>'status') || ' ' || (r.after->'values'->>'venue_id' = %L)::text || ' ' || c7.leaks(%L, 'ZQ7')::text || ' ' || c7.leaks(%L, 'zq7')::text
            from c7.last_row(%L) r$$, trim(both '''' from :'p_ve'), :p_ev, :p_ev, :p_ev), 'draft true false false');
select c7.val('PI1e DENOMINATOR: the event ROW carries the sentinel in four columns',
  format($$select count(*)::text from public.events where id=%L and name like '%%ZQ7%%' and location like '%%ZQ7%%'
            and ticket_link like '%%zq7%%' and notes like '%%ZQ7%%'$$, :p_ev), '1');
select c7.val('PI1f ...and the event_status_changes row the events trigger wrote is itself UNAUDITED (no client write path; the events row is the record)',
  format($$select count(*)::text || '/' || (select count(*) from public.audit_events where target_type='event_status_change')::text
            from public.event_status_changes where event_id=%L$$, :p_ev), '1/0');

select c7.val('PI2b event_lineup: 1 event_lineup.created, attributed',
  format($$select c7.shape(%L, %L, %L, 'event_lineup')$$, :p_lu, :'pmanager', :'alpha_org'), '1 event_lineup.created true true true');
select c7.val('PI2c ...keys exactly the allowlist, billing headliner, no sentinel',
  format($$select c7.value_keys(%L) || ' ' || (r.after->'values'->>'billing') || ' ' || c7.leaks(%L,'ZQ7')::text from c7.last_row(%L) r$$, :p_lu, :p_lu, :p_lu),
  'artist_id,billing,deleted_at,event_id,position,set_ends_at,set_starts_at headliner false');
select c7.val('PI2d DENOMINATOR: the lineup row carries the sentinel',
  format($$select count(*)::text from public.event_lineup where id=%L and notes like '%%ZQ7%%'$$, :p_lu), '1');

select c7.val('PI3b tasks: 1 task.created, keys, priority normal, no sentinel',
  format($$select c7.shape(%L, %L, %L, 'task') || ' | ' || c7.value_keys(%L) || ' ' || (r.after->'values'->>'priority') || ' ' || c7.leaks(%L,'ZQ7')::text
            from c7.last_row(%L) r$$, :p_tk, :'pmanager', :'alpha_org', :p_tk, :p_tk, :p_tk),
  '1 task.created true true true | completed_at,deleted_at,due_at,owner_user_id,priority,reminder_at,status normal false');
select c7.val('PI3c DENOMINATOR: the task row carries the sentinel in title and detail',
  format($$select count(*)::text from public.tasks where id=%L and title like '%%ZQ7%%' and detail like '%%ZQ7%%'$$, :p_tk), '1');

select c7.val('PI4b meetings: 1 meeting.created, keys, no sentinel -- attendees NEVER',
  format($$select c7.shape(%L, %L, %L, 'meeting') || ' | ' || c7.value_keys(%L) || ' ' || c7.leaks(%L,'ZQ7')::text || ' ' || c7.leaks(%L,'zq7')::text
            from c7.last_row(%L) r$$, :p_mt, :'pmanager', :'alpha_org', :p_mt, :p_mt, :p_mt, :p_mt),
  '1 meeting.created true true true | deleted_at,ends_at,owner_user_id,starts_at,status false false');
select c7.val('PI4c DENOMINATOR: the meeting row carries the sentinel in five columns',
  format($$select count(*)::text from public.meetings where id=%L and title like '%%ZQ7%%' and location like '%%ZQ7%%'
            and meeting_url like '%%zq7%%' and attendees like '%%ZQ7%%' and notes like '%%ZQ7%%'$$, :p_mt), '1');

select c7.val('PI5b notes: 1 note.created, keys owner/visibility/deleted_at, visibility private, body NEVER',
  format($$select c7.shape(%L, %L, %L, 'note') || ' | ' || c7.value_keys(%L) || ' ' || (r.after->'values'->>'visibility') || ' ' || c7.leaks(%L,'ZQ7')::text
            from c7.last_row(%L) r$$, :p_nt, :'pmanager', :'alpha_org', :p_nt, :p_nt, :p_nt),
  '1 note.created true true true | deleted_at,owner_user_id,visibility private false');
select c7.val('PI5c DENOMINATOR: the private note''s body IS the sentinel',
  format($$select count(*)::text from public.notes where id=%L and body like '%%ZQ7-PRIVATE-NOTE-BODY%%'$$, :p_nt), '1');
select c7.val('PI5d ...and the whole audit table carries no fragment of it (the Q54 boundary, measured over every row)',
  $$select count(*)::text from public.audit_events
     where (coalesce(before::text,'') || coalesce(after::text,'')) like '%nobody else may read%'$$, '0');

select c7.val('PI6b documents: 1 document.created, keys, scan_status pending, no filename, no storage key',
  format($$select c7.shape(%L, %L, %L, 'document') || ' | ' || c7.value_keys(%L) || ' ' || (r.after->'values'->>'scan_status') || ' ' || c7.leaks(%L,'ZQ7')::text || ' ' || c7.leaks(%L,'Smith')::text
            from c7.last_row(%L) r$$, :p_dc, :'pmanager', :'alpha_org', :p_dc, :p_dc, :p_dc, :p_dc),
  '1 document.created true true true | bytes_purged_at,deleted_at,mime_type,owner_user_id,retention_class,scan_status,scanned_at,size_bytes pending false false');
select c7.val('PI6c DENOMINATOR: the document row carries the sentinel in filename and storage_key',
  format($$select count(*)::text from public.documents where id=%L and filename like '%%ZQ7%%' and storage_key like '%%ZQ7%%'$$, :p_dc), '1');

select c7.val('PI7b-10b the four links: one .created each, keys exactly parent/entity_type/entity_id/deleted_at',
  format($$select string_agg(c7.shape(t, %L, %L, ty) || ' [' || c7.value_keys(t) || ']', ' ; ' order by ty)
            from (values (%L::uuid,'task_link'),(%L::uuid,'meeting_link'),(%L::uuid,'note_link'),(%L::uuid,'document_link')) v(t, ty)$$,
         :'pmanager', :'alpha_org', :p_tl, :p_ml, :p_nl, :p_dl),
  '1 document_link.created true true true [deleted_at,entity_id,entity_type,parent_id] ; 1 meeting_link.created true true true [deleted_at,entity_id,entity_type,parent_id] ; 1 note_link.created true true true [deleted_at,entity_id,entity_type,parent_id] ; 1 task_link.created true true true [deleted_at,entity_id,entity_type,parent_id]');

select c7.val('PI11b financial_entries: 1 financial_entry.created by padmin, keys, category cost, NO description and NO amount',
  format($$select c7.shape(%L, %L, %L, 'financial_entry') || ' | ' || c7.value_keys(%L) || ' ' || (r.after->'values'->>'category') || ' ' || c7.leaks(%L,'ZQ7')::text || ' ' || c7.leaks(%L,'987654321')::text
            from c7.last_row(%L) r$$, :p_fe, :'padmin', :'alpha_org', :p_fe, :p_fe, :p_fe, :p_fe),
  '1 financial_entry.created true true true | artist_id,category,created_by,currency,deleted_at,event_id,occurred_on,status,supplier_contact_id cost false false');
select c7.val('PI11c DENOMINATOR: the entry row carries the sentinel description and the amount',
  format($$select count(*)::text from public.financial_entries where id=%L and description like '%%ZQ7%%' and amount_minor = 987654321$$, :p_fe), '1');

select c7.val('PI12b network_profiles: a DRAFT insert is 1 row, network_profile.created (NOT .published), keys, no published value',
  format($$select c7.actions_for(%L) || ' | ' || c7.value_keys(%L) || ' ' || c7.leaks(%L,'ZQ7')::text || ' ' || c7.leaks(%L,'zq7')::text from c7.last_row(%L) r$$,
         :p_np, :p_np, :p_np, :p_np, :p_np),
  'network_profile.created | created_by,deleted_at,entity_id,entity_kind,field_visibility,published_at,status false false');
select c7.val('PI12c ...the visibility MAP is carried (names to levels), which is what tells the operator what was exposed without saying what it said',
  format($$select (r.after->'values'->'field_visibility'->>'bio') from c7.last_row(%L) r$$, :p_np), 'network');
select c7.val('PI12d DENOMINATOR: the profile row carries the sentinel in all eight published fields',
  format($$select count(*)::text from public.network_profiles where id=%L and display_name like '%%ZQ7%%' and headline like '%%ZQ7%%'
            and bio like '%%ZQ7%%' and city like '%%ZQ7%%' and region like '%%ZQ7%%' and country like '%%ZQ7%%'
            and website_url like '%%zq7%%' and contact_email like '%%zq7%%'$$, :p_np), '1');

select c7.val('PI13b network_links: 1 network_link.created, filed under the LINKING organisation (Q82: the publisher learns nothing)',
  format($$select c7.shape(%L, %L, %L, 'network_link') || ' | ' || c7.value_keys(%L) || ' ' || (select count(*) from public.audit_events where target_id=%L and organisation_id=%L)::text
            from c7.last_row(%L) r$$, :p_nk, :'pmanager', :'alpha_org', :p_nk, :p_nk, :'beta_org', :p_nk),
  '1 network_link.created true true true | created_by,deleted_at,network_profile_id,private_entity_id,private_entity_type 0');

-- ===========================================================================
-- § PU  UPDATE: content columns NAMED, never valued; structural carried
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU1a events: every free-text column to a new sentinel',
  format($$update public.events set name='ZQ7-RENAMED', location='ZQ7-LOC2', ticket_link='https://zq7-2.test/y', notes='ZQ7-NOTES2' where id=%L$$, :p_ev), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU1b event.updated naming exactly location, name, notes, ticket_link -- values EMPTY both sides, no leak',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || (r.before->'values')::text || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text || c7.leaks(%L,'zq7')::text
            from c7.last_row(%L) r$$, :p_ev, :p_ev, :p_ev),
  'event.updated ["location", "name", "notes", "ticket_link"] {}{} falsefalse');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU1c events: status draft -> confirmed and the room set (structural)',
  format($$update public.events set status='confirmed' where id=%L$$, :p_ev), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU1d ...before.values.status draft, after.values.status confirmed, changed=[status]',
  format($$select (r.before->'values'->>'status') || '->' || (r.after->'values'->>'status') || ' ' || (r.after->'changed')::text from c7.last_row(%L) r$$, :p_ev),
  'draft->confirmed ["status"]');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU2a event_lineup: notes to a sentinel, position and billing moved',
  format($$update public.event_lineup set notes='ZQ7-LU2', position=2, billing='support' where id=%L$$, :p_lu), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU2b event_lineup.updated: changed [billing, notes, position]; billing and position carried, notes not',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values')::text || '->' || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text from c7.last_row(%L) r$$, :p_lu, :p_lu),
  '["billing", "notes", "position"] {"billing": "headliner", "position": 1}->{"billing": "support", "position": 2} false');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU3a tasks: title and detail to sentinels, status done with completed_at',
  format($$update public.tasks set title='ZQ7-T2', detail='ZQ7-D2', status='done', completed_at=now() where id=%L$$, :p_tk), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU3b task.updated: changed [completed_at, detail, status, title]; status open->done and completed_at carried; no leak',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values'->>'status') || '->' || (r.after->'values'->>'status') || ' ' || ((r.after->'values'->>'completed_at') is not null)::text || ' ' || c7.leaks(%L,'ZQ7')::text
            from c7.last_row(%L) r$$, :p_tk, :p_tk),
  '["completed_at", "detail", "status", "title"] open->done true false');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU4a meetings: all five free-text columns to sentinels, status held',
  format($$update public.meetings set title='ZQ7-M2', location='ZQ7-ML2', meeting_url='https://zq7-2.test/r', attendees='ZQ7-ATT2', notes='ZQ7-MN2', status='held' where id=%L$$, :p_mt), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU4b meeting.updated: six names, only status valued, no leak',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values')::text || '->' || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text || c7.leaks(%L,'zq7')::text from c7.last_row(%L) r$$, :p_mt, :p_mt, :p_mt),
  '["attendees", "location", "meeting_url", "notes", "status", "title"] {"status": "scheduled"}->{"status": "held"} falsefalse');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU5a notes: the body rewritten AND visibility private -> company in one statement',
  format($$update public.notes set body='ZQ7-COMPANY-NOTE-BODY now the whole workspace reads it', visibility='company' where id=%L$$, :p_nt), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU5b note.updated: changed [body, visibility]; visibility private->company carried; body NAMED and never valued',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values')::text || '->' || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text || ' ' || c7.leaks(%L,'workspace reads')::text from c7.last_row(%L) r$$, :p_nt, :p_nt, :p_nt),
  '["body", "visibility"] {"visibility": "private"}->{"visibility": "company"} false false');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU6a documents: pmanager cannot write the scan verdict (outside the UPDATE grant since 20261029000000, final review A I1)',
  format($$update public.documents set scan_status='clean', scanned_at=now() where id=%L$$, :p_dc), 'denied(42501)');
reset role; reset request.jwt.claims;
-- The verdict lands through the scanner's RPC (service_role alone). It is a
-- SESSIONLESS write, so private.audit_crm_change() files no document.updated
-- row; the upload action's document_uploaded/_quarantined row is the record.
set role service_role;
select public.record_document_scan_verdict(:'alpha_org'::uuid, :p_dc::uuid, 'clean');
reset role;
select c7.val('PU6b the scanner''s verdict landed and filed no document.updated row (sessionless), and the refused PATCH filed none either',
  format($$select d.scan_status || ' ' || (select count(*) from public.audit_events e where e.target_id=d.id and e.action='document.updated')::text
             from public.documents d where d.id=%L$$, :p_dc),
  'clean 0');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU6c documents: pmanager cannot rename the file (filename is outside the UPDATE grant) -- so a filename can never enter an UPDATE row either',
  format($$update public.documents set filename='ZQ7-renamed.pdf' where id=%L$$, :p_dc), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU7a task_links: the link re-pointed from the event to the contact',
  format($$update public.task_links set entity_type='contact', entity_id=%L where id=%L$$, :p_ct, :p_tl), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU7b task_link.updated: entity_type event->contact and entity_id old->new carried (every column structural)',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values'->>'entity_type') || '->' || (r.after->'values'->>'entity_type') || ' ' || (r.before->'values'->>'entity_id' = %L and r.after->'values'->>'entity_id' = %L)::text from c7.last_row(%L) r$$,
         trim(both '''' from :'p_ev'), trim(both '''' from :'p_ct'), :p_tl),
  '["entity_id", "entity_type"] event->contact true');

set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PU11a financial_entries: description and amount changed, status budgeted -> actual',
  format($$update public.financial_entries set description='ZQ7-DESC2', amount_minor=123456789, status='actual' where id=%L$$, :p_fe), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU11b financial_entry.updated: changed [amount_minor, description, status]; status carried; NEITHER amount NOR description',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values')::text || '->' || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text || c7.leaks(%L,'123456789')::text || c7.leaks(%L,'987654321')::text from c7.last_row(%L) r$$, :p_fe, :p_fe, :p_fe, :p_fe),
  '["amount_minor", "description", "status"] {"status": "budgeted"}->{"status": "actual"} falsefalsefalse');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU12a network_profiles: every published field rewritten on the draft (an ordinary edit)',
  format($$update public.network_profiles set display_name='ZQ7-D2', headline='ZQ7-H2', bio='ZQ7-B2', city='ZQ7-C2', region='ZQ7-R2', country='ZQ7-K2', website_url='https://zq7-2.test', contact_email='zq7-2@alpha.test' where id=%L$$, :p_np), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU12b network_profile.updated: eight names, values EMPTY, no leak -- and NO network_profile.* transition row (still a draft)',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || (r.after->'values')::text || ' ' || c7.leaks(%L,'ZQ7')::text || c7.leaks(%L,'zq7')::text || ' ' || c7.actions_for(%L)
            from c7.last_row(%L) r$$, :p_np, :p_np, :p_np, :p_np),
  'network_profile.updated ["bio", "city", "contact_email", "country", "display_name", "headline", "region", "website_url"] {} falsefalse network_profile.created,network_profile.updated');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PU13a network_links: re-pointed to the first company',
  format($$update public.network_links set private_entity_id=%L where id=%L$$, :p_co, :p_nk), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PU13b network_link.updated with private_entity_id old->new',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values'->>'private_entity_id' = %L and r.after->'values'->>'private_entity_id' = %L)::text from c7.last_row(%L) r$$,
         trim(both '''' from :'p_co2'), trim(both '''' from :'p_co'), :p_nk), '["private_entity_id"] true');

-- ===========================================================================
-- § PD  SOFT-DELETE AND RESTORE ARE THEIR OWN ACTIONS, on every new
-- soft-deletable table. Links BEFORE parents (their UPDATE policies need a
-- live parent); financial entries as padmin.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PD1a task_link: soft delete',     format($$update public.task_links set deleted_at=now() where id=%L$$, :p_tl), 'ok(1)');
select c7.try('PD2a meeting_link: soft delete',  format($$update public.meeting_links set deleted_at=now() where id=%L$$, :p_ml), 'ok(1)');
select c7.try('PD3a note_link: soft delete',     format($$update public.note_links set deleted_at=now() where id=%L$$, :p_nl), 'ok(1)');
select c7.try('PD4a document_link: soft delete', format($$update public.document_links set deleted_at=now() where id=%L$$, :p_dl), 'ok(1)');
select c7.try('PD5a event_lineup: soft delete',  format($$update public.event_lineup set deleted_at=now() where id=%L$$, :p_lu), 'ok(1)');
select c7.try('PD6a task: soft delete',          format($$update public.tasks set deleted_at=now() where id=%L$$, :p_tk), 'ok(1)');
select c7.try('PD7a meeting: soft delete',       format($$update public.meetings set deleted_at=now() where id=%L$$, :p_mt), 'ok(1)');
select c7.try('PD8a note: soft delete',          format($$update public.notes set deleted_at=now() where id=%L$$, :p_nt), 'ok(1)');
select c7.try('PD9a document: soft delete (the guard overwrites the clock and freezes the class)',
                                                 format($$update public.documents set deleted_at=timestamptz '2001-01-01' where id=%L$$, :p_dc), 'ok(1)');
select c7.try('PD11a network_link: soft delete', format($$update public.network_links set deleted_at=now() where id=%L$$, :p_nk), 'ok(1)');
select c7.try('PD12a network_profile: soft delete', format($$update public.network_profiles set deleted_at=now() where id=%L$$, :p_np), 'ok(1)');
reset role; reset request.jwt.claims;
-- The finance line BEFORE its event: financial_entries_update_manage_finance
-- requires a live parent event (the first run, with this after the event,
-- was refused 42501 -- the policy working, not the audit failing).
set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PD13a financial_entry: soft delete (padmin)', format($$update public.financial_entries set deleted_at=now() where id=%L$$, :p_fe), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PD10a event: soft delete',        format($$update public.events set deleted_at=now() where id=%L$$, :p_ev), 'ok(1)');
reset role; reset request.jwt.claims;

select c7.val('PD20 every one of the thirteen names .soft_deleted, with before deleted_at null and after non-null',
  format($$select string_agg(a, ',' order by a collate "C") from (
            select (select r.action || case when (r.before->'values'->'deleted_at') = 'null'::jsonb
                                                and (r.after->'values'->>'deleted_at') is not null then '' else '!' end
                      from c7.last_row(t) r) a
              from unnest(array[%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L]::uuid[]) t) s$$,
         :p_tl, :p_ml, :p_nl, :p_dl, :p_lu, :p_tk, :p_mt, :p_nt, :p_dc, :p_ev, :p_nk, :p_np, :p_fe),
  'document.soft_deleted,document_link.soft_deleted,event.soft_deleted,event_lineup.soft_deleted,financial_entry.soft_deleted,meeting.soft_deleted,meeting_link.soft_deleted,network_link.soft_deleted,network_profile.soft_deleted,note.soft_deleted,note_link.soft_deleted,task.soft_deleted,task_link.soft_deleted');
-- financial, not operational: the document is linked to p_ev, which carries
-- a live finance line at the moment of deletion (PD13a runs later).
select c7.val('PD21 the document''s row carries the FROZEN retention class the guard stamped (financial: its event carries money), and the database''s clock, not 2001',
  format($$select (r.after->'changed')::text || ' ' || (r.after->'values'->>'retention_class') || ' ' || ((r.after->'values'->>'deleted_at')::timestamptz > now() - interval '1 minute')::text from c7.last_row(%L) r$$, :p_dc),
  '["deleted_at", "retention_class"] financial true');
select c7.val('PD22 a soft-delete row carries NO sentinel either (the sweep in § PS says so for all; this names the note)',
  format($$select c7.leaks(%L,'ZQ7')::text from c7.last_row(%L) r$$, :p_nt, :p_nt), 'false');

-- Restore, parents before children.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PD30a event: restore',          format($$update public.events set deleted_at=null where id=%L$$, :p_ev), 'ok(1)');
select c7.try('PD30b task: restore',           format($$update public.tasks set deleted_at=null where id=%L$$, :p_tk), 'ok(1)');
select c7.try('PD30c meeting: restore',        format($$update public.meetings set deleted_at=null where id=%L$$, :p_mt), 'ok(1)');
select c7.try('PD30d note: restore',           format($$update public.notes set deleted_at=null where id=%L$$, :p_nt), 'ok(1)');
select c7.try('PD30e document: restore',       format($$update public.documents set deleted_at=null where id=%L$$, :p_dc), 'ok(1)');
select c7.try('PD30f event_lineup: restore',   format($$update public.event_lineup set deleted_at=null where id=%L$$, :p_lu), 'ok(1)');
select c7.try('PD30g task_link: restore',      format($$update public.task_links set deleted_at=null where id=%L$$, :p_tl), 'ok(1)');
select c7.try('PD30h meeting_link: restore',   format($$update public.meeting_links set deleted_at=null where id=%L$$, :p_ml), 'ok(1)');
select c7.try('PD30i note_link: restore',      format($$update public.note_links set deleted_at=null where id=%L$$, :p_nl), 'ok(1)');
select c7.try('PD30j document_link: restore',  format($$update public.document_links set deleted_at=null where id=%L$$, :p_dl), 'ok(1)');
select c7.try('PD30k network_link: restore',   format($$update public.network_links set deleted_at=null where id=%L$$, :p_nk), 'ok(1)');
select c7.try('PD30l network_profile: restore',format($$update public.network_profiles set deleted_at=null where id=%L$$, :p_np), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PD30m financial_entry: restore (padmin)', format($$update public.financial_entries set deleted_at=null where id=%L$$, :p_fe), 'ok(1)');
reset role; reset request.jwt.claims;

select c7.val('PD31 every restore names .restored, before deleted_at non-null and after null',
  format($$select string_agg(a, ',' order by a collate "C") from (
            select (select r.action || case when (r.before->'values'->>'deleted_at') is not null
                                                and (r.after->'values'->'deleted_at') = 'null'::jsonb then '' else '!' end
                      from c7.last_row(t) r) a
              from unnest(array[%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L]::uuid[]) t) s$$,
         :p_tl, :p_ml, :p_nl, :p_dl, :p_lu, :p_tk, :p_mt, :p_nt, :p_dc, :p_ev, :p_nk, :p_np, :p_fe),
  'document.restored,document_link.restored,event.restored,event_lineup.restored,financial_entry.restored,meeting.restored,meeting_link.restored,network_link.restored,network_profile.restored,note.restored,note_link.restored,task.restored,task_link.restored');
select c7.val('PD32 the document''s restore CLEARS the frozen class (changed [deleted_at, retention_class], class null)',
  format($$select (r.after->'changed')::text || ' ' || ((r.after->'values'->'retention_class') = 'null'::jsonb)::text from c7.last_row(%L) r$$, :p_dc),
  '["deleted_at", "retention_class"] true');

-- ===========================================================================
-- § PN  THE NETWORK PAIR
-- ===========================================================================
\o /dev/null
select now()::text as c7_t_pn \gset
\o
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PN1 pmanager PUBLISHES the profile (status published, published_at set) and rewrites the bio in the same statement',
  format($$update public.network_profiles set status='published', published_at=now(), bio='ZQ7-BIO-AT-PUBLISH' where id=%L$$, :p_np), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN1b TWO rows for one statement: network_profile.published (the dedicated writer) and network_profile.updated (the generic one)',
  format($$select string_agg(action, ',' order by action collate "C") from public.audit_events where target_id=%L and created_at >= %L$$, :p_np, :'c7_t_pn'),
  'network_profile.published,network_profile.updated');
select c7.val('PN1c ...the .updated row names bio, published_at and status; carries status draft->published; the bio value is in neither row',
  format($$select (r.after->'changed')::text || ' ' || (r.before->'values'->>'status') || '->' || (r.after->'values'->>'status') || ' '
              || (select count(*) from public.audit_events where target_id=%L and (coalesce(before::text,'')||coalesce(after::text,'')) like '%%ZQ7-BIO-AT-PUBLISH%%')::text
            from (select * from public.audit_events where target_id=%L and action='network_profile.updated' order by created_at desc, id desc limit 1) r$$, :p_np, :p_np),
  '["bio", "published_at", "status"] draft->published 0');
select c7.val('PN1d ...and the .published row is what it always was: the visibility map, no value (20260907001000 unchanged)',
  format($$select (r.after ? 'field_visibility')::text || ' ' || (r.after ? 'changed')::text || ' ' || ((coalesce(r.before::text,'')||r.after::text) like '%%ZQ7%%')::text
            from (select * from public.audit_events where target_id=%L and action='network_profile.published' order by created_at desc limit 1) r$$, :p_np),
  'true false false');

-- Connection requests: three sends, the four transitions, the fallback.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PN2 ALPHA (pmanager) requests a connection with BETA''s profile',
  format($$insert into public.network_connection_requests (id, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
           values (%L, %L, %L, %L, %L)$$, :p_cr1, :'alpha_org', :p_np, :'beta_org', :p_bpr), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN2b network_connection.requested, filed against the SENDER (ALPHA), actor pmanager, the other side in the payload',
  format($$select c7.shape(%L, %L, %L, 'network_connection_request') || ' ' || (r.after->>'to_organisation_id' = %L)::text from c7.last_row(%L) r$$,
         :p_cr1, :'pmanager', :'alpha_org', trim(both '''' from :'beta_org'), :p_cr1), '1 network_connection.requested true true true true');
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select c7.try('PN3 BETA (pbowner) DECLINES it',
  format($$update public.network_connection_requests set status='declined', responded_at=now() where id=%L$$, :p_cr1), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN3b network_connection.declined, filed against the RECIPIENT (BETA), actor pbowner -- one row, no name-only fallback beside it',
  format($$select c7.shape(%L, %L, %L, 'network_connection_request') || ' | ' || c7.actions_for(%L) from c7.last_row(%L) r$$,
         :p_cr1, :'pbowner', :'beta_org', :p_cr1, :p_cr1), '2 network_connection.declined true true true | network_connection.requested,network_connection.declined');

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select c7.try('PN4 BETA (pbowner) requests a connection with ALPHA''s profile',
  format($$insert into public.network_connection_requests (id, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
           values (%L, %L, %L, %L, %L)$$, :p_cr2, :'beta_org', :p_bpr, :'alpha_org', :p_np), 'ok(1)');
select c7.try('PN4b ...and WITHDRAWS it (the transition 20260904005000 left unaudited)',
  format($$update public.network_connection_requests set status='withdrawn', responded_at=now() where id=%L$$, :p_cr2), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN4c network_connection.withdrawn, filed against the SENDER (BETA), actor pbowner',
  format($$select c7.shape(%L, %L, %L, 'network_connection_request') || ' | ' || c7.actions_for(%L) from c7.last_row(%L) r$$,
         :p_cr2, :'pbowner', :'beta_org', :p_cr2, :p_cr2), '2 network_connection.withdrawn true true true | network_connection.requested,network_connection.withdrawn');

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PN5 ALPHA requests again (the declined row does not block a re-request, Q79)',
  format($$insert into public.network_connection_requests (id, from_organisation_id, from_network_profile_id, to_organisation_id, to_network_profile_id)
           values (%L, %L, %L, %L, %L)$$, :p_cr3, :'alpha_org', :p_np, :'beta_org', :p_bpr), 'ok(1)');
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select c7.try('PN5b BETA ACCEPTS',
  format($$update public.network_connection_requests set status='accepted', responded_at=now() where id=%L$$, :p_cr3), 'ok(1)');
-- PN5c RUNS AS THE OWNER ROLE (pbowner's claims kept, so the audit actor is
-- still pbowner) SINCE 20261020000000 (Task 9b fix round 2, N1): a client can
-- no longer re-date an answered request -- private.connection_request_bound_update
-- refuses it (rls_phase6_network.sql NQ10) -- so the only writer left that can
-- make a same-status edit is an exempt one. The audit trigger's name-only
-- `updated` path it exists to measure is unchanged.
reset role;
select c7.try('PN5c ...then re-sets responded_at on the accepted row (status unchanged; an exempt writer, the client path is refused since 20261020000000)',
  format($$update public.network_connection_requests set responded_at=now() + interval '1 second' where id=%L$$, :p_cr3), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN5d network_connection.accepted then network_connection.updated (name-only: changed [responded_at]), both against BETA',
  format($$select c7.actions_for(%L) || ' | ' || (r.after->'changed')::text || ' ' || (r.organisation_id = %L)::text || ' ' || (r.after->>'status') from c7.last_row(%L) r$$,
         :p_cr3, :'beta_org', :p_cr3), 'network_connection.requested,network_connection.accepted,network_connection.updated | ["responded_at"] true accepted');
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select c7.try('PN5e a no-op UPDATE on the accepted row (nothing but updated_at moves)',
  format($$update public.network_connection_requests set responded_at=responded_at where id=%L$$, :p_cr3), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PN5f ...writes nothing',
  format($$select c7.rows_for(%L)::text$$, :p_cr3), '3');
select c7.val('PN6 no connection-request row carries a published VALUE (the fixture display names are the oracle)',
  $$select count(*)::text from public.audit_events
     where target_type='network_connection_request' and (after::text like '%C7 Beta Co%' or after::text like '%ZQ7%')$$, '0');

-- ===========================================================================
-- § PM  THE THREE THE DERIVATION FOUND
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PM1 padmin INVITES pbowner into ALPHA as a standard_user',
  format($$insert into public.organisation_memberships (id, organisation_id, user_id, role, status, invited_by)
           values (%L, %L, %L, 'standard_user', 'invited', %L)$$, :p_mb, :'alpha_org', :'pbowner', :'padmin'), 'ok(1)');
select c7.try('PM2 ...and ESCALATES the invite to manager',
  format($$update public.organisation_memberships set role='manager' where id=%L$$, :p_mb), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PM1b membership.created: actor padmin, org ALPHA, keys exactly the allowlist, role standard_user',
  format($$select r.action || ' ' || (r.actor_user_id = %L)::text || ' ' || (r.organisation_id = %L)::text
              || ' | ' || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r.after -> 'values') k)
              || ' ' || (r.after->'values'->>'role')
            from (select * from public.audit_events where target_id=%L and action='membership.created') r$$, :'padmin', :'alpha_org', :p_mb),
  'membership.created true true | invited_at,invited_by,joined_at,role,status,user_id standard_user');
select c7.val('PM2b membership.updated: role standard_user -> manager carried -- the escalation that used to leave no row',
  format($$select r.action || ' ' || (r.before->'values'->>'role') || '->' || (r.after->'values'->>'role') from c7.last_row(%L) r$$, :p_mb),
  'membership.updated standard_user->manager');
set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PM3 padmin REMOVES the invite (a hard DELETE)',
  format($$delete from public.organisation_memberships where id=%L$$, :p_mb), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PM3b membership.deleted via audit_crm_row: before carries user_id / role / status and nothing else',
  format($$select r.action || ' ' || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r.before) k) || ' ' || (r.before->>'role') || ' ' || (r.before->>'user_id' = %L)::text || ' ' || (r.after is null)::text
            from c7.last_row(%L) r$$, trim(both '''' from :'pbowner'), :p_mb),
  'membership.deleted role,status,user_id manager true true');
select c7.val('PM3c the membership''s whole story: created, updated, deleted',
  format($$select c7.actions_for(%L)$$, :p_mb), 'membership.created,membership.updated,membership.deleted');

-- Subscriptions: the platform's writes (manage_billing), as `super`.
set role authenticated;
set request.jwt.claims = :'super_c';
select c7.try('PM4 super gives BETA a Starter subscription',
  format($$insert into public.organisation_subscriptions (id, organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
           values (%L, %L, 'starter', 'monthly', 2, 'active', now() + interval '30 days')$$, :p_sb, :'beta_org'), 'ok(1)');
select c7.try('PM5 ...and moves it to Pro with five seats',
  format($$update public.organisation_subscriptions set plan_id='pro', seat_count=5 where id=%L$$, :p_sb), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PM4b subscription.created by super against BETA, keys exactly the allowlist',
  format($$select r.action || ' ' || (r.actor_user_id = %L)::text || ' ' || (r.organisation_id = %L)::text || ' ' || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r.after->'values') k)
            from (select * from public.audit_events e where e.target_id=%L and e.action='subscription.created') r$$, :'super', :'beta_org', :p_sb),
  'subscription.created true true billing_cycle,comp_expires_at,current_period_end,plan_id,seat_count,status');
select c7.val('PM5b subscription.updated: plan starter->pro, seats 2->5, both carried',
  format($$select (r.before->'values')::text || '->' || (r.after->'values')::text from c7.last_row(%L) r$$, :p_sb),
  '{"plan_id": "starter", "seat_count": 2}->{"plan_id": "pro", "seat_count": 5}');

-- merge_candidates: dismissing a flagged duplicate.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PM6 pmanager DISMISSES the flagged pair (deleted_at + resolution + resolved_by, the CHECK''s complete shape)',
  format($$update public.merge_candidates set deleted_at=now(), resolution='dismissed', resolved_by=%L where id=%L$$, :'pmanager', :p_mc), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PM6b merge_candidate.soft_deleted (the transition wins the name), resolution dismissed and resolved_by carried, the LABEL not',
  format($$select r.action || ' ' || (r.after->'changed')::text || ' ' || (r.after->'values'->>'resolution') || ' ' || (r.after->'values'->>'resolved_by' = %L)::text || ' ' || c7.leaks(%L,'ZQ7')::text
            from c7.last_row(%L) r$$, trim(both '''' from :'pmanager'), :p_mc, :p_mc),
  'merge_candidate.soft_deleted ["deleted_at", "resolution", "resolved_by"] dismissed true false');
select c7.val('PM6c DENOMINATOR: the candidate row carries the sentinel label',
  format($$select count(*)::text from public.merge_candidates where id=%L and label like '%%ZQ7%%'$$, :p_mc), '1');

-- ===========================================================================
-- § PX  THE EXEMPTION, FROM EVERY POSITION
-- ===========================================================================
\o /dev/null
select c7.rows_for(:p_nt)::text as nt_rows_before \gset
\o
-- (1) the SET NULL cascade shape: a sessionless UPDATE nulling the owner, which
-- is exactly what ON DELETE SET NULL does when an account is erased, and what
-- private.erase_account() runs with no session. No row -- and that is right:
-- a per-row `note.updated {owner_user_id: <erased id> -> null}` would write
-- the erased person's identifier into a payload the erasure exists to remove.
select c7.val('PX1 CONTROL: notes.owner_user_id really is ON DELETE SET NULL (the cascade this stands in for)',
  $$select confdeltype from pg_constraint where conrelid='public.notes'::regclass and contype='f'
      and conkey = array[(select attnum from pg_attribute where attrelid='public.notes'::regclass and attname='owner_user_id')]$$, 'n');
update public.notes set owner_user_id = null where id = :p_nt;
select c7.val('PX1b a SESSIONLESS owner-nulling update (the SET NULL cascade shape) emits no row',
  format($$select (c7.rows_for(%L) = %L)::text$$, :p_nt, :'nt_rows_before'), 'true');
update public.notes set owner_user_id = :'pmanager' where id = :p_nt;
select c7.val('PX1c ...nor does putting it back sessionless',
  format($$select (c7.rows_for(%L) = %L)::text$$, :p_nt, :'nt_rows_before'), 'true');
-- (2) a no-op as a member.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PX2 pmanager issues an UPDATE that changes nothing', format($$update public.notes set body=body where id=%L$$, :p_nt), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PX2b ...and no audit row is written for it',
  format($$select (c7.rows_for(%L) = %L)::text$$, :p_nt, :'nt_rows_before'), 'true');
-- (3) a refused write writes nothing: pstd1 is not the note's owner.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select c7.try('PX3 pstd1 (not the owner) is filtered out of the note UPDATE', format($$update public.notes set body='x' where id=%L$$, :p_nt), 'ok(0)');
reset role; reset request.jwt.claims;
select c7.val('PX3b ...and the trail did not move', format($$select (c7.rows_for(%L) = %L)::text$$, :p_nt, :'nt_rows_before'), 'true');
-- (4) service_role holds no write on any of the sixteen.
select c7.val('PX4 service_role holds no INSERT/UPDATE on any of the sixteen new tables -- no sessionless CLIENT writer hides in the exemption',
  $$select count(*)::text from unnest(array['events','event_lineup','tasks','meetings','notes','documents',
      'task_links','meeting_links','note_links','document_links','financial_entries',
      'network_profiles','network_links','organisation_memberships','organisation_subscriptions','merge_candidates']) t
     where has_table_privilege('service_role', 'public.' || t, 'INSERT')
        or has_table_privilege('service_role', 'public.' || t, 'UPDATE')
        or exists (select 1 from information_schema.column_privileges cp
                    where cp.table_schema='public' and cp.table_name=t and cp.grantee='service_role'
                      and cp.privilege_type in ('INSERT','UPDATE'))$$, '0');

-- ===========================================================================
-- § PS  THE SWEEP
-- ===========================================================================
select c7.val('PS1 SWEEP: no audit row written since the suite began carries the sentinel anywhere, in either case',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L
              and ((coalesce(before::text,'') || coalesce(after::text,'')) like '%%ZQ7%%'
                or (coalesce(before::text,'') || coalesce(after::text,'')) like '%%zq7%%')$$, :'c7_t0'), '0');
select c7.val('PS1b DENOMINATOR: rows WERE written since the suite began -- at least fifty, by this suite''s four actors',
  format($$select (count(*) >= 50)::text from public.audit_events
            where created_at >= %L and actor_user_id in (%L, %L, %L, %L)$$, :'c7_t0', :'pmanager', :'padmin', :'pbowner', :'super'), 'true');
-- Fix round 1, M5: this said TEN rows and counted `events` twice. It is NINE
-- rows, and the event's ticket_link is a second sentinel COLUMN on one of
-- them -- reported apart, so neither number is a double count.
select c7.val('PS1c DENOMINATOR: the sentinel is in NINE planted rows right now (events, lineup, tasks, meetings, notes, documents, entries, profile, candidate), and in the event''s ticket_link as well',
  format($$select (
      (select count(*) from public.events where id=%L and (name||location||coalesce(notes,'')||coalesce(ticket_link,'')) ilike '%%ZQ7%%')
    + (select count(*) from public.event_lineup where id=%L and notes ilike '%%ZQ7%%')
    + (select count(*) from public.tasks where id=%L and (title||coalesce(detail,'')) ilike '%%ZQ7%%')
    + (select count(*) from public.meetings where id=%L and (title||coalesce(location,'')||coalesce(attendees,'')||coalesce(notes,'')||coalesce(meeting_url,'')) ilike '%%ZQ7%%')
    + (select count(*) from public.notes where id=%L and body ilike '%%ZQ7%%')
    + (select count(*) from public.documents where id=%L and (filename||storage_key) ilike '%%ZQ7%%')
    + (select count(*) from public.financial_entries where id=%L and description ilike '%%ZQ7%%')
    + (select count(*) from public.network_profiles where id=%L and (display_name||coalesce(bio,'')) ilike '%%ZQ7%%')
    + (select count(*) from public.merge_candidates where id=%L and label ilike '%%ZQ7%%'))::text
    || '/' || (select count(*) from public.events where id=%L and ticket_link ilike '%%zq7%%')::text$$,
    :p_ev, :p_lu, :p_tk, :p_mt, :p_nt, :p_dc, :p_fe, :p_np, :p_mc, :p_ev), '9/1');
select c7.val('PS2 the two amounts appear in no audit row either',
  format($$select count(*)::text from public.audit_events where created_at >= %L
            and (coalesce(before::text,'') || coalesce(after::text,'')) ~ '(987654321|123456789)'$$, :'c7_t0'), '0');
select c7.val('PS3 every row this suite''s actors wrote carries an organisation (no row filed nowhere)',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L and actor_user_id in (%L, %L, %L, %L) and organisation_id is null$$,
         :'c7_t0', :'pmanager', :'padmin', :'pbowner', :'super'), '0');
-- Attribution over the WHOLE walk, not only the .created rows the shape()
-- checks read: every row this suite's actors wrote on an ALPHA-owned target
-- is filed under ALPHA (subscription rows are BETA's, connection requests are
-- filed per side by § PN). The count is the denominator -- PS4's sum less
-- subscription and network_connection_request.
-- 56 -> 55 and document=4 -> 3 SINCE 20261029000000 (final review A, I1):
-- the scan verdict is the scanner's sessionless RPC now, so PU6 files no
-- document.updated row (PU6b asserts exactly that).
select c7.val('PS5 every generic-target row the walk wrote is filed under ALPHA -- none misfiled (count/misfiled)',
  format($$select count(*)::text || '/' || count(*) filter (where organisation_id is distinct from %L)::text
            from public.audit_events
           where created_at >= %L and actor_user_id in (%L, %L, %L, %L)
             and target_type not in ('subscription', 'network_connection_request')$$,
         :'alpha_org', :'c7_t0', :'pmanager', :'padmin', :'pbowner', :'super'), '55/0');
select c7.val('PS4 VOLUME, measured: the rows this suite''s walk produced, by target type',
  format($$select string_agg(target_type || '=' || n, ' ' order by target_type) from
            (select target_type, count(*) n from public.audit_events
              where created_at >= %L and actor_user_id in (%L, %L, %L, %L) group by target_type) s$$,
         :'c7_t0', :'pmanager', :'padmin', :'pbowner', :'super'),
  'document=3 document_link=3 event=5 event_lineup=4 financial_entry=4 meeting=4 meeting_link=3 membership=3 merge_candidate=1 network_connection_request=7 network_link=4 network_profile=6 note=4 note_link=3 subscription=2 task=4 task_link=4');

-- ===========================================================================
-- § PQ  merge_candidate.created AND .restored, BEHAVIOURALLY (fix round 1, M3)
-- ===========================================================================
-- § PM exercised only `.soft_deleted`: its fixture pair is planted
-- sessionless, so the `.created` every flagged pair writes in production --
-- from public.screen_for_duplicates(), under the creating member's session
-- -- had no assertion, and nor did `.restored`. AFTER § PS on purpose, so the
-- walk's measured volume (PS4/PS5) is unchanged; § PZ removes it by actor.
\set p_sc1 '''c7000000-0000-4000-8000-000000000061'''
\set p_sc2 '''c7000000-0000-4000-8000-000000000062'''
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PQ1 pmanager creates two contacts a screen will pair (no email, so fuzzy_name)',
  format($$insert into public.contacts (id, organisation_id, owner_user_id, name) values
           (%L, %L, %L, 'ZQ7 Screenpair Harriet Okonkwo'),
           (%L, %L, %L, 'ZQ7 Screenpair Harriet Okonkwo')$$,
         :p_sc1, :'alpha_org', :'pmanager', :p_sc2, :'alpha_org', :'pmanager'), 'ok(2)');
select c7.try('PQ2 ...and runs the screen the create action runs, as themselves',
  format($$select public.screen_for_duplicates(%L, 'contact', %L)$$, :'alpha_org', :p_sc2), 'ok(1)');
reset role; reset request.jwt.claims;
\o /dev/null
select id::text as p_sq from public.merge_candidates
 where organisation_id = :'alpha_org' and keep_id in (:p_sc1, :p_sc2) and duplicate_id in (:p_sc1, :p_sc2) \gset
\o
select c7.val('PQ2b DENOMINATOR: the screen really flagged the pair, and its LABEL carries the sentinel',
  format($$select count(*)::text || '/' || bool_and(label like '%%ZQ7%%')::text || '/' || min(reason)
            from public.merge_candidates where id = %L$$, :'p_sq'), '1/true/fuzzy_name');
select c7.val('PQ2c merge_candidate.created from the SCREEN: actor pmanager, org ALPHA, allowlisted keys, owners carried, label not',
  format($$select r.action || ' ' || (r.actor_user_id = %L)::text || ' ' || (r.organisation_id = %L)::text
              || ' | ' || (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r.after -> 'values') k)
              || ' | ' || (r.after->'values'->>'keep_owner_user_id' = %L)::text
              || ' ' || c7.leaks(%L, 'ZQ7')::text || ' ' || c7.leaks(%L, 'Okonkwo')::text
            from (select * from public.audit_events where target_id = %L and action = 'merge_candidate.created') r$$,
         :'pmanager', :'alpha_org', trim(both '''' from :'pmanager'), :'p_sq', :'p_sq', :'p_sq'),
  'merge_candidate.created true true | deleted_at,duplicate_id,duplicate_owner_user_id,entity_type,keep_id,keep_owner_user_id,reason,resolution,resolved_by | true false false');
-- .restored: NOT REACHABLE FROM A CLIENT, measured rather than assumed. The
-- one UPDATE policy's WITH CHECK requires resolved_by = auth.uid(), and
-- merge_candidates_resolution_complete requires deleted_at, resolution and
-- resolved_by to be null or set together -- so un-dismissing a pair means a
-- null resolved_by, which the policy refuses. The verb is in the catalogue
-- because the generic writer emits it for any session-attributed restore
-- (PQ5 is that shape, through a definer path that bypasses the policy).
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select c7.try('PQ3 pmanager dismisses the screened pair',
  format($$update public.merge_candidates set deleted_at = now(), resolution = 'dismissed', resolved_by = %L where id = %L$$,
         :'pmanager', :'p_sq'), 'ok(1)');
select c7.try('PQ4 ...and CANNOT un-dismiss it: the resolve policy''s WITH CHECK refuses a null resolved_by',
  format($$update public.merge_candidates set deleted_at = null, resolution = null, resolved_by = null where id = %L$$,
         :'p_sq'), 'denied(42501)');
reset role;
-- The definer shape: a session is set, RLS is not in the way (postgres), so
-- only the trigger decides. This is what a future restore RPC would do.
update public.merge_candidates set deleted_at = null, resolution = null, resolved_by = null where id = :'p_sq';
reset request.jwt.claims;
select c7.val('PQ5 a session-attributed restore writes merge_candidate.restored, attributed, the dismissal''s values carried',
  format($$select r.action || ' ' || (r.actor_user_id = %L)::text || ' ' || (r.after->'changed')::text
              || ' ' || coalesce(r.before->'values'->>'resolution', '<null>') || '->' || coalesce(r.after->'values'->>'resolution', '<null>')
            from c7.last_row(%L) r$$, :'pmanager', :'p_sq'),
  'merge_candidate.restored true ["deleted_at", "resolution", "resolved_by"] dismissed-><null>');
select c7.val('PQ6 the screened pair''s whole story: created, soft_deleted, restored -- and the refused write wrote nothing',
  format($$select c7.actions_for(%L)$$, :'p_sq'),
  'merge_candidate.created,merge_candidate.soft_deleted,merge_candidate.restored');

-- ===========================================================================
-- § PO  organisation.updated (Q189, 20261031000000)
-- ===========================================================================
-- padmin (aal2 admin of ALPHA, holds manage_organisation) renames ALPHA and
-- moves its slug through PostgREST's path: each edit is ONE organisation.
-- updated row carrying the old and new value of what changed and nothing
-- else. Then the guards: a no-op, a sessionless edit, a lifecycle-only edit
-- WITH a session, a mixed edit whose lifecycle_reason must not travel, and a
-- non-identity column that is named but never valued. ALPHA goes back at
-- the end.
\o /dev/null
select name as po_name0, slug as po_slug0 from public.organisations where id = :'alpha_org' \gset
\o
create function c7.org_updates(p_org uuid, p_since timestamptz)
returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.audit_events e
   where e.target_id = p_org and e.action = 'organisation.updated' and e.created_at >= p_since;
$$;
grant execute on function c7.org_updates(uuid, timestamptz) to authenticated, anon, service_role;

set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PO1 padmin renames ALPHA', format($$update public.organisations set name='C7 Alpha Renamed' where id=%L$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PO1b ...ONE organisation.updated row, padmin, ALPHA, target_type organisation',
  format($$select c7.org_updates(%L, %L)::text || ' ' || r.action || ' ' || (r.actor_user_id = %L)::text
                  || ' ' || (r.organisation_id = %L)::text || ' ' || r.target_type
             from c7.last_row(%L) r$$, :'alpha_org', :'c7_t0', :'padmin', :'alpha_org', :'alpha_org'),
  '1 organisation.updated true true organisation');
select c7.val('PO1c ...before carries the OLD name and nothing else',
  format($$select (r.before = jsonb_build_object('values', jsonb_build_object('name', %L::text)))::text from c7.last_row(%L) r$$,
         :'po_name0', :'alpha_org'), 'true');
select c7.val('PO1d ...after carries changed=[name] and the NEW name, nothing else',
  format($$select (r.after = '{"changed": ["name"], "values": {"name": "C7 Alpha Renamed"}}'::jsonb)::text from c7.last_row(%L) r$$,
         :'alpha_org'), 'true');

set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PO2 padmin moves ALPHA''s slug', format($$update public.organisations set slug='org-alpha-q189' where id=%L$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PO2b ...a second row, carrying slug old -> new and changed=[slug]',
  format($$select c7.org_updates(%L, %L)::text || ' ' || (r.before -> 'values' ->> 'slug') || ' ' || (r.after -> 'values' ->> 'slug')
                  || ' ' || (r.after -> 'changed')::text
             from c7.last_row(%L) r$$, :'alpha_org', :'c7_t0', :'alpha_org'),
  format('2 %s org-alpha-q189 ["slug"]', :'po_slug0'));

set role authenticated;
set request.jwt.claims = :'padmin_c';
select c7.try('PO3 padmin issues an organisations UPDATE that changes nothing', format($$update public.organisations set name=name where id=%L$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;
select c7.val('PO3b ...and no row is written for it', format($$select c7.org_updates(%L, %L)::text$$, :'alpha_org', :'c7_t0'), '2');

select c7.try('PO4 a SESSIONLESS rename is accepted (a writer that audited it would raise: log_audit_event refuses a null actor)',
  format($$update public.organisations set name = 'C7 Alpha Sessionless' where id = %L$$, :'alpha_org'), 'ok(1)');
select c7.val('PO4a CONTROL: the sessionless rename really landed',
  format($$select name from public.organisations where id=%L$$, :'alpha_org'), 'C7 Alpha Sessionless');
select c7.val('PO4b ...and wrote no row (auth.uid() is null: migrations, seeds, runners)',
  format($$select c7.org_updates(%L, %L)::text$$, :'alpha_org', :'c7_t0'), '2');

-- A lifecycle-only edit WITH a session: the shape of every lifecycle RPC
-- (they run as the definer, which the guard exempts, with the caller's
-- auth.uid() still set). As postgres with padmin's claims, so the guard
-- exempts it the same way and the writer sees a real actor.
set request.jwt.claims = :'padmin_c';
update public.organisations set deleted_at = now(), lifecycle_reason = 'ZQ189-REASON' where id = :'alpha_org';
reset request.jwt.claims;
select c7.val('PO5 CONTROL: the lifecycle edit landed, reason and all',
  format($$select lifecycle_state || ' ' || lifecycle_reason from public.organisations where id=%L$$, :'alpha_org'),
  'suspended ZQ189-REASON');
select c7.val('PO5b ...and a lifecycle-only edit with a session writes no organisation.updated (the RPCs audit themselves)',
  format($$select c7.org_updates(%L, %L)::text$$, :'alpha_org', :'c7_t0'), '2');
set request.jwt.claims = :'padmin_c';
update public.organisations set name = 'C7 Alpha Mixed', lifecycle_reason = 'ZQ189-REASON-2' where id = :'alpha_org';
reset request.jwt.claims;
select c7.val('PO6 CONTROL: the mixed edit landed, the new reason IS in the row',
  format($$select name || ' ' || lifecycle_reason from public.organisations where id=%L$$, :'alpha_org'),
  'C7 Alpha Mixed ZQ189-REASON-2');
select c7.val('PO6b ...one row, changed=[name] only: the lifecycle columns are outside the changed set',
  format($$select c7.org_updates(%L, %L)::text || ' ' || (r.after -> 'changed')::text from c7.last_row(%L) r$$,
         :'alpha_org', :'c7_t0', :'alpha_org'), '3 ["name"]');
select c7.val('PO6c ...and lifecycle_reason (old or new) is in NO organisation.updated payload',
  format($$select count(*)::text from public.audit_events e
            where e.target_id=%L and e.action='organisation.updated' and e.created_at >= %L
              and (coalesce(e.before::text,'') || coalesce(e.after::text,'')) like '%%ZQ189-REASON%%'$$,
         :'alpha_org', :'c7_t0'), '0');

-- A non-identity column is NAMED, never valued.
set request.jwt.claims = :'padmin_c';
update public.organisations set created_at = created_at - interval '1 second' where id = :'alpha_org';
reset request.jwt.claims;
select c7.val('PO7 a change to a column other than name/slug is named in changed and carries no value',
  format($$select c7.org_updates(%L, %L)::text || ' ' || (r.after -> 'changed')::text || ' ' || (r.after -> 'values')::text
                  || ' ' || (r.before -> 'values')::text from c7.last_row(%L) r$$,
         :'alpha_org', :'c7_t0', :'alpha_org'), '4 ["created_at"] {} {}');

-- Put ALPHA back: name, slug, created_at, lifecycle. As postgres WITH
-- padmin's claims rather than sessionless, so the restore still lands when
-- the sessionless exemption is mutated away (a sessionless write would then
-- raise and leave ALPHA suspended for every later suite). Its own
-- organisation.updated row is padmin's and § PZ deletes it.
set request.jwt.claims = :'padmin_c';
update public.organisations
   set name = :'po_name0', slug = :'po_slug0', created_at = created_at + interval '1 second', deleted_at = null
 where id = :'alpha_org';
reset request.jwt.claims;
select c7.val('PO8 ALPHA is back: original name and slug, active, no reason',
  format($$select (name = %L and slug = %L and lifecycle_state = 'active' and lifecycle_reason is null)::text
             from public.organisations where id=%L$$, :'po_name0', :'po_slug0', :'alpha_org'), 'true');
select c7.val('PO9 organisations_audit_update is an enabled AFTER ROW UPDATE trigger, and fires on no INSERT',
  $$select tgenabled::text || ' ' || ((tgtype & 1) <> 0)::text || ' ' || ((tgtype & 66) = 0)::text
           || ' ' || ((tgtype & 16) <> 0)::text || ' ' || ((tgtype & 4) <> 0)::text
      from pg_trigger where tgrelid='public.organisations'::regclass and tgname='organisations_audit_update'$$,
  'O true true true false');
-- A REAL lifecycle round trip (review minor 3): PO5-PO7 simulate the RPC
-- shape; this calls the RPCs. The superuser suspends ALPHA and reinstates it
-- (ALPHA has an active Owner, so reinstate is admitted). Their own rows are
-- organisation.suspended / .reinstated by `super`, which § PZ deletes.
\o /dev/null
select c7.org_updates(:'alpha_org', :'c7_t0')::text as po_n_before \gset
\o
set role authenticated;
set request.jwt.claims = :'super_c';
select c7.val('PO10 the superuser suspends ALPHA through public.suspend_organisation()',
  $$select (public.suspend_organisation('org-alpha', 'C7 Q189 lifecycle round trip') is not null)::text$$, 'true');
select c7.val('PO10a ...and reinstates it through public.reinstate_organisation()',
  $$select (public.reinstate_organisation('org-alpha', 'C7 Q189 lifecycle round trip back') is not null)::text$$, 'true');
reset role; reset request.jwt.claims;
select c7.val('PO10b ...the RPCs wrote their own suspended + reinstated rows',
  format($$select count(*)::text from public.audit_events where target_id=%L and created_at >= %L
            and action in ('organisation.suspended','organisation.reinstated')$$, :'alpha_org', :'c7_t0'), '2');
select c7.val('PO10c ...and NO organisation.updated beside them',
  format($$select c7.org_updates(%L, %L)::text$$, :'alpha_org', :'c7_t0'), :'po_n_before');
select c7.val('PO10d ...ALPHA is active again',
  format($$select lifecycle_state from public.organisations where id=%L$$, :'alpha_org'), 'active');
drop function c7.org_updates(uuid, timestamptz);

-- ===========================================================================
-- § PZ  HOUSEKEEPING -- every row and audit event this suite created goes.
-- Sessionless, so the deletes below are themselves un-audited.
-- ===========================================================================
delete from public.audit_events where created_at >= :'c7_t0'
   and actor_user_id in (:'pmanager', :'padmin', :'pbowner', :'super');
delete from public.network_connection_requests where id in (:p_cr1, :p_cr2, :p_cr3);
delete from public.network_links where id = :p_nk;
delete from public.network_profiles where id in (:p_np, :p_bpr);
delete from public.financial_entries where id = :p_fe;
delete from public.document_links where id = :p_dl;
delete from public.note_links where id = :p_nl;
delete from public.meeting_links where id = :p_ml;
delete from public.task_links where id = :p_tl;
delete from public.documents where id = :p_dc;
delete from public.notes where id = :p_nt;
delete from public.meetings where id = :p_mt;
delete from public.tasks where id = :p_tk;
delete from public.event_lineup where id = :p_lu;
delete from public.event_status_changes where event_id = :p_ev;
delete from public.events where id = :p_ev;
delete from public.merge_candidates where id in (:p_mc, :'p_sq');
delete from public.organisation_memberships where id = :p_mb;
delete from public.companies where id in (:p_co, :p_co2, :p_bco);
delete from public.contacts where id in (:p_ct, :p_ct2, :p_sc1, :p_sc2);
delete from public.artists where id = :p_ar;
delete from public.venues where id = :p_ve;
delete from public.rate_limit_counters where category = 'network_connection_request'
   and subject_id in (:'alpha_org', :'beta_org');
delete from public.incident_alerts where created_at >= :'c7_t0' and organisation_id in (:'alpha_org', :'beta_org');
drop function c7.probe_planted(text);
drop function c7.probe_shape(text);
-- Both subscriptions go back to what they were (nothing, today).
delete from public.organisation_subscriptions where organisation_id in (:'alpha_org', :'beta_org');
insert into public.organisation_subscriptions select * from c7.saved_sub;

select c7.val('PZ1 no audit rows by this suite''s actors remain from its window',
  format($$select count(*)::text from public.audit_events
            where created_at >= %L and actor_user_id in (%L, %L, %L, %L)$$, :'c7_t0', :'pmanager', :'padmin', :'pbowner', :'super'), '0');
select c7.val('PZ2 no fixture rows remain',
  format($$select (
      (select count(*) from public.events where id = %L)
    + (select count(*) from public.notes where id = %L)
    + (select count(*) from public.documents where id = %L)
    + (select count(*) from public.network_profiles where id in (%L, %L))
    + (select count(*) from public.organisation_memberships where id = %L)
    + (select count(*) from public.organisation_subscriptions where organisation_id in (%L, %L)) - (select count(*) from c7.saved_sub))::text$$,
    :p_ev, :p_nt, :p_dc, :p_np, :p_bpr, :p_mb, :'alpha_org', :'beta_org'), '0');

-- ===========================================================================
-- RESULTS
-- ===========================================================================
\pset format aligned
select seq, case when pass then 'PASS' else 'FAIL' end as result, label, expected, actual
  from c7.results order by seq;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed
  from c7.results;
