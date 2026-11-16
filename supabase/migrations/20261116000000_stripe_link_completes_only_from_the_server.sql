-- ===========================================================================
-- A STRIPE LINK COMPLETES ONLY FROM THE APP'S SERVER (audit 2026-11-16)
-- ===========================================================================
-- complete_stripe_link is granted to authenticated and took p_account on
-- trust: the only proof the id came from Stripe was the OAuth callback's code
-- exchange (app/api/stripe/connect/callback/route.ts). A manage_finance holder
-- could begin and claim a state, then call the RPC straight through PostgREST
-- with any acct_ id: linking an account whose owner never agreed, or holding
-- it so its owner is refused stripe_account_in_use.
--
-- The fix is the server-only request mark (20261108000000): the function now
-- refuses unless private.request_is_from_server(). Rebuilt from the live
-- definition (20261110001000) with that one added check; grants unchanged.
-- Fails closed where the Vault digest is not set (SECURITY.md § 15).
-- ===========================================================================

create or replace function public.complete_stripe_link(
  p_state            text,
  p_account          text,
  p_charges_enabled  boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'complete_stripe_link: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  -- Audit 2026-11-16: p_account is only trustworthy when the callback passes
  -- what Stripe's code exchange returned. A direct PostgREST call could name
  -- any acct_ id, so only a request the app's server marked may complete.
  if not private.request_is_from_server() then
    raise exception 'complete_stripe_link: only the app''s server may complete a link'
      using errcode = '42501', hint = 'server_request_mark_required';
  end if;
  if p_account is null or p_account !~ '^acct_[A-Za-z0-9]+$' then
    raise exception 'complete_stripe_link: not a Stripe account id'
      using errcode = '22023', hint = 'stripe_account_invalid';
  end if;

  update private.stripe_link_states s
     set used_at = pg_catalog.now()
   where s.state_hash = extensions.digest(coalesce(p_state, ''), 'sha256')
     and s.user_id = v_uid
     and s.claimed_at is not null
     and s.used_at is null
     and s.expires_at > pg_catalog.now()
  returning s.organisation_id into v_org;
  if v_org is null then
    raise exception 'complete_stripe_link: the state is unknown, unclaimed, used, expired or another user''s'
      using errcode = '42501', hint = 'stripe_link_state_invalid';
  end if;

  -- Re-checked on the state's workspace; a refusal rolls the state's use back.
  if not public.has_permission(v_org, 'manage_finance') then
    raise exception 'complete_stripe_link: the caller may no longer manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_org) then
    raise exception 'complete_stripe_link: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  if exists (select 1 from public.invoice_stripe_accounts a
              where a.stripe_account_id = p_account and a.ended_at is null and a.organisation_id <> v_org) then
    raise exception 'complete_stripe_link: that Stripe account is linked to another workspace'
      using errcode = '22023', hint = 'stripe_account_in_use';
  end if;

  begin
    insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by, linked_at)
    values (v_org, p_account, coalesce(p_charges_enabled, false), v_uid, pg_catalog.now())
    on conflict (organisation_id) do update
      set stripe_account_id = excluded.stripe_account_id,
          charges_enabled   = excluded.charges_enabled,
          linked_by         = excluded.linked_by,
          linked_at         = excluded.linked_at,
          ended_at          = null,
          ended_reason      = null;
  exception when unique_violation then   -- two workspaces racing for one account
    raise exception 'complete_stripe_link: that Stripe account is linked to another workspace'
      using errcode = '22023', hint = 'stripe_account_in_use';
  end;

  -- The account id is never in the audit row: the fact that it changed is.
  perform private.log_audit_event('invoice_stripe_account.linked', 'invoice_stripe_account', v_org, null, null, null,
                                  pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('stripe_account')));
end;
$$;

comment on function public.complete_stripe_link(text, text, boolean) is
  'Finishes a Stripe link from the OAuth callback, AFTER claim_stripe_link_state. Takes the workspace from the state row, never from the caller: the state must be this user''s, claimed, not yet completed and unexpired (stripe_link_state_invalid otherwise). Requires manage_finance and the Pro entitlement on that workspace, a well-formed acct_ id, and refuses an account another workspace holds live (stripe_account_in_use). Upserts the workspace''s one row (a re-link replaces the account) and audits invoice_stripe_account.linked as {changed: [stripe_account]} -- never the id. Since 20261116000000 it also refuses (42501 server_request_mark_required) unless the request carried the server-only mark: the account id is trusted only from the callback, which passes what Stripe''s code exchange returned.';
