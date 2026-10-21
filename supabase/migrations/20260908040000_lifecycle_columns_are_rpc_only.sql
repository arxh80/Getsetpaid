-- Phase 7 Task 3, FIX ROUND 1 (review finding I1): the lifecycle columns are
-- writable ONLY through the three audited superuser RPCs.
--
-- ===========================================================================
-- THE FINDING, REPRODUCED BEFORE IT WAS FIXED
-- ===========================================================================
-- An aal2 Owner of a LIVE workspace could wind it down and word the customer's
-- banner, in one un-audited PATCH:
--
--   update public.organisations
--      set deleted_at = now(),
--          lifecycle_state = 'deleted',
--          lifecycle_reason = 'Suspended by GetSetPaid for suspected fraud
--                              - call 0800-SCAM'
--    where id = <their own org>;
--
--   ATTACK RESULT: ok(1)
--   state=deleted  reason=[Suspended by GetSetPaid for suspected fraud ...]
--   audit rows for lifecycle actions: 0
--
-- Three links, each of which was correct on its own:
--
--   1. 20260828220000 § 2 added `deleted_at is null` to
--      organisations_update_manage_organisation's USING **only**, deliberately
--      ("suspending is a door you can walk through, un-suspending is not").
--      Its WITH CHECK is still 20260826154304:737's bare has_permission().
--   2. `grant select, update on public.organisations to authenticated`
--      (20260826154304:958) is TABLE-WIDE, so it covered the four columns
--      20260908030000 added the moment they existed. RLS filters ROWS, not
--      COLUMNS.
--   3. private.organisation_lifecycle_sync()'s wound-down branch keeps a
--      caller-supplied non-active state (it only overrides null/'active') and
--      never touches lifecycle_reason at all.
--
-- So the row matched USING (still live at statement snapshot), passed WITH
-- CHECK (has_permission reads the pre-update row), satisfied the biconditional
-- CHECK, and the normaliser accepted both fields.
--
-- WHY IT MATTERS MORE THAN "an Owner can already self-suspend":
--   * it reaches `deleted`, which under Q101 removes the workspace's published
--     profiles from the directory immediately, and which consequence P7 then
--     stops that same Owner undoing;
--   * it renders MEMBER-AUTHORED TEXT ON THE PLATFORM'S OWN BANNER -- the
--     panel whose next line says "Contact GetSetPaid support to have the
--     workspace reinstated". React escapes it, so this is not XSS; it is an
--     in-tenant social-engineering surface that did not exist before Task 3
--     and that Task 3 created;
--   * it falsified three shipped comments (corrected at the bottom of this
--     file).
--
-- ===========================================================================
-- THE FIX IS TWO INDEPENDENT GATES, because one was the whole problem
-- ===========================================================================
-- I1 exists precisely because a single term (USING) was assumed to cover both
-- directions of a write. So this migration does not add one term.
--
--   GATE 1, THE POLICY. organisations_update_manage_organisation's WITH CHECK
--   gains `deleted_at is null and lifecycle_state = 'active' and
--   lifecycle_reason is null`: an Owner's update must LEAVE THE WORKSPACE
--   LIVE. USING is untouched.
--
--   GATE 2, A TRIGGER, which does not consult any policy: a change to
--   deleted_at, lifecycle_state or lifecycle_reason raises 42501 unless the
--   transaction-scoped marker is set -- i.e. unless it is one of the three
--   RPCs doing it.
--
-- Either alone closes the attack. Gate 2 covers what Gate 1 structurally
-- cannot: a THIRD update policy that a later phase adds to this table without
-- reading this file, and a future relaxation of Gate 1 itself.
-- rls_phase7_lifecycle.sql § LP measures Gate 2 with Gate 1 switched off, the
-- same way rls_phase2_crm.sql P11 measures its second gate.
--
-- WHAT NEITHER GATE COVERS, STATED PLAINLY RATHER THAN IMPLIED: `service_role`.
-- It holds rolbypassrls, so no policy applies to it (Gate 1) and
-- row_security_active() is false for it (Gate 2 exempts it by the same clause
-- that exempts `postgres`). That is true of every table in this schema and is
-- why service-role keys are server-side only (CLAUDE.md § Non-negotiable
-- rules); the precise claim for Gate 2 is that it covers every caller for whom
-- RLS is active, which is the whole of the PostgREST client path and the whole
-- of the attack surface I1 described.
--
-- ===========================================================================
-- THE EXEMPTION IS `row_security_active()`, AND NOT `is_superuser`
-- ===========================================================================
-- The obvious exemption -- let a Postgres superuser through -- DOES NOT WORK
-- HERE, measured rather than assumed: on this stack
-- `current_setting('is_superuser')` is **'off' for `postgres` too** (Supabase's
-- `postgres` is not `rolsuper`; it is `rolbypassrls`). A guard keyed on it
-- would have refused every migration, every DBA repair and every fixture in
-- the psql suite.
--
-- So the guard asks the precise question instead: IS ROW-LEVEL SECURITY BEING
-- APPLIED TO THIS CALLER AT ALL? `pg_catalog.row_security_active()` is false
-- exactly for the roles that bypass RLS -- `postgres` and `service_role` --
-- and true for `authenticated` and `anon`, which is the PostgREST client path
-- and is the entire attack surface. Migrations, `supabase db reset`, the psql
-- fixtures and the e2e `setOrganisationSuspended()` helper all run as
-- `postgres` and are unaffected; nothing reachable from a browser is.
--
-- It is a role property, not a policy, so Gate 2 stays independent of Gate 1
-- being right.
--
-- ===========================================================================
-- THIS REVERSES A DELIBERATE PHASE 2 DECISION. QUEUED AS Q104.
-- ===========================================================================
-- 20260828220000 § 2 says in as many words:
--
--     "WITH CHECK is left alone because adding `deleted_at is null` there
--      would forbid SETTING deleted_at -- i.e. it would remove an aal2 Owner's
--      ability to soft-delete their own organisation, which is existing
--      behaviour this fix round has no mandate to change."
--
-- THIS migration has that mandate, and takes it. Phase 2 was a CRM task
-- declining to make an org-lifecycle decision in passing; Phase 7 Task 3 is
-- the org-lifecycle task, and CLAUDE.md § Superuser dashboard is unambiguous
-- that suspension is a SUPERUSER action requiring step-up re-auth, an audited
-- reason and admin notification. A self-service PATCH has none of the three.
-- It is also a footgun: consequence P7 means the Owner who walks through that
-- door cannot walk back, and until Task 3 there was no reinstate path at all.
--
-- The founder may disagree -- an Owner asking to close their own workspace is
-- a reasonable product feature. It is queued as DECISIONS-QUEUE Q104 with this
-- as the shipped default, and the honest version of that feature is a fourth
-- RPC (`close_own_organisation`, requiring manage_organisation, audited, with
-- the reason recorded as the CUSTOMER's rather than the operator's), not a
-- bare column write.
--
-- ADDITIVE. `alter policy` for the one policy that changes, `create function` /
-- `create trigger` for the new gate, `comment on` for the corrections.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- GATE 1 -- the policy. USING IS NOT TOUCHED.
--
-- `alter policy` leaves an omitted clause unchanged, so the USING added by
-- 20260828220000 (`has_permission(id,'manage_organisation') and deleted_at is
-- null`) stands exactly as it was, and P7/P11a/P11b keep measuring it.
--
-- The three new terms describe the RESULT, not the change, because a policy
-- cannot see the old row: whatever an Owner does, the row they leave behind
-- must be a live one. That is equivalent to "you may not wind your workspace
-- down" without needing OLD.
-- ---------------------------------------------------------------------------
alter policy organisations_update_manage_organisation
  on public.organisations
  with check (
    public.has_permission(id, 'manage_organisation')
    and deleted_at       is null
    and lifecycle_state  = 'active'
    and lifecycle_reason is null
  );

