-- PHASE 8 TASK 8 MUTANT 12a-erasure-last-owner-guard
-- guard:  private.assert_account_is_erasable
-- change: the Q131 guard answers 'erasable' for everybody
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.assert_account_is_erasable(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_owned   text;
  v_unowned text;
begin
  return;
  select pg_catalog.string_agg(b.organisation_name, ', ' order by b.organisation_name)
           filter (where b.reason <> 'no_owner_to_transfer'),
         pg_catalog.string_agg(b.organisation_name, ', ' order by b.organisation_name)
           filter (where b.reason = 'no_owner_to_transfer')
    into v_owned, v_unowned
    from private.account_erasure_blockers(p_user_id) b;

  if v_owned is not null and v_unowned is null then
    -- Unchanged: the subject is an Owner of every blocker and both remedies
    -- are theirs to perform.
    raise exception 'Deleting this account would leave % with no owner. Make somebody else an owner there, or close the workspace, and then ask again.', v_owned
      using errcode = '22023', hint = 'last_owner_of_workspace';
  elsif v_owned is null and v_unowned is not null then
    -- N2: name the door that opens. Not an address -- the support contact is
    -- an environment value rendered at request time (SECURITY.md section 13),
    -- and the database is deliberately not one of the places it is written
    -- down.
    raise exception 'Deleting this account would leave % with no owner, and you are not an owner of it -- so you cannot make somebody else one, and there is no way for a member to close a workspace. Contact support and ask them to close it, and then ask again.', v_unowned
      using errcode = '22023', hint = 'workspace_has_no_owner';
  elsif v_owned is not null and v_unowned is not null then
    raise exception 'Deleting this account would leave % with no owner: make somebody else an owner there, or close the workspace. It would also leave % with no owner, and you are not an owner of that one -- contact support and ask them to close it. Then ask again.', v_owned, v_unowned
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;
end;
$function$;
