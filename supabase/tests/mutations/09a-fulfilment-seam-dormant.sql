-- PHASE 8 TASK 8 MUTANT 09a-fulfilment-seam-dormant
-- guard:  private.dsr_fulfilment_job_ready
-- change: both halves answer false again, so a request can be closed by hand with no job having run
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.dsr_fulfilment_job_ready(p_kind text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select false and case p_kind
           when 'export'  then true   -- Phase 8 Task 4 shipped: public.export_jobs
           when 'erasure' then true   -- Phase 8 Task 5 shipped: public.erasure_jobs
           else false
         end
$function$;