comment on policy organisations_update_manage_organisation on public.organisations is
  'Rename / edit the organisation. THREE GATES since Phase 7 Task 3 fix round 1. (1) public.has_permission(id,''manage_organisation''), false in a suspended organisation because public.permissions.survives_suspension is false for that key. (2) An unconditional `deleted_at is null` in USING (20260828220000), which does not consult the catalogue -- DECISIONS-QUEUE consequence P7, an Owner cannot un-suspend their own organisation. (3) NEW: WITH CHECK now requires the row this update LEAVES BEHIND to be live -- `deleted_at is null and lifecycle_state = ''active'' and lifecycle_reason is null` -- so an Owner cannot wind their own workspace DOWN either. THAT REVERSES 20260828220000 § 2''s "suspending is a door you can walk through", deliberately and with a mandate that fix round did not have: review finding I1 showed the door also reached lifecycle_state = ''deleted'' (immediate directory removal under Q101, undoable only by the superuser under P7) and let a member write arbitrary text into lifecycle_reason, which the platform''s own suspended-workspace banner renders as the reason. Suspension is a superuser action under CLAUDE.md § Superuser dashboard -- step-up, audited reason, admin notification -- and a bare PATCH had none of them. Queued as DECISIONS-QUEUE Q104; if the founder wants customer-initiated closure it is a fourth audited RPC, not a column write. private.organisation_lifecycle_guard() is the second, policy-independent gate on the same three columns.';


