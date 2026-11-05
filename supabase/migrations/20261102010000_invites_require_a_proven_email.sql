-- ===========================================================================
-- Phase 10 Task 4 (G11, Critical): an invitation is accepted only by an
-- account that has PROVED its email address.
--
-- THE HOLE. Account pre-hijacking through invites. A squatter signs up as
-- bookings@victim.example before the victim ever does. A workspace later
-- invites that address, lib/org/actions.ts binds the invitation to the
-- squatter's existing auth.users id, and public.accept_invite() checked only
-- user_id = auth.uid() and status = 'invited'. Whoever held a session for that
-- auth.users row joined the tenant with the invited role. Nothing asked
-- whether the account had ever shown it controls the inbox the invitation was
-- addressed to. Reproduced through the real forms before this migration, with
-- confirmations off (the old local config): the squatter's membership went
-- from 'invited' to 'active' as a Manager.
--
-- WHAT THIS MIGRATION ADDS, AND WHAT IT DOES NOT CLOSE ON ITS OWN.
-- One refusal, before any read of the membership and before any write: the
-- caller's auth.users row must carry email_confirmed_at. SQLSTATE 42501, hint
-- invite_email_unconfirmed (the hint is what tells it apart from the 42501 of
-- "no such invitation / not yours", which must stay indistinguishable from
-- each other -- design note (c) of 20260827015924 -- and still are). The
-- check is about the CALLER only, so it reveals nothing about any membership.
--
-- It is defence in depth, not the whole fix, and the order of the layers is
-- worth stating so nobody leans on this one alone:
--   * With confirmations OFF, GoTrue confirms every sign-up at once, so a
--     squatter's email_confirmed_at is set and this check passes. Path 1 is
--     closed by [auth.email] enable_confirmations = true (config.toml,
--     asserted by tests/unit/security/auth-config.test.ts, and on the
--     SECURITY.md § 15 hosted checklist).
--   * With confirmations ON, the squatter's account is unconfirmed until the
--     inbox proves it, and the real owner following an invitation link is
--     exactly what confirms it -- with the squatter's password intact. That
--     is path 2, and it is closed in the invite step (lib/org/actions.ts),
--     which refuses to bind an existing unconfirmed sign-up BEFORE any
--     invitation email exists. This refusal cannot see that case: by the
--     time anyone could accept, the account is confirmed.
--   * What this refusal does catch is any session held by an account that
--     never proved its address: a future GoTrue setting that admits
--     unverified sign-ins (MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS), a
--     hand-made auth.users row, or a path not yet written. Joining a tenant
--     is the one write in the product that is granted to an email address,
--     so it is the one that asks for the address to be proven.
--
-- REBUILT FROM THE LIVE DEFINITION. pg_get_functiondef(public.accept_invite)
-- was diffed against 20260827015924 first: the body was identical
-- (20260828220000 changed only the object comment). The body below is that
-- one with the single new block marked G11; nothing else moved.
-- ===========================================================================

