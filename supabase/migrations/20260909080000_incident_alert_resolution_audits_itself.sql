-- Phase 7 Task 5, fix round 1, review finding I4: resolving an incident alert
-- wrote no `audit_events` row, and the compensating control it relied on is
-- erasable by its own reopen branch.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- `resolveIncidentAlertAction` was defended -- in the report and in the file's
-- own header -- on the grounds that "the accountability lives in
-- resolved_by/resolved_at on the row itself instead". It does not:
--
--   const reopen = formData.get("reopen") === "true";
--   … .update(reopen ? { resolved_at: null, resolved_by: null } : {…})
--
-- and § RA17 confirms the guard permits un-resolving. So resolve -> reopen
-- leaves the row reading `null, null` with NO record anywhere that it was ever
-- resolved, by whom, or when. The stated compensating control is destroyed by
-- a branch of the same action, and that branch is reachable from a crafted
-- form post even though the UI renders no control for it.
--
-- CLAUDE.md § Non-negotiable rules: "Audit high-value actions" and "Superuser
-- access audits itself". READING this page already audits itself
-- (`platform_health.viewed`, inside the snapshot RPC) and every other
-- superuser WRITE in Phase 7 audits. This was the sole exception, and its
-- justification did not hold.
--
-- ===========================================================================
-- A TRIGGER, NOT A CALL IN THE SERVER ACTION
-- ===========================================================================
-- The review's recommendation was an audit row from the action. A trigger is
-- strictly stronger for the same effort and is the shape this schema already
-- uses when a fact must hold "for every path that ever sets the status"
-- (`private.document_quarantine_alert()`'s own comment). `incident_alerts`
-- carries a client UPDATE grant and a permissive UPDATE policy for the
-- superuser, so `PATCH /rest/v1/incident_alerts?id=eq.…` from the operator's
-- own browser is a real resolve path that no application-side call site can
-- cover. Here, both paths audit.
--
-- THE EXEMPTION IS `auth.uid() is null`, NOT `row_security_active()`, and the
-- difference is not cosmetic. The sibling guard on this table
-- (`private.incident_alert_resolution_guard()`) is SECURITY INVOKER, so
-- `row_security_active()` there is evaluated as the CALLING role and is true
-- for any browser session. This function must be SECURITY DEFINER --
-- `private.log_audit_event()` is granted to no client role at all -- so inside
-- it the current user is the owner, `row_security_active()` is false for
-- everybody, and copying that guard would have made this trigger a no-op for
-- every caller (measured: it wrote zero rows). `auth.uid() is null` is the
-- test `private.audit_crm_row()` and `private.audit_network_row()` already use
-- for exactly this reason: a migration, a seed, a cascade or a fixture is not
-- a client action, and `log_audit_event()` raises 28000 rather than write an
-- unattributable row (20260826154304's own reasoning). Task 6's sender is
-- unaffected either way: it stamps `notified_at`, and this trigger's WHEN
-- clause fires on the resolution pair alone.
--
-- BEFORE AND AFTER, NOT JUST THE NEW STATE. A reopen's whole significance is
-- what it erased, so `before` carries the resolution it removed. That is what
-- makes the trail survive the branch that motivated this migration.
--
-- ADDITIVE. No previously applied migration is edited; the resolution guard,
-- the policy and the grants are untouched.

create or replace function private.audit_incident_alert_resolution()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- NOT A CLIENT ACTION (see the header): a migration, a seed, a fixture or a
  -- cascade has no auth.uid() to attribute, and log_audit_event refuses to
  -- write an unattributable row. row_security_active() is the WRONG test here
  -- because this function is SECURITY DEFINER and would therefore skip for
  -- everybody.
  if (select auth.uid()) is null then
    return null;
  end if;

  perform private.log_audit_event(
    p_action      => case when new.resolved_at is null
                          then 'incident_alert.reopened'
                          else 'incident_alert.resolved' end,
    p_target_type => 'incident_alert',
    -- The alert's own organisation, when it has one. A user-scoped crossing
    -- has none (20260909050000, finding I1), and a null here is the same
    -- "platform-scoped, not a tenant's" fact `platform_health.viewed` records.
    p_organisation_id => new.organisation_id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object(
                           'resolved_at', old.resolved_at,
                           'resolved_by', old.resolved_by),
    p_after           => pg_catalog.jsonb_build_object(
                           'alert_type',  new.alert_type,
                           'resolved_at', new.resolved_at,
                           'resolved_by', new.resolved_by)
  );
  return null;
end;
$$;

comment on function private.audit_incident_alert_resolution() is
  'Writes incident_alert.resolved / incident_alert.reopened into public.audit_events for every client resolve or reopen (fix round 1, review finding I4: this was the only superuser write in Phase 7 with no audit row, and the resolved_by column it relied on for accountability is nulled by the action''s own reopen branch, which RA17 permits). A TRIGGER rather than a call in resolveIncidentAlertAction, because the table carries a client UPDATE grant and a permissive superuser UPDATE policy -- a raw PATCH is a real resolve path no call site could cover. `before` carries the resolution that was removed, which is the half a reopen would otherwise erase. Exempts callers with no auth.uid() -- a migration, a seed, a cascade, a fixture -- the private.audit_crm_row/private.audit_network_row test, deliberately NOT row_security_active(): this function is SECURITY DEFINER (log_audit_event is granted to no client role), so row_security_active() inside it is false for every caller and would make the trigger a no-op.';

revoke all on function private.audit_incident_alert_resolution()
  from public, anon, authenticated, service_role;

create trigger incident_alerts_audit_resolution
  after update on public.incident_alerts
  for each row
  when (old.resolved_at is distinct from new.resolved_at
        or old.resolved_by is distinct from new.resolved_by)
  execute function private.audit_incident_alert_resolution();