-- ---------------------------------------------------------------------------
-- GATE 2 -- the trigger. Consults no policy, so it holds when a policy is
-- wrong or when a later phase adds another one.
--
-- BEFORE UPDATE, and named to sort BEFORE organisation_lifecycle_sync so it
-- inspects the row the CALLER actually submitted rather than the normalised
-- one (Postgres fires per-row BEFORE triggers in name order). Seeing the raw
-- NEW is the point: the attack's payload is `lifecycle_state = 'deleted'`, and
-- after normalisation that value would be indistinguishable from one the
-- normaliser chose.
--
-- The two DERIVED columns (lifecycle_changed_at, retention_expires_at) are
-- deliberately not listed. They are recomputed or cleared by the normaliser on
-- every write, so a client cannot make them stick; and the only branch that
-- honours a caller-supplied lifecycle_changed_at requires the row to be
-- ALREADY wound down, which Gate 1's USING makes unreachable from a client.
-- Guarding them would add two terms that can never fire and imply the other
-- two matter less.
-- ---------------------------------------------------------------------------
create or replace function private.organisation_lifecycle_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- row_security_active() is FALSE exactly for the roles that bypass RLS --
  -- `postgres` and `service_role` -- so migrations, DBA repair, the psql
  -- fixtures and the e2e helpers are unaffected, and every path reachable from
  -- a browser is guarded. `is_superuser` would NOT work here: it is 'off' for
  -- `postgres` on this stack (Supabase's postgres is rolbypassrls, not
  -- rolsuper), so a guard keyed on it would refuse every migration.
  if not pg_catalog.row_security_active('public.organisations') then
    return new;
  end if;

  -- The three RPCs, and nothing else, open this.
  if private.lifecycle_transition_in_progress() then
    return new;
  end if;

  if new.deleted_at       is distinct from old.deleted_at
     or new.lifecycle_state  is distinct from old.lifecycle_state
     or new.lifecycle_reason is distinct from old.lifecycle_reason
  then
    raise exception
      'organisation lifecycle: deleted_at, lifecycle_state and lifecycle_reason are set only by the audited superuser lifecycle RPCs'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.organisation_lifecycle_guard() is
  'THE SECOND GATE on public.organisations'' three lifecycle columns (Phase 7 Task 3 fix round 1, review finding I1). Raises 42501 when a client-path caller changes deleted_at, lifecycle_state or lifecycle_reason outside one of the three audited superuser RPCs. IT CONSULTS NO POLICY, which is the whole point: I1 happened because a single policy term was assumed to cover both directions of a write, and a defence-in-depth term that is a function of the gate beside it is not depth. Exempts callers for whom RLS is not active -- pg_catalog.row_security_active() is false exactly for rolbypassrls roles (`postgres`, `service_role`), so migrations, DBA repair and every psql/e2e fixture that suspends an organisation directly keep working, while nothing reachable through PostgREST does. `is_superuser` was measured and rejected as the exemption: it is ''off'' for `postgres` on this stack. Fires BEFORE organisation_lifecycle_sync (per-row BEFORE triggers run in name order), so it inspects the row the caller actually submitted rather than the normalised one.';

drop trigger if exists organisation_lifecycle_guard on public.organisations;
create trigger organisation_lifecycle_guard
  before update on public.organisations
  for each row execute function private.organisation_lifecycle_guard();


-- ---------------------------------------------------------------------------
-- THE CORRECTIONS. Three shipped comments were falsified by I1; two of them
-- become TRUE as of this migration and one was wrong in a second way the
-- review names separately (Minor 2).
-- ---------------------------------------------------------------------------

