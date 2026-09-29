-- Phase 7 Task 1: the audit log viewer's SELF-AUDIT write path, plus the one
-- index the viewer's keyset pager needs.
--
-- ===========================================================================
-- WHAT ALREADY EXISTS AND IS NOT REBUILT HERE
-- ===========================================================================
-- Task 1's brief asks for a superuser identity foundation and a cross-tenant
-- read policy for public.audit_events. Both already shipped, in the
-- Foundation phase, under different names than the brief guessed at:
--
--   superuser identity   public.platform_admins (the allowlist table),
--                         public.is_platform_admin() (aal-independent
--                         IDENTITY check, PostgREST-reachable),
--                         private.has_platform_permission(text) (aal2-gated
--                         PERMISSION check) -- all from
--                         20260826154304_permission_engine_and_rls.sql,
--                         20260827180000_public_is_platform_admin.sql and
--                         20260827210000_mfa_aal_permission_gate.sql. Seeded
--                         by 20260827210500_seed_platform_superuser.sql.
--   cross-tenant read     "audit_events_select_platform_superuser", a row
--                         policy on public.audit_events gated on
--                         has_platform_permission('view_audit_log'), shipped
--                         in the SAME 20260826154304 migration and already
--                         proven cross-tenant in
--                         tests/integration/rls/rls.test.ts section D.
--
-- So this migration adds nothing to either surface. Renaming either one to
-- match the brief's guessed names (`platform_superusers`, `is_superuser()`)
-- would be pure churn against a working, tested design -- migrations are
-- append-only and a rename is a second migration for no behavioural gain.
-- lib/admin/audit-log.ts (the app-layer half of this task) reads
-- public.audit_events directly through the EXISTING policy above; it adds no
-- new read surface, which is the deliberate, narrow shape Task 1's brief
-- asks for ("the FIRST cross-tenant read surface... must be deliberate,
-- narrow, and tested").
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES ADD: THE SELF-AUDIT WRITE PATH
-- ===========================================================================
-- CLAUDE.md § Non-negotiable rules: "Superuser access audits itself." Viewing
-- the audit log is itself a superuser access and has no write path today --
-- private.log_audit_event is granted to no client role at all (by design,
-- 20260826154304), so nothing outside another SECURITY DEFINER function can
-- call it. The audit_document_action pair
-- (20260902031000_document_scan_and_access_audit.sql) is the precedent this
-- migration copies exactly: a `private` writer with no guard beyond input
-- validation, and a `public` thin RPC that carries the actual authorisation
-- check and is the only client-reachable entrypoint.
--
-- private.audit_superuser_audit_log_view(jsonb)
--   The writer. No guard of its own (mirrors private.audit_document_action):
--   trusts its one caller, the public wrapper below, to have already checked
--   the caller may act. Always writes action='audit_log.viewed',
--   target_type='audit_log', organisation_id=null, target_id=null,
--   before=null -- the only variable input is `after`, which the app layer
--   fills with the FILTER CRITERIA the query ran with (organisation_id,
--   actor_user_id, action, date range -- never the returned rows, never a
--   count). "no result content" (Task 1's brief) is enforced by what the
--   caller is expected to pass, the same trust boundary
--   audit_document_action already accepts for its own p_action/p_org/
--   p_document_id arguments.
--
-- public.audit_superuser_audit_log_view(jsonb)
--   The thin RPC. Checks has_platform_permission('view_audit_log') itself
--   (fail closed, 42501) before calling the writer -- so a non-superuser, or
--   a superuser session that has not reached aal2, cannot mint a
--   'audit_log.viewed' row at all, let alone read anything. Callable by any
--   authenticated caller with the anon key (the same surface every RPC has);
--   the guard is what confines that to nothing worth doing, same shape as
--   audit_document_action's own header explains for its two guards.
--
-- ===========================================================================
-- WHY THIS CANNOT RECURSE
-- ===========================================================================
-- "make sure that self-audit cannot recurse" (Task 1's brief). The call graph
-- is linear and terminates in one INSERT:
--
--   public.audit_superuser_audit_log_view
--     -> private.has_platform_permission            [reads platform_admins]
--     -> private.audit_superuser_audit_log_view
--          -> private.log_audit_event                [INSERT audit_events]
--
-- Nothing loops back. public.audit_events carries NO trigger of any kind
-- (checked: no CREATE TRIGGER ... ON public.audit_events anywhere in this
-- migration history) -- so the INSERT this call chain performs does not fire
-- anything that could call back into this function, or into
-- log_audit_event, or into itself. The chain also runs exactly once per
-- application-level call: lib/admin/audit-log.ts calls this RPC once per
-- page render, not from inside a loop over the rows it is about to fetch, so
-- there is no risk of the write's own row being read back and re-audited as
-- part of the SAME request either (it may appear on a LATER page load, like
-- any other row -- which is correct: the self-audit trail is itself part of
-- the transparent record, viewable like any other action, not a special
-- case that hides itself).
--
-- ===========================================================================
-- THE KEYSET INDEX
-- ===========================================================================
-- lib/admin/audit-log.ts pages audit_events by created_at descending with id
-- as the tie-break -- the same "redundant range bound plus exact tie-break"
-- shape lib/list/query.ts's applyCursor documents at length, because
-- PostgREST (and, here, plain SQL through the same client) has no row-value
-- comparison syntax that reaches an index the way `(col, id) > (v, i)` would.
-- 20260826151656_foundation_schema.sql already indexes created_at alone
-- (audit_events_created_at_idx, ascending); it cannot serve a DESC scan with
-- an id tie-break as a pure index walk. This composite, both columns DESC,
-- is what keeps a superuser's "Next" click O(page) rather than a sort of the
-- whole cross-tenant table -- the table lib/list/query.ts's own header
-- measures as the expensive one to get wrong, and this one has no tenant
-- filter to shrink it at all.
create index audit_events_created_at_id_desc_idx
  on public.audit_events (created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- private.audit_superuser_audit_log_view(p_filters jsonb)
-- ---------------------------------------------------------------------------
create or replace function private.audit_superuser_audit_log_view(p_filters jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := private.log_audit_event(
    p_action          => 'audit_log.viewed',
    p_target_type     => 'audit_log',
    p_organisation_id => null,
    p_target_id       => null,
    p_before          => null,
    p_after           => p_filters
  );
  return v_id;
end;
$$;

comment on function private.audit_superuser_audit_log_view(jsonb) is
  'Writer for the audit-log-viewer self-audit (CLAUDE.md: "Superuser access audits itself"). No guard of its own -- mirrors private.audit_document_action, trusting its one caller (public.audit_superuser_audit_log_view) to have already checked has_platform_permission. Always writes action=''audit_log.viewed'', target_type=''audit_log''; p_filters (the query''s filter criteria, never its result rows) becomes `after`. Granted to no client role.';

revoke all on function private.audit_superuser_audit_log_view(jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.audit_superuser_audit_log_view(p_filters jsonb)
-- ---------------------------------------------------------------------------
create or replace function public.audit_superuser_audit_log_view(p_filters jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- FAIL CLOSED. This is the only guard between "any authenticated caller
  -- with the anon key" and a write into the append-only platform audit
  -- trail -- same shape audit_document_action's public wrapper uses for its
  -- own two guards. A caller who is not the platform superuser, or is but
  -- has not reached aal2, mints no row at all.
  if not private.has_platform_permission('view_audit_log') then
    raise exception 'audit_superuser_audit_log_view: caller does not hold view_audit_log at aal2'
      using errcode = '42501';
  end if;

  return private.audit_superuser_audit_log_view(p_filters);
end;
$$;

comment on function public.audit_superuser_audit_log_view(jsonb) is
  'Client-reachable (public schema) self-audit for the superuser audit-log viewer. Records ONE audit_events row (action=audit_log.viewed) per call, carrying the caller''s filter criteria in `after` and never result content. Raises 42501 for any caller who does not hold view_audit_log at aal2 -- so a refused call writes no row. Called once per page render by lib/admin/audit-log.ts, before the page query runs; a failure here is treated as a hard refusal (no results shown without a matching audit record) rather than a silently-unaudited read.';

revoke all on function public.audit_superuser_audit_log_view(jsonb)
  from public, anon, service_role;
grant execute on function public.audit_superuser_audit_log_view(jsonb) to authenticated;
