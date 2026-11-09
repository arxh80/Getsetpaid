-- ===========================================================================
-- INVOICES PART 2 -- TASK 3: LINKING AND ENDING A WORKSPACE'S STRIPE ACCOUNT.
--
--   begin_stripe_link        step-up; mints the OAuth state (a row, plan decision 3)
--   claim_stripe_link_state  the callback's FIRST call, before the code is exchanged:
--                            claims the state once, says which workspace it is for
--   complete_stripe_link     the callback's last: spends a CLAIMED state, stores the account
--   end_stripe_account_link  step-up; ends the link, returns the id to deauthorise
--   stripe_account_deauthorized / stripe_account_updated   service_role: the webhook's
--   stripe_application_fee_bps                              the fee the settings page names
--   pending_invoice_stripe_account_notifications            service_role: the tick's queue
--
-- BANK-DETAIL FRAUD GUARD, AGAIN (spec § Security): re-pointing where a
-- customer pays is a Stripe link as much as a bank account. A link or an end is
-- audited by NAME ONLY (never the acct_ id), and each audit row is the subject
-- of an email to every active Owner and Admin -- the 20261107004000 machinery,
-- one more notice. Modelled on public.save_invoice_settings throughout.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE LEDGER LEARNS ONE MORE NOTICE (20261107004000's shape).
-- ---------------------------------------------------------------------------
alter table private.notification_deliveries
  drop constraint notification_deliveries_notice_check,
  add constraint notification_deliveries_notice_check
    check (notice in ('connection_received', 'connection_accepted', 'connection_declined',
                      'task_reminder',
                      'workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                      'invoice_bank_details_changed',
                      'invoice_stripe_account_changed')),
  drop constraint notification_deliveries_one_subject,
  add constraint notification_deliveries_one_subject check (
    case when notice = 'task_reminder'
           then task_id is not null and request_id is null and audit_event_id is null
         when notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                         'invoice_bank_details_changed', 'invoice_stripe_account_changed')
           then audit_event_id is not null and request_id is null and task_id is null
         else request_id is not null and task_id is null and audit_event_id is null end);

-- The two write paths, rebuilt from their live definitions (diffed identical to
-- 20261107004000 first). Only a new branch is added to each: the Stripe notice
-- is keyed on TWO audit actions (linked, ended), so it cannot ride
-- private.closure_notice_action's one-action map and states its list itself.
CREATE OR REPLACE FUNCTION public.mark_notices_delivered(p_notice text, p_subject_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_notices_delivered: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id)
    select 'task_reminder', t.id
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id)
    select p_notice, r.id
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  elsif p_notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                     'invoice_bank_details_changed') then
    insert into private.notification_deliveries (notice, audit_event_id)
    select p_notice, a.id
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = private.closure_notice_action(p_notice)
    on conflict do nothing;
  elsif p_notice = 'invoice_stripe_account_changed' then
    insert into private.notification_deliveries (notice, audit_event_id)
    select p_notice, a.id
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action in ('invoice_stripe_account.linked', 'invoice_stripe_account.ended')
    on conflict do nothing;
  else
    raise exception 'mark_notices_delivered: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_notices_undeliverable(p_notice text, p_subject_ids uuid[], p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_notices_undeliverable: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_reason is null or p_reason not in ('content_refused', 'no_recipient') then
    raise exception 'mark_notices_undeliverable: unknown reason %', p_reason
      using errcode = '22023', hint = 'notification_reason_unknown';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id, outcome, reason)
    select 'task_reminder', t.id, 'undeliverable', p_reason
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id, outcome, reason)
    select p_notice, r.id, 'undeliverable', p_reason
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  elsif p_notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                     'invoice_bank_details_changed') then
    insert into private.notification_deliveries (notice, audit_event_id, outcome, reason)
    select p_notice, a.id, 'undeliverable', p_reason
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = private.closure_notice_action(p_notice)
    on conflict do nothing;
  elsif p_notice = 'invoice_stripe_account_changed' then
    insert into private.notification_deliveries (notice, audit_event_id, outcome, reason)
    select p_notice, a.id, 'undeliverable', p_reason
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action in ('invoice_stripe_account.linked', 'invoice_stripe_account.ended')
    on conflict do nothing;
  else
    raise exception 'mark_notices_undeliverable: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. BEGIN: the step-up is spent here, and the OAuth state is minted.
