-- PHASE 8 TASK 9a MUTANT 17h-ceiling-release-can-be-extended (Q184, founder 2026-09-30)
-- guard:  public.release_audit_purge_ceiling
-- change: one-at-a-time is gone: a second press while active re-releases
-- Generated from the LIVE definition at 213 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION public.release_audit_purge_ceiling(p_reason text)
 RETURNS retention_settings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  -- THE PLATFORM SUPERUSER, AT aal2. private.has_platform_permission() is
  -- both halves: the one platform_admins row AND private.session_is_aal2().
  -- Step-up is "any high-risk admin/superuser function" (CLAUDE.md § Session
  -- security) and this one lets the largest delete in the product proceed.
  if not private.has_platform_permission('manage_retention') then
    raise exception 'release_audit_purge_ceiling: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'audit_ceiling_release_is_superuser_only';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'release_audit_purge_ceiling: a reason is required'
      using errcode = '22023', hint = 'audit_ceiling_release_needs_a_reason';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'release_audit_purge_ceiling: the reason is longer than 500 characters'
      using errcode = '22023', hint = 'audit_ceiling_release_reason_too_long';
  end if;

  -- ONE AT A TIME. The row lock serialises two presses; the check refuses a
  -- second release while one is active rather than extending it.
  select * into v_before from public.retention_settings s where s.id for update;
  if false then
    raise exception 'release_audit_purge_ceiling: a release is already active until %',
      v_before.audit_ceiling_release_expires_at
      using errcode = '55000', hint = 'audit_ceiling_release_already_active';
  end if;

  update public.retention_settings s
     set audit_ceiling_released_at        = pg_catalog.now(),
         audit_ceiling_release_expires_at = pg_catalog.now() + interval '72 hours',
         audit_ceiling_release_reason     = pg_catalog.btrim(p_reason)
   where s.id
  returning * into v_after;

  perform private.log_audit_event(
    'retention.audit_ceiling_released', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'released_at', v_before.audit_ceiling_released_at,
      'expires_at',  v_before.audit_ceiling_release_expires_at),
    pg_catalog.jsonb_build_object(
      'released_at', v_after.audit_ceiling_released_at,
      'expires_at',  v_after.audit_ceiling_release_expires_at,
      'reason',      v_after.audit_ceiling_release_reason));

  return v_after;
end;
$function$;
