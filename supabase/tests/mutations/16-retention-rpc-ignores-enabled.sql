-- PHASE 8 TASK 8 MUTANT 16-retention-rpc-ignores-enabled
-- guard:  public.set_retention_enabled
-- change: the operator's kill-switch RPC ignores p_enabled and keeps the
--         current value (audit_purge_enabled, the reason and the audit row are
--         still written) -- the founder presses "off" and the job keeps running.
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION public.set_retention_enabled(p_enabled boolean, p_audit_purge_enabled boolean, p_reason text)
 RETURNS retention_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  if not private.has_platform_permission('manage_retention') then
    raise exception 'set_retention_enabled: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'retention_switch_is_superuser_only';
  end if;
  if p_enabled is null or p_audit_purge_enabled is null then
    raise exception 'set_retention_enabled: both switches must be named'
      using errcode = '22023', hint = 'retention_switch_needs_both';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'set_retention_enabled: a reason is required'
      using errcode = '22023', hint = 'retention_switch_needs_a_reason';
  end if;

  select * into v_before from public.retention_settings s where s.id;

  update public.retention_settings s
     set enabled             = s.enabled,
         audit_purge_enabled = p_audit_purge_enabled,
         reason              = pg_catalog.btrim(p_reason),
         updated_at          = pg_catalog.now(),
         updated_by          = (select auth.uid())
   where s.id
  returning * into v_after;

  -- AUDITED LIKE ANY OTHER HIGH-VALUE ADMIN ACTION. The reason travels in the
  -- payload, which is the whole reason it is mandatory: a switch that was
  -- flipped with no recorded why is a switch nobody can reason about later.
  perform private.log_audit_event(
    'retention_settings.changed', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'enabled', v_before.enabled, 'audit_purge_enabled', v_before.audit_purge_enabled),
    pg_catalog.jsonb_build_object(
      'enabled', v_after.enabled, 'audit_purge_enabled', v_after.audit_purge_enabled,
      'reason', v_after.reason));

  return v_after;
end;
$function$

;