-- ---------------------------------------------------------------------------
create or replace function public.begin_stripe_link(p_org uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_state text;
begin
  if v_uid is null then
    raise exception 'begin_stripe_link: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.has_permission(p_org, 'manage_finance') then
    raise exception 'begin_stripe_link: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = p_org) then
    raise exception 'begin_stripe_link: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  -- After the refusals above, so a refused caller never spends a token.
  perform private.consume_step_up('invoice_settings');

  -- The table is a ten-minute scratchpad: each mint sweeps what has expired.
  delete from private.stripe_link_states s where s.expires_at < pg_catalog.now();

  -- 32 random bytes as base64url, unpadded: 43 characters. Only the hash is kept.
  v_state := pg_catalog.translate(
    pg_catalog.rtrim(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into private.stripe_link_states (state_hash, organisation_id, user_id, expires_at)
  values (extensions.digest(v_state, 'sha256'), p_org, v_uid, pg_catalog.now() + interval '10 minutes');
  return v_state;
end;
$$;

comment on function public.begin_stripe_link(uuid) is
  'Starts linking a workspace to its own Stripe account. Requires manage_finance and the Pro entitlement and spends an invoice_settings step-up token. Stores the SHA-256 of a fresh random OAuth state bound to the caller and the workspace for ten minutes (plan decision 3) and returns the state itself, 43 base64url characters, for the authorize URL. Sweeps expired states on each call.';
revoke all on function public.begin_stripe_link(uuid) from public, anon, authenticated, service_role;
grant execute on function public.begin_stripe_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. CLAIM, THEN COMPLETE. The callback is ONE fixed URL (Stripe matches the
--    redirect_uri exactly against a registered list), so the workspace is not
--    in the path: the state row says which one. Stripe's token endpoint is not
--    idempotent (a code used twice REVOKES the connection), so the state is
--    CLAIMED -- once, by the user who began it, still unexpired, with
--    manage_finance and Pro re-checked on the row's workspace -- BEFORE the
--    code is exchanged. A replay, a reload or a forged GET is refused here and
--    never reaches Stripe. complete_stripe_link then accepts only a state this
--    user claimed and has not completed.
-- ---------------------------------------------------------------------------
alter table private.stripe_link_states add column claimed_at timestamptz;

-- The earlier shape of complete_stripe_link (it took the workspace as an
-- argument) never left this branch.
drop function if exists public.complete_stripe_link(uuid, text, text, boolean);

create or replace function public.claim_stripe_link_state(p_state text)
returns table (organisation_id uuid, slug text)
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
    raise exception 'claim_stripe_link_state: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;

  update private.stripe_link_states s
     set claimed_at = pg_catalog.now()
   where s.state_hash = extensions.digest(coalesce(p_state, ''), 'sha256')
     and s.user_id = v_uid
     and s.claimed_at is null
     and s.used_at is null
     and s.expires_at > pg_catalog.now()
  returning s.organisation_id into v_org;
  if v_org is null then
    raise exception 'claim_stripe_link_state: the state is unknown, claimed, used, expired or another user''s'
      using errcode = '42501', hint = 'stripe_link_state_invalid';
  end if;

  -- A refusal below rolls the claim back with the rest of this call.
  if not public.has_permission(v_org, 'manage_finance') then
    raise exception 'claim_stripe_link_state: the caller may no longer manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = v_org) then
    raise exception 'claim_stripe_link_state: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  return query select o.id, o.slug from public.organisations o where o.id = v_org;
end;
$$;

comment on function public.claim_stripe_link_state(text) is
  'The OAuth callback''s first database call, BEFORE the code is exchanged with Stripe (whose token endpoint revokes the connection if a code is used twice). Claims, once, a state this user began and that has not expired; re-checks manage_finance and Pro on the state''s workspace (a refusal rolls the claim back) and returns that workspace -- the only source of the workspace the callback acts on. stripe_link_state_invalid for an unknown, already claimed, used, expired or another user''s state.';
revoke all on function public.claim_stripe_link_state(text) from public, anon, authenticated, service_role;
grant execute on function public.claim_stripe_link_state(text) to authenticated;

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
  'Finishes a Stripe link from the OAuth callback, AFTER claim_stripe_link_state. Takes the workspace from the state row, never from the caller: the state must be this user''s, claimed, not yet completed and unexpired (stripe_link_state_invalid otherwise). Requires manage_finance and the Pro entitlement on that workspace, a well-formed acct_ id, and refuses an account another workspace holds live (stripe_account_in_use). Upserts the workspace''s one row (a re-link replaces the account) and audits invoice_stripe_account.linked as {changed: [stripe_account]} -- never the id.';
revoke all on function public.complete_stripe_link(text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.complete_stripe_link(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. END: a person disconnects. Returns the id for the Stripe deauthorise call.
-- ---------------------------------------------------------------------------
create or replace function public.end_stripe_account_link(p_org uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_account text;
begin
  if v_uid is null then
    raise exception 'end_stripe_account_link: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.has_permission(p_org, 'manage_finance') then
    raise exception 'end_stripe_account_link: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = p_org) then
    raise exception 'end_stripe_account_link: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  perform private.consume_step_up('invoice_settings');

  update public.invoice_stripe_accounts a
     set ended_at = pg_catalog.now(), ended_reason = 'disconnected'
   where a.organisation_id = p_org and a.ended_at is null
  returning a.stripe_account_id into v_account;
  if v_account is null then
    return null;   -- nothing live: no change, no audit row
  end if;

  perform private.log_audit_event('invoice_stripe_account.ended', 'invoice_stripe_account', p_org, null, null, null,
                                  pg_catalog.jsonb_build_object('reason', 'disconnected'));
  return v_account;
end;
$$;

comment on function public.end_stripe_account_link(uuid) is
  'Disconnects a workspace''s live Stripe link (ended_reason disconnected). Requires manage_finance and the Pro entitlement and spends an invoice_settings step-up token. Returns the ended account id so the caller can deauthorise it at Stripe, or null when no link was live (then nothing is written). Audits invoice_stripe_account.ended as {reason}, never the id.';
revoke all on function public.end_stripe_account_link(uuid) from public, anon, authenticated, service_role;
grant execute on function public.end_stripe_account_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. THE WEBHOOK'S TWO: service_role only, no person on the session.
-- ---------------------------------------------------------------------------
create or replace function public.stripe_account_deauthorized(p_account text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'stripe_account_deauthorized: written by the webhook, never from a person''s session'
      using errcode = '42501', hint = 'stripe_write_is_server_only';
  end if;
  update public.invoice_stripe_accounts a
     set ended_at = pg_catalog.now(), ended_reason = 'deauthorized'
   where a.stripe_account_id = p_account and a.ended_at is null
  returning a.organisation_id into v_org;
  if v_org is null then
    return false;
  end if;
  -- Sessionless, so private.log_audit_event (which wants auth.uid()) cannot be used.
  insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, after)
  values (v_org, private.erased_user_id(), 'invoice_stripe_account.ended', 'invoice_stripe_account',
          pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('reason', 'deauthorized'));
  return true;
end;
$$;

comment on function public.stripe_account_deauthorized(text) is
  'service_role only: Stripe says the workspace revoked GetSetPaid''s access (account.application.deauthorized). Ends the live link for that account (ended_reason deauthorized) and audits invoice_stripe_account.ended as {reason} with the Q130 tombstone as actor. True when a live link was found, false for an account no workspace holds.';
revoke all on function public.stripe_account_deauthorized(text) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_deauthorized(text) to service_role;

create or replace function public.stripe_account_updated(p_account text, p_charges_enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_old boolean;
  v_new boolean := coalesce(p_charges_enabled, false);
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'stripe_account_updated: written by the webhook, never from a person''s session'
      using errcode = '42501', hint = 'stripe_write_is_server_only';
  end if;
  select a.organisation_id, a.charges_enabled into v_org, v_old
    from public.invoice_stripe_accounts a
   where a.stripe_account_id = p_account and a.ended_at is null
     for update;
  if v_org is null then
    return false;
  end if;
  -- account.updated is noisy: only a real flip is written, and audited.
  if v_old is distinct from v_new then
    update public.invoice_stripe_accounts a set charges_enabled = v_new where a.organisation_id = v_org;
    -- Sessionless, so private.log_audit_event cannot be used. No notice reads this action.
    insert into public.audit_events (organisation_id, actor_user_id, action, target_type, correlation_id, after)
    values (v_org, private.erased_user_id(), 'invoice_stripe_account.charges_enabled_changed', 'invoice_stripe_account',
            pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('charges_enabled')));
  end if;
  return true;
end;
$$;

comment on function public.stripe_account_updated(text, boolean) is
  'service_role only: mirrors Stripe''s charges_enabled for the live link on p_account (account.updated). True when a live link was found, false otherwise. When the stored value actually flips it audits invoice_stripe_account.charges_enabled_changed as {changed: [charges_enabled]} with the Q130 tombstone as actor; a repeat of the same value writes nothing. That action feeds no notice.';
revoke all on function public.stripe_account_updated(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.stripe_account_updated(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 6. THE FEE THE SETTINGS PAGE NAMES (the table itself grants no client a read).
-- ---------------------------------------------------------------------------
create or replace function public.stripe_application_fee_bps()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select s.application_fee_bps from public.stripe_platform_settings s
$$;

comment on function public.stripe_application_fee_bps() is
  'The application fee GetSetPaid takes on each card payment, in basis points (Q279: 100 = 1%), so the Invoice settings page can state it. The one integer; the table grants no client role a read.';
revoke all on function public.stripe_application_fee_bps() from public, anon, authenticated, service_role;
grant execute on function public.stripe_application_fee_bps() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE RESOLVER the delivery tick reads (20261107004000's shape). The audit
--    row carries names only, so the email says linked or ended and nothing of
--    the account.
-- ---------------------------------------------------------------------------
create or replace function public.pending_invoice_stripe_account_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, emails text[], organisation_slug text, organisation_name text,
               change text, changed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_invoice_stripe_account_notifications: read by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;
  return query
    select a.id,
           (select pg_catalog.array_agg(u.email::text order by u.email)
              from public.organisation_memberships m
              join auth.users u on u.id = m.user_id
             where m.organisation_id = a.organisation_id
               and m.status = 'active'
               and m.role in ('owner', 'admin')
               and u.id <> private.erased_user_id()
               and u.email is not null),
           o.slug, o.name,
           case a.action when 'invoice_stripe_account.linked' then 'linked' else 'ended' end,
           a.created_at
      from public.audit_events a
      join public.organisations o on o.id = a.organisation_id
     where a.action in ('invoice_stripe_account.linked', 'invoice_stripe_account.ended')
       and a.created_at > pg_catalog.now() - interval '7 days'
       and not exists (select 1 from private.notification_deliveries d
                        where d.audit_event_id = a.id and d.notice = 'invoice_stripe_account_changed')
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;

comment on function public.pending_invoice_stripe_account_notifications(integer) is
  'service_role only: invoice_stripe_account.linked / .ended audit rows from the last seven days not yet in the notice ledger, each with the CURRENT active Owners'' and Admins'' addresses (tombstone excluded), the workspace, and whether the link was made or ended. The audit row carries no account id and neither does this. lib/email/invoice-notifications.ts sends one email per row on the delivery tick.';
revoke all on function public.pending_invoice_stripe_account_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.pending_invoice_stripe_account_notifications(integer) to service_role;

comment on table public.invoice_stripe_accounts is
  'A workspace''s link to its own Stripe account (Invoices part 2, Standard Connect). One row per workspace; ended_at/ended_reason mark a link that was disconnected or deauthorized, and free the account id for another workspace. Read by view_finance; written only by public.complete_stripe_link and public.end_stripe_account_link (linking begins with begin_stripe_link, and begin and end each spend a step-up token) and, sessionless, by the webhook''s stripe_account_deauthorized / stripe_account_updated. Every link and end is audited by name and emailed to the Owners and Admins.';

-- ---------------------------------------------------------------------------
-- 8. THE AUDIT CATALOGUE gains invoice_stripe_account.charges_enabled_changed:
--    stripe_account_updated writes it when the stored value really flips. Rebuilt
--    from the live definition (diffed identical to 20261110000000 first); only
--    that row is added. No notice reads it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.platform_audit_actions()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
    ('organisation.updated'),
    ('membership.accepted'),
    ('document_uploaded'),
    ('document_downloaded'),
    ('document_deleted'),
    ('document_quarantined'),
    ('network_profile.published'),
    ('network_profile.unpublished'),
    ('network_profile.visibility_changed'),
    ('network_connection.requested'),
    ('network_connection.accepted'),
    ('network_connection.declined'),
    ('network_connection.withdrawn'),
    ('network_connection.updated'),
    ('audit_log.viewed'),
    ('impersonation.requested'),
    ('impersonation.accepted'),
    ('impersonation.declined'),
    ('impersonation.started'),
    ('impersonation.page_viewed'),
    ('impersonation.ended'),
    ('impersonation.expired'),
    ('organisation.suspended'),
    ('organisation.deleted'),
    ('organisation.reinstated'),
    ('organisation.closed_by_owner'),
    ('organisation.closure_reassigned'),
    ('organisation.closure_deleted'),
    ('organisation.closure_candidates_viewed'),
    ('organisation.billing_override_granted'),
    ('organisation.billing_override_revoked'),
    ('organisation.feature_override_granted'),
    ('organisation.feature_override_revoked'),
    ('platform_health.viewed'),
    ('incident_alert.resolved'),
    ('incident_alert.reopened'),
    ('feedback.submitted'),
    ('feedback.status_changed'),
    ('feedback.screenshot_viewed'),
    ('legal_document.draft_created'),
    ('legal_document.draft_updated'),
    ('legal_document.published'),
    ('legal_document.counsel_review_recorded'),
    ('consent.granted'),
    ('consent.withdrawn'),
    ('data_subject_request.submitted'),
    ('data_subject_request.in_progress'),
    ('data_subject_request.routed'),
    ('data_subject_request.fulfilled'),
    ('data_subject_request.rejected'),
    ('data_subject_request.withdrawn'),
    ('data_subject_request.fulfilment_recorded'),
    ('data_subject_request.note_added'),
    ('data_subject_request.rerouted'),
    ('export_job.requested'),
    ('export_job.downloaded'),
    ('erasure_job.requested'),
    ('account.erased'),
    ('organisation.erased'),
    ('retention_settings.changed'),
    ('retention.swept'),
    ('retention.audit_ceiling_released'),
    ('integration.connected'),
    ('integration.revoked'),
    ('integration.token_stored'),
    ('integration.sync_failed'),
    -- Invoices part 1 (20261107000000; written by Tasks 5, 6, 7, 10, 11).
    ('invoice.issued'),
    ('invoice.sent'),
    ('invoice.marked_paid'),
    ('invoice.voided'),
    ('invoice.pdf_downloaded'),
    ('invoice_settings.changed'),
    ('invoice_settings.bank_details_changed'),
    -- Invoices part 2 (20261110000000; written by Tasks 3 and 4).
    ('invoice.paid_by_card'),
    ('invoice.card_payment_conflict'),
    ('invoice.card_refund_flagged'),
    ('invoice_stripe_account.linked'),
    ('invoice_stripe_account.ended'),
    ('invoice_stripe_account.charges_enabled_changed')
$function$;

