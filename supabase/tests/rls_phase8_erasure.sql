-- ===========================================================================
-- Phase 8 Task 5 (account erasure and workspace purge) RLS / behaviour suite.
--
-- Covers 20260930000000 .. 20260930006000:
--   the Q130 TOMBSTONE and its three enforced properties
--   public.erasure_jobs, its two policies and its two triggers
--   private.assert_account_is_erasable()          the Q131 last-owner guard
--   private.erase_account()                       THE CHOKEPOINT
--   private.erase_organisation()                  Task 6's primitive
--   private.sweep_custom_field_values()           the polymorphic trap
--   claim / purge_manifest / run / fail           the runner's four RPCs
--   public.start_erasure_for_request()            the operator on behalf
--   private.dsr_fulfilment_job_ready('erasure')   THE SEAM, now awake
--
-- RUN IT WITH: supabase/tests/run-rls-tests.sh, after the export suite, on
-- the same P7VARS fixtures. § EZ removes every row it made.
--
-- ===========================================================================
-- IT ERASES NOBODY THE OTHER SUITES USE.
-- ===========================================================================
-- Every account this suite deletes is one it created itself, in § EF, with
-- its own organisations. The twelve Phase 2 users and organisations ALPHA and
-- BETA are UNTOUCHED, and § EX asserts that by counting ALPHA's rows before
-- and after the erasure rather than assuming it -- which is the brief's
-- "a second tenant is untouched (count its rows before and after)".
--
-- ===========================================================================
-- THE DENOMINATOR RULE (progress.md, standing lesson 1).
-- ===========================================================================
-- Every "X is gone" is preceded by "X was there". The erasure is a function
-- whose whole job is to make things absent, so a suite that asserted only
-- absences would pass perfectly against a function that did nothing at all
-- because its subject never existed. Section EE plants each blocking
-- reference BY NAME, counts it, erases, and counts again.
--
-- SECTIONS:
--   EF  fixtures -- the throwaway subject, his workspaces, his rows
--   ET  the tombstone: it exists, cannot sign in, cannot be a member,
--       cannot be deleted, cannot be erased
--   EB  THE BLOCKER LIST, RE-DERIVED from pg_constraint, and its count
--   EG  the catalogue: RLS, policies, grants, triggers, function privileges
--   EW  writing a job: attribution, the sessionless refusal, the meter
--   EJ  a job's progress: server-only, the transition table, the stamps
--   EL  Q131: the guard refuses and says why; the empty solo workspace does not
--   EE  THE ERASURE: every trap, every blocking reference, idempotence
--   EX  the second tenant, counted before and after
--   ER  a forced mid-sequence failure rolls the whole thing back
--   EO  the workspace purge: the seven types, field_resolution, `replica`
--   ES  the fulfilment seam, BOTH halves awake, with a positive control
--   EZ  housekeeping
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists er cascade;
create schema er;

create table er.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function er.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into er.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function er.try(p_label text, p_sql text, p_expected text)
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
  perform er.record(p_label, p_expected, v_actual);
end $$;

-- THE HINT TOO. Every refusal in this task carries its own hint precisely so
-- that a refusal BY A GUARD and a refusal BY A MISSING PRIVILEGE -- both
-- 42501 -- can be told apart. Phase 7 shipped a false green of exactly that
-- shape, and this task's whole last-owner/tombstone/seam story depends on it.
create function er.try_hint(p_label text, p_sql text, p_expected text)
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
  perform er.record(p_label, p_expected, v_actual);
end $$;

