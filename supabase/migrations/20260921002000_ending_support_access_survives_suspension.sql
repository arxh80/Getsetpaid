-- ===========================================================================
-- PHASE 7 PRE-MERGE FIX ROUND, FINDING I1 -- SUSPENDING A WORKSPACE TOOK THE
-- CUSTOMER'S CONTROL OF A LIVE SUPPORT SESSION AWAY AND LEFT THE OPERATOR'S
-- READ RUNNING.
--
-- ===========================================================================
-- THE DEFECT, MEASURED
-- ===========================================================================
-- The two halves of impersonation read public.permissions.survives_suspension
-- with opposite results:
--
--   key                  | survives_suspension
--   manage_organisation  | f
--   view_crm             | t     <- the ONLY true row in the product
--
--   * THE OPERATOR'S READ SURVIVES. private.impersonated_organisations() ends
--     `and (o.deleted_at is null or perm.survives_suspension)` and is probed
--     with 'view_crm', so a live session keeps reading a suspended workspace --
--     deliberately (rls_phase7_impersonation.sql § IS6/IS7 assert it).
--   * THE CUSTOMER'S REVOCATION DID NOT. public.end_impersonation_session()'s
--     customer branch was `public.has_permission(v_org,'manage_organisation')`,
--     false in a suspended organisation. 42501.
--   * AND THE CUSTOMER COULD NOT EVEN SEE THE SESSION.
--     impersonation_sessions_select_target_admin is keyed on
--     permitted_organisations('manage_organisation') too.
--   * NOTHING ENDS LIVE SESSIONS ON A LIFECYCLE TRANSITION. Neither
--     20260908030000 nor 20260908031000 mentions impersonation_sessions.
--
-- So a routine billing suspension landing mid-session silently converted a
-- consented, revocable, time-boxed read into an unrevocable one -- while
-- app/(app)/[orgSlug]/support-access/page.tsx told the customer, in words,
-- "Nobody at GetSetPaid can see this workspace in the meantime."
--
-- 20260908020000's own header states the property this broke:
-- "EITHER PARTY MAY CALL IT ... a customer who can grant access but not
-- withdraw it has not really consented."
--
-- ===========================================================================
-- WHICH FIX, AND WHY THIS ONE
-- ===========================================================================
-- Two were available: (a) end every live session when the workspace is
-- suspended, or (b) make the customer's end-session path work under
-- suspension. (b) is taken.
--
--   1. ENDING SUPPORT ACCESS IS A CONSENT WITHDRAWAL, NOT A MANAGEMENT ACTION.
--      Founder decision Q6 makes suspension READ-ONLY rather than a lockout,
--      and consequence P7 makes it not self-serviceable -- both are about what
--      a customer may CHANGE about their workspace. Withdrawing a grant they
--      made is neither: it removes capability rather than adding it, and a
--      right to revoke that a billing event can suspend is not a right.
--   2. (a) WOULD BREAK A DELIBERATE, ASSERTED BEHAVIOUR. § IS6/IS7 assert that
--      an already-live session survives suspension for reads, and that is the
--      support case impersonation exists for: the customer most likely to need
--      support is the suspended one. Cutting the operator off at the moment of
--      suspension would make the feature useless exactly when it is needed,
--      and would have to be written as a weakening of two green assertions.
--   3. THE SUITE ITSELF NAMED THIS FIX IN ADVANCE.
--      rls_phase7_impersonation.sql § IS's header: "If the founder rules the
--      other way, the fix is `survives_suspension` on a NEW
--      accept-support-access key -- not a special case in has_permission."
--      This is that key, scoped to ENDING rather than accepting.
--
-- Q98 IS NOT REOPENED. A suspended workspace still cannot REQUEST-answer:
-- accepting a new grant is a change to the workspace and stays gated on
-- manage_organisation, so § IS1/§ IS2 hold unchanged. Only the withdrawal
-- moves, and the new SELECT policy is scoped to status = 'active' so a
-- suspended admin still cannot SEE a pending request (§ IS1) -- they can see,
-- and end, only a session that is already running against them.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE KEY.
--
-- survives_suspension = true, which makes this the SECOND true row in the
-- catalogue after view_crm. That is a deliberate, narrow widening and
-- rls_phase2_crm.sql M1g pins the exact set, so a third cannot arrive
-- unnoticed. It grants NO read and NO write: the only two things in the
-- product that consult it are the policy and the RPC branch below, both of
-- which act on an impersonation_sessions row and nothing else.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, survives_suspension, description) values
  ('end_support_access', true,
   'End a RUNNING break-glass support-access session over this organisation, and see the row for one. The second key in the product with survives_suspension = true (Q6/pre-merge finding I1): withdrawing consent is not a change to the workspace, so a suspended workspace''s Owner/Admin keeps it while manage_organisation -- which ACCEPTING a new request still requires -- stays false. Grants no read of any tenant table and no write anywhere; it is consulted only by impersonation_sessions_select_target_live_session and by public.end_impersonation_session()''s customer branch.')
