-- ===========================================================================
-- Phase 7 Task 2 (Impersonation) RLS suite -- THE BREAK-GLASS PROOF.
--
-- Covers 20260908020000_impersonation_sessions.sql:
--   the table + its state-machine CHECK and live-pair index
--   private.impersonated_organisations()          THE GRANT
--   public.has_permission / private.permitted_organisations /
--     private.full_scope_organisations             the three consumers
--   the two SELECT policies + organisations_select_impersonation_counterparty
--   the five RPCs (request / accept / decline / start / end) and the
--     page-view audit RPC
--
-- RUN IT WITH:  supabase/tests/run-rls-tests.sh
--   It runs AFTER network_leakage_phase6.sql and reuses the SAME fixtures
--   whole -- the twelve Phase 2 users, orgs ALPHA and BETA, and their CRM
--   rows. It creates ONLY impersonation_sessions rows (plus the audit_events
--   those produce), and § IZ asserts it leaves NO session row behind at all:
--   a live one would hand `super` view_crm over ALPHA for the whole of the
--   HTTP block below, which was written against a superuser who can read
--   audit_events and nothing else.
--
-- IT USES ITS OWN `imp` SCHEMA, so a Phase 7 failure is not reported under a
-- Phase 6 heading. The helpers are rls_phase6_network.sql's, verbatim, with
-- the schema renamed.
--
-- ===========================================================================
-- WHAT THIS FILE IS FOR
-- ===========================================================================
-- CLAUDE.md § Superuser dashboard makes impersonation the ONLY sanctioned
-- deep-access path in the product ("No direct tenant-data access outside
-- impersonation"). Everything else in this repository is tested to prove a
-- boundary HOLDS; this is the one feature tested to prove a boundary OPENS,
-- and opens exactly as far as it was supposed to and not one row further.
--
-- The claim under test has five independent parts, and this file drives each
-- of them both ways round:
--
--   CONSENT      no grant exists until the TARGET organisation's own admin
--                accepts -- not at 'requested', not at 'declined', and not
--                merely because the platform superuser asked.  (§ IG, § IR)
--   TIME-BOX     the grant evaluates `expires_at > now()` on every permission
--                check, so an expired session grants nothing even while its
--                status column still reads 'active'.                 (§ IG)
--   ENVELOPE     exactly the `read_only` role's key set -- reads, never
--                writes -- and read_only holds no `manage_` key, asserted
--                structurally so a future grant cannot widen this quietly.
--                                                              (§ IP, § IW)
--   SCOPE        one organisation. Impersonating ALPHA grants nothing in
--                BETA, and nothing platform-wide.                    (§ IX)
--   RECORD       every transition and every page reached is audited, on one
--                correlation thread, carrying no tenant record content.
--                                                                    (§ IA)
--
-- SECTIONS (every negative paired with a positive control, every count with a
-- denominator):
--   IF  fixtures and their sanity
--   IP  THE ENVELOPE, read out of the catalogue -- the structural guard
--   IR  the table's own RLS and the absence of a client write path
--   IG  THE GRANT LIFECYCLE: requested / accepted / active / expired
--   IW  writes refused throughout an ACTIVE session
--   IX  the scope boundary: ALPHA only, and nothing platform-wide
--   IM  the has_permission <-> permitted_organisations mirror, WITH a live
--       session (rls_phase2_crm.sql § M cannot see this branch: no session
--       exists when it runs)
--   ID  a DECLINED request grants nothing, ever
--   IE  either party may end a session; the org admin's revoke works
--   IS  the suspension consequence (Q98), measured rather than assumed
--   IA  the audit trail and its correlation thread
--   IZ  housekeeping: no session row left behind
--
-- EXPECTATION VOCABULARY (rls_phase2_crm.sql's, unchanged):
--   denied(42501)  REJECTED -- no grant, or a policy/guard refusal.
--   denied(23514)  rejected by a CHECK.
--   denied(23505)  rejected by a UNIQUE index.
--   ok(0)          ACCEPTED, matched no rows -- the USING clause filtered it.
--
-- psql vars required (supplied by run-rls-tests.sh's P7VARS): the twelve
--   Phase 2 users' claims as `<user>_c` / `<user>_c1`, plus `super`,
--   `super_c` (aal2) and `super_c1` (aal1).
-- ===========================================================================
\set ON_ERROR_STOP on
\pset pager off

drop schema if exists imp cascade;
create schema imp;

create table imp.results (
  seq serial primary key, label text, expected text, actual text, pass boolean
);

create function imp.record(p_label text, p_expected text, p_actual text)
returns void language sql security definer set search_path = '' as $$
  insert into imp.results (label, expected, actual, pass)
  values (p_label, p_expected, p_actual, p_expected is not distinct from p_actual);
$$;

create function imp.try(p_label text, p_sql text, p_expected text)
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
  perform imp.record(p_label, p_expected, v_actual);
end $$;

create function imp.val(p_label text, p_sql text, p_expected text)
returns void language plpgsql security invoker set search_path = 'pg_catalog, public' as $$
declare v_actual text;
begin
  begin
    execute p_sql into v_actual;
    v_actual := coalesce(v_actual, '<null>');
  exception when others then
    v_actual := 'denied(' || sqlstate || ')';
  end;
  perform imp.record(p_label, p_expected, v_actual);
end $$;

grant usage on schema imp to authenticated, anon, service_role;
grant execute on function imp.record(text,text,text) to authenticated, anon, service_role;
grant execute on function imp.try(text,text,text)    to authenticated, anon, service_role;
grant execute on function imp.val(text,text,text)    to authenticated, anon, service_role;

\o /dev/null

select id as alpha_org from public.organisations where slug='org-alpha' \gset
select id as beta_org  from public.organisations where slug='org-beta'  \gset

-- ===========================================================================
-- § IF  FIXTURES AND THEIR SANITY
--
-- EVERY ZERO BELOW IS ONLY MEANINGFUL IF THESE PASS. If `super` is not on the
-- allowlist, every refusal in this file is the allowlist refusing rather than
-- the feature working; if ALPHA has no contacts, "the impersonator can see
-- ALPHA's contacts" has no denominator to be measured against.
-- ===========================================================================
select imp.val('IF1 FIXTURE: `super` is on the platform_admins allowlist',
  format($$select count(*)::text from public.platform_admins where user_id=%L$$, :'super'), '1');

select imp.val('IF2 FIXTURE: `super` is a member of NO organisation (the whole premise)',
  format($$select count(*)::text from public.organisation_memberships where user_id=%L$$, :'super'), '0');

select imp.val('IF3 FIXTURE: ALPHA has contacts to be seen (the denominator)',
  format($$select (count(*) > 0)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), 'true');

select imp.val('IF4 FIXTURE: BETA has contacts too (the cross-tenant denominator)',
  format($$select (count(*) > 0)::text from public.contacts where organisation_id=%L$$, :'beta_org'), 'true');

select imp.val('IF5 FIXTURE: powner holds manage_organisation in ALPHA (can accept)',
  format($$select count(*)::text from public.organisation_memberships m
           join public.role_permissions rp on rp.role_key = m.role
           where m.user_id=%L and m.organisation_id=%L
             and rp.permission_key='manage_organisation'$$, :'powner', :'alpha_org'), '1');

select imp.val('IF6 FIXTURE: no impersonation session exists before this suite',
  $$select count(*)::text from public.impersonation_sessions$$, '0');

-- ===========================================================================
-- § IP  THE ENVELOPE, READ OUT OF THE CATALOGUE
--
-- private.impersonated_organisations() resolves its key set by joining
-- public.role_permissions for role_key = 'read_only' rather than listing keys
-- (20260908020000 § 3). That is the RIGHT design -- a hardcoded list silently
-- misses the next `view_*` key a phase adds -- and it has one failure mode
-- worth a standing guard: if anybody ever grants a WRITE key to `read_only`,
-- the impersonation envelope widens with it, silently, in a migration whose
-- diff says nothing about impersonation.
--
-- IP1 IS THAT GUARD. It is deliberately a statement about the CATALOGUE, not
-- about impersonation, so it stays true and stays checked no matter how this
-- feature is later refactored.
-- ===========================================================================
select imp.val('IP1 GUARD: `read_only` grants NO key beginning "manage_" (the envelope cannot widen quietly)',
  $$select count(*)::text from public.role_permissions
    where role_key='read_only' and permission_key like 'manage\_%'$$, '0');

select imp.val('IP2 GUARD: `read_only` grants NO key beginning "merge_"',
  $$select count(*)::text from public.role_permissions
    where role_key='read_only' and permission_key like 'merge\_%'$$, '0');

select imp.val('IP3 CONTROL: `read_only` DOES grant the read keys (so IP1/IP2 are not vacuous)',
  $$select string_agg(permission_key, ',' order by permission_key)
    from public.role_permissions where role_key='read_only'$$,
  'view_crm,view_network');

select imp.val('IP4 the time-box is 60 minutes (bound to IMPERSONATION_TIME_BOX_MINUTES by the matches-db test)',
  $$select extract(epoch from private.impersonation_time_box())::bigint::text$$, '3600');

-- ===========================================================================
-- § IR  THE TABLE'S OWN RLS, AND THE ABSENCE OF A CLIENT WRITE PATH
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';

select public.request_impersonation('org-alpha', 'ticket 9001: customer reports a missing event') as s1 \gset

select imp.val('IR0 CONTROL: the request created exactly one row, visible to its superuser',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s1'), '1');

select imp.try('IR1 a SECOND live request for the same organisation is refused (live-pair index)',
  $$select public.request_impersonation('org-alpha', 'a second, overlapping request')$$,
  'denied(23505)');

select imp.try('IR2 the superuser cannot INSERT a session row directly (no write grant, no policy)',
  format($$insert into public.impersonation_sessions
             (superuser_user_id, target_organisation_id, reason, status)
           values (%L, %L, 'self-granted', 'active')$$, :'super', :'alpha_org'),
  'denied(42501)');

select imp.try('IR3 the superuser cannot UPDATE their own session to `active` directly',
  format($$update public.impersonation_sessions set status='active' where id=%L$$, :'s1'),
  'denied(42501)');

select imp.try('IR4 the superuser cannot DELETE a session (the record is not theirs to erase)',
  format($$delete from public.impersonation_sessions where id=%L$$, :'s1'),
  'denied(42501)');

select imp.try('IR5 the superuser cannot accept their OWN request (no unilateral impersonation)',
  format($$select public.accept_impersonation_request(%L)$$, :'s1'), 'denied(42501)');

reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pbowner_c';

select imp.val('IR6 BETA''s owner cannot SEE ALPHA''s impersonation request',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s1'), '0');

select imp.try('IR7 BETA''s owner cannot ACCEPT ALPHA''s impersonation request',
  format($$select public.accept_impersonation_request(%L)$$, :'s1'), 'denied(42501)');

select imp.try('IR8 BETA''s owner cannot DECLINE it either (a foreign refusal is still a foreign write)',
  format($$select public.decline_impersonation_request(%L)$$, :'s1'), 'denied(42501)');

reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'pmanager_c';

select imp.val('IR9 an ALPHA MANAGER (no manage_organisation) cannot see the request',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s1'), '0');

select imp.try('IR10 an ALPHA MANAGER cannot accept it',
  format($$select public.accept_impersonation_request(%L)$$, :'s1'), 'denied(42501)');

reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';

select imp.val('IR11 CONTROL: ALPHA''s OWNER can see the request (so IR6/IR9''s zeros are the boundary)',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s1'), '1');

select imp.val('IR12 CONTROL: ALPHA''s owner reads the REASON they are being asked to judge',
  format($$select reason from public.impersonation_sessions where id=%L$$, :'s1'),
  'ticket 9001: customer reports a missing event');

-- ===========================================================================
-- § IG  THE GRANT LIFECYCLE
--
-- The same three measurements at four points in the session's life: does the
-- superuser hold view_crm over ALPHA, can they read ALPHA's contacts, and can
-- they read ALPHA's organisations row. All three must move together, and all
-- three must be FALSE/0 everywhere except while the session is genuinely live.
-- ===========================================================================
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';

select imp.val('IG1 REQUESTED: no view_crm over ALPHA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select imp.val('IG2 REQUESTED: reads 0 ALPHA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');
select imp.val('IG3 REQUESTED: cannot even read ALPHA''s organisations row... ',
  format($$select count(*)::text from public.organisations where id=%L$$, :'alpha_org'), '1');
-- ^ 1, NOT 0, AND THAT IS THE DESIGNED ANSWER, NOT A LEAK. The counterparty
--   policy (organisations_select_impersonation_counterparty) is deliberately
--   keyed on having a session ROW at any status, so the superuser's own
--   /super/impersonation list can name the workspace it is showing. It is
--   metadata (id/name/slug/timestamps), which CLAUDE.md § Superuser dashboard
--   explicitly permits the dashboard to show. IG2 is the assertion that
--   matters: metadata, and not one record.

-- The admin accepts.
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select public.accept_impersonation_request(:'s1'::uuid);
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';

select imp.val('IG4 ACCEPTED: STILL no view_crm -- acceptance is not a session',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select imp.val('IG5 ACCEPTED: STILL reads 0 ALPHA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');

select public.start_impersonation_session(:'s1'::uuid) as s1_expires \gset

select imp.val('IG6 ACTIVE: view_crm over ALPHA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'true');
select imp.val('IG7 ACTIVE: view_network over ALPHA (the envelope''s second key)',
  format($$select public.has_permission(%L,'view_network')::text$$, :'alpha_org'), 'true');
select imp.val('IG8 ACTIVE: reads ALPHA''s contacts -- the whole point of the feature',
  format($$select (count(*) > 0)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), 'true');
select imp.val('IG9 ACTIVE: FULL record scope -- reads contacts owned by OTHER people (Q97)',
  format($$select (count(*) > 0)::text from public.contacts
           where organisation_id=%L and owner_user_id is distinct from %L$$, :'alpha_org', :'super'), 'true');
select imp.val('IG10 ACTIVE: reads ALPHA''s events too (the grant is the key set, not one table)',
  format($$select (count(*) > 0)::text from public.events where organisation_id=%L$$, :'alpha_org'), 'true');
-- ===========================================================================
-- IG10b/IG10c: WHY THE ENTITLEMENT LAYER RESOLVES DURING IMPERSONATION, AND
-- WHY NO NEW POLICY WAS ADDED FOR IT -- MEASURED, NOT REASONED
-- ===========================================================================
-- lib/entitlements reads public.organisation_subscriptions through the
-- CALLER's own RLS, and that table's member policy is
-- private.is_active_member() -- which an impersonating superuser is not. The
-- first cut of this task therefore added an impersonation SELECT policy to
-- that table, on the argument that without it every impersonated workspace
-- would resolve to FREE: no finance panel, and every blocked write control
-- blaming the customer's billing rather than the read-only envelope.
--
-- THE ARGUMENT WAS RIGHT AND THE PREMISE WAS FALSE, and this pair of
-- assertions is what caught it. `organisation_subscriptions_select_platform_
-- billing` has existed since Foundation and reads
-- has_platform_permission(...) -- allowlist plus aal2, organisation-
-- independent -- so the platform superuser could ALREADY read every
-- organisation's subscription row, impersonating or not. The extra policy
-- granted nothing and was deleted rather than shipped as a second way to
-- reach a row that was already reachable.
--
-- IG10c is the load-bearing half: it proves the read is the PLATFORM policy
-- and not the impersonation grant, by measuring it against an organisation
-- the superuser has NO session over at all.
select imp.val('IG10b ACTIVE: the subscription read the entitlement layer needs resolves (via the PLATFORM billing policy, not this feature)',
  format($$select count(*)::text from public.organisation_subscriptions where organisation_id=%L$$, :'beta_org'), '1');

-- THE ENVELOPE, MEASURED KEY BY KEY. Every one of these is a WRITE key, and
-- every one must be false for the whole session.
select imp.val('IG11 ACTIVE: NO manage_contacts',
  format($$select public.has_permission(%L,'manage_contacts')::text$$, :'alpha_org'), 'false');
select imp.val('IG12 ACTIVE: NO manage_events',
  format($$select public.has_permission(%L,'manage_events')::text$$, :'alpha_org'), 'false');
select imp.val('IG13 ACTIVE: NO manage_members',
  format($$select public.has_permission(%L,'manage_members')::text$$, :'alpha_org'), 'false');
select imp.val('IG14 ACTIVE: NO manage_organisation -- support access cannot extend itself',
  format($$select public.has_permission(%L,'manage_organisation')::text$$, :'alpha_org'), 'false');
select imp.val('IG15 ACTIVE: NO manage_network_profile',
  format($$select public.has_permission(%L,'manage_network_profile')::text$$, :'alpha_org'), 'false');
select imp.val('IG16 ACTIVE: NO merge_records',
  format($$select public.has_permission(%L,'merge_records')::text$$, :'alpha_org'), 'false');
select imp.val('IG17 ACTIVE: a nonexistent key is still false (fail-closed, not "any key while active")',
  format($$select public.has_permission(%L,'no_such_permission')::text$$, :'alpha_org'), 'false');

-- ===========================================================================
-- IG20-IG22: THE BLAST RADIUS OF THE Q97 WIDENING, MEASURED (fix round 1,
-- Minor 7)
-- ===========================================================================
-- IG8/IG9 prove full record scope WORKS (the impersonator reads rows they do
-- not own, which is the whole point of Q97). They do not prove it stopped
-- where it was supposed to. Full scope relaxes the OWNER half of
-- `org_id in (permitted) and (full_scope or owner_user_id = auth.uid())`, so
-- the question worth asking is: which read did the product gate on OWNERSHIP
-- rather than on a permission key, and did widening scope open it?
--
-- There is exactly one, and IG20 is it. `notes_select_by_visibility`
-- (20260902011000) deliberately carries NO full_scope term -- a `private`
-- note reaches its author and nobody else, whatever their role -- so an
-- impersonating superuser must not read one either. That holds today by a
-- property of a PHASE 4 policy, not by anything this feature does, which is
-- precisely why it is worth pinning here: a later edit that "tidies up" that
-- policy by giving it the same full_scope shape as its siblings would widen
-- impersonation as a side effect, in a diff that never mentions it.
--
-- IG21 is the second gate that is a KEY rather than scope (view_finance,
-- which read_only does not hold), and IG22 is the positive control that
-- keeps both zeros honest -- documents ARE readable, on view_crm, so the two
-- zeros above are the specific gates and not a blanket refusal.
select imp.val('IG20 ACTIVE: full scope does NOT open another user''s PRIVATE note (Q97''s one real risk)',
  format($$select count(*)::text from public.notes
           where organisation_id=%L and visibility='private'$$, :'alpha_org'), '0');
select imp.val('IG21 ACTIVE: reads 0 financial_entries -- view_finance is not in the envelope',
  format($$select count(*)::text from public.financial_entries where organisation_id=%L$$, :'alpha_org'), '0');
select imp.val('IG22 CONTROL: documents ARE readable (view_crm), so IG20/IG21 are gates, not a blanket refusal',
  format($$select (count(*) > 0)::text from public.documents where organisation_id=%L$$, :'alpha_org'), 'true');
select imp.val('IG23 CONTROL: COMPANY-visibility notes ARE readable, so IG20 is the visibility term',
  format($$select (count(*) > 0)::text from public.notes
           where organisation_id=%L and visibility='company'$$, :'alpha_org'), 'true');

-- THE DENOMINATORS FOR IG20 AND IG21, READ AS POSTGRES. Without these, both
-- zeros above are equally well explained by "there is nothing there" --
-- Constraint 14's rule, and the reason every negative in this file is paired.
reset role; reset request.jwt.claims;
select imp.val('IG20b DENOMINATOR: a PRIVATE note really does exist in ALPHA, owned by somebody other than the superuser',
  format($$select (count(*) > 0)::text from public.notes
           where organisation_id=%L and visibility='private' and owner_user_id is distinct from %L$$,
         :'alpha_org', :'super'), 'true');
select imp.val('IG21b DENOMINATOR: ALPHA really does have financial_entries',
  format($$select (count(*) > 0)::text from public.financial_entries where organisation_id=%L$$, :'alpha_org'), 'true');
set role authenticated;
set request.jwt.claims = :'super_c';

-- AN aal1 SESSION HOLDS NOTHING. The same claim set, one assurance level down
-- -- a stolen password with no second factor -- must grant nothing at all,
-- because private.impersonated_organisations() carries
-- has_platform_permission(), which is aal2-gated.
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c1';
select imp.val('IG18 ACTIVE but aal1: NO view_crm (the MFA gate composes with the grant)',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select imp.val('IG19 ACTIVE but aal1: reads 0 ALPHA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');

-- ===========================================================================
-- § IW  WRITES ARE REFUSED THROUGHOUT AN ACTIVE SESSION
--
-- IG11-IG16 measured the KEYS. These measure the POLICIES, which is a
-- different claim: a key the caller does not hold is only a refusal if the
-- policies actually consult it.
--
-- INSERT is a loud 42501 (an INSERT has only WITH CHECK). UPDATE and DELETE
-- are `ok(0)` -- accepted, matched no rows, because the USING clause filtered
-- every row out. That distinction is lib/crm/write.ts's whole reason for
-- existing and rls_phase2_crm.sql documents it at length; asserting the wrong
-- one here would hide a real hole behind a green test.
-- ===========================================================================
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';

select imp.try('IW1 ACTIVE: cannot INSERT a contact into ALPHA',
  format($$insert into public.contacts (organisation_id, name, owner_user_id)
           values (%L, 'Impersonator Wrote This', %L)$$, :'alpha_org', :'super'),
  'denied(42501)');

select imp.try('IW2 ACTIVE: cannot UPDATE an ALPHA contact (filtered, not refused -- ok(0))',
  format($$update public.contacts set name='Rewritten' where organisation_id=%L$$, :'alpha_org'),
  'ok(0)');

-- denied(42501), NOT ok(0), AND THE DIFFERENCE IS MEASURED RATHER THAN
-- GUESSED: public.contacts has NO delete policy and NO DELETE grant to
-- `authenticated` at all (verified in pg_policies/role_table_grants -- only
-- select/insert/update are granted). A hard DELETE is refused for EVERY
-- client, member and impersonator alike, before RLS is consulted; soft-delete
-- is an UPDATE, which IW2 already covers. Written as the stronger expectation
-- so that if a later phase ever adds a DELETE grant, this goes red and is
-- re-read rather than silently downgrading to a filtered no-op.
select imp.try('IW3 ACTIVE: cannot DELETE an ALPHA contact (no grant at all, not merely filtered)',
  format($$delete from public.contacts where organisation_id=%L$$, :'alpha_org'),
  'denied(42501)');

select imp.try('IW4 ACTIVE: cannot INSERT an ALPHA event',
  format($$insert into public.events (organisation_id, name, starts_at, owner_user_id)
           values (%L, 'Impersonator Event', now(), %L)$$, :'alpha_org', :'super'),
  'denied(42501)');

select imp.try('IW5 ACTIVE: cannot INSERT a membership into ALPHA (the privilege-escalation move)',
  format($$insert into public.organisation_memberships (organisation_id, user_id, role, status)
           values (%L, %L, 'owner', 'active')$$, :'alpha_org', :'super'),
  'denied(42501)');

select imp.try('IW6 ACTIVE: cannot RENAME ALPHA',
  format($$update public.organisations set name='Owned' where id=%L$$, :'alpha_org'),
  'ok(0)');

select imp.try('IW7 ACTIVE: cannot UN-SUSPEND or SUSPEND ALPHA',
  format($$update public.organisations set deleted_at=now() where id=%L$$, :'alpha_org'),
  'ok(0)');

select imp.val('IW8 CONTROL: the contacts IW2 tried to rewrite are unchanged',
  format($$select count(*)::text from public.contacts
           where organisation_id=%L and name='Rewritten'$$, :'alpha_org'), '0');

-- ===========================================================================
-- § IX  THE SCOPE BOUNDARY
--
-- One organisation, for one window. Everything below is measured DURING the
-- live ALPHA session, which is the only time these zeros are interesting.
-- ===========================================================================
select imp.val('IX1 an ALPHA session grants NO view_crm over BETA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'beta_org'), 'false');
select imp.val('IX2 an ALPHA session reads 0 BETA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'beta_org'), '0');
select imp.val('IX3 an ALPHA session reads 0 BETA events',
  format($$select count(*)::text from public.events where organisation_id=%L$$, :'beta_org'), '0');
-- IX4, RE-MEASURED FOR PHASE 7 TASK 3 (20260908030000). It expected 0 and now
-- expects 1, and NOTHING ABOUT IMPERSONATION CHANGED: the superuser gained
-- organisations_select_platform_lifecycle, a permissive SELECT policy that
-- gives them every organisation's row -- id, name, slug, timestamps, lifecycle
-- state -- because Postgres applies SELECT policies to an UPDATE's row
-- matching, so without it every suspend and reinstate would match zero rows
-- and report success (the trap 20260826154304 documents on
-- organisation_subscriptions_select_platform_billing).
--
-- THE SCOPE CLAIM THIS SECTION MAKES IS UNAFFECTED, and IX1/IX2/IX3 above are
-- where it lives: an ALPHA session grants no permission over BETA and reads
-- none of BETA's records. What is now readable is the tenant's NAME, not the
-- tenant's DATA -- which CLAUDE.md § Superuser dashboard permits in as many
-- words ("only aggregate metadata"), and which the superuser could already
-- half-see through the billing policy on organisation_subscriptions.
select imp.val('IX4 MEASURED (Task 3): the superuser reads BETA''s organisations ROW -- metadata, not records',
  format($$select count(*)::text from public.organisations where id=%L$$, :'beta_org'), '1');
select imp.val('IX4b ...and it is the LIFECYCLE policy doing it, not anything about the session',
  $$select count(*)::text from pg_policies
     where schemaname='public' and tablename='organisations'
       and policyname='organisations_select_platform_lifecycle'$$, '1');
-- IG10c, PLACED HERE BECAUSE IT IS A SCOPE MEASUREMENT: the subscription row
-- the entitlement layer reads is reachable for an organisation this session
-- does NOT cover, which is what proves IG10b is the pre-existing platform
-- billing policy rather than anything this task added. It is not a leak this
-- feature opened -- CLAUDE.md § Superuser dashboard explicitly permits the
-- operator aggregate metadata (seats, plan, usage) outside impersonation --
-- but it IS the reason no impersonation policy on that table was needed, and
-- a future reader deserves to see it measured rather than argued.
select imp.val('IG10c the same read succeeds for an org with NO session at all -- so IG10b is the platform policy',
  format($$select count(*)::text from public.organisation_subscriptions where organisation_id=%L$$, :'beta_org'), '1');
select imp.val('IX4b CONTRAST: the same caller reads 0 BETA CONTACTS -- metadata is not records',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'beta_org'), '0');
select imp.val('IX5 has_permission(NULL, ...) is still FALSE, never NULL, with a session live',
  $$select coalesce(public.has_permission(null,'view_crm')::text, 'NULL LEAKED')$$, 'false');
select imp.val('IX6 the unfiltered contact read returns ONLY ALPHA''s rows',
  format($$select count(*)::text from public.contacts where organisation_id <> %L$$, :'alpha_org'), '0');

-- ===========================================================================
-- § IM  THE MIRROR, WITH A LIVE SESSION
--
-- rls_phase2_crm.sql § M1 sweeps has_permission against
-- permitted_organisations for every user x aal x org x key -- and CANNOT SEE
-- THIS BRANCH, because no impersonation session exists at the point it runs.
-- A one-sided implementation (the disjunct added to has_permission and not to
-- permitted_organisations, or vice versa) would leave M1 green and produce a
-- product where the UI renders a workspace whose every list policy returns
-- nothing, or the reverse.
--
-- So the sweep runs again HERE, with the session live. Run as postgres with
-- request.jwt.claims set, which is legitimate for the same reason M1 gives:
-- the thing under test is whether two expressions AGREE over the same
-- auth.uid(), and both pin the caller in their own WHERE clause.
--
-- IM2 adds the THIRD consumer, private.full_scope_organisations(), which M1
-- does not cover at all: record scope is a separate narrower and Q97 put the
-- impersonation branch in it too.
-- ===========================================================================
reset role; reset request.jwt.claims;

do $$
declare
  u record; o record; a text; k text;
  v_scalar boolean; v_set boolean; n int := 0; bad int := 0;
begin
  for u in select id from auth.users loop
    foreach a in array array['aal1','aal2'] loop
      perform pg_catalog.set_config('request.jwt.claims',
        pg_catalog.json_build_object('sub', u.id, 'role', 'authenticated', 'aal', a)::text,
        true);
      for o in select id from public.organisations loop
        foreach k in array array[
          'view_crm','view_network','manage_contacts','manage_events',
          'manage_members','manage_organisation','merge_records',
          'no_such_permission'] loop
          v_scalar := public.has_permission(o.id, k);
          v_set    := exists (select 1 from private.permitted_organisations(k) x where x = o.id);
          n := n + 1;
          if v_scalar is distinct from v_set then bad := bad + 1; end if;
        end loop;
      end loop;
    end loop;
  end loop;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform imp.record(
    'IM1 has_permission(org,k) == org IN permitted_organisations(k) WITH A LIVE SESSION, ' || n || ' triples',
    '0 mismatches', bad || ' mismatches');
end $$;

do $$
declare v_alpha uuid; v_full boolean;
begin
  select id into v_alpha from public.organisations where slug='org-alpha';
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', (select superuser_user_id from public.impersonation_sessions
                                         where status='active' limit 1),
                                 'role','authenticated','aal','aal2')::text, true);
  v_full := exists (select 1 from private.full_scope_organisations() x where x = v_alpha);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform imp.record(
    'IM2 the impersonated organisation is in full_scope_organisations() (Q97 -- otherwise every list is empty)',
    'true', v_full::text);
end $$;

-- ===========================================================================
-- § ID  A DECLINED REQUEST GRANTS NOTHING, EVER
--
-- Uses BETA and a SECOND session, so ALPHA's live one is undisturbed.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select public.request_impersonation('org-beta', 'ticket 9002: billing question') as s2 \gset
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select public.decline_impersonation_request(:'s2'::uuid);
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select imp.val('ID1 DECLINED: no view_crm over BETA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'beta_org'), 'false');
select imp.val('ID2 DECLINED: reads 0 BETA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'beta_org'), '0');
select imp.try('ID3 DECLINED: cannot be started -- the refusal is terminal',
  format($$select public.start_impersonation_session(%L)$$, :'s2'), 'denied(42501)');
select imp.try('ID4 DECLINED: the row is immutable to its own superuser',
  format($$update public.impersonation_sessions set status='accepted' where id=%L$$, :'s2'),
  'denied(42501)');
select imp.try('ID5 DECLINED: a declined pair no longer blocks a fresh request (re-requestable)',
  $$select public.request_impersonation('org-beta', 'ticket 9002 again, with more detail')$$,
  'ok(1)');
select imp.val('ID6 CONTROL: the fresh BETA request is `requested`, and still grants nothing',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'beta_org'), 'false');

-- ===========================================================================
-- § IA  THE AUDIT TRAIL
--
-- The brief: request, accept/decline, start, every impersonated page access
-- (route only, no content), early end, expiry -- all audited with the real
-- actor, the org, reason, and correlation across the session.
-- ===========================================================================
set role authenticated;
set request.jwt.claims = :'super_c';
select imp.try('IA0 the page-view RPC records a route while the session is live',
  format($$select public.audit_impersonated_page_view(%L, '/org-alpha/contacts')$$, :'alpha_org'),
  'ok(1)');
select imp.try('IA0b the page-view RPC REFUSES for an organisation with no live session (BETA)',
  format($$select public.audit_impersonated_page_view(%L, '/org-beta/contacts')$$, :'beta_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pmanager_c';
select imp.try('IA0c a NON-superuser cannot mint a page-view audit row at all',
  format($$select public.audit_impersonated_page_view(%L, '/org-alpha/contacts')$$, :'alpha_org'),
  'denied(42501)');
reset role; reset request.jwt.claims;

select imp.val('IA1 the ALPHA session''s events, in order, on ONE correlation thread',
  format($$select string_agg(action, ',' order by created_at, id)
           from public.audit_events where correlation_id = %L$$, :'s1'),
  'impersonation.requested,impersonation.accepted,impersonation.started,impersonation.page_viewed');

select imp.val('IA2 every one of them carries the TARGET organisation',
  format($$select count(*)::text from public.audit_events
           where correlation_id = %L and organisation_id is distinct from %L$$, :'s1', :'alpha_org'), '0');

select imp.val('IA3 the request row records the REASON verbatim (it outlives the session row)',
  format($$select after->>'reason' from public.audit_events
           where correlation_id = %L and action='impersonation.requested'$$, :'s1'),
  'ticket 9001: customer reports a missing event');

select imp.val('IA4 the ACCEPT is attributed to the ADMIN who gave consent, not to the superuser',
  format($$select (actor_user_id = %L)::text from public.audit_events
           where correlation_id = %L and action='impersonation.accepted'$$, :'powner', :'s1'), 'true');

select imp.val('IA5 the REQUEST/START are attributed to the superuser (the REAL actor, never a borrowed identity)',
  format($$select count(*)::text from public.audit_events
           where correlation_id = %L and action in ('impersonation.requested','impersonation.started')
             and actor_user_id <> %L$$, :'s1', :'super'), '0');

select imp.val('IA6 the page-view row carries the ROUTE and NOTHING ELSE (no content, no count, no rows)',
  format($$select string_agg(k, ',' order by k) from public.audit_events e,
           lateral jsonb_object_keys(e.after) k
           where e.correlation_id = %L and e.action='impersonation.page_viewed'$$, :'s1'),
  'route');

select imp.val('IA7 the route recorded is the one that was reached',
  format($$select after->>'route' from public.audit_events
           where correlation_id = %L and action='impersonation.page_viewed'$$, :'s1'),
  '/org-alpha/contacts');

select imp.val('IA8 the DECLINE was audited on its own thread',
  format($$select string_agg(action, ',' order by created_at, id)
           from public.audit_events where correlation_id = %L$$, :'s2'),
  'impersonation.requested,impersonation.declined');

set role authenticated;
set request.jwt.claims = :'powner_c';
select imp.val('IA9 the trail is NOT tenant data: the impersonated organisation''s own OWNER reads 0 of its rows',
  format($$select count(*)::text from public.audit_events where correlation_id = %L$$, :'s1'), '0');
reset role; reset request.jwt.claims;
select imp.val('IA10 CONTROL: as postgres the same thread is non-empty (so IA9''s zero is the policy, not an empty table)',
  format($$select (count(*) > 0)::text from public.audit_events where correlation_id = %L$$, :'s1'), 'true');

-- ===========================================================================
-- § IE  EITHER PARTY MAY END IT, AND EXPIRY GRANTS NOTHING
-- ===========================================================================
-- First: expiry. Wind the clock back on the live ALPHA session and re-measure
-- everything IG6-IG10 measured. THE STATUS COLUMN STILL READS 'active'
-- throughout -- that is the point of the assertion, and the reason the grant
-- reads expires_at rather than status.
update public.impersonation_sessions set expires_at = pg_catalog.now() - interval '1 second'
where id = :'s1'::uuid;

select imp.val('IE1 the expired session''s STATUS still says `active` (so IE2-IE4 are the clock, not the column)',
  format($$select status from public.impersonation_sessions where id=%L$$, :'s1'), 'active');

set role authenticated;
set request.jwt.claims = :'super_c';
select imp.val('IE2 EXPIRED: no view_crm over ALPHA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select imp.val('IE3 EXPIRED: reads 0 ALPHA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');
select imp.val('IE4 EXPIRED: no full record scope either',
  format($$select count(*)::text from public.events where organisation_id=%L$$, :'alpha_org'), '0');
select imp.try('IE5 EXPIRED: the page-view RPC refuses -- an expired session cannot even be audited into life',
  format($$select public.audit_impersonated_page_view(%L, '/org-alpha/events')$$, :'alpha_org'),
  'denied(42501)');
select imp.val('IE6 ending an expired session records it as EXPIRED, not as a deliberate end',
  format($$select public.end_impersonation_session(%L)$$, :'s1'), 'expired');
reset role; reset request.jwt.claims;

select imp.val('IE7 the expiry is audited on the same thread',
  format($$select string_agg(action, ',' order by created_at, id)
           from public.audit_events where correlation_id = %L$$, :'s1'),
  'impersonation.requested,impersonation.accepted,impersonation.started,impersonation.page_viewed,impersonation.expired');

-- Then: the ORG ADMIN's revoke, on a fresh, genuinely live session.
set role authenticated;
set request.jwt.claims = :'super_c';
select public.request_impersonation('org-alpha', 'ticket 9004: revocation test') as s4 \gset
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'powner_c';
select public.accept_impersonation_request(:'s4'::uuid);
reset role; reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = :'super_c';
select public.start_impersonation_session(:'s4'::uuid);
select imp.val('IE8 CONTROL: the fresh session is live (so IE10''s zero is the revoke)',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'pbowner_c';
select imp.try('IE9 a FOREIGN organisation''s owner cannot end ALPHA''s session',
  format($$select public.end_impersonation_session(%L)$$, :'s4'), 'denied(42501)');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select imp.val('IE10 the TARGET organisation''s own admin CAN end it mid-session (consent is withdrawable)',
  format($$select public.end_impersonation_session(%L)$$, :'s4'), 'ended');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select imp.val('IE11 after the revoke: no view_crm over ALPHA',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'false');
select imp.val('IE12 after the revoke: reads 0 ALPHA contacts',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');
reset role; reset request.jwt.claims;

select imp.val('IE13 the revoke names WHO ended it',
  format($$select after->>'ended_by' from public.audit_events
           where correlation_id = %L and action='impersonation.ended'$$, :'s4'),
  'organisation_admin');

-- ===========================================================================
-- § IS  THE SUSPENSION CONSEQUENCE (DECISIONS-QUEUE Q98)
--
-- MEASURED, NOT ASSUMED, and recorded here as behaviour rather than as an
-- aspiration. `manage_organisation` has survives_suspension = false
-- (20260828210000), so a SUSPENDED organisation's own Owner holds no
-- manage_organisation -- and therefore can neither SEE nor ACCEPT an
-- impersonation request while the workspace is suspended.
--
-- That follows DECISIONS-QUEUE consequence P7 (suspension is not
-- self-serviceable) rather than contradicting it, and it is the reason Q98
-- exists: the support case most likely to need impersonation is a suspended
-- customer, and today that customer cannot let support in. If the founder
-- rules the other way, the fix is `survives_suspension` on a NEW
-- accept-support-access key -- not a special case in has_permission.
--
-- IT RUNS LAST OF THE BEHAVIOURAL SECTIONS, and that is a constraint rather
-- than a preference: impersonation_sessions_live_pair permits at most one
-- live (requested/accepted/active) session per superuser per organisation, so
-- this section's own ALPHA request can only be made once § IE has ended the
-- one before it.
--
-- ALPHA is suspended and restored TWICE inside this section, and § IS4/§ IS8
-- assert the restoration, so nothing downstream sees a suspended ALPHA.
-- ===========================================================================
reset role; reset request.jwt.claims;
update public.organisations set deleted_at = now() where id = :'alpha_org';

set role authenticated;
set request.jwt.claims = :'super_c';
select public.request_impersonation('org-alpha', 'ticket 9003: suspended workspace') as s3 \gset
select imp.val('IS0 CONTROL: the superuser CAN still request access to a suspended workspace',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s3'), '1');
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'powner_c';
select imp.val('IS1 MEASURED: a SUSPENDED organisation''s Owner cannot SEE an impersonation request (Q98)',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s3'), '0');
select imp.try('IS2 MEASURED: a SUSPENDED organisation''s Owner cannot ACCEPT one (Q98)',
  format($$select public.accept_impersonation_request(%L)$$, :'s3'), 'denied(42501)');
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = null where id = :'alpha_org';
select imp.val('IS3 HOUSEKEEPING: ALPHA is no longer suspended',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$, :'alpha_org'), 'true');

set role authenticated;
set request.jwt.claims = :'powner_c';
select imp.val('IS4 CONTROL: with ALPHA restored, its Owner CAN see the request again (IS1 was suspension, not the policy)',
  format($$select count(*)::text from public.impersonation_sessions where id=%L$$, :'s3'), '1');
select public.accept_impersonation_request(:'s3'::uuid);
reset role; reset request.jwt.claims;

set role authenticated;
set request.jwt.claims = :'super_c';
select public.start_impersonation_session(:'s3'::uuid);
select imp.val('IS5 CONTROL: the session is live before ALPHA is suspended again',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'true');
reset role; reset request.jwt.claims;

-- THE OTHER HALF OF Q6, FOR THE IMPERSONATOR. `view_crm` is the one key with
-- survives_suspension = true, and private.impersonated_organisations() carries
-- the Q6 join character-for-character from has_permission -- so suspending the
-- workspace mid-session must NOT cut a support session that is already
-- running, exactly as it does not cut a member's own read.
update public.organisations set deleted_at = now() where id = :'alpha_org';

set role authenticated;
set request.jwt.claims = :'super_c';
select imp.val('IS6 MEASURED: an ALREADY-LIVE session SURVIVES suspension for reads (view_crm survives_suspension = true)',
  format($$select public.has_permission(%L,'view_crm')::text$$, :'alpha_org'), 'true');
select imp.val('IS7 MEASURED: and still reads ALPHA''s contacts while suspended',
  format($$select (count(*) > 0)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), 'true');
select imp.val('IS8 but view_network does NOT survive suspension, for the impersonator as for a member',
  format($$select public.has_permission(%L,'view_network')::text$$, :'alpha_org'), 'false');
select imp.val('IS9 and writes stay refused, suspended or not',
  format($$select public.has_permission(%L,'manage_contacts')::text$$, :'alpha_org'), 'false');
select public.end_impersonation_session(:'s3'::uuid);
reset role; reset request.jwt.claims;

update public.organisations set deleted_at = null where id = :'alpha_org';
select imp.val('IS10 HOUSEKEEPING: ALPHA is left un-suspended',
  format($$select (deleted_at is null)::text from public.organisations where id=%L$$, :'alpha_org'), 'true');

-- ===========================================================================
-- § IZ  HOUSEKEEPING
--
-- THIS FILE MUST LEAVE NO SESSION ROW BEHIND -- not merely no LIVE one. The
-- HTTP block that runs after this suite was written against a superuser who
-- can read audit_events and nothing else, and every row this file created is
-- either live (which would hand `super` view_crm over ALPHA for the rest of
-- the run) or a counterparty row (which would hand `super` a readable
-- organisations row for ALPHA and BETA). Both are new reachability the checks
-- below were not written against, and rls_phase5/6 set the precedent: a suite
-- that plants state asserts it removed it.
--
-- THE AUDIT ROWS STAY. They are the record, they are readable only to the
-- superuser, and audit_events is append-only by design -- deleting them to
-- tidy up would be the one thing this whole feature exists to make impossible.
-- ===========================================================================
delete from public.impersonation_sessions;

select imp.val('IZ1 this suite leaves NO impersonation_sessions row behind',
  $$select count(*)::text from public.impersonation_sessions$$, '0');

set role authenticated;
set request.jwt.claims = :'super_c';
select imp.val('IZ2 with the rows gone, `super` reads 0 ALPHA contacts again',
  format($$select count(*)::text from public.contacts where organisation_id=%L$$, :'alpha_org'), '0');
-- IZ3, RE-MEASURED FOR PHASE 7 TASK 3 -- same reason as IX4 above. The row
-- stays readable because the superuser holds a lifecycle SELECT policy over
-- every organisation, with or without a session. IZ2 immediately above is the
-- assertion that carries the meaning of this section: with the session rows
-- gone, the superuser reads NONE of ALPHA's contacts.
select imp.val('IZ3 MEASURED (Task 3): ALPHA''s organisations ROW stays readable -- the lifecycle policy, not a session',
  format($$select count(*)::text from public.organisations where id=%L$$, :'alpha_org'), '1');
reset role; reset request.jwt.claims;

select imp.val('IZ4 the AUDIT trail survived the cleanup (append-only)',
  $$select (count(*) > 0)::text from public.audit_events where target_type='impersonation_session'$$,
  'true');

\o

select seq, case when pass then 'PASS' else 'FAIL' end as result,
       label, expected, actual
from imp.results order by seq;

select count(*) filter (where not pass) as failures, count(*) as total from imp.results;
