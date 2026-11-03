-- PHASE 8 TASK 8 MUTANT 12b-membership-keeps-an-owner
-- guard:  private.membership_keeps_an_owner
-- change: the last-owner trigger on organisation_memberships passes every change
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.membership_keeps_an_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_name text;
begin
  -- Only the loss of an ACTIVE OWNER can leave a workspace ownerless.
  if true or not (old.role = 'owner' and old.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and new.role = 'owner' and new.status = 'active'
     and new.organisation_id = old.organisation_id
     and new.user_id = old.user_id then
    return new;
  end if;

  -- THE CASCADE THIS IS NOT ABOUT: the workspace itself is being deleted (the
  -- parent row goes first, so it is already absent here).
  select o.name into v_name
    from public.organisations o
   where o.id = old.organisation_id and o.deleted_at is null;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- THE ACCOUNT CASCADE, NOW GATED ON THE DECLARATION (Q179). The row being
  -- gone is still necessary -- organisation_memberships.user_id is ON DELETE
  -- CASCADE, so nothing but an account deletion can reach here -- and it is
  -- no longer sufficient. private.erase_account() declares itself; a direct
  -- `delete from auth.users` and a Studio Auth-page click do not.
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id) then
    if private.account_deletion_is_sanctioned(old.user_id) then
      return old;
    end if;
    -- It is only a REFUSAL where it would have been DAMAGE. An undeclared
    -- deletion of somebody who is not the last Owner of a live, non-empty
    -- workspace falls through to the checks below and is admitted exactly as
    -- before.
    if exists (select 1 from public.organisation_memberships m
                where m.organisation_id = old.organisation_id
                  and m.user_id <> old.user_id
                  and m.role = 'owner'
                  and m.status = 'active') then
      return old;
    end if;
    if not exists (select 1 from public.organisation_memberships m
                    where m.organisation_id = old.organisation_id
                      and m.user_id <> old.user_id)
       and private.organisation_is_empty(old.organisation_id) then
      return old;
    end if;
    raise exception 'Deleting this account directly would leave % with no owner. private.erase_account() is the only sanctioned account deletion; it checks this under a lock, transfers what it must and refuses when it cannot.', v_name
      using errcode = '42501', hint = 'account_deletion_is_not_sanctioned';
  end if;

  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id
                and m.role = 'owner'
                and m.status = 'active') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- No other active Owner. An empty workspace with nobody else in it is
  -- allowed to end this way -- there is nothing to strand.
  if exists (select 1 from public.organisation_memberships m
              where m.organisation_id = old.organisation_id
                and m.user_id <> old.user_id)
     or not private.organisation_is_empty(old.organisation_id) then
    raise exception 'That would leave % with no owner. Make somebody else an owner there first.', v_name
      using errcode = '22023', hint = 'last_owner_of_workspace';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
