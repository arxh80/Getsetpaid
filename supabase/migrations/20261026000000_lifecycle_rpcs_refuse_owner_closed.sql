-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1 -- THE PHASE 7 LIFECYCLE RPCs REFUSE AN
-- OWNER-CLOSED WORKSPACE (review I1).
--
-- suspend_organisation() refused only 'suspended', delete_organisation() only
-- 'deleted' and reinstate_organisation() only 'active' (20260908030000), and
-- /super/organisations offered them on every non-active row -- owner_closed
-- included. So the founder's decision flow (Task 9c job 2:
-- reassign_closed_workspace / delete_closed_workspace, each reasoned, audited
-- and emailing the remaining Owners/Admins) could be bypassed in one click:
--   * Reinstate returned the workspace to active with no closure_reassigned
--     row, no email and -- if the closing Owner had erased, which closing
--     exists to allow -- NO OWNER, the state Q131 exists to prevent.
--   * Suspend or Delete lost the owner_closed discriminator, dropped the item
--     off /super/closures, re-stamped a fresh 60 days and emailed nobody.
-- Each of the three now refuses owner_closed (22023, hint
-- owner_closed_is_decided_at_super_closures) before anything is written.
-- private.lifecycle_target() is NOT changed: the two decision RPCs do not use
-- it, but a state filter there would be a fourth caller's surprise.
--
-- Rebuilt from the LATEST pg_get_functiondef of each at 230 migrations
-- (standing lesson 4); CREATE OR REPLACE keeps grants and comments.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.suspend_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'suspend_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'suspended' then
    raise exception 'suspend_organisation: that workspace is already suspended'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'suspended',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'suspend_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.suspended', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'delete_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'deleted' then
    raise exception 'delete_organisation: that workspace is already deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object('lifecycle_state', v_target.lifecycle_state);

  perform private.begin_lifecycle_transition(v_corr);

  -- SOFT ONLY. There is no DELETE anywhere in this function and there must
  -- never be one: CLAUDE.md § Superuser dashboard, "soft-delete only... no
  -- immediate hard delete", and § Non-negotiable rules, "never silently delete
  -- data". The retention clock re-stamps here (private.organisation_lifecycle_
  -- sync sees the state change), which EXTENDS a suspended workspace's window
  -- rather than shortening it -- the customer-favourable reading of an
  -- ambiguity Q88 does not resolve. Queued as DECISIONS-QUEUE Q102.
  update public.organisations
  set deleted_at       = coalesce(deleted_at, pg_catalog.now()),
      lifecycle_state  = 'deleted',
      lifecycle_reason = pg_catalog.btrim(p_reason)
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'delete_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.deleted', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reinstate_organisation(p_organisation_slug text, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_target record;
  v_corr   uuid := pg_catalog.gen_random_uuid();
  v_before jsonb;
  n        integer;
begin
  select * into v_target from private.lifecycle_target(p_organisation_slug, p_reason);

  -- 20261026000000 (Task 9c fix round 1, I1): AN OWNER-CLOSED WORKSPACE IS
  -- DECIDED AT /super/closures, NOT HERE. Reinstating it skipped the
  -- reassignment (a live workspace whose closing Owner may already be erased,
  -- with no Owner at all) and suspending or deleting it erased the
  -- owner_closed discriminator, re-stamped the 60-day clock and told nobody.
  -- reassign_closed_workspace() / delete_closed_workspace() are the two ways
  -- out of owner_closed.
  if v_target.lifecycle_state = 'owner_closed' then
    raise exception 'reinstate_organisation: that workspace was closed by its Owner; decide it on /super/closures (reassign or delete)'
      using errcode = '22023', hint = 'owner_closed_is_decided_at_super_closures';
  end if;

  if v_target.lifecycle_state = 'active' then
    raise exception 'reinstate_organisation: that workspace is not suspended or deleted'
      using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'lifecycle_state', v_target.lifecycle_state,
    'deleted_at',      v_target.deleted_at);

  perform private.begin_lifecycle_transition(v_corr);

  -- Clearing deleted_at is the whole reinstatement: every gate in the schema
  -- reads that column, so the workspace becomes writable again the instant
  -- this commits. private.organisation_lifecycle_sync() clears the three
  -- lifecycle columns with it, so no live workspace carries a stale retention
  -- deadline or a stale suspension reason.
  --
  -- NOTE THE ABSENCE OF ANY WINDOW CHECK. Reinstatement is deliberately
  -- possible past retention_expires_at too: the 60 days is when the workspace
  -- stops being VISIBLE and becomes eligible for a future purge, not a
  -- deadline after which the operator is locked out of their own undo. A
  -- one-way door with a clock on it is the failure mode this whole task
  -- exists to avoid.
  update public.organisations
  set deleted_at = null
  where id = v_target.id;
  get diagnostics n = row_count;

  if n = 0 then
    raise exception 'reinstate_organisation: refused'
      using errcode = '42501';
  end if;

  perform private.log_organisation_lifecycle_event(
    v_target.id, 'organisation.reinstated', v_corr, v_before, pg_catalog.btrim(p_reason));

  -- CLOSE THE DOOR. Not optional -- see private.end_lifecycle_transition().
  perform private.end_lifecycle_transition();

  return v_target.id;
end;
$function$;