create or replace function public.accept_invite(p_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_role   text;
  v_status text;
begin
  -- Defence in depth: this function bypasses RLS, so it re-checks the one
  -- thing RLS would otherwise have guaranteed.
  if v_actor is null then
    raise exception 'accept_invite: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if p_membership_id is null then
    raise exception 'accept_invite: membership id is required'
      using errcode = '22023';
  end if;

  -- G11 (20261102010000): the caller's account must have proved its email
  -- address. An invitation is addressed to an inbox, and accepting it is the
  -- one write in the product granted to an email address, so an account that
  -- never showed it controls that inbox does not get to accept. Before the
  -- membership lookup: it is about the caller, reveals nothing about any
  -- row, and refuses before anything is read or written. A missing auth.users
  -- row (a deleted account with a still-live token) is refused the same way.
  if not exists (
    select 1
      from auth.users u
     where u.id = v_actor
       and u.email_confirmed_at is not null
  ) then
    raise exception 'accept_invite: confirm your email address before accepting an invitation'
      using errcode = '42501', hint = 'invite_email_unconfirmed';
  end if;

  -- The ownership check lives in the WHERE clause, not in a later IF: the row
  -- is never even read into a variable unless it belongs to the caller. FOR
  -- UPDATE holds it until commit so a concurrent second accept cannot also
  -- observe status='invited' (design note (d)).
  select m.organisation_id, m.role, m.status
    into v_org, v_role, v_status
    from public.organisation_memberships m
   where m.id = p_membership_id
     and m.user_id = v_actor
   for update;

  -- Same error for "no such row" and "that row is not yours" -- see design
  -- note (c). Do not split these apart.
  if not found then
    raise exception 'accept_invite: no pending invitation found'
      using errcode = '42501';
  end if;

  if v_status <> 'invited' then
    raise exception 'accept_invite: invitation is not pending (status is %)', v_status
      using errcode = '22023';
  end if;

  -- Dead code today ('platform_superuser' is not in the roles catalogue, so
  -- the FK on organisation_memberships.role already rejects it) and kept for
  -- the same reason Task 4 kept its copies: it costs nothing and it holds if
  -- that key is ever re-introduced. See Task 4 design note (c).
  if v_role = 'platform_superuser' then
    raise exception 'accept_invite: platform superuser is not an organisation role'
      using errcode = '42501';
  end if;

  -- Joining a soft-deleted tenant would produce an active membership of an
  -- organisation the user can never see (organisations_select_member does not
  -- filter deleted_at, but every product surface does, and a suspended org
  -- must not gain members).
  if exists (
    select 1
      from public.organisations o
     where o.id = v_org
       and o.deleted_at is not null
  ) then
    raise exception 'accept_invite: organisation is no longer active'
      using errcode = '22023';
  end if;

  update public.organisation_memberships m
     set status     = 'active',
         joined_at  = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where m.id      = p_membership_id
     -- Both predicates are re-asserted rather than trusted from the SELECT
     -- above: the UPDATE must be correct on its own terms, not because an
     -- earlier statement in this function happened to check them.
     and m.user_id = v_actor
     and m.status  = 'invited';

  if not found then
    raise exception 'accept_invite: invitation could not be accepted'
      using errcode = '55000';
  end if;

  perform private.log_audit_event(
    p_action          => 'membership.accepted',
    p_target_type     => 'organisation_membership',
    p_organisation_id => v_org,
    p_target_id       => p_membership_id,
    p_before          => pg_catalog.jsonb_build_object('status', 'invited'),
    p_after           => pg_catalog.jsonb_build_object('status', 'active', 'role', v_role)
  );
end;
$$;

-- CREATE OR REPLACE keeps the existing ACL; restated so this file is correct
-- on its own terms (20260827015924's grant, unchanged).
revoke all on function public.accept_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.accept_invite(uuid) to authenticated;

comment on function public.accept_invite(uuid) is
  'Flips the CALLER''S OWN pending organisation_memberships row from ''invited'' to ''active'' and stamps joined_at, then audits it as ''membership.accepted''. The only sanctioned path for that transition -- the client-facing UPDATE policy refuses it for everyone including the invitee. REFUSES AN ACCOUNT THAT HAS NOT PROVED ITS EMAIL (20261102010000, G11): auth.users.email_confirmed_at must be set for auth.uid(), else 42501 with hint invite_email_unconfirmed, before anything is read or written. Defence in depth for account pre-hijacking through invites -- the primary closures are [auth.email] enable_confirmations = true and the invite step''s refusal to bind an existing unconfirmed sign-up (lib/org/actions.ts); see the migration header for which path each layer closes. Ownership is enforced as user_id = auth.uid() in the lookup itself; a row that does not exist and a row belonging to someone else raise the identical error (the email refusal is told apart by its hint and concerns only the caller). REFUSES A SOFT-DELETED (SUSPENDED) ORGANISATION, and the reason recorded in the body''s inline comment is half wrong: it says such a membership would be "of an organisation the user can never see", which stopped being true at 20260828210000 (DECISIONS-QUEUE § Q6 -- suspension is read-only, members DO see their own CRM). The refusal stands on the other half, which is the load-bearing one: accepting an invite is a WRITE, and a suspended organisation must not gain members. 20260828220000 puts the same rule on the direct-PostgREST path beside it (organisation_memberships_insert_manage_members also calls private.organisation_is_live()).';