-- (a) 20260908030000's policy comment claimed "every transition that reaches
--     the column carries a reason and an audit row". That was true of the
--     superuser path and false of the Owner's. It is now true of both, and the
--     comment says which gate makes it so rather than asserting it.
comment on policy organisations_update_platform_lifecycle on public.organisations is
  'THE SUPERUSER REINSTATE/SUSPEND/DELETE PATH, and the only policy in the schema whose USING clause can match a SOFT-DELETED organisation row -- so the only way deleted_at can ever be cleared. FOLLOW-UPS.md § "Phase 7 -- superuser dashboard" specified exactly this shape: a NEW permissive policy (permissive policies OR together), NOT a relaxation of organisations_update_manage_organisation and NOT opening manage_organisation in public.permissions, either of which would hand self-service un-suspension to every Owner (DECISIONS-QUEUE consequence P7). rls_phase2_crm.sql P7/P7a/P7b and P11a-P11f are unaffected and still pass. TWO TERMS, BOTH REQUIRED: has_platform_permission (aal2 + on public.platform_admins) says WHO; private.lifecycle_transition_in_progress() says THROUGH WHAT -- it is true only inside a transaction that called private.begin_lifecycle_transition(), which only public.suspend_organisation / delete_organisation / reinstate_organisation do, so a raw PATCH from the superuser''s own browser matches nothing. EVERY TRANSITION THAT REACHES THESE COLUMNS THEREFORE CARRIES A REASON AND AN AUDIT ROW -- which was NOT true when this comment was first written (review finding I1: an Owner reached lifecycle_state and lifecycle_reason through the sibling policy''s ungated WITH CHECK, un-audited). It is true as of 20260908040000, and it is made true by two gates that are not this one: that policy''s WITH CHECK, and private.organisation_lifecycle_guard().';

-- (b) The lifecycle_reason column comment said the reason is "mandatory on
--     every transition" -- true of the RPCs, false of the Owner's PATCH, which
--     could write any string or none. Now true. AND (review Minor 2) it said
--     "Null iff lifecycle_state = 'active'", which no constraint enforces: the
--     biconditional CHECK deliberately omits lifecycle_reason, because a bare
--     `set deleted_at = now()` by a DBA leaves the reason null on a suspended
--     row and the normaliser is built to accept exactly that. Softened to what
--     is actually true.
comment on column public.organisations.lifecycle_reason is
  'The operator''s reason for the current lifecycle state. MANDATORY ON EVERY TRANSITION -- the three RPCs raise 22023 for an empty one, and since 20260908040000 they are the only client-reachable way to write this column at all (review finding I1: an Owner could previously write arbitrary text here on their own live workspace, un-audited, and the platform''s suspended-workspace banner rendered it). CLEARED ON REINSTATEMENT, because the reason for a state that has ended is history and lives in public.audit_events, which is append-only; leaving a stale reason on a live workspace would put it in front of the customer''s own admins on the next suspension banner. NOT "null iff lifecycle_state = ''active''" -- that is what the RPCs produce, but no constraint enforces it: organisations_lifecycle_matches_deleted_at deliberately omits this column, so a DBA''s bare `set deleted_at = now()` leaves a suspended row with a null reason, which private.organisation_lifecycle_sync() is built to accept. IT IS CUSTOMER-VISIBLE, AND THAT IS DELIBERATE (20260908032000): public.organisations is readable by every active member through organisations_select_member, RLS filters rows and not columns, and Postgres column privileges are per-role -- so there is no arrangement in which the superuser sees this and the workspace''s own people do not. The suspended-workspace banner RENDERS it and the operator''s form warns them that the workspace''s own people will read it. DO NOT PUT ANYTHING HERE THAT THE CUSTOMER MUST NOT READ. If a separate internal-only note is ever wanted it is a SECOND column that no member-facing query projects (DECISIONS-QUEUE Q103), never a quiet re-use of this one.';

-- (c) The lifecycle_state column comment is unchanged in substance but gains
--     the one sentence I1 proves it needed: the invariant is what makes a new
--     state read-only, and the GUARD is what makes the state itself
--     unwritable by a member.
comment on column public.organisations.lifecycle_state is
  'WHICH kind of wound-down state this workspace is in: ''active'', ''suspended'' or ''deleted''. THE READ-ONLY FLAG IS STILL deleted_at, NOT THIS COLUMN -- every permission gate in the schema reads deleted_at (public.has_permission''s catalogue join, private.organisation_is_live(), private.crm_write_organisations(), private.custom_field_limit(), private.finance_module_organisations(), private.network_publish_organisations(), public.accept_invite()), and 20260908030000''s header explains at length why teaching all of them a second column would be the more dangerous design. This column is the DISCRIMINATOR beside it, and the invariant `lifecycle_state = ''active'' <=> deleted_at is null` is enforced twice: normalised by private.organisation_lifecycle_sync() and asserted by organisations_lifecycle_matches_deleted_at. CONSEQUENCE, WHICH IS THE POINT: a lifecycle state added by a later phase cannot exist without deleted_at set, and therefore cannot exist without being read-only. WHO MAY WRITE IT: only the three audited superuser RPCs, from any client path -- enforced since 20260908040000 by organisations_update_manage_organisation''s WITH CHECK and, independently, by private.organisation_lifecycle_guard(). Before that an Owner could set ''deleted'' on their own live workspace in one un-audited PATCH (review finding I1).';
