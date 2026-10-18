-- Phase 10 Task 20 (Q245, Critical): A PASSWORD CHOSEN AFTER THE PROOF.
--
-- ===========================================================================
-- THE RESIDUAL THIS CLOSES (G11, measured on GoTrue v2.196.0 by Task 4)
-- ===========================================================================
-- GoTrue keeps the FIRST password on an unconfirmed re-sign-up, and confirming
-- does not replace it. So a squatter who signs up as somebody else's address
-- first owns the account its real owner later confirms -- by signing up over
-- it, by following the squatter's own confirmation email, by asking for an
-- emailed sign-in link (GoTrue sends a sign-up confirmation instead), or by
-- following a recovery email anybody can request.
--
-- The fix lives in app/auth/callback/route.ts and lib/auth/first-proof.ts: an
-- address's FIRST proof keeps the password only when the browser proving it
-- is the browser whose sign-up created the account; otherwise the password is
-- replaced, every other session is signed out, and the user must choose a new
-- one. This table is how the callback tells a FIRST proof from a later one.
--
-- ===========================================================================
-- WHAT THIS MIGRATION ADDS
-- ===========================================================================
--   1. private.address_first_proofs: one row per account whose address has
--      been proved through the callback, recording whether the pre-proof
--      password was kept. Not exposed (private schema), granted to nobody.
--   2. Two SECURITY DEFINER functions, executable by service_role ALONE and
--      refusing any session with a person on it -- the callback's only reach
--      into the table, through lib/auth/first-proof.ts (the service-role
--      client census names that file):
--        public.address_is_proved(uuid)                  -> boolean
--        public.record_address_first_proof(uuid, boolean) -> void
--   3. A BACKFILL: every account already confirmed is recorded as proved,
--      password kept, so no existing account is sent to /set-password.
--   4. A trigger on auth.users doing the same for an account created ALREADY
--      confirmed after today (Admin API, OAuth).
--   5. 'set-password' joins the reserved workspace slugs (a new top-level route).
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- 1. THE MARKER.
create table private.address_first_proofs (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  proved_at     timestamptz not null default now(),
  password_kept boolean not null
);

revoke all on table private.address_first_proofs from public, anon, authenticated, service_role;

comment on table private.address_first_proofs is
  'THE FIRST PROOF OF AN ADDRESS (20261104000000; Phase 10 Task 20, Q245). One row per account whose email address has been proved through app/auth/callback/route.ts, or that was already confirmed when this table arrived (the backfill, password_kept = true). password_kept says whether the password set before the proof survived it: true when the proving browser held the sign-up binding (or the account has no email identity, so no password), false when the callback replaced it and required a new one. No row = the next proof through the callback is the first. Not exposed, granted to nobody; read and written ONLY by public.address_is_proved() and public.record_address_first_proof() (service_role, sessionless); deleted by the FK cascade with the account.';


