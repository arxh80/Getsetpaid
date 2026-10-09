-- Phase 8 Task 9c job 1 mutant, from the LIVE pg_get_functiondef at 225 migrations.
-- the write refusal while closed, at the gate: the CRM write gate ignores deleted_at.
CREATE OR REPLACE FUNCTION private.crm_write_organisations()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.organisation_id
  from public.organisation_memberships m
  join public.organisations o
    on o.id = m.organisation_id
  join lateral private.effective_organisation_plan(m.organisation_id) e on true
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and e.crm_writes
    and e.status_ok;
$function$;