-- AND THE MESSAGE, for the one refusal whose WORDS are the feature: Q131
-- requires the guard to say what the person must do first, and a hint cannot
-- carry a workspace name.
create function er.try_says(p_label text, p_sql text, p_needle text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_msg text; v_actual text;
begin
  begin
    execute p_sql;
    v_actual := 'no refusal at all';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- strpos(), not position(... in ...): the SQL `in` form is a construct
    -- rather than an ordinary call and cannot be schema-qualified, which is
    -- the pg_catalog.<construct> trap the CI guard exists for.
    v_actual := case when pg_catalog.strpos(coalesce(v_msg, ''), p_needle) > 0
                     then 'says it' else 'said instead: ' || coalesce(v_msg, '<null>') end;
  end;
  perform er.record(p_label, 'says it', v_actual);
end $$;

create function er.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform er.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema er to authenticated, anon, service_role;
grant execute on function er.record(text,text,text)   to authenticated, anon, service_role;
grant execute on function er.try(text,text,text)      to authenticated, anon, service_role;
grant execute on function er.try_hint(text,text,text) to authenticated, anon, service_role;
grant execute on function er.val(text,text,text)      to authenticated, anon, service_role;
grant execute on function er.try_says(text,text,text) to authenticated, anon, service_role;


-- ===========================================================================
-- EF  FIXTURES
-- ===========================================================================
-- Three throwaway accounts and three throwaway workspaces, so that nothing
-- this suite deletes belongs to any other suite.
--
--   esub    THE SUBJECT. Owner of BLOCKED (with a colleague and a contact in
--           it) and sole owner of SOLO (empty). Author of one private and one
--           company note, one merge, one data subject request, and the actor
--           on audit rows.
--   emate   the colleague who makes BLOCKED blocked, and the second owner who
--           later unblocks it.
--   ebyst   a bystander who owns rows in PURGE, the workspace § EO purges.
-- ===========================================================================
\o /dev/null
-- CAPTURED FIRST, before this suite writes a single audit row: EZ5 compares
-- against it, and a baseline taken after the fixtures would let the cleanup
-- delete MORE than this suite added and still read as balanced.
select count(*)::text as audit_before from public.audit_events \gset
select gen_random_uuid()::text as esub  \gset
select gen_random_uuid()::text as emate \gset
select gen_random_uuid()::text as ebyst \gset

insert into auth.users (id, instance_id, aud, role, email)
values (:'esub',  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erase-subject-'   || :'esub'  || '@test.local'),
       (:'emate', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erase-colleague-' || :'emate' || '@test.local'),
       (:'ebyst', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erase-bystander-' || :'ebyst' || '@test.local');

select gen_random_uuid()::text as org_blocked \gset
select gen_random_uuid()::text as org_solo    \gset
select gen_random_uuid()::text as org_purge   \gset

insert into public.organisations (id, name, slug) values
  (:'org_blocked', 'Erasure Blocked Ltd', 'erasure-blocked'),
  (:'org_solo',    'Erasure Solo Ltd',    'erasure-solo'),
  (:'org_purge',   'Erasure Purge Ltd',   'erasure-purge');

insert into public.organisation_memberships (organisation_id, user_id, role, status) values
  (:'org_blocked', :'esub',  'owner',         'active'),
  (:'org_blocked', :'emate', 'standard_user', 'active'),
  (:'org_solo',    :'esub',  'owner',         'active'),
  (:'org_purge',   :'ebyst', 'owner',         'active'),
  -- A SECOND OWNER of PURGE, so that section ER's forced failure is reached
  -- at all: without one the Q131 guard refuses ebyst's erasure before any
  -- step of it runs, and "the rollback works" would be measuring the
  -- last-owner check instead.
  (:'org_purge',   :'emate', 'owner',         'active');

-- The workspace's own records, which a member's departure must NOT delete.
insert into public.contacts (id, organisation_id, name, email, owner_user_id) values
  (gen_random_uuid(), :'org_blocked', 'Erasure Bystander Contact', 'bystander@erase.test', :'esub');

-- Two notes: one PRIVATE (hard-deleted by the erasure, because nulling its
-- owner leaves it readable by nobody and stored for ever) and one COMPANY
-- (kept, with a nulled author -- the workspace's, not the member's).
select gen_random_uuid()::text as note_private \gset
select gen_random_uuid()::text as note_company \gset
insert into public.notes (id, organisation_id, owner_user_id, body, visibility) values
  (:'note_private', :'org_blocked', :'esub', 'ERASURE PRIVATE NOTE', 'private'),
  (:'note_company', :'org_blocked', :'esub', 'ERASURE COMPANY NOTE', 'company');

-- The audit log's two shapes: the subject as ACTOR (a foreign key, re-pointed
-- by the derived walk) and as TARGET (no foreign key at all, so it survives
-- unless step 6b moves it) with a payload describing them.
insert into public.audit_events
  (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, before, after)
values
  -- The ACTOR row carries a payload, because M1 is about exactly that column
  -- on exactly this shape of row: the page promises the description of the
  -- change is dropped, and before fix round 1 only the TARGET rows lost it.
  (:'org_blocked', :'esub', 'erase.fixture.actor',  'contact', gen_random_uuid(), gen_random_uuid(),
   '{"erasure_fixture_payload": "a change the subject made"}'::jsonb, null),
  (:'org_blocked', :'emate', 'erase.fixture.target', 'contact', :'esub', gen_random_uuid(),
   '{"erasure_fixture_payload": "about the subject"}'::jsonb, null);

-- merges: the blocking `merged_by`, the FK-LESS owner snapshots, and the
-- field_resolution that holds a discarded record's values verbatim.
select gen_random_uuid()::text as merge_id \gset
insert into public.merges
  (id, organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution,
   winner_owner_user_id, loser_owner_user_id)
values (:'merge_id', :'org_blocked', 'contact', gen_random_uuid(), gen_random_uuid(), :'esub',
        '{"email": "ERASURE-DISCARDED@example.com"}'::jsonb, :'esub', :'esub');

-- merge_candidates.resolved_by: the second blocking reference in this family.
-- `merge_candidates_resolution_complete` requires deleted_at, resolution and
-- resolved_by to arrive together, so a resolved candidate is the only shape
-- that can carry the column at all.
-- ... AND THE TWO OWNER-ID SNAPSHOTS BESIDE IT, which have no foreign key at
-- all. This fixture originally left them null, and that omission is the whole
-- reason C1 shipped green: screen_for_duplicates() writes both on every
-- flagged duplicate, so the real table's common row carries them.
insert into public.merge_candidates
  (organisation_id, entity_type, keep_id, duplicate_id, label, reason,
   deleted_at, resolution, resolved_by,
   keep_owner_user_id, duplicate_owner_user_id)
values (:'org_blocked', 'contact', gen_random_uuid(), gen_random_uuid(),
        'Erasure fixture candidate', 'fuzzy_name',
        pg_catalog.now(), 'dismissed', :'esub',
        :'esub', :'esub');

-- impersonation_sessions x3, organisation_*_overrides x2, incident_alerts:
-- the remaining blocking families, planted so § EE can count them by name.
-- TWO rows, because one cannot carry both columns: the status CHECK makes a
-- `declined` session one that was never accepted. Between them they name the
-- subject on all THREE of this table's no-ON-DELETE references.
insert into public.impersonation_sessions
  (superuser_user_id, target_organisation_id, reason, status, declined_by, declined_at)
values (:'esub', :'org_blocked', 'erasure fixture: a session the subject declined',
        'declined', :'esub', pg_catalog.now());
insert into public.impersonation_sessions
  (superuser_user_id, target_organisation_id, reason, status,
   admin_accepted_by, accepted_at, started_at, expires_at, ended_at)
values (:'esub', :'org_blocked', 'erasure fixture: a session the subject accepted',
        'ended', :'esub', pg_catalog.now(), pg_catalog.now(),
        pg_catalog.now() + interval '1 hour', pg_catalog.now());

insert into public.organisation_billing_overrides
  (organisation_id, override_tier, reason, granted_by, expires_at, revoked_by, revoked_at, revoked_reason)
values (:'org_blocked', 'pro', 'erasure fixture', :'esub', pg_catalog.now() + interval '30 days',
        :'esub', pg_catalog.now(), 'erasure fixture revoke');

insert into public.organisation_feature_overrides
  (organisation_id, flag_key, reason, granted_by, expires_at, revoked_by, revoked_at, revoked_reason)
values (:'org_blocked', 'early_access_preview', 'erasure fixture', :'esub',
        pg_catalog.now() + interval '30 days', :'esub', pg_catalog.now(), 'erasure fixture revoke');

insert into public.incident_alerts (alert_type, organisation_id, summary, details, resolved_at, resolved_by)
values ('rate_limit_tripped', :'org_blocked', 'erasure fixture alert',
        pg_catalog.jsonb_build_object('subject_id', :'esub', 'nested',
          pg_catalog.jsonb_build_object('also', :'esub')),
        pg_catalog.now(), :'esub');

-- A rate-limit counter keyed on the subject: an identifier with no foreign
-- key, which the delete would otherwise leave behind.
insert into public.rate_limit_counters (category, subject_scope, subject_id, window_start, request_count)
values ('search', 'user', :'esub', private.rate_limit_window_start(pg_catalog.now(), 60), 3);

-- The data subject register (Q158) and its operator note, the two
-- no-ON-DELETE references Phase 8 itself added, are written below through the
-- real RPC from the subject's own session -- a request cannot be filed in
-- somebody else's name, which is Task 3's whole attribution story.
\o
\set esub_c   '{"sub":"' :esub '","role":"authenticated","aal":"aal1"}'
\set emate_c  '{"sub":"' :emate '","role":"authenticated","aal":"aal1"}'
\set ebyst_c  '{"sub":"' :ebyst '","role":"authenticated","aal":"aal1"}'
\set anon_c '{"role":"anon"}'
\set svc_c  '{"role":"service_role"}'

\o /dev/null
set request.jwt.claims to :'esub_c';
set role authenticated;
select count(*) from public.submit_data_subject_request(
  'erasure', 'account', 'ERASURE FIXTURE DETAIL: please delete my account');
reset role;
reset request.jwt.claims;

select id::text as dsr_id from public.data_subject_requests
 where detail = 'ERASURE FIXTURE DETAIL: please delete my account' \gset

-- An operator note AUTHORED BY THE SUBJECT. Contrived on purpose: the
-- inventory's own reading is that this column "blocks only the founder's own
-- account today", and a reference that only the founder can create is a
-- reference nothing would ever test. The audit trigger is disabled for the
-- insert because private.log_audit_event() requires a session and this one
-- has none -- which is itself the evidence that a note cannot be written
-- unattributed through the product. EF6 asserts it is back on.
alter table public.data_subject_request_notes disable trigger data_subject_request_notes_audit;
insert into public.data_subject_request_notes (request_id, author_user_id, body)
values (:'dsr_id', :'esub', 'ERASURE FIXTURE OPERATOR NOTE');
alter table public.data_subject_request_notes enable trigger data_subject_request_notes_audit;

-- What the second tenant looks like BEFORE anything is erased. § EX.
select id as alpha_org from public.organisations where slug = 'org-alpha' \gset
select (select count(*) from public.contacts  where organisation_id = :'alpha_org')::text || '/' ||
       (select count(*) from public.notes     where organisation_id = :'alpha_org')::text || '/' ||
       (select count(*) from public.organisation_memberships where organisation_id = :'alpha_org')::text
       as alpha_before \gset
\o

select er.val('EF1 the subject exists',
  $$select count(*)::text from auth.users where id = '$$ || :'esub' || $$'$$, '1');
select er.val('EF2 the subject owns two workspaces',
  $$select count(*)::text from public.organisation_memberships
     where user_id = '$$ || :'esub' || $$' and role = 'owner'$$, '2');
select er.val('EF3 the subject has one private and one company note',
  $$select string_agg(visibility, ',' order by visibility) from public.notes
     where owner_user_id = '$$ || :'esub' || $$'$$, 'company,private');
select er.val('EF4 the register holds the subject''s own erasure request',
  $$select count(*)::text from public.data_subject_requests
     where user_id = '$$ || :'esub' || $$' and right_type = 'erasure'$$, '1');
select er.val('EF5 and an operator note on it',
  $$select count(*)::text from public.data_subject_request_notes
     where author_user_id = '$$ || :'esub' || $$'$$, '1');
select er.val('EF6 the note audit trigger is ENABLED again before anything is measured',
  $$select tgenabled::text from pg_catalog.pg_trigger
     where tgrelid = 'public.data_subject_request_notes'::pg_catalog.regclass
       and tgname = 'data_subject_request_notes_audit'$$, 'O');


-- ===========================================================================
-- ET  THE TOMBSTONE (Q130)
-- ===========================================================================

select er.val('ET1 the tombstone row exists, created by a migration',
  $$select count(*)::text from auth.users where id = private.erased_user_id()$$, '1');
select er.val('ET2 it has no password, no confirmed address and is banned for ever',
  $$select (encrypted_password is null)::text || '/' || (email_confirmed_at is null)::text
        || '/' || (banned_until = 'infinity')::text
      from auth.users where id = private.erased_user_id()$$, 'true/true/true');
select er.val('ET3 its address is in the RFC 2606 .invalid TLD, so it can never receive mail',
  $$select (email like '%.invalid')::text from auth.users where id = private.erased_user_id()$$, 'true');
select er.val('ET4 it has no auth.identities row, so no provider can sign it in',
  $$select count(*)::text from auth.identities where user_id = private.erased_user_id()$$, '0');
select er.val('ET5 it has a profile, so a pseudonymised audit row reads as a sentence',
  $$select full_name from public.profiles where id = private.erased_user_id()$$, 'Erased user');

select er.try_hint('ET6 it CANNOT be given a password',
  $$update auth.users set encrypted_password = 'x' where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_not_a_login)');
-- M4: the guard was a column list, and these two were not on it. Neither is a
-- live path -- both need direct database access, and the tombstone has no
-- password and no identity row -- but they are the two columns that would
-- decide what a token SAID if one were ever minted.
select er.try_hint('ET6b it CANNOT have its role changed (M4)',
  $$update auth.users set role = 'service_role' where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_not_a_login)');
select er.try_hint('ET6c nor its app metadata, where a role claim would also live (M4)',
  $$update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"service_role"}'::jsonb
     where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_not_a_login)');
select er.val('ET6d and neither write landed',
  $$select role || '/' || coalesce(raw_app_meta_data ->> 'role', 'none')
      from auth.users where id = private.erased_user_id()$$, 'authenticated/none');
select er.try_hint('ET7 it CANNOT have its ban lifted',
  $$update auth.users set banned_until = null where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_not_a_login)');
select er.try_hint('ET8 it CANNOT have its address confirmed',
  $$update auth.users set email_confirmed_at = now() where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_not_a_login)');
select er.try_hint('ET9 it CANNOT be deleted -- every pseudonymised row hangs from it',
  $$delete from auth.users where id = private.erased_user_id()$$,
  'denied(42501:tombstone_is_permanent)');
select er.try_hint('ET10 it CANNOT hold a membership',
  $$insert into public.organisation_memberships (organisation_id, user_id, role, status)
    values ('$$ || :'org_blocked' || $$', private.erased_user_id(), 'owner', 'active')$$,
  'denied(42501:tombstone_is_nobody)');
select er.try_hint('ET11 it CANNOT be a platform admin',
  $$insert into public.platform_admins (user_id) values (private.erased_user_id())$$,
  'denied(42501:tombstone_is_nobody)');
select er.try_hint('ET12 and it CANNOT be erased',
  $$select private.erase_account(private.erased_user_id(), null)$$,
  'denied(42501:tombstone_is_nobody)');

-- POSITIVE CONTROL for ET6-ET9: the same statements against ANOTHER account
-- succeed, so the four refusals above are the tombstone trigger and not a
-- missing privilege or a read-only auth schema.
select er.try('ET13 POSITIVE CONTROL: another account CAN be given a password',
  $$update auth.users set encrypted_password = 'x' where id = '$$ || :'ebyst' || $$'$$, 'ok(1)');
select er.try('ET14 POSITIVE CONTROL: another account CAN have its ban set',
  $$update auth.users set banned_until = null where id = '$$ || :'ebyst' || $$'$$, 'ok(1)');


-- ===========================================================================
-- EB  THE BLOCKER LIST, RE-DERIVED
-- ===========================================================================
-- The erasure walks pg_constraint rather than carrying a list, so THIS is
-- where the list is pinned -- and a fourteenth blocking foreign key added by
-- a later phase arrives here as a red assertion naming itself, rather than as
-- an account that silently cannot be deleted.

select er.val('EB1 exactly thirteen foreign keys to auth.users have NO ON DELETE action',
  $$select count(*)::text from pg_catalog.pg_constraint con
     where con.contype = 'f' and con.confrelid = 'auth.users'::pg_catalog.regclass
       and con.confdeltype = 'a'$$, '13');

select er.val('EB2 and they are these thirteen, by name',
  $$select string_agg(t, ',' order by t) from (
      select con.conrelid::pg_catalog.regclass::text || '.' || a.attname as t
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_attribute a
          on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       where con.contype = 'f' and con.confrelid = 'auth.users'::pg_catalog.regclass
         and con.confdeltype = 'a') s$$,
  'public.audit_events.actor_user_id,'
  'public.data_subject_request_notes.author_user_id,'
  'public.data_subject_requests.user_id,'
  'public.impersonation_sessions.admin_accepted_by,'
  'public.impersonation_sessions.declined_by,'
  'public.impersonation_sessions.superuser_user_id,'
  'public.incident_alerts.resolved_by,'
  'public.merge_candidates.resolved_by,'
  'public.merges.merged_by,'
  'public.organisation_billing_overrides.granted_by,'
  'public.organisation_billing_overrides.revoked_by,'
  'public.organisation_feature_overrides.granted_by,'
  'public.organisation_feature_overrides.revoked_by');

-- ASSERT WHAT THE DERIVATION WOULD DROP. The walk is single-column; a
-- composite foreign key to auth.users would be skipped in silence. The
-- erasure raises on one; this is the standing assertion that there is none.
select er.val('EB3 no COMPOSITE foreign key to auth.users exists -- the walk could not see one',
  $$select count(*)::text from pg_catalog.pg_constraint con
     where con.contype = 'f' and con.confrelid = 'auth.users'::pg_catalog.regclass
       and pg_catalog.array_length(con.conkey, 1) > 1$$, '0');

-- THE INVENTORY SAID `notes.author_user_id`. MEASURED: there is no such
-- column. This is the assertion that corrects it, so the claim cannot come
-- back on the next reading of the document.
select er.val('EB4 public.notes has no author_user_id column -- its author is owner_user_id',
  $$select count(*)::text from pg_catalog.pg_attribute
     where attrelid = 'public.notes'::pg_catalog.regclass and attname = 'author_user_id'$$, '0');
select er.val('EB5 and notes.owner_user_id is ON DELETE SET NULL, not a blocker',
  $$select con.confdeltype::text from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute a
        on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f' and con.conrelid = 'public.notes'::pg_catalog.regclass
       and a.attname = 'owner_user_id'$$, 'n');


-- ===========================================================================
-- EC  THE COLUMNS NO FOREIGN KEY PROTECTS (fix round 1, C1)
-- ===========================================================================
-- § EB pins what pg_constraint CAN see. This section pins what it cannot: a
-- uuid column in no foreign key is invisible to every walk in the erasure, so
-- private.fkless_identifier_columns() is the roll and
-- private.assert_fkless_identifier_roll() is what stops the roll going stale.
-- EC5 is the MUTATION, standing: a new FK-less uuid column makes the erasure
-- REFUSE rather than report a success that left an identifier behind.

select er.val('EC1 every FK-less uuid column in public/private is classified on the roll',
  $$select count(*)::text from private.unclassified_fkless_identifiers()$$, '0');
select er.val('EC2a the roll classifies merge_candidates.keep_owner_user_id as a person''s id',
  $$select r.identifies || '/' || r.treatment from private.fkless_identifier_columns() r
     where r.table_name = 'public.merge_candidates' and r.column_name = 'keep_owner_user_id'$$,
  'user/null_on_match');
select er.val('EC2b and merge_candidates.duplicate_owner_user_id likewise',
  $$select r.identifies || '/' || r.treatment from private.fkless_identifier_columns() r
     where r.table_name = 'public.merge_candidates' and r.column_name = 'duplicate_owner_user_id'$$,
  'user/null_on_match');
select er.val('EC3 the roll names FIVE person-bearing columns, and they are the ones the erasure runs',
  $$select pg_catalog.string_agg(r.table_name || '.' || r.column_name, ',' order by r.table_name, r.column_name)
      from private.fkless_identifier_columns() r
     where r.identifies = 'user' and r.treatment in ('null_on_match', 'delete_row')$$,
  'public.merge_candidates.duplicate_owner_user_id,'
  'public.merge_candidates.keep_owner_user_id,'
  'public.merges.loser_owner_user_id,'
  'public.merges.winner_owner_user_id,'
  'public.rate_limit_counters.subject_id');

-- THE POSITIVE CONTROL FIRST: with the catalogue and the roll agreeing, an
-- erasure of a subject who does not exist answers `already_erased`. So EC5's
-- refusal is the planted column's and not the subject's.
select er.val('EC4 POSITIVE CONTROL: with the roll intact the chokepoint gets past step 0',
  $$select (private.erase_account(gen_random_uuid(), null) ->> 'already_erased')$$, 'true');

create table public.er_unclassified_probe (
  id uuid primary key default gen_random_uuid(), who uuid);
select er.try_hint('EC5 MUTATION: an unclassified FK-less uuid column REFUSES the erasure',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');
drop table public.er_unclassified_probe;
select er.val('EC6 and with the probe gone the chokepoint gets past step 0 again',
  $$select (private.erase_account(gen_random_uuid(), null) ->> 'already_erased')$$, 'true');

-- ---------------------------------------------------------------------------
-- THE FIVE SHAPES THE ROLL USED TO BE BLIND TO (fix round 2, N1).
--
-- The scoped re-review planted ten column shapes and called the chokepoint:
-- E1/E1p/E10 (an ordinary FK-less uuid, in `private`, and UNLOGGED) refused
-- and are EC5 above; THREE got past step 0 in silence and are EC7-EC9 here;
-- two more are closed with them (EC10, EC11). The remaining three are left
-- open on purpose and 20261002000000's header says why: a uuid inside jsonb
-- or text (a content scan), and any schema but public/private (auth, storage
-- and the rest are not ours to classify).
--
-- Each one is a MUTATION with EC12 as its shared control: plant, refuse,
-- drop. EC13 is the NEGATIVE control the narrowing needs -- the surrogate
-- `id uuid primary key` is still exempt, or this would refuse every table in
-- the schema and pass for the wrong reason.
-- ---------------------------------------------------------------------------

create table public.er_natural_pk_probe (user_id uuid primary key);
select er.try_hint('EC7 MUTATION: a NATURAL uuid primary key refuses the erasure',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');
drop table public.er_natural_pk_probe;

create table public.er_composite_pk_probe (user_id uuid, k int, primary key (user_id, k));
select er.try_hint('EC8 MUTATION: a uuid inside a COMPOSITE primary key refuses it too',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');
drop table public.er_composite_pk_probe;

create table public.er_array_probe (
  id uuid primary key default gen_random_uuid(), whos uuid[]);
select er.try_hint('EC9 MUTATION: a uuid[] refuses it -- the shape NO foreign key can protect',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');

-- AND AN ARRAY ON THE ROLL WITH A TREATMENT THE LOOPS CANNOT RUN. The roll is
-- saved from the catalogue and put back from the catalogue, so this probe
-- does not restate the roll's own contents and cannot go stale when it grows.
create table er.saved_roll as
  select pg_catalog.pg_get_functiondef('private.fkless_identifier_columns()'::pg_catalog.regprocedure) as def;
do $mut$
declare v_def text;
begin
  select s.def into v_def from er.saved_roll s;
  execute pg_catalog.replace(v_def, 'from (values',
    'from (values (''public.er_array_probe'', ''whos'', ''user'', ''null_on_match'', null, ''fix round 2 probe''),');
end;
$mut$;
select er.try_hint('EC10 MUTATION: a uuid[] CLASSIFIED for the generic loops refuses, by its own hint',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:array_identifier_needs_a_named_step)');
do $res$
declare v_def text;
begin
  select s.def into v_def from er.saved_roll s;
  execute v_def;
end;
$res$;
select er.val('EC10a the roll is back the way it was found',
  $$select (pg_catalog.pg_get_functiondef('private.fkless_identifier_columns()'::pg_catalog.regprocedure)
            = (select def from er.saved_roll))::text$$, 'true');
drop table public.er_array_probe;

create domain public.er_uid as uuid;
create table public.er_domain_probe (
  id uuid primary key default gen_random_uuid(), who public.er_uid);
select er.try_hint('EC11 MUTATION: a DOMAIN over uuid refuses it -- the base type is what counts',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');
drop table public.er_domain_probe;
drop domain public.er_uid;

create materialized view public.er_matview_probe as select gen_random_uuid() as who;
select er.try_hint('EC12 MUTATION: a MATERIALIZED VIEW is storage and refuses it (a plain view is not)',
  $$select private.erase_account(gen_random_uuid(), null)$$,
  'denied(55000:unclassified_fkless_identifier)');
drop materialized view public.er_matview_probe;

select er.val('EC13 CONTROL: every probe gone, the chokepoint gets past step 0 again',
  $$select (private.erase_account(gen_random_uuid(), null) ->> 'already_erased')$$, 'true');

create table public.er_surrogate_pk_probe (
  id uuid primary key default gen_random_uuid(), name text);
select er.val('EC14 NEGATIVE CONTROL: the surrogate `id uuid primary key` is still exempt',
  $$select (private.erase_account(gen_random_uuid(), null) ->> 'already_erased')$$, 'true');
drop table public.er_surrogate_pk_probe;


-- ===========================================================================
-- EG  THE CATALOGUE
-- ===========================================================================

select er.val('EG1 erasure_jobs has RLS enabled AND forced',
  $$select (relrowsecurity)::text || '/' || (relforcerowsecurity)::text
      from pg_catalog.pg_class where oid = 'public.erasure_jobs'::pg_catalog.regclass$$, 'true/true');
select er.val('EG2 it has exactly two policies',
  $$select string_agg(polname, ',' order by polname) from pg_catalog.pg_policy
     where polrelid = 'public.erasure_jobs'::pg_catalog.regclass$$,
  'erasure_jobs_insert_own,erasure_jobs_select_own');
select er.val('EG3 authenticated may INSERT exactly ONE column',
  $$select string_agg(a.attname, ',' order by a.attname)
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.erasure_jobs'::pg_catalog.regclass and a.attnum > 0
       and has_column_privilege('authenticated', a.attrelid, a.attname, 'INSERT')$$, 'kind');
select er.val('EG4 authenticated holds NO update and NO delete on the register',
  $$select (has_table_privilege('authenticated', 'public.erasure_jobs', 'UPDATE'))::text || '/' ||
           (has_table_privilege('authenticated', 'public.erasure_jobs', 'DELETE'))::text$$,
  'false/false');
-- FOUR SINCE FIX ROUND 1, NOT FIVE (review finding I2). `summary` left the
-- grant: it is the one column whose CHECK calls private.jsonb_is_count_map(),
-- and `service_role` cannot reach that function -- it has no USAGE on schema
-- `private` at all -- so the first direct PostgREST write of it would have met
-- `permission denied for schema private`. Every writer of `summary` is a
-- SECURITY DEFINER RPC, evaluated as the definer, so nothing needed it.
select er.val('EG5 service_role may UPDATE exactly the four outcome columns, and not `summary`',
  $$select string_agg(a.attname, ',' order by a.attname)
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.erasure_jobs'::pg_catalog.regclass and a.attnum > 0
       and has_column_privilege('service_role', a.attrelid, a.attname, 'UPDATE')$$,
  'completed_at,failure_reason,started_at,status');
select er.val('EG6 the two triggers are on the table',
  $$select string_agg(tgname, ',' order by tgname) from pg_catalog.pg_trigger
     where tgrelid = 'public.erasure_jobs'::pg_catalog.regclass and not tgisinternal$$,
  'erasure_jobs_after_insert_audit,erasure_jobs_before_insert,erasure_jobs_before_update');
select er.val('EG7 the four runner RPCs are service_role-only',
  $$select string_agg(p.proname || ':' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text || '/' ||
        (has_function_privilege('service_role', p.oid, 'EXECUTE'))::text, ',' order by p.proname)
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.proname in ('claim_erasure_job','erasure_purge_manifest','fail_erasure_job','run_erasure_job')$$,
  'claim_erasure_job:false/true,erasure_purge_manifest:false/true,fail_erasure_job:false/true,run_erasure_job:false/true');
select er.val('EG8 the two erasure primitives are reachable by NO client role at all',
  $$select string_agg(p.proname || ':' ||
        (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('service_role', p.oid, 'EXECUTE'))::text, ',' order by p.proname)
      from pg_catalog.pg_proc p
     where p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname in ('erase_account','erase_organisation')$$,
  'erase_account:false,erase_organisation:false');
select er.val('EG9 the account_erasure budget exists and is user-scoped',
  $$select subject_scope || '/' || max_requests::text || '/' || window_seconds::text
      from public.rate_limit_policies where category = 'account_erasure'$$, 'user/3/86400');
select er.val('EG10 the ONE cron job still runs the ONE tick, its command untouched',
  $$select count(*)::text || ':' || max(command) from cron.job where jobname = 'incident-alert-delivery'$$,
  '1:select private.run_incident_alert_tick()');
select er.val('EG11 and that tick now reaches the erasure runner',
  $$select (pg_catalog.pg_get_functiondef(p.oid) like '%deliver_erasure_jobs%')::text
      from pg_catalog.pg_proc p
     where p.pronamespace = 'private'::pg_catalog.regnamespace
       and p.proname = 'run_incident_alert_tick'$$, 'true');


-- ===========================================================================
-- EW  WRITING A JOB
-- ===========================================================================

set role authenticated;
set request.jwt.claims to :'esub_c';

-- ATTRIBUTION IS NOT THE CALLER'S TO SUPPLY. `subject_user_id` is outside the
-- INSERT grant, so naming it is refused before any trigger runs -- the
-- feedback table's I1 shape.
select er.try('EW1 a client naming a subject is refused by the COLUMN GRANT',
  $$insert into public.erasure_jobs (kind, subject_user_id)
    values ('account', '$$ || :'emate' || $$')$$, 'denied(42501)');
select er.try_hint('EW2 a client cannot start a WORKSPACE purge',
  $$insert into public.erasure_jobs (kind) values ('workspace')$$,
  'denied(42501:purge_is_server_only)');
select er.try('EW3 a client cannot write a job''s status',
  $$update public.erasure_jobs set status = 'succeeded'$$, 'denied(42501)');

reset role;
reset request.jwt.claims;

select er.try_hint('EW4 a SESSIONLESS account job is refused -- an erasure is somebody''s own act',
  $$insert into public.erasure_jobs (kind) values ('account')$$,
  'denied(42501:erasure_needs_a_session)');
select er.try_hint('EW5 a SESSIONLESS workspace purge with no workspace is refused',
  $$insert into public.erasure_jobs (kind) values ('workspace')$$,
  'denied(22023:purge_needs_a_workspace)');


-- ===========================================================================
-- EL  Q131 -- THE LAST-OWNER GUARD
-- ===========================================================================
-- Asked DIRECTLY of the trigger-level rule and not only through the RPC that
-- carries its own guard (Task 3's mutation 3 found a hole exactly there).

select er.val('EL1 the guard names the blocking workspace and its reason',
  $$select organisation_name || ':' || reason
      from private.account_erasure_blockers('$$ || :'esub' || $$')$$,
  'Erasure Blocked Ltd:other_members');
select er.val('EL2 the EMPTY solo workspace is NOT a blocker',
  $$select count(*)::text from private.account_erasure_blockers('$$ || :'esub' || $$')
     where organisation_name = 'Erasure Solo Ltd'$$, '0');
select er.try_hint('EL3 the guard REFUSES the erasure itself',
  $$select private.erase_account('$$ || :'esub' || $$', null)$$,
  'denied(22023:last_owner_of_workspace)');
select er.try_says('EL4a the refusal NAMES the workspace',
  $$select private.erase_account('$$ || :'esub' || $$', null)$$, 'Erasure Blocked Ltd');
select er.try_says('EL4b and says what to do first (Q131: a refusal that only says no is not enough)',
  $$select private.erase_account('$$ || :'esub' || $$', null)$$, 'Make somebody else an owner');

-- THE SAME REFUSAL AT THE INSERT, so it reaches the person on the page.
set role authenticated;
set request.jwt.claims to :'esub_c';
select er.try_hint('EL5 the INSERT is refused by the same guard, with the same hint',
  $$insert into public.erasure_jobs (kind) values ('account')$$,
  'denied(22023:last_owner_of_workspace)');
reset role;
reset request.jwt.claims;

select er.val('EL6 nothing was written -- a refused ask costs no job row',
  $$select count(*)::text from public.erasure_jobs
     where subject_user_id = '$$ || :'esub' || $$'$$, '0');
select er.val('EL7 and no budget was spent on it',
  $$select coalesce(max(request_count), 0)::text from public.rate_limit_counters
     where category = 'account_erasure' and subject_id = '$$ || :'esub' || $$'$$, '0');

-- Make the colleague an Owner: the workspace now has another owner, the guard
-- lets go, and EL1's denominator is proved to have been real.
\o /dev/null
update public.organisation_memberships set role = 'owner'
 where organisation_id = :'org_blocked' and user_id = :'emate';
\o

select er.val('EL8 with a second owner the guard lets go',
  $$select count(*)::text from private.account_erasure_blockers('$$ || :'esub' || $$')$$, '0');


-- ===========================================================================
-- EM  Q131 AT THE MEMBERSHIP (fix round 1, I1/Q176)
-- ===========================================================================
-- The erasure guard used to be keyed on the word "owner", and NOTHING guarded
-- public.organisation_memberships -- so an Admin at aal2 holding
-- manage_members could demote the sole Owner, after which the erasure guard
-- stopped firing for everybody and the remaining members could erase
-- themselves one by one. Asked DIRECTLY of the trigger here: as `postgres`,
-- which no policy binds, and as a real authenticated Admin, which is the
-- product route.
\set emate_a2 '{"sub":"' :emate '","role":"authenticated","aal":"aal2"}'

select er.val('EM1 DENOMINATOR: BLOCKED has two active owners',
  $$select count(*)::text from public.organisation_memberships
     where organisation_id = '$$ || :'org_blocked' || $$' and role = 'owner' and status = 'active'$$, '2');
select er.try('EM2 POSITIVE CONTROL: demoting ONE of two owners is allowed',
  $$update public.organisation_memberships set role = 'admin'
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'emate' || $$'$$, 'ok(1)');
select er.val('EM3 leaving exactly one active owner',
  $$select count(*)::text from public.organisation_memberships
     where organisation_id = '$$ || :'org_blocked' || $$' and role = 'owner' and status = 'active'$$, '1');

select er.try_hint('EM4 demoting the SOLE owner is refused -- as postgres, which no policy binds',
  $$update public.organisation_memberships set role = 'standard_user'
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'denied(22023:last_owner_of_workspace)');

set role authenticated;
set request.jwt.claims to :'emate_a2';
select er.try_hint('EM5 and refused for the aal2 ADMIN who holds manage_members -- the route that reached it',
  $$update public.organisation_memberships set role = 'standard_user'
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'denied(22023:last_owner_of_workspace)');
reset role;
reset request.jwt.claims;

select er.try_hint('EM6 REMOVING the sole owner is refused by the same rule',
  $$delete from public.organisation_memberships
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'denied(22023:last_owner_of_workspace)');
select er.try_hint('EM7 and so is revoking their membership -- status, not only role',
  $$update public.organisation_memberships set status = 'revoked'
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'denied(22023:last_owner_of_workspace)');
select er.try_says('EM8 the refusal NAMES the workspace',
  $$update public.organisation_memberships set role = 'standard_user'
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'Erasure Blocked Ltd');
select er.val('EM9 and nothing moved -- the owner is still an active owner',
  $$select role || '/' || status from public.organisation_memberships
     where organisation_id = '$$ || :'org_blocked' || $$' and user_id = '$$ || :'esub' || $$'$$,
  'owner/active');

-- THE EXEMPTION, AS A POSITIVE CONTROL: an EMPTY workspace with nobody else
-- in it has nothing to strand, so its sole owner may leave.
\o /dev/null
select gen_random_uuid()::text as org_shell \gset
insert into public.organisations (id, name, slug)
values (:'org_shell', 'Erasure Shell Ltd', 'erasure-shell');
insert into public.organisation_memberships (organisation_id, user_id, role, status)
values (:'org_shell', :'emate', 'owner', 'active');
\o
select er.try('EM10 POSITIVE CONTROL: the sole owner of an EMPTY, memberless workspace may leave',
  $$delete from public.organisation_memberships
     where organisation_id = '$$ || :'org_shell' || $$'$$, 'ok(1)');
\o /dev/null
delete from public.organisations where id = :'org_shell';
-- ... and BLOCKED goes back to two owners, which is what § EE assumes.
update public.organisation_memberships set role = 'owner'
 where organisation_id = :'org_blocked' and user_id = :'emate';
\o
select er.val('EM11 BLOCKED is back to two active owners for the erasure that follows',
  $$select count(*)::text from public.organisation_memberships
     where organisation_id = '$$ || :'org_blocked' || $$' and role = 'owner' and status = 'active'$$, '2');


-- ===========================================================================
-- EE  THE ERASURE ITSELF
-- ===========================================================================
-- THE DENOMINATOR FIRST. Every blocking reference planted in § EF is counted
-- HERE, by name, before anything is erased -- so each "0" below it means the
-- erasure moved a row rather than that no row was ever there.

select er.val('EE1 DENOMINATOR: audit_events.actor_user_id names the subject',
  $$select count(*)::text from public.audit_events where actor_user_id = '$$ || :'esub' || $$'$$, '2');
select er.val('EE1b DENOMINATOR: an audit row the subject ACTED on carries a payload',
  $$select count(*)::text from public.audit_events
     where actor_user_id = '$$ || :'esub' || $$' and before is not null$$, '1');
select er.val('EE2 DENOMINATOR: merges.merged_by names the subject',
  $$select count(*)::text from public.merges where merged_by = '$$ || :'esub' || $$'$$, '1');
select er.val('EE3 DENOMINATOR: merge_candidates.resolved_by names the subject',
  $$select count(*)::text from public.merge_candidates where resolved_by = '$$ || :'esub' || $$'$$, '1');
-- C1: the two columns in the same table that NO foreign key protects, so no
-- pg_constraint walk in the erasure can see them. EE26b/EE26c are the halves
-- that were measured naming an erased person before fix round 1.
select er.val('EE3b DENOMINATOR: merge_candidates.keep_owner_user_id names the subject',
  $$select count(*)::text from public.merge_candidates where keep_owner_user_id = '$$ || :'esub' || $$'$$, '1');
select er.val('EE3c DENOMINATOR: merge_candidates.duplicate_owner_user_id names the subject',
  $$select count(*)::text from public.merge_candidates where duplicate_owner_user_id = '$$ || :'esub' || $$'$$, '1');
select er.val('EE4 DENOMINATOR: all three impersonation_sessions columns name the subject',
  $$select (select count(*) from public.impersonation_sessions where superuser_user_id = '$$ || :'esub' || $$')::text
        || '/' || (select count(*) from public.impersonation_sessions where admin_accepted_by = '$$ || :'esub' || $$')::text
        || '/' || (select count(*) from public.impersonation_sessions where declined_by = '$$ || :'esub' || $$')::text$$,
  '2/1/1');
select er.val('EE5 DENOMINATOR: both overrides tables name the subject twice each',
  $$select (select count(*) from public.organisation_billing_overrides
             where granted_by = '$$ || :'esub' || $$' and revoked_by = '$$ || :'esub' || $$')::text
        || '/' ||
           (select count(*) from public.organisation_feature_overrides
             where granted_by = '$$ || :'esub' || $$' and revoked_by = '$$ || :'esub' || $$')::text$$,
  '1/1');
select er.val('EE6 DENOMINATOR: incident_alerts.resolved_by names the subject',
  $$select count(*)::text from public.incident_alerts where resolved_by = '$$ || :'esub' || $$'$$, '1');
select er.val('EE7 DENOMINATOR: the register and its note name the subject',
  $$select (select count(*) from public.data_subject_requests where user_id = '$$ || :'esub' || $$')::text
        || '/' ||
           (select count(*) from public.data_subject_request_notes where author_user_id = '$$ || :'esub' || $$')::text$$,
  '1/1');
select er.val('EE8 DENOMINATOR: the FK-LESS identifiers name the subject too',
  $$select (select count(*) from public.audit_events where target_id = '$$ || :'esub' || $$')::text || '/' ||
           (select count(*) from public.merges
             where winner_owner_user_id = '$$ || :'esub' || $$' or loser_owner_user_id = '$$ || :'esub' || $$')::text || '/' ||
           (select count(*) from public.incident_alerts
             where details::text like '%$$ || :'esub' || $$%')::text || '/' ||
           (select count(*) from public.rate_limit_counters where subject_id = '$$ || :'esub' || $$')::text$$,
  -- TWO counters: the one planted above and the one the subject's own data
  -- subject request spent. Both are keyed on a user id with no foreign key.
  '1/1/1/2');
select er.val('EE9 DENOMINATOR: the audit row that TARGETS the subject carries a payload',
  $$select (before is not null)::text from public.audit_events
     where action = 'erase.fixture.target'$$, 'true');

-- THE BYTES GATE. A stored object under a key the subject's own rows name is
-- planted, and the erasure must REFUSE while it is there.
\o /dev/null
select gen_random_uuid()::text as fb_id \gset
insert into public.feedback (id, user_id, user_email, organisation_id, organisation_role,
                             category, message, route, user_agent,
                             screenshot_key, screenshot_mime, screenshot_size_bytes,
                             screenshot_scan_status, screenshot_scanned_at)
values (:'fb_id', :'esub', 'erase-subject@test.local', :'org_blocked', 'owner',
        'bug', 'erasure fixture feedback', '/erasure', 'psql',
        'feedback/' || :'fb_id', 'image/png', 10, 'clean', pg_catalog.now());
insert into storage.objects (bucket_id, name, owner)
values ('feedback-screenshots', 'feedback/' || :'fb_id', null);
\o

select er.val('EE10 DENOMINATOR: the screenshot object is really in the bucket',
  $$select count(*)::text from storage.objects
     where bucket_id = 'feedback-screenshots' and name = 'feedback/$$ || :'fb_id' || $$'$$, '1');
select er.try_hint('EE11 the erasure REFUSES while a byte of the account is still stored',
  $$select private.erase_account('$$ || :'esub' || $$', null)$$,
  'denied(55000:bytes_not_purged)');
select er.val('EE12 and nothing moved -- the refusal is all-or-nothing like every other',
  $$select count(*)::text from public.audit_events where actor_user_id = '$$ || :'esub' || $$'$$, '2');

-- REMOVING IT NEEDS THE STORAGE API'S OWN GUARD STOOD DOWN, which is worth
-- saying rather than working around quietly: storage.protect_delete() refuses
-- a direct DELETE from storage.objects, and `postgres` is not even the owner
-- of that table, so the only lever is the session's replication role. That is
-- exactly why the erasure REFUSES to delete a row while its bytes are still
-- there instead of trying to delete the object itself in SQL -- the database
-- cannot, by design. EZ6 asserts the role is back at `origin`, and every
-- erasure in this suite runs after it is.
\o /dev/null
set session_replication_role = replica;
delete from storage.objects where bucket_id = 'feedback-screenshots' and name = 'feedback/' || :'fb_id';
set session_replication_role = default;
\o

-- `replica` IS REFUSED. Not a comment in a brief: a control.
set session_replication_role = replica;
select er.try_hint('EE13 the erasure REFUSES under session_replication_role = replica',
  $$select private.erase_account('$$ || :'esub' || $$', null)$$,
  'denied(55000:replication_role_must_be_origin)');
set session_replication_role = default;

-- THE REAL RUN, through the runner's own RPC so the whole path is exercised:
-- a claimed job, the interlock the register anonymisation requires, the seam,
-- and the outcome recorded in the same transaction.
\o /dev/null
set role authenticated;
set request.jwt.claims to :'esub_c';
insert into public.erasure_jobs (kind) values ('account');
reset role;
reset request.jwt.claims;
select id::text as job_id from public.erasure_jobs
 where subject_user_id = :'esub' and kind = 'account' \gset
\o

select er.val('EE14 the job was attributed to the session, not to anything the insert named',
  $$select (subject_user_id = '$$ || :'esub' || $$')::text || '/' ||
           (requested_by = '$$ || :'esub' || $$')::text || '/' || status
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, 'true/true/queued');
select er.val('EE15 and the ask was audited',
  $$select count(*)::text from public.audit_events
     where action = 'erasure_job.requested' and target_id = '$$ || :'job_id' || $$'$$, '1');

-- THE REGISTER ANONYMISATION IS INTERLOCKED ON A RUNNING JOB. Asked directly
-- of the trigger, from postgres, BEFORE the job is claimed -- so the refusal
-- is the interlock and not a missing privilege.
select er.try_hint('EE16 the register cannot be anonymised with no erasure in flight',
  $$update public.data_subject_requests
       set user_id = private.erased_user_id(), user_email = '[erased]', detail = '[erased]'
     where id = '$$ || :'dsr_id' || $$'$$,
  'denied(42501:no_erasure_in_flight)');
select er.try_hint('EE17 and the operator note cannot be re-pointed either',
  $$update public.data_subject_request_notes set author_user_id = private.erased_user_id()
     where author_user_id = '$$ || :'esub' || $$'$$,
  'denied(42501:note_is_append_only)');

-- A CLIENT SESSION cannot claim a job or run one.
set role authenticated;
set request.jwt.claims to :'esub_c';
select er.try('EE18 a client cannot claim a job',
  $$select public.claim_erasure_job()$$, 'denied(42501)');
select er.try('EE19 a client cannot run one',
  $$select public.run_erasure_job('$$ || :'job_id' || $$')$$, 'denied(42501)');
reset role;
reset request.jwt.claims;

\o /dev/null
select count(*) from public.claim_erasure_job();
\o

select er.val('EE20 the claim moved the job to running and stamped it',
  $$select status || '/' || (started_at is not null)::text
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, 'running/true');

\o /dev/null
select public.run_erasure_job(:'job_id') as erasure_summary \gset
\o

select er.val('EE21 THE ACCOUNT IS GONE',
  $$select count(*)::text from auth.users where id = '$$ || :'esub' || $$'$$, '0');
select er.val('EE22 the private note was HARD-DELETED, not left unreadable-but-stored',
  $$select count(*)::text from public.notes where id = '$$ || :'note_private' || $$'$$, '0');
select er.val('EE23 the COMPANY note survives, with its author nulled',
  $$select (owner_user_id is null)::text || '/' || body
      from public.notes where id = '$$ || :'note_company' || $$'$$, 'true/ERASURE COMPANY NOTE');
select er.val('EE24 audit_events.actor_user_id is the tombstone, and the rows are still there',
  $$select count(*)::text from public.audit_events
     where actor_user_id = private.erased_user_id()
       and action in ('erase.fixture.actor', 'erasure_job.requested')$$, '2');
-- M1: /legal/data-subject-rights v5 says "any description of the change is
-- dropped" for every entry of theirs. It was true of the rows that TARGETED
-- them and not of the rows they ACTED on.
select er.val('EE24b and the payload of the row the subject ACTED on is dropped (M1)',
  $$select (before is null and after is null)::text from public.audit_events
     where action = 'erase.fixture.actor'$$, 'true');
select er.val('EE25 merges.merged_by is the tombstone and the merge row survives',
  $$select (merged_by = private.erased_user_id())::text
      from public.merges where id = '$$ || :'merge_id' || $$'$$, 'true');
select er.val('EE26 merge_candidates.resolved_by is the tombstone',
  $$select count(*)::text from public.merge_candidates
     where resolved_by = private.erased_user_id()$$, '1');
-- C1. NULLED rather than tombstoned: the snapshot said who owned the record at
-- the moment of the merge, and "the erased user owned it" is not a fact about
-- anything. What matters is that the subject's uuid is not there.
select er.val('EE26b merge_candidates.keep_owner_user_id no longer names the subject',
  $$select count(*)::text from public.merge_candidates where keep_owner_user_id = '$$ || :'esub' || $$'$$, '0');
select er.val('EE26c merge_candidates.duplicate_owner_user_id no longer names the subject',
  $$select count(*)::text from public.merge_candidates where duplicate_owner_user_id = '$$ || :'esub' || $$'$$, '0');
select er.val('EE26d and the candidate row itself survives -- the workspace''s, not the member''s',
  $$select count(*)::text from public.merge_candidates
     where label = 'Erasure fixture candidate'$$, '1');
select er.val('EE27 all three impersonation_sessions columns are the tombstone',
  $$select (select count(*) from public.impersonation_sessions where superuser_user_id = private.erased_user_id())::text
        || '/' || (select count(*) from public.impersonation_sessions where admin_accepted_by = private.erased_user_id())::text
        || '/' || (select count(*) from public.impersonation_sessions where declined_by = private.erased_user_id())::text$$,
  '2/1/1');
select er.val('EE28 both overrides tables are the tombstone on both columns',
  $$select (select count(*) from public.organisation_billing_overrides
             where granted_by = private.erased_user_id() and revoked_by = private.erased_user_id())::text
        || '/' ||
           (select count(*) from public.organisation_feature_overrides
             where granted_by = private.erased_user_id() and revoked_by = private.erased_user_id())::text$$,
  '1/1');
select er.val('EE29 incident_alerts.resolved_by is the tombstone',
  $$select count(*)::text from public.incident_alerts
     where resolved_by = private.erased_user_id()$$, '1');
select er.val('EE30 NOT ONE reference to the account survives, over EVERY foreign key',
  $$select count(*)::text from public.audit_events where actor_user_id = '$$ || :'esub' || $$'$$, '0');

-- Q158: THE REGISTER SURVIVES, ANONYMISED.
select er.val('EE31 the register row is KEPT and re-pointed at the tombstone',
  $$select (user_id = private.erased_user_id())::text || '/' || user_email || '/' || detail
      from public.data_subject_requests where id = '$$ || :'dsr_id' || $$'$$,
  'true/[erased]/[erased]');
select er.val('EE32 and it still says what was asked, and when it was due',
  $$select right_type || '/' || subject_scope || '/' || (due_by is not null)::text
      from public.data_subject_requests where id = '$$ || :'dsr_id' || $$'$$,
  'erasure/account/true');
select er.val('EE33 the operator note is kept, re-pointed, with its body intact',
  $$select (author_user_id = private.erased_user_id())::text || '/' || body
      from public.data_subject_request_notes where request_id = '$$ || :'dsr_id' || $$'$$,
  'true/ERASURE FIXTURE OPERATOR NOTE');

-- THE FK-LESS IDENTIFIERS.
select er.val('EE34 the audit row that TARGETED the subject names the tombstone instead',
  $$select (target_id = private.erased_user_id())::text || '/' || (before is null)::text
      from public.audit_events where action = 'erase.fixture.target'$$, 'true/true');
select er.val('EE35 the merges owner-id SNAPSHOTS are gone -- no FK would have moved them',
  $$select (winner_owner_user_id is null)::text || '/' || (loser_owner_user_id is null)::text
      from public.merges where id = '$$ || :'merge_id' || $$'$$, 'true/true');
select er.val('EE36 the incident alert''s jsonb no longer carries the id, at any depth',
  $$select count(*)::text from public.incident_alerts
     where details::text like '%$$ || :'esub' || $$%'$$, '0');
select er.val('EE37 the subject''s rate-limit counters are gone',
  $$select count(*)::text from public.rate_limit_counters
     where subject_id = '$$ || :'esub' || $$'$$, '0');
select er.val('EE38 the feedback row went with the account, by its own cascade',
  $$select count(*)::text from public.feedback where id = '$$ || :'fb_id' || $$'$$, '0');
select er.val('EE39 the consent ledger went with it too (the shipped cascade, Q173)',
  $$select count(*)::text from public.consents where user_id = '$$ || :'esub' || $$'$$, '0');

-- Q131'S NARROW CASE.
select er.val('EE40 the EMPTY solo workspace went with the account',
  $$select count(*)::text from public.organisations where id = '$$ || :'org_solo' || $$'$$, '0');
select er.val('EE41 the workspace with other members and records DID NOT',
  $$select count(*)::text from public.organisations where id = '$$ || :'org_blocked' || $$'$$, '1');
select er.val('EE42 and its contact is untouched -- a member leaving is not the workspace''s erasure',
  $$select count(*)::text from public.contacts
     where organisation_id = '$$ || :'org_blocked' || $$'$$, '1');

-- THE JOB, THE SUMMARY AND THE AUDIT ROW.
select er.val('EE43 the job succeeded and its subject column went NULL by the foreign key',
  $$select status || '/' || (subject_user_id is null)::text || '/' || (requested_by is null)::text
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, 'succeeded/true/true');
select er.val('EE44 the summary is COUNTS, never content -- no string value anywhere in it',
  $$select (private.jsonb_is_count_map(summary))::text
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, 'true');
select er.val('EE45 and it records the private-note delete and the tombstoned references',
  $$select (summary->>'notes.private_deleted') || '/' || (summary->>'notes.company_kept')
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, '1/1');
select er.val('EE46 ONE summary audit row, actor = the tombstone, payload = the counts',
  $$select count(*)::text from public.audit_events
     where action = 'account.erased'
       and actor_user_id = private.erased_user_id()
       and target_id = '$$ || :'job_id' || $$'$$, '1');
select er.val('EE47 the summary audit row carries no free text',
  $$select (private.jsonb_is_count_map(after))::text from public.audit_events
     where action = 'account.erased' and target_id = '$$ || :'job_id' || $$'$$, 'true');

-- IDEMPOTENCE.
select er.val('EE48 running it again is NOT an error -- it says the account was already gone',
  $$select (private.erase_account('$$ || :'esub' || $$', null) ->> 'already_erased')$$, 'true');
select er.val('EE49 and the second run changed nothing',
  $$select count(*)::text from public.audit_events where action = 'account.erased'$$, '1');


-- ===========================================================================
-- EJ  A JOB'S PROGRESS IS THE RUNNER'S
-- ===========================================================================
-- Asked of the trigger DIRECTLY, as `postgres`, on the finished job -- not
-- through an RPC that carries its own guard. Task 3's mutation 3 found a hole
-- exactly there: a rule only ever asked through a guarded RPC cannot be seen.

select er.try_hint('EJ1 a FINISHED job is not rewritten, even by postgres',
  $$update public.erasure_jobs set status = 'failed', failure_reason = 'x'
     where id = '$$ || :'job_id' || $$'$$,
  'denied(22023:erasure_job_is_finished)');
select er.try_hint('EJ2 the request itself is immutable',
  $$update public.erasure_jobs set kind = 'workspace' where id = '$$ || :'job_id' || $$'$$,
  'denied(42501:erasure_request_is_immutable)');
select er.try_hint('EJ3 a job can never be re-pointed at another subject',
  $$update public.erasure_jobs set subject_user_id = '$$ || :'emate' || $$'
     where id = '$$ || :'job_id' || $$'$$,
  'denied(42501:erasure_subject_is_immutable)');
select er.val('EJ4 and none of that moved it',
  $$select status || '/' || kind || '/' || (subject_user_id is null)::text
      from public.erasure_jobs where id = '$$ || :'job_id' || $$'$$, 'succeeded/account/true');


-- ===========================================================================
-- EX  THE SECOND TENANT, COUNTED BEFORE AND AFTER
-- ===========================================================================

select er.val('EX1 organisation ALPHA is exactly as this suite found it',
  $$select (select count(*) from public.contacts  where organisation_id = '$$ || :'alpha_org' || $$')::text || '/' ||
           (select count(*) from public.notes     where organisation_id = '$$ || :'alpha_org' || $$')::text || '/' ||
           (select count(*) from public.organisation_memberships where organisation_id = '$$ || :'alpha_org' || $$')::text$$,
  :'alpha_before');
select er.val('EX2 and the colleague''s own account is untouched',
  $$select count(*)::text from auth.users where id = '$$ || :'emate' || $$'$$, '1');


-- ===========================================================================
-- ER  ALL-OR-NOTHING: A FORCED MID-SEQUENCE FAILURE ROLLS THE WHOLE THING BACK
-- ===========================================================================
-- A throwaway trigger on public.merges raises when the re-point walk reaches
-- it -- AFTER the private notes have been deleted and the register
-- anonymised. If the erasure were not one transaction, the bystander's
-- private note would be gone and his account would still exist.

\o /dev/null
insert into public.notes (organisation_id, owner_user_id, body, visibility)
values (:'org_purge', :'ebyst', 'ROLLBACK PRIVATE NOTE', 'private');
insert into public.merges
  (organisation_id, entity_type, winner_id, loser_id, merged_by, field_resolution)
values (:'org_purge', 'contact', gen_random_uuid(), gen_random_uuid(), :'ebyst',
        '{"email": "ROLLBACK-DISCARDED@example.com"}'::jsonb);
insert into public.custom_field_definitions (organisation_id, entity_type, key, label, field_type)
values (:'org_purge', 'contact', 'erasure_probe', 'Erasure probe', 'text');
\o

select er.val('ER1 DENOMINATOR: the bystander has a private note and a merge',
  $$select (select count(*) from public.notes where body = 'ROLLBACK PRIVATE NOTE')::text || '/' ||
           (select count(*) from public.merges where merged_by = '$$ || :'ebyst' || $$')::text$$, '1/1');

create function er.boom() returns trigger language plpgsql as $$
begin raise exception 'er.boom: forced mid-sequence failure' using errcode = 'P0001'; end $$;
create trigger er_boom before update on public.merges
  for each row execute function er.boom();

select er.try('ER2 the erasure fails when a step mid-sequence raises',
  $$select private.erase_account('$$ || :'ebyst' || $$', null)$$, 'denied(P0001)');

drop trigger er_boom on public.merges;
drop function er.boom();

select er.val('ER3 AND NOTHING WAS ERASED -- the private note is still there',
  $$select count(*)::text from public.notes where body = 'ROLLBACK PRIVATE NOTE'$$, '1');
select er.val('ER4 the account is still there',
  $$select count(*)::text from auth.users where id = '$$ || :'ebyst' || $$'$$, '1');
select er.val('ER5 and no summary audit row was written for it',
  $$select count(*)::text from public.audit_events where action = 'account.erased'$$, '1');


-- ===========================================================================
-- EO  THE WORKSPACE PURGE (Task 6's primitive)
-- ===========================================================================

\o /dev/null
select id::text as probe_field from public.custom_field_definitions
 where organisation_id = :'org_purge' and key = 'erasure_probe' \gset
select gen_random_uuid()::text as purge_contact \gset
insert into public.contacts (id, organisation_id, name) values (:'purge_contact', :'org_purge', 'Purge Contact');
insert into public.custom_field_values (organisation_id, field_id, entity_type, entity_id, value)
values (:'org_purge', :'probe_field', 'contact', :'purge_contact', '"probe"'::jsonb);
insert into public.documents (organisation_id, filename, storage_key, mime_type, size_bytes,
                              scan_status, scanned_at, deleted_at)
values (:'org_purge', 'purged.pdf', :'org_purge' || '/' || gen_random_uuid()::text,
        'application/pdf', 10, 'clean', pg_catalog.now(), pg_catalog.now());
select storage_key as doc_key from public.documents where organisation_id = :'org_purge' \gset
insert into storage.objects (bucket_id, name, owner) values ('documents', :'doc_key', null);
-- THE TWO WORKSPACE-BEARING COLUMNS NO FOREIGN KEY PROTECTS (fix round 1).
-- A feedback row of the bystander's that names this workspace as the one a
-- superuser was inside, and a rate-limit counter metered against the
-- workspace itself. Neither is reachable by the purge's pg_constraint walk.
insert into public.feedback (user_id, category, message, route, support_access_organisation_id)
values (:'ebyst', 'bug', 'erasure purge fixture', '/', :'org_purge');
insert into public.rate_limit_counters (category, subject_scope, subject_id, window_start, request_count)
values ('network_connection_request', 'organisation', :'org_purge', pg_catalog.date_trunc('hour', pg_catalog.now()), 1);
\o

select er.val('EO1 the seven entity types are read from the LIVE CHECK, not a list',
  $$select string_agg(t, ',' order by t) from private.custom_field_entity_types() t$$,
  'agency,artist,company,contact,event,financial_entry,venue');
select er.val('EO2 SEVEN, where the brief and the inventory both say six',
  $$select count(*)::text from private.custom_field_entity_types() t$$, '7');
select er.try_hint('EO3 the sweep REFUSES a type the CHECK does not allow, rather than deleting nothing',
  $$select private.sweep_custom_field_values('$$ || :'org_purge' || $$', 'not_an_entity', null)$$,
  'denied(22023:unknown_custom_field_entity_type)');

select er.val('EO4 DENOMINATOR: the polymorphic table holds a row for this workspace',
  $$select count(*)::text from public.custom_field_values
     where organisation_id = '$$ || :'org_purge' || $$'$$, '1');
select er.val('EO5 DENOMINATOR: merges.field_resolution holds the discarded record verbatim',
  $$select count(*)::text from public.merges
     where organisation_id = '$$ || :'org_purge' || $$'
       and field_resolution::text like '%ROLLBACK-DISCARDED%'$$, '1');
select er.val('EO5b DENOMINATOR: feedback names this workspace in a column with no foreign key',
  $$select count(*)::text from public.feedback
     where support_access_organisation_id = '$$ || :'org_purge' || $$'$$, '1');
select er.val('EO5c DENOMINATOR: a rate-limit counter is metered against this workspace',
  $$select count(*)::text from public.rate_limit_counters
     where subject_scope = 'organisation' and subject_id = '$$ || :'org_purge' || $$'$$, '1');
select er.val('EO6 DENOMINATOR: a SOFT-DELETED document still has its bytes (Q52)',
  $$select count(*)::text from storage.objects
     where bucket_id = 'documents' and name = '$$ || :'doc_key' || $$'$$, '1');

select er.try_hint('EO7 a LIVE workspace is not purged',
  $$select private.erase_organisation('$$ || :'org_purge' || $$', null, true)$$,
  'denied(22023:workspace_is_live)');

\o /dev/null
update public.organisations set deleted_at = pg_catalog.now(), lifecycle_state = 'deleted'
 where id = :'org_purge';
\o

select er.try_hint('EO8 and a closed one is not purged while its document bytes remain',
  $$select private.erase_organisation('$$ || :'org_purge' || $$', null, true)$$,
  'denied(55000:bytes_not_purged)');

set session_replication_role = replica;
select er.try_hint('EO9 the purge REFUSES under `replica` -- the shortcut is a CONTROL, not a comment',
  $$select private.erase_organisation('$$ || :'org_purge' || $$', null, true)$$,
  'denied(55000:replication_role_must_be_origin)');
set session_replication_role = default;

\o /dev/null
set session_replication_role = replica;
delete from storage.objects where bucket_id = 'documents' and name = :'doc_key';
set session_replication_role = default;
select private.erase_organisation(:'org_purge', null, true) as purge_summary \gset
\o

select er.val('EO10 the workspace is gone',
  $$select count(*)::text from public.organisations where id = '$$ || :'org_purge' || $$'$$, '0');
select er.val('EO11 the polymorphic rows went with it -- no orphan survives',
  $$select count(*)::text from public.custom_field_values
     where organisation_id = '$$ || :'org_purge' || $$'$$, '0');
select er.val('EO12 the sweep counted them PER TYPE, so a removed step is visible in the summary',
  $$select ('$$ || :'purge_summary' || $$'::jsonb ->> 'custom_field_values.contact')$$, '1');
select er.val('EO13 the merge scrub counted itself too',
  $$select ('$$ || :'purge_summary' || $$'::jsonb ->> 'merges.field_resolution')$$, '1');
-- EO14 IS NOT THE SCRUB'S PROOF, AND SAYING SO IS THE POINT. `merges` is
-- org-scoped with an ON DELETE CASCADE, so the discarded record's values
-- would be gone whether the scrub ran or not: deleting the scrub statement
-- leaves this assertion GREEN and reds EO13 alone (measured). EO14 is the
-- end-state check; EO13 is the step check. What the scrub actually buys is
-- the window between itself and the delete -- a backup or a replica taken
-- mid-transaction already has nothing in it -- and no assertion from outside
-- that transaction can observe it.
select er.val('EO14 the discarded record''s values are gone from the database entirely',
  $$select count(*)::text from public.merges where field_resolution::text like '%ROLLBACK-DISCARDED%'$$, '0');
select er.val('EO15 purging a workspace that is already gone is NOT an error',
  $$select private.erase_organisation('$$ || :'org_purge' || $$', null, true) ->> 'already_erased'$$, 'true');
select er.val('EO16 the bystander''s ACCOUNT survives a purge of his workspace',
  $$select count(*)::text from auth.users where id = '$$ || :'ebyst' || $$'$$, '1');

-- FIX ROUND 1. The workspace-bearing columns no foreign key protects, and the
-- summary row the purge never wrote (M2).
select er.val('EO17 feedback no longer names the purged workspace, and the row itself survives',
  $$select (select count(*) from public.feedback
             where support_access_organisation_id = '$$ || :'org_purge' || $$')::text
        || '/' || (select count(*) from public.feedback
                    where message = 'erasure purge fixture')::text$$, '0/1');
select er.val('EO18 and the workspace''s rate-limit counters went with it',
  $$select count(*)::text from public.rate_limit_counters
     where subject_scope = 'organisation' and subject_id = '$$ || :'org_purge' || $$'$$, '0');
select er.val('EO19 ONE summary audit row, counts only, actor = the tombstone (M2)',
  $$select (actor_user_id = private.erased_user_id())::text || '/' || target_type
      from public.audit_events
     where action = 'organisation.erased'
       and target_id = '$$ || :'org_purge' || $$'$$, 'true/organisation');
select er.val('EO20 and it says what was erased in COUNTS, never in content',
  $$select ((after ->> 'organisations') = '1'
            and (after ->> 'custom_field_values') is not null
            and after::text not like '%ROLLBACK-DISCARDED%')::text
      from public.audit_events
     where action = 'organisation.erased'
       and target_id = '$$ || :'org_purge' || $$'$$, 'true');


-- ===========================================================================
-- ES  THE FULFILMENT SEAM -- BOTH HALVES AWAKE, WITH A POSITIVE CONTROL
-- ===========================================================================

select er.val('ES1 BOTH halves of the predicate are now awake',
  $$select (private.dsr_fulfilment_job_ready('export'))::text || '/' ||
           (private.dsr_fulfilment_job_ready('erasure'))::text$$, 'true/true');
select er.val('ES2 and a right that has no job is still false',
  $$select (private.dsr_fulfilment_job_ready('rectification'))::text$$, 'false');
select er.val('ES3 the erasure recorded itself on the register row it answered',
  $$select fulfilment_kind || '/' || (fulfilment_reference = '$$ || :'job_id' || $$')::text
        || '/' || (fulfilment_recorded_at is not null)::text
      from public.data_subject_requests where id = '$$ || :'dsr_id' || $$'$$,
  'erasure/true/true');

-- AND SINCE FIX ROUND 1 (M6) THE ERASURE CLOSED IT ITSELF. Nothing else was
-- ever going to: the operator could, and nothing tells them to (Q45), so the
-- row stayed `open` and private.raise_dsr_deadline_alerts() re-raised
-- dsr_overdue for it weekly -- about a request that had been answered.
select er.val('ES4 the erasure CLOSED the request it answered, in its own transaction (M6)',
  $$select status || '/' || fulfilment_kind || '/' || (fulfilled_at is not null)::text
      from public.data_subject_requests where id = '$$ || :'dsr_id' || $$'$$,
  'fulfilled/erasure/true');

-- THE POSITIVE CONTROL THE SUITE HAS NEVER HAD (review I5c) now reads the
-- other way round: the closure is REAL, so the operator's own attempt to
-- close it again is refused as a closed request rather than admitted. A
-- constraint that refused everything would have reddened ES4.
set role authenticated;
set request.jwt.claims to :'super_c';
select er.try('ES4b and the operator is refused a second closure, because it is already closed',
  $$select public.transition_data_subject_request('$$ || :'dsr_id' || $$', 'fulfilled', null)$$,
  'denied(22023)');
reset role;
reset request.jwt.claims;


select er.val('ES5 and the request is closed, with its outcome still on it',
  $$select status || '/' || fulfilment_kind
      from public.data_subject_requests where id = '$$ || :'dsr_id' || $$'$$, 'fulfilled/erasure');

-- ...AND THE REFUSAL, on a request whose job has NOT run. Made by the
-- colleague, who is now an owner and whose account nothing has touched.
-- FILED BY THE BYSTANDER, not the colleague: by now the colleague is the last
-- owner of the workspace with records in it, so the Q131 guard would refuse
-- ES9 and the POSITIVE CONTROL would be measuring the guard instead of the
-- operator's permission. The bystander's workspace was purged in section EO,
-- so he owns nothing.
\o /dev/null
set role authenticated;
set request.jwt.claims to :'ebyst_c';
select count(*) from public.submit_data_subject_request(
  'erasure', 'account', 'ERASURE SEAM CONTROL: not yet run');
reset role;
reset request.jwt.claims;
select id::text as seam_dsr from public.data_subject_requests
 where detail = 'ERASURE SEAM CONTROL: not yet run' \gset
\o

set role authenticated;
set request.jwt.claims to :'super_c';
select er.try_hint('ES6 a request whose erasure has NOT run cannot be marked fulfilled',
  $$select public.transition_data_subject_request('$$ || :'seam_dsr' || $$', 'fulfilled', null)$$,
  'denied(22023:fulfilment_not_recorded)');
reset role;
reset request.jwt.claims;

-- AND THE BRANCH OPENS NOTHING. It applies only while the erasure job named
-- on the row is `running`; any other session of the same shape falls through
-- to the ordinary transition rules, which is why the operator's own closure
-- (ES6, and the export suite's XS1) still works and why this sessionless
-- direct write -- no auth.uid(), so not the operator -- is refused.
select er.try('ES4c a sessionless write cannot close a request with no erasure in flight',
  $$update public.data_subject_requests
       set status = 'fulfilled', fulfilment_kind = 'erasure',
           fulfilment_reference = gen_random_uuid()
     where id = '$$ || :'seam_dsr' || $$'$$, 'denied(42501)');

-- THE OPERATOR ON BEHALF (20260930005000). Bounded by data, not a flag.
set role authenticated;
set request.jwt.claims to :'emate_c';
select er.try('ES7 a non-operator cannot start an erasure for somebody else',
  $$select public.start_erasure_for_request('$$ || :'seam_dsr' || $$')$$, 'denied(42501)');
reset role;
reset request.jwt.claims;

set role authenticated;
set request.jwt.claims to :'super_c';
select er.try_hint('ES8 not even the operator, on a request that is already closed',
  $$select public.start_erasure_for_request('$$ || :'dsr_id' || $$')$$,
  'denied(22023:request_is_closed)');
select er.try('ES9 POSITIVE CONTROL: the operator CAN start one on an open erasure request',
  $$select public.start_erasure_for_request('$$ || :'seam_dsr' || $$')$$, 'ok(1)');
reset role;
reset request.jwt.claims;

select er.val('ES10 and the job it made names the REQUESTER, not the operator',
  $$select (subject_user_id = '$$ || :'ebyst' || $$')::text || '/' ||
           (requested_by = '$$ || :'super' || $$')::text
      from public.erasure_jobs where kind = 'account' and status = 'queued'$$, 'true/true');


-- ===========================================================================
-- EZ  HOUSEKEEPING
-- ===========================================================================
-- `session_replication_role = replica` for the register, the export suite's
-- own rule and for the same reason: NOTHING may delete a register row
-- (20260925001000), so a suite that made one cannot clean up without stepping
-- round the guard it just proved. It is set for those statements only, and
-- EZ6 asserts it is back -- which matters more in THIS suite than in any
-- other, because private.erase_account() and private.erase_organisation()
-- both REFUSE to run under it and every assertion above depends on them
-- having run at `origin`.
\o /dev/null
delete from public.erasure_jobs;
set session_replication_role = replica;
delete from public.audit_events
 where action in ('erasure_job.requested', 'account.erased', 'organisation.erased',
                  'erase.fixture.actor', 'erase.fixture.target')
    or (action like 'data_subject_request.%'
        and target_id in (select id from public.data_subject_requests));
delete from public.data_subject_request_notes;
delete from public.data_subject_requests;
set session_replication_role = default;
delete from public.incident_alerts where summary = 'erasure fixture alert';
delete from public.rate_limit_counters
 where category in ('account_erasure', 'data_subject_request', 'search')
   and subject_id in (select id from auth.users where email like 'erase-%@test.local');
delete from public.organisations where id in (:'org_blocked', :'org_solo', :'org_purge');
delete from auth.users where email like 'erase-%@test.local';
\o

select er.val('EZ1 no erasure jobs left behind',
  $$select count(*)::text from public.erasure_jobs$$, '0');
select er.val('EZ2 no data subject requests left behind',
  $$select count(*)::text from public.data_subject_requests$$, '0');
select er.val('EZ3 no throwaway workspaces left behind',
  $$select count(*)::text from public.organisations where slug like 'erasure-%'$$, '0');
select er.val('EZ4 no throwaway accounts left behind',
  $$select count(*)::text from auth.users where email like 'erase-%@test.local'$$, '0');
select er.val('EZ5 the audit log is back where this suite found it',
  $$select count(*)::text from public.audit_events$$, :'audit_before');
select er.val('EZ6 the guards are ENABLED again (replica mode was reset)',
  $$select current_setting('session_replication_role')$$, 'origin');
select er.val('EZ7 the TOMBSTONE is still there -- it outlives every erasure, this suite included',
  $$select count(*)::text from auth.users where id = private.erased_user_id()$$, '1');


-- ===========================================================================
-- REPORT
-- ===========================================================================
\echo ''
\echo '=== Phase 8 Task 5 (erasure) suite ==='
select seq, case when pass then 'PASS' else 'FAIL' end as result, label,
       case when pass then '' else 'expected ' || coalesce(expected,'<null>')
                                  || ', got ' || coalesce(actual,'<null>') end as detail
  from er.results order by seq;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
  from er.results;
