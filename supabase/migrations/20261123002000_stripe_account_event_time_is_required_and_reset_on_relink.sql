-- ===========================================================================
-- account.updated ordering: the event time is required, and a re-link resets it.
--
-- 1. stripe_account_updated took p_event_created with a null default, and a
--    null skipped the "older than the newest applied" check. The webhook always
--    passes it, so nothing breaks; a caller that forgot it would silently let a
--    stale event through. It is now required and a null is refused.
-- 2. complete_stripe_link upserts the workspace's one row, and a re-link to a
--    DIFFERENT account kept the old account's charges_enabled_event_at. The new
--    account's first events, created before that time, were then ignored and
--    charges_enabled stayed at the link-time value. A link now clears it, so the
--    new account starts exactly as a first link does. (Null rather than now():
--    Stripe's created has one-second resolution on another clock, so now() could
--    drop an event raised in the same second as the link.)
--
-- Both functions are rebuilt from their live definitions (20261118003000,
-- 20261116000000) with only these changes; grants re-stated for the dropped one.
-- ===========================================================================

drop function public.stripe_account_updated(text, text, boolean, timestamptz);

create function public.stripe_account_updated(
  p_event_id        text,
  p_account         text,
  p_charges_enabled boolean,
  p_event_created   timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_old     boolean;
  v_seen_at timestamptz;
  v_new     boolean := coalesce(p_charges_enabled, false);
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'stripe_account_updated: written by the webhook, never from a person''s session'
      using errcode = '42501', hint = 'stripe_write_is_server_only';
  end if;
  if p_event_created is null then
    raise exception 'stripe_account_updated: the event''s created time is required'
      using errcode = '22023', hint = 'stripe_event_created_required';
  end if;
  select a.organisation_id, a.charges_enabled, a.charges_enabled_event_at into v_org, v_old, v_seen_at
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account and a.ended_at is null
     for update;
  if v_org is null then
    return false;
  end if;
  insert into public.stripe_events (id, organisation_id, type)
  values (p_event_id, v_org, 'account.updated')
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  -- Older than the newest applied event: recorded above, applied never.
  if p_event_created < v_seen_at then
    return false;
  end if;
  update public.invoice_stripe_accounts a
     set charges_enabled = v_new,
         charges_enabled_event_at = p_event_created
   where a.organisation_id = v_org;
  if v_old is distinct from v_new then
    insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, after)
    values (v_org, private.erased_user_id(), 'invoice_stripe_account.charges_enabled_changed', 'invoice_stripe_account',
            pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('charges_enabled')));
  end if;
  return true;
end;
$$;
comment on function public.stripe_account_updated(text, text, boolean, timestamptz) is
  'service_role only: mirrors Stripe''s charges_enabled for the live link on p_account (account.updated, event p_event_id, created p_event_created). p_event_created is required (22023 stripe_event_created_required on null). True when a live link was found and the event was new and not older than the newest one applied; false otherwise (no live link, an event id already recorded, or an older event: nothing applied, though a new id is still recorded). When the stored value actually flips it audits invoice_stripe_account.charges_enabled_changed as {changed: [charges_enabled]} with the Q130 tombstone as actor; a repeat of the same value writes nothing. That action feeds no notice.';
revoke all on function public.stripe_account_updated(text, text, boolean, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_updated(text, text, boolean, timestamptz) to service_role;

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
  -- p_account is only trustworthy when the callback passes
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
    insert into public.invoice_stripe_accounts (organisation_id, stripe_account_id, charges_enabled, linked_by, linked_at, charges_enabled_event_at)
    values (v_org, p_account, coalesce(p_charges_enabled, false), v_uid, pg_catalog.now(), null)
    on conflict (organisation_id) do update
      set stripe_account_id = excluded.stripe_account_id,
          charges_enabled   = excluded.charges_enabled,
          linked_by         = excluded.linked_by,
          linked_at         = excluded.linked_at,
          ended_at          = null,
          ended_reason      = null,
          charges_enabled_event_at = null;
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
  'Finishes a Stripe link from the OAuth callback, AFTER claim_stripe_link_state. Takes the workspace from the state row, never from the caller: the state must be this user''s, claimed, not yet completed and unexpired (stripe_link_state_invalid otherwise). Requires manage_finance and the Pro entitlement on that workspace, a well-formed acct_ id, and refuses an account another workspace holds live (stripe_account_in_use). Upserts the workspace''s one row (a re-link replaces the account and clears charges_enabled_event_at, so the new account''s events start fresh) and audits invoice_stripe_account.linked as {changed: [stripe_account]} -- never the id. Since 20261116000000 it also refuses (42501 server_request_mark_required) unless the request carried the server-only mark: the account id is trusted only from the callback, which passes what Stripe''s code exchange returned.';
