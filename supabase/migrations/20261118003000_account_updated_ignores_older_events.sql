-- ===========================================================================
-- account.updated: an OLDER event never overwrites a newer one.
--
-- Stripe does not deliver events in the order it creates them. A late
-- "charges_enabled: false" arriving after "true" switched card payment off for
-- a workspace whose account was fine, until Stripe happened to send another
-- account.updated (audit 2026-11-18, finding 3). The refund handler already
-- refuses to go backwards; this does the same for the link.
--
-- The webhook passes the event's own `created`. The RPC stores the newest one
-- it applied and ignores anything older (an equal time is applied: Stripe's
-- clock has one-second resolution, and the later delivery is the better
-- guess). The event id is still recorded, so a stale event is a duplicate on
-- retry. Rebuilt from 20261110002000 with only that comparison added.
-- ===========================================================================

alter table public.invoice_stripe_accounts
  add column charges_enabled_event_at timestamptz;

comment on column public.invoice_stripe_accounts.charges_enabled_event_at is
  'The Stripe `created` time of the newest account.updated event applied to charges_enabled; an older event is ignored. Null until the first one.';

drop function public.stripe_account_updated(text, text, boolean);

create function public.stripe_account_updated(
  p_event_id        text,
  p_account         text,
  p_charges_enabled boolean,
  p_event_created   timestamptz default null
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
         charges_enabled_event_at = coalesce(p_event_created, a.charges_enabled_event_at)
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
  'service_role only: mirrors Stripe''s charges_enabled for the live link on p_account (account.updated, event p_event_id, created p_event_created). True when a live link was found and the event was new and not older than the newest one applied; false otherwise (no live link, an event id already recorded, or an older event: nothing applied, though a new id is still recorded). When the stored value actually flips it audits invoice_stripe_account.charges_enabled_changed as {changed: [charges_enabled]} with the Q130 tombstone as actor; a repeat of the same value writes nothing. That action feeds no notice.';
revoke all on function public.stripe_account_updated(text, text, boolean, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_updated(text, text, boolean, timestamptz) to service_role;
