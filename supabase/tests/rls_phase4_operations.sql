-- ===========================================================================
-- Phase 4 (Operations) RLS / permission / record-scope / tenant-boundary suite.
--
-- Covers
--   20260902000000-002000  the nine tables + grants (RLS on, zero policies)
--   20260902010000         manage_tasks/_meetings/_notes/_documents
--   20260902011000         the policies on all nine tables
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER rls_phase3_events.sql and reuses the SAME fixtures whole --
--   the twelve users, orgs ALPHA and BETA, and the Phase 2 contacts / companies
--   / venues / artists that the *_links target end points at. Only operational
--   rows (tasks, meetings, notes, documents, links) are created here. A second
--   cast of characters would be a second place for the role matrix to drift.
--
-- IT USES ITS OWN `op` SCHEMA, NOT `ev` OR `crm`. Each suite counts its own
-- results table in run-rls-tests.sh, so a Phase 4 failure is not reported under
-- a Phase 3 heading. The helpers below are rls_phase3_events.sql's, verbatim,
-- with the schema renamed.
--
-- SECTIONS (each with a positive control per Global Constraint 14):
--   OA role x permission, from the catalogue and behaviourally
--   OB the SET-FORM shape guard over all 25 new policies (denominator)
--   OC tenant breakout, all nine tables, links from both ends
--   OD note visibility -- the NEW predicate, the quartet + its link consequence
--   OE link parent tenant-correlation, the FK-lift technique (multi-org reader)
--   OF link TARGET validated AS THE CALLER (see-but-not-manage; cross-tenant)
--   OG suspension: writes stop, reads continue (the EI/P11 technique)
--   OH documents SELECT does NOT filter scan_status (structural + behavioural)
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a WITH CHECK / INSERT policy fail.
--   denied(23503)  rejected by a FOREIGN KEY -- constraint layer, every writer.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--                  On UPDATE, "you cannot see it", distinct from denied(42501)'s
--                  "you can see it and may not do that to it".
--
-- POSITIVE CONTROLS ARE MANDATORY. A suite of "expect 0" assertions passes
-- against a database where every policy denies everything; every negative below
-- is paired with the positive that proves the path works for somebody.
--
-- psql vars required (supplied by run-rls-tests.sh's P2VARS): the twelve
--   fixture users' claims as `<user>_c` (realistic aal) and `<user>_c1` (aal1).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists op cascade;
create schema op;

create table op.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function op.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into op.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create table op.notes (k text primary key, v text);
create function op.note(p_k text, p_v text)
returns void language sql security definer set search_path = '' as $$
  insert into op.notes (k, v) values (p_k, p_v)
  on conflict (k) do update set v = excluded.v;
$$;

create function op.try(p_label text, p_sql text, p_expected text)
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
  perform op.record(p_label, p_expected, v_actual);
end $$;

create function op.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform op.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema op to authenticated, anon, service_role;
grant execute on function op.record(text,text,text) to authenticated, anon, service_role;
grant execute on function op.note(text,text)         to authenticated, anon, service_role;
grant select  on op.notes                            to authenticated, anon, service_role;
grant execute on function op.try(text,text,text)     to authenticated, anon, service_role;
grant execute on function op.val(text,text,text)     to authenticated, anon, service_role;

\o /dev/null

-- ===========================================================================
-- Fixtures -- OPERATIONAL ROWS ONLY, planted as postgres
-- ===========================================================================
select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- Tasks. pstd1 (record-scoped) and pmanager (full-scope) in ALPHA; pbowner in
-- BETA; pbooker in ALPHA for the § OF see-but-not-manage positive.
insert into public.tasks (id, organisation_id, owner_user_id, title)
select v.id::uuid, o.id, nullif(v.owner,'')::uuid, v.t
from public.organisations o, (values
  ('7a000000-0000-0000-0000-000000000001', :'pstd1',    'Std1 Task'),
  ('7a000000-0000-0000-0000-000000000002', :'pmanager', 'Manager Task'),
  ('7a0000b0-0000-0000-0000-0000000000b0', :'pbooker',  'Booker Task')
) as v(id, owner, t) where o.slug='org-alpha';
insert into public.tasks (id, organisation_id, owner_user_id, title)
select '7a00000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Task'
from public.organisations o where o.slug='org-beta';

-- Meetings.
insert into public.meetings (id, organisation_id, owner_user_id, title, starts_at)
select '7e000000-0000-0000-0000-000000000001', o.id, :'pmanager', 'Manager Meeting',
       timestamptz '2026-10-01 15:00+00'
from public.organisations o where o.slug='org-alpha';
insert into public.meetings (id, organisation_id, owner_user_id, title, starts_at)
select '7e00000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'Beta Meeting',
       timestamptz '2026-10-02 15:00+00'
from public.organisations o where o.slug='org-beta';

-- Notes -- the § OD cast. private/pstd1, company/pmanager, company/pstd1 in
-- ALPHA; private and company in BETA for the cross-tenant checks.
insert into public.notes (id, organisation_id, owner_user_id, body, visibility)
select v.id::uuid, o.id, v.owner::uuid, v.b, v.vis
from public.organisations o, (values
  ('70000000-0000-0000-0000-000000000001', :'pstd1',    'Std1 private',    'private'),
  ('70000000-0000-0000-0000-000000000002', :'pmanager', 'Manager company', 'company'),
  ('70000000-0000-0000-0000-000000000003', :'pstd1',    'Std1 company',    'company')
) as v(id, owner, b, vis) where o.slug='org-alpha';
insert into public.notes (id, organisation_id, owner_user_id, body, visibility)
select v.id::uuid, o.id, :'pbowner', v.b, v.vis
from public.organisations o, (values
  ('7000000b-0000-0000-0000-00000000000b', 'Beta private', 'private'),
  ('7000000c-0000-0000-0000-00000000000c', 'Beta company', 'company')
) as v(id, b, vis) where o.slug='org-beta';

-- Documents. A clean and a QUARANTINED one owned by pmanager (§ OH), and a BETA
-- one. storage_key must start with the org id (documents_storage_key_shape);
-- scanned_at must be set exactly when scan_status is a terminal state.
insert into public.documents
  (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
select v.id::uuid, o.id, :'pmanager', v.fn,
       o.id::text || '/' || v.id, 'application/pdf', 1024, v.ss,
       case when v.ss = 'pending' then null else now() end
from public.organisations o, (values
  ('d0000000-0000-0000-0000-000000000001', 'manager.pdf',     'clean'),
  ('d0000000-0000-0000-0000-000000000002', 'quarantined.pdf', 'quarantined')
) as v(id, fn, ss) where o.slug='org-alpha';
insert into public.documents
  (id, organisation_id, owner_user_id, filename, storage_key, mime_type, size_bytes, scan_status, scanned_at)
select 'd000000b-0000-0000-0000-00000000000b', o.id, :'pbowner', 'beta.pdf',
       o.id::text || '/d000000b-0000-0000-0000-00000000000b', 'application/pdf', 2048, 'clean', now()
from public.organisations o where o.slug='org-beta';

-- Links (ALPHA). A task->contact on pstd1's task; a note->company on the
-- company note (visible to all) and a note->contact on the private note
-- (visible only to its author) for the § OD/OD link consequence; a
-- document->contact and a meeting->contact.
insert into public.task_links (id, organisation_id, parent_id, entity_type, entity_id)
select '71000000-0000-0000-0000-000000000001', o.id,
       '7a000000-0000-0000-0000-000000000001', 'contact',
       '22220000-0000-0000-0000-000000000001'
from public.organisations o where o.slug='org-alpha';
-- 72...0001: on a COMPANY note authored by pstd1, target Manager Contact -- so a
--   full-scope NON-AUTHOR (pmanager) sees both the note (company) and the target.
-- 72...0002: on a PRIVATE note authored by pstd1, target Std1 Contact -- so its
--   AUTHOR (pstd1) sees both, and a non-author sees neither (the note hides it).
insert into public.note_links (id, organisation_id, parent_id, entity_type, entity_id)
select v.id::uuid, o.id, v.parent::uuid, 'contact', v.target::uuid
from public.organisations o, (values
  ('72000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003',
   '22220000-0000-0000-0000-000000000002'),   -- company note (pstd1) -> Manager Contact
  ('72000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001',
   '22220000-0000-0000-0000-000000000001')    -- private note (pstd1) -> Std1 Contact
) as v(id, parent, target) where o.slug='org-alpha';
insert into public.document_links (id, organisation_id, parent_id, entity_type, entity_id)
select '73000000-0000-0000-0000-000000000001', o.id,
       'd0000000-0000-0000-0000-000000000001', 'contact',
       '22220000-0000-0000-0000-000000000002'
from public.organisations o where o.slug='org-alpha';
insert into public.meeting_links (id, organisation_id, parent_id, entity_type, entity_id)
select '74000000-0000-0000-0000-000000000001', o.id,
       '7e000000-0000-0000-0000-000000000001', 'contact',
       '22220000-0000-0000-0000-000000000002'
from public.organisations o where o.slug='org-alpha';

-- Links (BETA), for the tenant-breakout section from the other end.
insert into public.task_links (id, organisation_id, parent_id, entity_type, entity_id)
select '7100000b-0000-0000-0000-00000000000b', o.id,
       '7a00000b-0000-0000-0000-00000000000b', 'company',
       '1111000b-0000-0000-0000-00000000000b'
from public.organisations o where o.slug='org-beta';

-- ===========================================================================
-- OA. The permission catalogue, and the role matrix it drives
-- ===========================================================================
-- The mutation: granting one of the four keys to read_only in 20260902010000,
-- or seeding a key with survives_suspension=true. A matrix seeded wrong makes
-- every policy assertion below green against the wrong rows.
select op.val('OA1 all four operational write keys exist',
  $$select count(*)::text from public.permissions
     where key in ('manage_tasks','manage_meetings','manage_notes','manage_documents')$$, '4');
select op.val('OA2 ...and NONE of them survives suspension (they are write keys)',
  $$select count(*)::text from public.permissions
     where key in ('manage_tasks','manage_meetings','manage_notes','manage_documents')
       and survives_suspension$$, '0');
-- Cell by cell: 6 roles x 4 keys = 24 grants, named.
select op.val('OA3 the six write roles hold all four keys -- 24 grants',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('manage_tasks','manage_meetings','manage_notes','manage_documents')
       and role_key in ('owner','admin','manager','booker','venue_manager','standard_user')$$, '24');
select op.val('OA4 ...and that is the WHOLE grant set for these keys -- no seventh role',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('manage_tasks','manage_meetings','manage_notes','manage_documents')$$, '24');
-- The negative, written out: the three roles a "just give everyone operations"
-- edit reaches for first hold the four keys ZERO times.
select op.val('OA5 finance, marketing and read_only hold the four keys ZERO times',
  $$select count(*)::text from public.role_permissions
     where permission_key in ('manage_tasks','manage_meetings','manage_notes','manage_documents')
       and role_key in ('finance','marketing','read_only')$$, '0');
select op.val('OA6 CONTROL: those same three roles DO hold view_crm',
  $$select count(*)::text from public.role_permissions
     where permission_key='view_crm' and role_key in ('finance','marketing','read_only')$$, '3');

-- The role matrix behaviourally, on a representative key per table. Booker holds
-- all four; finance and read_only hold none. The positives make the refusals
-- below mean something.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select op.try('OA7 POSITIVE: a booker creates a task',
  format($$insert into public.tasks (organisation_id, title) values (%L,'booker task')$$,
         :'alpha_org'), 'ok(1)');
select op.try('OA8 POSITIVE: a booker creates a meeting',
  format($$insert into public.meetings (organisation_id, title, starts_at)
           values (%L,'booker mtg', now())$$, :'alpha_org'), 'ok(1)');
select op.try('OA9 POSITIVE: a booker creates a note',
  format($$insert into public.notes (organisation_id, body) values (%L,'booker note')$$,
         :'alpha_org'), 'ok(1)');
select op.try('OA10 POSITIVE: a booker creates a document',
  format($$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes)
           values (%L,'b.pdf',%L,'application/pdf',10)$$,
         :'alpha_org', :'alpha_org' || '/booker-doc'), 'ok(1)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pfinance_c';
select op.try('OA11 finance cannot create a task (view_crm only)',
  format($$insert into public.tasks (organisation_id, title) values (%L,'fin')$$,
         :'alpha_org'), 'denied(42501)');
select op.try('OA12 finance cannot create a note',
  format($$insert into public.notes (organisation_id, body) values (%L,'fin')$$,
         :'alpha_org'), 'denied(42501)');
select op.val('OA13 CONTROL: finance READS tasks perfectly well',
  $$select (count(*) >= 0)::text from public.tasks$$, 'true');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pro_c';
select op.try('OA14 read_only cannot create a document',
  format($$insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes)
           values (%L,'ro.pdf',%L,'application/pdf',10)$$,
         :'alpha_org', :'alpha_org' || '/ro-doc'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- DELETE is absent at the grant layer, in every role -- there is no DELETE grant
-- and no DELETE policy on any of the nine tables.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.try('OA15 not even a manager can DELETE a task (no grant)',
  $$delete from public.tasks where id='7a000000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select op.try('OA16 nor DELETE a note',
  $$delete from public.notes where id='70000000-0000-0000-0000-000000000002'$$, 'denied(42501)');
select op.try('OA17 nor DELETE a link',
  $$delete from public.task_links where id='71000000-0000-0000-0000-000000000001'$$, 'denied(42501)');
-- THE PAIRED POSITIVE: removal IS available as an UPDATE of deleted_at.
select op.try('OA18 CONTROL: soft-delete is an UPDATE, and it works',
  $$update public.tasks set deleted_at=now()
     where id='7a000000-0000-0000-0000-000000000002'$$, 'ok(1)');
select op.try('OA19 ...and the restore that proves it was soft',
  $$update public.tasks set deleted_at=null
     where id='7a000000-0000-0000-0000-000000000002'$$, 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OB. THE SET-FORM SHAPE GUARD, over all 25 new policies
-- ===========================================================================
-- The per-row form public.has_permission(...) returns identical rows to the set
-- form for every user, so no behavioural assertion tells them apart. Measured
-- 200x (20260828120500). These three assertions, with a denominator, are the
-- only thing that catches a refactor back to it. Replacing one set-form policy
-- with has_permission is the mutation this section catches.
select op.val('OB1 no Phase 4 policy calls has_permission per row',
  $$select count(*)::text from pg_policies
     where schemaname='public'
       and tablename in ('tasks','meetings','notes','documents','document_versions',
                         'task_links','meeting_links','note_links','document_links')
       and (coalesce(qual,'') like '%has_permission(%'
         or coalesce(with_check,'') like '%has_permission(%')$$, '0');
select op.val('OB2 every Phase 4 policy is built on the hoistable set form',
  $$select count(*)::text from pg_policies
     where schemaname='public'
       and tablename in ('tasks','meetings','notes','documents','document_versions',
                         'task_links','meeting_links','note_links','document_links')
       and coalesce(qual,'') || coalesce(with_check,'')
           not like '%permitted_organisations%'$$, '0');
select op.val('OB3 CONTROL: OB1/OB2 inspected 25 policies, not zero',
  $$select count(*)::text from pg_policies
     where schemaname='public'
       and tablename in ('tasks','meetings','notes','documents','document_versions',
                         'task_links','meeting_links','note_links','document_links')$$, '25');

-- ===========================================================================
-- OC. Tenant breakout -- all nine tables, links from both ends
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OC1 pmanager (ALPHA) reads ZERO BETA tasks',
  format($$select count(*)::text from public.tasks where organisation_id=%L$$, :'beta_org'), '0');
select op.val('OC2 ...ZERO BETA meetings',
  format($$select count(*)::text from public.meetings where organisation_id=%L$$, :'beta_org'), '0');
select op.val('OC3 ...ZERO BETA documents',
  format($$select count(*)::text from public.documents where organisation_id=%L$$, :'beta_org'), '0');
-- A BETA COMPANY note is invisible to ALPHA too: company visibility is
-- WITHIN-tenant, gated by view_crm which pmanager does not hold in BETA.
select op.val('OC4 ...ZERO BETA notes, INCLUDING the company-visible one',
  format($$select count(*)::text from public.notes where organisation_id=%L$$, :'beta_org'), '0');
select op.val('OC5 ...ZERO BETA task_links (from the link end)',
  $$select count(*)::text from public.task_links
     where id='7100000b-0000-0000-0000-00000000000b'$$, '0');
select op.try('OC6 INSERT of a task into BETA is REFUSED',
  format($$insert into public.tasks (organisation_id, title) values (%L,'planted')$$,
         :'beta_org'), 'denied(42501)');
select op.try('OC7 UPDATE of a BETA note matches nothing -- ok(0), the USING clause',
  $$update public.notes set body='rewritten'
     where id='7000000c-0000-0000-0000-00000000000c'$$, 'ok(0)');
select op.try('OC8 INSERT of a task_link into BETA is REFUSED',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a00000b-0000-0000-0000-00000000000b','company',
                   '1111000b-0000-0000-0000-00000000000b')$$, :'beta_org'), 'denied(42501)');
-- POSITIVE CONTROLS: the same reader, their own tenant.
select op.val('OC9 CONTROL: pmanager reads their own ALPHA tasks',
  $$select (count(*) > 0)::text from public.tasks$$, 'true');
select op.val('OC10 CONTROL: ...and their own ALPHA task_link',
  $$select count(*)::text from public.task_links
     where id='71000000-0000-0000-0000-000000000001'$$, '1');
reset role; reset request.jwt.claims;

-- THE MIRROR, from BETA -- without it OC1-OC5 pass against a policy that shows
-- ALPHA to everybody and BETA was simply never asked.
set role authenticated;
set request.jwt.claims = :'pbowner_c';
select op.val('OC11 pbowner (BETA) reads ZERO ALPHA tasks',
  format($$select count(*)::text from public.tasks where organisation_id=%L$$, :'alpha_org'), '0');
select op.val('OC12 ...ZERO ALPHA notes, including the company one',
  format($$select count(*)::text from public.notes where organisation_id=%L$$, :'alpha_org'), '0');
select op.val('OC13 ...ZERO ALPHA task_links',
  $$select count(*)::text from public.task_links
     where id='71000000-0000-0000-0000-000000000001'$$, '0');
select op.val('OC14 CONTROL: pbowner reads their own BETA task_link',
  $$select count(*)::text from public.task_links
     where id='7100000b-0000-0000-0000-00000000000b'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OD. NOTE VISIBILITY -- the new predicate (the quartet + link consequence)
-- ===========================================================================
-- The mutation: adding `organisation_id in full_scope_organisations()` to
-- notes_select_by_visibility. It leaves OD1-OD3 green and flips OD4: a
-- record-scoped standard_user stops seeing a company note they did not write.
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select op.val('OD1 the AUTHOR sees their own PRIVATE note',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000001'$$, '1');
-- pstd1 is record-scoped and holds view_crm, and sees pmanager's COMPANY note --
-- proving notes are NOT owner-record-scoped on read.
select op.val('OD3 a record-scoped view_crm holder sees a COMPANY note they did not write',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000002'$$, '1');
reset role; reset request.jwt.claims;

-- A full-scope Admin who did NOT write a PRIVATE note does not see it: 'private'
-- is not overridden by full scope (there is no full_scope term).
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OD2 a full-scope Admin does NOT see another user''s PRIVATE note',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000001'$$, '0');
select op.val('OD2b CONTROL: the same Admin DOES see a company note they did not write',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000003'$$, '1');
reset role; reset request.jwt.claims;

-- THE MUTATION-SENSITIVE ONE. pstd2 is a record-scoped standard_user who did not
-- write the company note 70000000-...0003 (pstd1 did). Visibility, not owner
-- scope, must govern -> ok(1). Under the full_scope mutation this becomes 0.
set role authenticated;
set request.jwt.claims = :'pstd2_c';
select op.val('OD4 a record-scoped standard_user sees a COMPANY note they did NOT write',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000003'$$, '1');
-- CONTROL: the same reader does NOT see pstd1's PRIVATE note -- so OD4 is the
-- company flag talking, not pstd2 seeing every note.
select op.val('OD4b CONTROL: ...and does NOT see pstd1''s PRIVATE note',
  $$select count(*)::text from public.notes
     where id='70000000-0000-0000-0000-000000000001'$$, '0');
reset role; reset request.jwt.claims;
-- THE LINK CONSEQUENCE. A link on a COMPANY note follows the note's visibility;
-- a link on a PRIVATE note does not leak to a non-author. Read as a full-scope
-- NON-AUTHOR (pmanager did not write either note; pstd1 did), so the reader sees
-- the link's target either way and the ONLY thing that can hide the link is the
-- note's own visibility.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OD5 a link on a COMPANY note is visible to a full-scope non-author',
  $$select count(*)::text from public.note_links
     where id='72000000-0000-0000-0000-000000000001'$$, '1');
select op.val('OD6 a link on a PRIVATE note is NOT visible to a non-author',
  $$select count(*)::text from public.note_links
     where id='72000000-0000-0000-0000-000000000002'$$, '0');
reset role; reset request.jwt.claims;
-- CONTROL for OD6: the note's AUTHOR does see the link on their private note
-- (pstd1 owns both the private note and its Std1 Contact target).
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select op.val('OD6b CONTROL: the author DOES see the link on their private note',
  $$select count(*)::text from public.note_links
     where id='72000000-0000-0000-0000-000000000002'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OE. LINK PARENT TENANT-CORRELATION, the FK-lift technique (§ EF / § Y)
-- ===========================================================================
-- The mutation: removing `p.organisation_id = task_links.organisation_id` from
-- task_links_select_via_task. While task_links_parent_fkey holds, the two
-- columns agree by construction and the term cannot change an answer -- the same
-- gap § Y proved on venue_rooms. So the FK comes off for the length of the
-- section, the row it would refuse is planted as postgres, and the policy is
-- asked on its own. schema_invariants D11 asserts the term is PRESENT; this
-- asserts it WORKS.
--
-- ISOLATING THE CORRELATION NEEDS A MULTI-ORG READER. The parent EXISTS carries
-- BOTH the correlation AND a parent-visibility term reading the PARENT's org;
-- the target check reads the LINK's org. A cross-tagged row has parent.org !=
-- link.org, so for every OTHER term to pass the reader must hold view_crm in
-- BOTH orgs -- pmulti, admin in ALPHA and BETA. The link is tagged ALPHA with an
-- ALPHA target pmulti sees; its parent is a BETA task pmulti sees. Only the
-- correlation (BETA != ALPHA) stands between pmulti and the row.
--
-- IN AN EXPLICIT TRANSACTION so an abort between the drop and the restore cannot
-- leave the schema without its FK.
begin;

set search_path = 'pg_catalog, public';
select op.note('oe_fkey_def', (select pg_catalog.pg_get_constraintdef(oid)
  from pg_catalog.pg_constraint
 where conname='task_links_parent_fkey' and connamespace='public'::regnamespace));
select op.note('oe_fkey_comment', (select pg_catalog.obj_description(oid,'pg_constraint')
  from pg_catalog.pg_constraint
 where conname='task_links_parent_fkey' and connamespace='public'::regnamespace));
reset search_path;

alter table public.task_links drop constraint task_links_parent_fkey;

-- A BETA task, and a task_link TAGGED ALPHA pointing at it with an ALPHA target.
-- The composite FK is the only thing that would refuse this, which is why it
-- came off first.
insert into public.tasks (id, organisation_id, owner_user_id, title)
select '7a0000ee-0000-0000-0000-0000000000ee', o.id, :'pbowner', 'OE Beta Task'
from public.organisations o where o.slug='org-beta';
insert into public.task_links (id, organisation_id, parent_id, entity_type, entity_id)
select '710000ee-0000-0000-0000-0000000000ee', o.id,
       '7a0000ee-0000-0000-0000-0000000000ee', 'contact',
       '22220000-0000-0000-0000-000000000002'
from public.organisations o where o.slug='org-alpha';

select op.val('OE0 CONTROL: the cross-correlated row really was planted',
  $$select count(*)::text from public.task_links
     where id='710000ee-0000-0000-0000-0000000000ee'$$, '1');

set role authenticated;
set request.jwt.claims = :'pmulti_c';
-- pmulti sees the ALPHA target and the BETA parent; the ONLY failing term is the
-- correlation. THIS IS THE ASSERTION THE MUTATION FLIPS: without the term it
-- becomes 1 and a link tagged one tenant hangs off another tenant's parent.
select op.val('OE1 a link whose org disagrees with its parent''s is INVISIBLE -- the correlation, alone',
  $$select count(*)::text from public.task_links
     where id='710000ee-0000-0000-0000-0000000000ee'$$, '0');
-- POSITIVE CONTROL: a correctly-correlated ALPHA link IS visible to pmulti, so
-- the zero above is the correlation and not a blind reader.
select op.val('OE2 CONTROL: a correctly-correlated ALPHA link IS visible to the same reader',
  $$select count(*)::text from public.task_links
     where id='71000000-0000-0000-0000-000000000001'$$, '1');
reset role; reset request.jwt.claims;

delete from public.task_links where id='710000ee-0000-0000-0000-0000000000ee';
delete from public.tasks      where id='7a0000ee-0000-0000-0000-0000000000ee';

alter table public.task_links
  add constraint task_links_parent_fkey
    foreign key (parent_id, organisation_id)
    references public.tasks (id, organisation_id) on delete cascade;
-- The comment `alter table ... add constraint` drops on the floor, restored
-- verbatim from 20260902002000 so the schema is left identical.
comment on constraint task_links_parent_fkey on public.task_links is
  'TENANT-SCOPED COMPOSITE FK (parent_id, organisation_id) -> public.tasks (id, organisation_id). A plain single-column FK is the cross-tenant-write defect 20260828001132 closed. Task 2''s child policy must also carry p.organisation_id = task_links.organisation_id -- the FK and that term are each other''s only backstop (D11).';

select op.val('OE3 the composite FK is restored EXACTLY as the migration made it',
  $$select ((select pg_catalog.pg_get_constraintdef(oid)
               from pg_catalog.pg_constraint
              where conname='task_links_parent_fkey'
                and connamespace='public'::regnamespace)
            = (select v from op.notes where k='oe_fkey_def'))::text$$, 'true');
select op.val('OE3a CONTROL: and that is the composite definition, not any FK',
  $$select (select v from op.notes where k='oe_fkey_def')$$,
  'FOREIGN KEY (parent_id, organisation_id) REFERENCES public.tasks(id, organisation_id) ON DELETE CASCADE');
select op.val('OE3b the constraint COMMENT is restored too',
  $$select ((select pg_catalog.obj_description(oid,'pg_constraint')
               from pg_catalog.pg_constraint
              where conname='task_links_parent_fkey'
                and connamespace='public'::regnamespace)
            = (select v from op.notes where k='oe_fkey_comment'))::text$$, 'true');
select op.val('OE3c ...and the planted rows are gone',
  $$select (select count(*) from public.task_links where id='710000ee-0000-0000-0000-0000000000ee')::text
        || '/' || (select count(*) from public.tasks where id='7a0000ee-0000-0000-0000-0000000000ee')::text$$,
  '0/0');

commit;

-- ===========================================================================
-- OF. LINK TARGET VALIDATED AS THE CALLER -- see-but-not-manage, cross-tenant
-- ===========================================================================
-- The mutation: switching the target check to private.entity_is_manageable.
-- The target check is entity_is_VISIBLE: linking to a record you can SEE but not
-- EDIT is legitimate (20260828235000's decision, one link table along).
--
-- THE SEE-BUT-NOT-MANAGE CASE NEEDS A FULL-SCOPE ROLE LACKING THE TARGET'S
-- MANAGE KEY. A record-scoped user (the brief's phrasing) sees only what they
-- OWN, and owning it plus holding the manage key means they MANAGE it -- so for
-- them see and manage coincide and the distinction cannot be drawn. A booker is
-- full-scope, holds manage_tasks and view_crm, and does NOT hold manage_venues:
-- they SEE every ALPHA venue and MANAGE none. Booker linking their task to a
-- venue is exactly the case that succeeds on entity_is_visible and would fail on
-- entity_is_manageable.
set role authenticated;
set request.jwt.claims = :'pbooker_c';
select op.val('OF0 CONTROL: the booker can SEE the Manager Venue (view_crm, full scope)',
  $$select count(*)::text from public.venues
     where id='55550000-0000-0000-0000-000000000002'$$, '1');
select op.val('OF0b CONTROL: ...but does NOT hold manage_venues',
  $$select count(*)::text from public.role_permissions
     where role_key='booker' and permission_key='manage_venues'$$, '0');
select op.try('OF1 POSITIVE: booker links their task to a venue they SEE but cannot MANAGE',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a0000b0-0000-0000-0000-0000000000b0','venue',
                   '55550000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'ok(1)');
-- Cross-tenant target: a BETA venue, from the booker's ALPHA task. entity_is_
-- visible resolves entity_id against org=ALPHA and finds nothing -> refused.
select op.try('OF2 NEGATIVE: linking to a venue in ANOTHER tenant is refused',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a0000b0-0000-0000-0000-0000000000b0','venue',
                   '5555000b-0000-0000-0000-00000000000b')$$, :'alpha_org'), 'denied(42501)');
-- LABELLED, so the behaviour is documented not discovered: entity_is_visible has
-- no deleted_at term, so a link to a SOFT-DELETED but otherwise visible target is
-- ALLOWED and the application decides. (22220000-...0004 is the Phase 2
-- "Deleted Contact"; a full-scope booker sees it because visibility ignores
-- deleted_at.)
select op.try('OF3 DOCUMENTED: a link to a soft-deleted-but-visible target is ALLOWED',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a0000b0-0000-0000-0000-0000000000b0','contact',
                   '22220000-0000-0000-0000-000000000004')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- THE TARGET GATE ON A RECORD-SCOPED CALLER. pstd1 can link to their OWN
-- company; linking to a company they do not own (invisible to them) is refused
-- by entity_is_visible evaluated AS pstd1 -- the deliberate collapse of "cannot
-- see" into "cannot link".
set role authenticated;
set request.jwt.claims = :'pstd1_c';
select op.try('OF4 POSITIVE: a record-scoped user links their task to a company they OWN',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a000000-0000-0000-0000-000000000001','company',
                   '11110000-0000-0000-0000-000000000001')$$, :'alpha_org'), 'ok(1)');
select op.try('OF5 NEGATIVE: ...but NOT to a company they cannot see (owned by another)',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a000000-0000-0000-0000-000000000001','company',
                   '11110000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- CANNOT ATTACH TO A DELETED PARENT. The mutation dropping `p.deleted_at is null`
-- from a link write policy: pmanager soft-deletes their task, then a link INSERT
-- on to it must refuse. Paired with the positive on a live task.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.try('OF6 CONTROL: soft-delete the Manager Task',
  $$update public.tasks set deleted_at=now()
     where id='7a000000-0000-0000-0000-000000000002'$$, 'ok(1)');
select op.try('OF7 a link INSERT on to a SOFT-DELETED task is refused (p.deleted_at is null)',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a000000-0000-0000-0000-000000000002','contact',
                   '22220000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'denied(42501)');
select op.try('OF8 CONTROL: restore it...',
  $$update public.tasks set deleted_at=null
     where id='7a000000-0000-0000-0000-000000000002'$$, 'ok(1)');
select op.try('OF9 ...and the SAME link INSERT now succeeds',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a000000-0000-0000-0000-000000000002','contact',
                   '22220000-0000-0000-0000-000000000002')$$, :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OG. A SUSPENDED ORGANISATION IS READ-ONLY, NOT A LOCKOUT (the EI/P11 shape)
-- ===========================================================================
-- The four keys are survives_suspension=false (OA2), so a suspended org's writes
-- stop while its reads continue. Counts are taken WHILE LIVE and compared after
-- suspension rather than hardcoded. Then the P11 technique: flip
-- manage_tasks.survives_suspension to true -- the one-row mistake that opens the
-- first gate -- and prove crm_write_organisations() (which carries its own
-- unconditional exclusion of a suspended org) STILL refuses.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.note('live_tasks', (select count(*)::text from public.tasks));
select op.note('live_notes', (select count(*)::text from public.notes));
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = now() where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OG1 SUSPENDED: tasks are still readable, the SAME count as live',
  $$select ((select count(*) from public.tasks)::text
            = (select v from op.notes where k='live_tasks'))::text$$, 'true');
select op.val('OG1a CONTROL: ...and that baseline is not zero',
  $$select ((select v from op.notes where k='live_tasks')::int > 0)::text$$, 'true');
select op.val('OG2 SUSPENDED: notes are still readable, same count as live',
  $$select ((select count(*) from public.notes)::text
            = (select v from op.notes where k='live_notes'))::text$$, 'true');
select op.try('OG3 SUSPENDED: a task INSERT is refused',
  format($$insert into public.tasks (organisation_id, title) values (%L,'susp')$$,
         :'alpha_org'), 'denied(42501)');
select op.try('OG4 SUSPENDED: a note INSERT is refused',
  format($$insert into public.notes (organisation_id, body) values (%L,'susp')$$,
         :'alpha_org'), 'denied(42501)');
select op.try('OG5 SUSPENDED: a task_link INSERT is refused',
  format($$insert into public.task_links (organisation_id, parent_id, entity_type, entity_id)
           values (%L,'7a000000-0000-0000-0000-000000000001','contact',
                   '22220000-0000-0000-0000-000000000003')$$, :'alpha_org'), 'denied(42501)');
reset role; reset request.jwt.claims;

-- THE P11 TECHNIQUE, on manage_tasks. Flip the boolean, prove the SECOND gate
-- (crm_write_organisations) still refuses; restore per-key to what was found.
do $$
declare v_alpha uuid; v_mgr uuid; n int; r_insert text; v_first_gate text; v_saved boolean;
begin
  select id into v_alpha from public.organisations where slug='org-alpha';
  select id into v_mgr from auth.users where email='pmanager@test.local';
  select survives_suspension into v_saved from public.permissions where key='manage_tasks';
  update public.permissions set survives_suspension=true where key='manage_tasks';

  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub',v_mgr,'role','authenticated','aal','aal1')::text, true);
  v_first_gate := public.has_permission(v_alpha,'manage_tasks')::text;

  set local role authenticated;
  begin
    insert into public.tasks (organisation_id, title) values (v_alpha,'first gate off');
    get diagnostics n = row_count; r_insert := 'ok(' || n || ')';
  exception when others then r_insert := 'denied(' || sqlstate || ')'; end;
  reset role;

  perform pg_catalog.set_config('request.jwt.claims','',true);
  update public.permissions set survives_suspension=v_saved where key='manage_tasks';

  perform op.record('OG6 CONTROL: the catalogue flip really DOES open the first gate','true',v_first_gate);
  perform op.record('OG7 FIRST GATE OFF: the task INSERT still refuses (crm_write_organisations)',
    'denied(42501)', r_insert);
  perform op.record('OG8 the key this block borrows was found -- and restored -- FALSE','false',v_saved::text);
end $$;

update public.organisations set deleted_at = null where slug = 'org-alpha';

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.try('OG9 REINSTATED: the same task INSERT is allowed again',
  format($$insert into public.tasks (organisation_id, title) values (%L,'reinstated')$$,
         :'alpha_org'), 'ok(1)');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OH. documents SELECT does NOT filter scan_status
-- ===========================================================================
-- The mutation: a "helpful" `scan_status='clean'` term on documents_select_view_
-- crm. It would hide a quarantined file's own metadata from the person who
-- uploaded it -- presenting as a lost upload -- while the byte gate (Task 5,
-- the download path) is the actual control. Structural first, then behavioural.
select op.val('OH1 documents SELECT policy does NOT mention scan_status',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='documents' and cmd='SELECT'
       and coalesce(qual,'') like '%scan_status%'$$, '0');
select op.val('OH1a CONTROL: OH1 inspected the documents SELECT policy, and there is one',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='documents' and cmd='SELECT'$$, '1');
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OH2 the uploader reads their QUARANTINED document''s metadata row',
  $$select count(*)::text from public.documents
     where id='d0000000-0000-0000-0000-000000000002'$$, '1');
select op.val('OH2b CONTROL: ...and their CLEAN document too (so OH2 is not "sees everything")',
  $$select scan_status from public.documents
     where id='d0000000-0000-0000-0000-000000000001'$$, 'clean');
select op.val('OH3 CONTROL: the quarantined row''s scan_status is readable and says so',
  $$select scan_status from public.documents
     where id='d0000000-0000-0000-0000-000000000002'$$, 'quarantined');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- OI. THE ACTIVITY TIMELINE -- the four Task 7 branches on activity_events
-- ===========================================================================
-- 20260902040000 adds four POLYMORPHIC sources (task_links, meeting_links,
-- note_links, document_links), each read FROM the link table so its subject is
-- the CRM record the operational object hangs off. The security-critical one is
-- note_added: the view is security_invoker, so a 'private' note the reader did
-- NOT author is filtered by notes_select_by_visibility AT THE JOIN and never
-- reaches a third party's timeline. OI3 (a full-scope non-author sees 0) vs OI4
-- (the author sees 1) on the SAME subject is that proof -- if the view were ever
-- switched to security_definer, OI3 would go red.
--
-- Fixtures reused: pstd1's 'Std1 Task' (task_link -> Std1 Contact 2222..0001);
-- pstd1's PRIVATE note 'Std1 private' (note_link -> Std1 Contact 2222..0001);
-- pstd1's COMPANY note 'Std1 company' (note_link -> Manager Contact 2222..0002);
-- pmanager's 'manager.pdf' (document_link -> 2222..0002); pmanager's 'Manager
-- Meeting' (meeting_link -> 2222..0002).

-- Complete pstd1's task so the task_completed arm has a completed_at to fire on.
-- As postgres: "done" is an application transition the write path owns and this
-- suite has none; the branch only READS completed_at.
update public.tasks
   set status='done', completed_at = timestamptz '2026-09-15 10:00+00'
 where id='7a000000-0000-0000-0000-000000000001';

-- The four backedBy names (lib/crm/activity.ts) are REAL indexes -- the half a
-- psql suite can prove; tests/unit/crm/activity.test.ts asserts the spec names
-- them. Same shape as rls_phase3_events.sql §§ EX/EL for the Phase 3 branches.
select op.val('OI0a task_links_target_idx is a real index',
  $$select count(*)::text from pg_indexes where schemaname='public'
     and indexname='task_links_target_idx'$$, '1');
select op.val('OI0b meeting_links_target_idx is a real index',
  $$select count(*)::text from pg_indexes where schemaname='public'
     and indexname='meeting_links_target_idx'$$, '1');
select op.val('OI0c note_links_target_idx is a real index',
  $$select count(*)::text from pg_indexes where schemaname='public'
     and indexname='note_links_target_idx'$$, '1');
select op.val('OI0d document_links_target_idx is a real index',
  $$select count(*)::text from pg_indexes where schemaname='public'
     and indexname='document_links_target_idx'$$, '1');

-- pmanager is FULL-SCOPE and a THIRD PARTY to pstd1's private note.
set role authenticated;
set request.jwt.claims = :'pmanager_c';
select op.val('OI1 the linked task appears on the contact timeline (link_added, named)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and kind='link_added' and detail->>'other_name'='Std1 Task'$$, '1');
select op.val('OI2 the completed task appears (task_completed, named)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and kind='task_completed' and detail->>'other_name'='Std1 Task'$$, '1');
-- THE SECURITY ASSERTION. pstd1's PRIVATE note is linked to this contact, but
-- pmanager did not author it and full scope does NOT override 'private', so its
-- note_added is filtered by notes_select_by_visibility through the join.
select op.val('OI3 SECURITY: a private note authored by someone else is NOT on a third party''s timeline',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and kind='note_added'$$, '0');
select op.val('OI3a CONTROL: pmanager CAN read this contact (so OI3''s 0 is the note filtered, not the record invisible)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and kind='record_created'$$, '1');
-- NO NULL-SORTED BAND. The link branches fold their arms into a lateral whose
-- `where e.occurred_at is not null` drops the arm whose timestamp is absent (an
-- open task's completed_at, a live link's deleted_at). Removing that filter --
-- the brief's mutation -- would emit a link_removed/task_completed row with a
-- NULL occurred_at, which `notNull:true` on the sort assumes cannot exist and
-- which drops a band out of a keyset page. Std1 Task's link is LIVE (deleted_at
-- null) and OPEN-then-completed, so the mutation surfaces a null row here.
select op.val('OI3b no timeline row for this contact has a NULL occurred_at (the null filter holds)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and occurred_at is null$$, '0');

-- pstd1 is the AUTHOR of that private note.
set request.jwt.claims = :'pstd1_c';
select op.val('OI4 POSITIVE: the AUTHOR sees their own private note''s note_added on the same subject',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000001'
       and kind='note_added'$$, '1');

-- The remaining three branches, proven to produce a row where they should
-- (on Manager Contact 2222..0002), read as pmanager who can see it (full scope).
set request.jwt.claims = :'pmanager_c';
select op.val('OI5 a COMPANY note appears (note_added) on its linked contact',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000002'
       and kind='note_added'$$, '1');
select op.val('OI6 an attached document appears (document_attached, named by filename)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000002'
       and kind='document_attached' and detail->>'other_name'='manager.pdf'$$, '1');
select op.val('OI7 a linked meeting appears (link_added, named)',
  $$select count(*)::text from public.activity_events
     where subject_type='contact' and subject_id='22220000-0000-0000-0000-000000000002'
       and kind='link_added' and detail->>'other_name'='Manager Meeting'$$, '1');
reset role; reset request.jwt.claims;

-- ===========================================================================
-- Results
-- ===========================================================================
\o
\echo ''
\echo '========== PHASE 4 OPERATIONS RLS SUITE =========='
select seq, case when pass then 'PASS' else '**FAIL**' end as result,
       label, expected, actual
from op.results order by seq;

\echo ''
select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from op.results;
