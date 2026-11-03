-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- M4: THE TOMBSTONE'S GUARD WAS A COLUMN LIST,
-- AND TWO COLUMNS IT OMITTED WERE WRITABLE.
--
-- private.tombstone_is_not_a_login() (20260930000000) refuses the tombstone a
-- password, a confirmed email or phone, a changed address, a lifted ban and an
-- SSO/anonymous flip. It did not mention `role` or `raw_app_meta_data`, and
-- both took an UPDATE:
--
--     update auth.users set role = 'service_role' where id = <tombstone>;  --> UPDATE 1
--     update auth.users set raw_app_meta_data = raw_app_meta_data
--            || '{"role":"service_role"}' where id = <tombstone>;          --> UPDATE 1
--
-- NOT A LIVE PATH -- both need direct database access, and with no password,
-- no auth.identities row and banned_until = 'infinity' the tombstone still
-- cannot be issued a token, so neither write grants anything on its own. It is
-- closed because the guard READS as exhaustive while being a list: the next
-- column that matters would not be on it either. `role` and
-- `raw_app_meta_data` are the two that decide what a token would say if one
-- were ever minted, which makes them the two worth naming.
--
-- Everything else about the row stays writable on purpose: GoTrue itself
-- writes bookkeeping columns (updated_at, last_sign_in_at and the token
-- columns) and a guard that froze the whole row would refuse the platform's
-- own housekeeping.
--
-- ADDITIVE. Rebuilt from its LATEST definition (20260930000000 section 3);
-- the DELETE branch and the existing login-shaped columns are unchanged.
-- ===========================================================================

create or replace function private.tombstone_is_not_a_login()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if old.id is distinct from private.erased_user_id() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'the erased-user tombstone cannot be deleted: every pseudonymised audit row hangs from it'
      using errcode = '42501', hint = 'tombstone_is_permanent';
  end if;

  if new.encrypted_password is not null
     or new.email_confirmed_at is not null
     or new.phone_confirmed_at is not null
     or new.banned_until is distinct from old.banned_until
     or new.email is distinct from old.email
     or new.is_sso_user is distinct from old.is_sso_user
     or new.is_anonymous is distinct from old.is_anonymous
     -- M4: the two that decide what a token would SAY, if the five refusals
     -- above ever stopped being enough to make sure one is never minted.
     or new.role is distinct from old.role
     or new.raw_app_meta_data is distinct from old.raw_app_meta_data then
    raise exception 'the erased-user tombstone is not a login and cannot be made into one'
      using errcode = '42501', hint = 'tombstone_is_not_a_login';
  end if;

  return new;
end;
$$;

comment on function private.tombstone_is_not_a_login() is
  'BEFORE UPDATE OR DELETE on auth.users, for the Q130 tombstone alone (rebuilt in 20261001005000 from 20260930000000). It cannot be deleted -- every pseudonymised audit row hangs from it -- and it cannot be made into a login: no password, no confirmed email or phone, no changed address, no lifted ban, no SSO or anonymous flip, and since fix round 1 (M4) no change to `role` or `raw_app_meta_data` either, the two columns that decide what a token would say. Everything else on the row stays writable, because GoTrue writes its own bookkeeping columns and a guard that froze the whole row would refuse the platform''s housekeeping.';