-- 2. THE TWO ENTRY POINTS.
create or replace function public.address_is_proved(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'address_is_proved: read by the auth callback, never from a person''s session'
      using errcode = '42501', hint = 'address_first_proof_is_server_only';
  end if;

  return exists (select 1 from private.address_first_proofs where user_id = p_user_id);
end;
$$;

revoke all on function public.address_is_proved(uuid) from public, anon, authenticated;
grant execute on function public.address_is_proved(uuid) to service_role;

comment on function public.address_is_proved(uuid) is
  'Has this account''s address already been proved (a row in private.address_first_proofs)? Called by lib/auth/first-proof.ts from the auth callback after verifyOtp / the code exchange, to tell an address''s FIRST proof from a later one. service_role only; refuses any session (42501 address_first_proof_is_server_only). Answers one boolean about one account.';

create or replace function public.record_address_first_proof(p_user_id uuid, p_password_kept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'record_address_first_proof: written by the auth callback, never from a person''s session'
      using errcode = '42501', hint = 'address_first_proof_is_server_only';
  end if;

  if p_user_id is null or p_password_kept is null then
    raise exception 'record_address_first_proof: user and outcome are required'
      using errcode = '22023', hint = 'address_first_proof_incomplete';
  end if;

  -- The first record stands: a concurrent second proof (two tabs) changes nothing.
  insert into private.address_first_proofs (user_id, password_kept)
  values (p_user_id, p_password_kept)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function public.record_address_first_proof(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_address_first_proof(uuid, boolean) to service_role;

comment on function public.record_address_first_proof(uuid, boolean) is
  'Records an account''s FIRST proof of address in private.address_first_proofs, with whether the pre-proof password was kept. Called by lib/auth/first-proof.ts from the auth callback ONLY after the outcome is complete (password kept, or replaced with other sessions signed out and the must-choose mark set), so a failure part-way leaves no row and the next proof retries. The first row stands (ON CONFLICT DO NOTHING). service_role only; refuses any session (42501 address_first_proof_is_server_only); a null argument is 22023 address_first_proof_incomplete.';


-- 3. THE BACKFILL: an account confirmed before this table existed is not gated.
insert into private.address_first_proofs (user_id, proved_at, password_kept)
select u.id, coalesce(u.email_confirmed_at, now()), true
  from auth.users u
 where u.email_confirmed_at is not null
on conflict (user_id) do nothing;


-- 4. AN ACCOUNT BORN CONFIRMED. Only the server (the Admin API with
--    email_confirm) or an OAuth provider can create an account whose address
--    is already confirmed; neither went through a proof the callback could
--    see, and neither carries a squatter's password. Without this row its
--    first emailed sign-in link would count as a first proof and replace a
--    password its owner chose.
--
--    MEASURED (GoTrue v2.196.0): the Admin API does not insert a confirmed
--    row. In ONE transaction it inserts the account unconfirmed, then updates
--    email_confirmed_at. So "born confirmed" is "confirmed in the transaction
--    that created it": the INSERT leaves a transaction-local marker
--    (set_config(..., true), gone at commit) and the UPDATE that confirms
--    reads it. A self-service sign-up or an invitation is confirmed later, in
--    another transaction, by the proof itself -- which must stay the
--    callback's to record, so that UPDATE writes nothing here.
create or replace function private.record_born_confirmed_address()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_created_here text := 'gsp.created_in_tx_' || pg_catalog.replace(new.id::text, '-', '');
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.set_config(v_created_here, 'on', true);
  end if;

  if new.email_confirmed_at is not null
     and pg_catalog.current_setting(v_created_here, true) = 'on' then
    insert into private.address_first_proofs (user_id, proved_at, password_kept)
    values (new.id, new.email_confirmed_at, true)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

comment on function private.record_born_confirmed_address() is
  'AFTER INSERT OR UPDATE OF email_confirmed_at trigger on auth.users (20261104000000; Phase 10 Task 20): an account confirmed IN THE TRANSACTION THAT CREATED IT (the Admin API with email_confirm inserts unconfirmed and confirms in the same transaction, measured; OAuth) is recorded in private.address_first_proofs as proved, password kept, so its first emailed link is not treated as the first proof of its address. An account confirmed in a later transaction (self-service sign-up, invitation) gets no row here; its first proof through the auth callback writes one.';

revoke all on function private.record_born_confirmed_address() from public, anon, authenticated, service_role;

create trigger on_auth_user_confirmed_at_birth
  after insert or update of email_confirmed_at on auth.users
  for each row
  execute function private.record_born_confirmed_address();


-- 5. /set-password IS A TOP-LEVEL ROUTE, so its segment is a reserved
--    workspace slug (Q151; tests/unit/org/reserved-slugs.test.ts). Rebuilt
--    from the live definition, which matched 20260923005000 exactly; the one
--    change is the 'set-password' row.
create or replace function private.reserved_workspace_slugs()
returns table (slug text)
language sql
immutable
set search_path = ''
as $$
  values ('account'::text),
         ('api'::text),
         ('auth'::text),
         ('invites'::text),
         ('legal'::text),
         ('login'::text),
         ('magic-link'::text),
         ('onboarding'::text),
         ('set-password'::text),
         ('signup'::text),
         ('super'::text);
$$;

comment on function private.reserved_workspace_slugs() is
  'The static top-level route segments of the app (20260923005000, Q151; set-password added by 20261104000000): a workspace slug equal to one would be shadowed by that route. Asserted equal to the segments app/ defines by tests/unit/org/reserved-slugs.test.ts; mirrored by lib/org/reserved-slugs.ts. Enforced by private.organisations_slug_not_reserved().';

revoke all on function private.reserved_workspace_slugs() from public, anon, authenticated, service_role;
