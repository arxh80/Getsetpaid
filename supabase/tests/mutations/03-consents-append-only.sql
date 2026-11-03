-- PHASE 8 TASK 8 MUTANT 03-consents-append-only
-- guard:  private.consents_guard
-- change: the append-only guard passes every UPDATE and DELETE
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.consents_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then return old; end if;
  return new;
  if tg_op = 'UPDATE' then
    raise exception 'consents: the consent ledger is append-only -- record a new event instead'
      using errcode = '42501';
  end if;
  -- DELETE. Depth 1 is a DELETE statement (from any role, or any function).
  -- Depth >= 2 is a trigger's DELETE -- allowed only when it is the cascade
  -- from the account's own deletion, i.e. the account is already gone.
  if pg_catalog.pg_trigger_depth() < 2
     or exists (select 1 from auth.users u where u.id = old.user_id) then
    raise exception 'consents: the consent ledger is append-only -- rows go only with the account they belong to'
      using errcode = '42501';
  end if;
  return old;
end;
$function$;