on conflict (key) do nothing;

-- Granted to exactly the roles that hold manage_organisation, DERIVED rather
-- than hardcoded: the set is Owner and Admin today, and the day a migration
-- grants organisation administration to a third role, that role is the one
-- that should also be able to end a support session. `read_only` is not in
-- that set, which is what keeps the key out of the impersonation envelope
-- (private.impersonated_organisations() resolves it from read_only's grants --
-- rls_phase7_impersonation.sql § IP3 pins those to view_crm,view_network).
insert into public.role_permissions (role_key, permission_key)
select rp.role_key, 'end_support_access'
from public.role_permissions rp
where rp.permission_key = 'manage_organisation'
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. SEEING THE RUNNING SESSION.
--
-- A SECOND, NARROWER POLICY rather than a rewrite of
-- impersonation_sessions_select_target_admin. Permissive policies OR together,
-- so this adds exactly one thing to what a target organisation's
-- administrators may read: a session that is ALREADY ACTIVE against them.
-- Widening the existing policy to the new key instead would have made a
-- suspended workspace's Owner able to see a PENDING request too, which is
-- Q98's measured behaviour (§ IS1) and is not what this fix is about.
-- ---------------------------------------------------------------------------
create policy impersonation_sessions_select_target_live_session
  on public.impersonation_sessions
  for select
  to authenticated
  using (
    status = 'active'
    and target_organisation_id in (select private.permitted_organisations('end_support_access'))
  );

comment on policy impersonation_sessions_select_target_live_session on public.impersonation_sessions is
  'PERMITS: an Owner/Admin (at aal2) of the TARGET organisation reading a session that is ALREADY ACTIVE against their workspace -- including while the workspace is SUSPENDED, because end_support_access has survives_suspension = true. That is the read behind the "End access now" control, and without it the customer could not see the session they are entitled to end (pre-merge review finding I1). DOES NOT PERMIT: seeing a requested/accepted/declined/ended row while suspended -- `status = ''active''` is a term, so DECISIONS-QUEUE Q98 is untouched and rls_phase7_impersonation.sql § IS1/§ IS2 still hold; reading another organisation''s sessions; reading below aal2. On a LIVE workspace this policy is redundant with impersonation_sessions_select_target_admin, which is the correct relationship between a general policy and a narrow one that survives a state the general one does not.';


-- ---------------------------------------------------------------------------
-- 3. ENDING IT.
--
-- REISSUED FROM ITS LATEST DEFINITION -- 20260908020000, the only migration
-- that has ever defined this function. ONE line changes: the customer branch's
-- permission key. Everything else -- the lookup, the 42501s, the superuser
-- branch, the expired/ended arithmetic, the UPDATE's own `status = 'active'`
-- guard, the audit call and its payload -- is byte-identical. This phase lost
-- a clause twice by rebuilding a function from the wrong version; whoever
-- reissues this next starts from THIS file.
-- ---------------------------------------------------------------------------
create or replace function public.end_impersonation_session(p_session_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_expires timestamptz;
  v_by_role text;
  v_status  text;
begin
  select s.target_organisation_id, s.expires_at into v_org, v_expires
  from public.impersonation_sessions s
  where s.id = p_session_id and s.status = 'active';

  if v_org is null then
    raise exception 'end_impersonation_session: no active session with that id'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.impersonation_sessions s
    where s.id = p_session_id
      and s.superuser_user_id = (select auth.uid())
  ) and private.has_platform_permission('impersonate') then
    v_by_role := 'superuser';
  -- THE CUSTOMER'S BRANCH, ON A KEY THAT SURVIVES SUSPENSION (finding I1).
  -- It was 'manage_organisation', which is false in a suspended organisation --
  -- so suspending a workspace mid-session revoked the CUSTOMER's control and
  -- left the operator's read running. end_support_access is held by exactly
  -- the same roles and is true while suspended.
  elsif public.has_permission(v_org, 'end_support_access') then
    v_by_role := 'organisation_admin';
  else
    raise exception 'end_impersonation_session: you may not end that session'
      using errcode = '42501';
  end if;

  v_status := case when v_expires <= pg_catalog.now() then 'expired' else 'ended' end;

  update public.impersonation_sessions
  set status   = v_status,
      ended_at = pg_catalog.now()
  where id = p_session_id and status = 'active';

  perform private.log_audit_event(
    p_action          => 'impersonation.' || v_status,
    p_target_type     => 'impersonation_session',
    p_organisation_id => v_org,
    p_target_id       => p_session_id,
    p_correlation_id  => p_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'active'),
    p_after           => pg_catalog.jsonb_build_object(
                           'status', v_status,
                           'ended_by', v_by_role)
  );

  return v_status;
end;
$$;

