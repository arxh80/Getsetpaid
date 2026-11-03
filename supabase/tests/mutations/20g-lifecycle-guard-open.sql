-- Phase 8 Task 9c job 1 mutant, from the LIVE pg_get_functiondef at 225 migrations.
-- the direct-UPDATE refusal: the lifecycle guard admits every write.
CREATE OR REPLACE FUNCTION private.organisation_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  if true then
    return new;
  end if;

  if new.deleted_at       is distinct from old.deleted_at
     or new.lifecycle_state  is distinct from old.lifecycle_state
     or new.lifecycle_reason is distinct from old.lifecycle_reason
  then
    raise exception
      'organisation lifecycle: deleted_at, lifecycle_state and lifecycle_reason are set only by the audited superuser lifecycle RPCs'
      using errcode = '42501', hint = 'organisation_lifecycle_is_the_rpcs';
  end if;

  return new;
end;
$function$;
