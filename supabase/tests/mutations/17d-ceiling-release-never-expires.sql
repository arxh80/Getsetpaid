-- PHASE 8 TASK 9a MUTANT 17d-ceiling-release-never-expires (Q184, founder 2026-09-30)
-- guard:  private.audit_ceiling_release_active
-- change: the reader no longer compares now() with expires_at
-- Generated from the LIVE definition at 213 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.audit_ceiling_release_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select s.audit_ceiling_released_at <= pg_catalog.now()
       
       and s.audit_ceiling_release_expires_at <= s.audit_ceiling_released_at + interval '72 hours'
      from public.retention_settings s
     where s.id), false);
$function$;