comment on function public.end_impersonation_session(uuid) is
  'Step 4: close the window. EITHER PARTY MAY CALL IT -- the superuser who holds the session, or an Owner/Admin of the target organisation revoking consent mid-session (a customer who can grant access but not withdraw it has not really consented). Anyone else gets 42501. Writes ''ended'' when the clock was still running and ''expired'' when it had already lapsed, and audits ''impersonation.ended'' / ''impersonation.expired'' accordingly, with `after.ended_by` naming which party did it. THE EXPIRY BRANCH IS BOOKKEEPING, NOT ENFORCEMENT: private.impersonated_organisations() stopped returning the organisation at expires_at whether or not this is ever called, which is why no sweep job is owed. SINCE THE PRE-MERGE FIX ROUND (finding I1) the customer branch asks for ''end_support_access'' rather than ''manage_organisation'': the latter has survives_suspension = false, so suspending a workspace during a live session removed the CUSTOMER''s ability to end it while leaving the OPERATOR''s read running (view_crm survives). Withdrawing a grant is not a change to the workspace, so the new key survives suspension; ACCEPTING a new request still requires manage_organisation and is still impossible while suspended (Q98, rls_phase7_impersonation.sql § IS1/§ IS2).';

-- Unchanged, restated so `create or replace` cannot silently drift them.
revoke all on function public.end_impersonation_session(uuid) from public, anon, service_role;
grant execute on function public.end_impersonation_session(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. THE TWO LIVE OBJECT COMMENTS THAT THIS MAKES FALSE.
--
-- Both say, in a `comment on` statement rather than a `--` script comment, that
-- view_crm is the ONLY key with survives_suspension = true. It is now one of
-- two. A `comment on` IS additively reissuable (the 20260904007000 precedent),
-- so both are corrected here rather than left to contradict the catalogue --
-- `SECURITY.md`'s own standard: a document that describes a control wrongly is
-- worse than one that describes it not at all.
--
-- The `--` script comments carrying the same sentence
-- (20260901010000:54, 20260902010000:50, 20260903002000:32, 20260904002000:32)
-- are NOT live database objects and their files are immutable. This migration,
-- rls_phase2_crm.sql M1g and CLAUDE.md are the correction of record for those.
-- ---------------------------------------------------------------------------
comment on column public.permissions.survives_suspension is
  'True iff this permission is still held in a SOFT-DELETED (suspended) organisation. Founder decision, DECISIONS-QUEUE § Q6, 2026-08-28: suspension stops work without hiding a customer''s own data, so READ keys are true and every write key is false. DEFAULT FALSE IS DELIBERATE AND LOAD-BEARING -- a permission added by a later phase that never considers suspension gets the safe answer, and the failure mode is a suspended user missing a capability (visible, complained about) rather than a suspended user still writing (silent). Consequence: manage_organisation is false, so an Owner cannot un-suspend their own organisation -- intended, see DECISIONS-QUEUE consequence P7 and CLAUDE.md § Superuser dashboard. HOW MUCH A WRONG VALUE HERE COSTS, corrected in Task 3a fix round 1: setting this true for a WRITE key no longer opens the write, because every organisation-scoped write policy now carries a SECOND, unconditional deleted_at gate beside the permission engine -- private.crm_write_organisations() for the 25 CRM write policies, private.organisation_is_live() for the four Foundation ones (20260828220000). Before that migration the four Foundation policies had no second gate and one wrong boolean here let an Owner un-suspend their own organisation. TWO KEYS ARE TRUE SINCE THE PHASE 7 PRE-MERGE FIX ROUND (finding I1): view_crm, and end_support_access (20260921002000), which lets a suspended workspace''s Owner/Admin see and END a support-access session already running against them -- withdrawing a grant is not a change to the workspace, and suspending one mid-session used to revoke the CUSTOMER''s control while leaving the operator''s read running. It opens no read of any tenant table and no write anywhere. rls_phase2_crm.sql M1g asserts the EXACT SET rather than a count, so a third cannot arrive unnoticed, and P11-P11d assert the second gate by disabling this one.';

comment on policy "events_select_view_crm" on public.events is
  'PERMITS: reading events of an organisation the caller holds view_crm in -- all of them for a full-scope role, only their own for a record-scoped one (standard_user, read_only). DOES NOT PERMIT: reading another tenant''s events under any role, or reading at all below aal2 for owner/admin/finance, whose permissions are MFA-gated (20260827210000) -- the read gate closes for them with no separate term here. DELIBERATELY DOES NOT HIDE SOFT-DELETED ROWS: `deleted_at` is not a term, because the restore path and the detail page''s "Deleted" notice both read the row (20260828121000 design note (g)); the application filters. NOT entitlement-gated: reads stay open on Free and in a suspended organisation (Q6), which is why `view_crm` carries survives_suspension = true -- it is the only READ key that does, and since 20260921002000 the catalogue also carries end_support_access (true), which grants no read of anything and exists only so a suspended workspace can still END a live support-access session.';
