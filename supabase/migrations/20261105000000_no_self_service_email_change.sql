-- Phase 10 Task 20 fix round 1 (G11, Critical): NO SELF-SERVICE EMAIL CHANGE.
--
-- ===========================================================================
-- THE HOLE (measured on the local stack, GoTrue v2.196.0, anon key only)
-- ===========================================================================
-- A squatter with a confirmed account of their own sends
-- PUT /auth/v1/user {email: <victim>} and GoTrue mails a "Confirm your new
-- email address" link to BOTH addresses ([auth.email] double_confirm_changes
-- = true). The squatter confirms the leg sent to their own old inbox; when
-- the victim follows the unsolicited one, the squatter's account holds the
-- victim's address, confirmed, with the squatter's password -- and the
-- squatter signs in as the victim. It works in EITHER order: if the victim
-- clicks first, the squatter's own click completes the change in the
-- squatter's browser. So routing the link through /auth/callback and forcing
-- a new password there would hand the forced password to whoever clicked
-- last -- possibly the squatter. The first-proof marker cannot help either:
-- it is keyed on the account, and this account was proved long ago.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- GetSetPaid has no change-email feature (nothing in lib/ or app/ calls
-- updateUser({ email })), so every self-service address change is a raw
-- GoTrue call and hostile by default. GoTrue records a pending change in
-- auth.users.email_change before it mails either link; this trigger refuses
-- that write, so the request fails and no link exists. The Admin API's
-- direct email update (server-side, service role) does not use the column
-- and is unaffected, as is anything that CLEARS it. A future change-email
-- feature must replace this trigger with a design that survives both click
-- orders -- it is not a toggle.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.refuse_self_service_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.email_change, '') <> ''
     and new.email_change is distinct from old.email_change then
    raise exception 'auth.users: changing an account''s email address is not available'
      using errcode = '42501', hint = 'email_change_disabled';
  end if;
  return new;
end;
$$;

comment on function private.refuse_self_service_email_change() is
  'BEFORE UPDATE OF email_change trigger on auth.users (20261105000000; Phase 10 Task 20 fix round 1, G11): refuses recording a pending email change, so GoTrue''s PUT /auth/v1/user {email} fails before any confirmation link exists. Closes the email-change account takeover measured on the local stack (a confirmed account takes a victim''s address, with its own password, in either click order). The product has no change-email feature; one would need its own design, not the removal of this trigger.';

revoke all on function private.refuse_self_service_email_change() from public, anon, authenticated, service_role;

create trigger refuse_self_service_email_change
  before update of email_change on auth.users
  for each row
  execute function private.refuse_self_service_email_change();
