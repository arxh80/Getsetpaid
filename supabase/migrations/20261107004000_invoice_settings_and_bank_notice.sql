-- ===========================================================================
-- INVOICES PART 1 -- TASK 7: SETTINGS, AND THE BANK-CHANGE NOTICE.
--
-- public.save_invoice_settings(): the only writer of invoice_settings apart
-- from issue_invoice's next_number. Step-up re-authentication is the app's
-- (lib/invoices/settings-actions.ts, checkStepUp); manage_finance here is
-- already aal2-gated. BANK-DETAIL FRAUD GUARD (spec § Security 2): a change to
-- any bank field writes invoice_settings.bank_details_changed, and that audit
-- row is the subject of an email to every active Owner and Admin, delivered
-- on the existing tick through the notice ledger (plan decision 9) -- the
-- 20261022001000 pattern: ledger notice, rebuilt mark_notices_* branches, a
-- service_role resolver.
--
-- NAMES ONLY IN THE AUDIT (CLAUDE.md: audit payloads are name-only diffs; the
-- log is superuser-readable). The plan put the account's last four digits in
-- the bank row's before/after; the coordinator's 2026-10-25 ruling (invoices
-- ledger) overrides it: the row carries {changed: [bank column names]} and
-- nothing else. The email's last four come from the CURRENT invoice_settings
-- row at send time, read by the resolver -- two changes inside one tick both
-- show the live account, which is the fraud-relevant fact.
-- ===========================================================================

create or replace function public.save_invoice_settings(
  p_org                 uuid,
  p_business_name       text,
  p_business_address    text,
  p_vat_number          text,
  p_bank_account_name   text,
  p_bank_sort_code      text,
  p_bank_account_number text,
  p_number_prefix       text,
  p_payment_terms_days  integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_old     public.invoice_settings;
  v_new     public.invoice_settings;
  v_changed text[];
  v_bank    text[];
begin
  if v_uid is null then
    raise exception 'save_invoice_settings: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  if p_org is null or not public.has_permission(p_org, 'manage_finance') then
    raise exception 'save_invoice_settings: the caller may not manage finance in this workspace'
      using errcode = '42501', hint = 'forbidden';
  end if;
  if not exists (select 1 from private.finance_module_organisations() f where f = p_org) then
    raise exception 'save_invoice_settings: this workspace''s plan does not include invoicing'
      using errcode = '42501', hint = 'plan_does_not_include_invoicing';
  end if;

  select * into v_old from public.invoice_settings s where s.organisation_id = p_org for update;

  begin
    insert into public.invoice_settings (organisation_id, business_name, business_address, vat_number,
                                         bank_account_name, bank_sort_code, bank_account_number,
                                         number_prefix, payment_terms_days)
    values (p_org, p_business_name, p_business_address, p_vat_number,
            p_bank_account_name, p_bank_sort_code, p_bank_account_number,
            p_number_prefix, p_payment_terms_days)
    on conflict (organisation_id) do update
      set business_name       = excluded.business_name,
          business_address    = excluded.business_address,
          vat_number          = excluded.vat_number,
          bank_account_name   = excluded.bank_account_name,
          bank_sort_code      = excluded.bank_sort_code,
          bank_account_number = excluded.bank_account_number,
          number_prefix       = excluded.number_prefix,
          payment_terms_days  = excluded.payment_terms_days
    returning * into v_new;
  exception when check_violation or not_null_violation then
    raise exception 'save_invoice_settings: a setting is invalid'
      using errcode = '22023', hint = 'invoice_settings_invalid';
  end;

  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_changed
    from pg_catalog.unnest(array['bank_account_name', 'bank_account_number', 'bank_sort_code',
                                 'business_address', 'business_name', 'number_prefix',
                                 'payment_terms_days', 'vat_number']) k
   where (pg_catalog.to_jsonb(v_new) -> k) is distinct from (pg_catalog.to_jsonb(v_old) -> k);
  select coalesce(pg_catalog.array_agg(k order by k), '{}') into v_bank
    from pg_catalog.unnest(v_changed) k
   where k in ('bank_account_name', 'bank_account_number', 'bank_sort_code');

  -- Column NAMES only, never values, in both rows.
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.log_audit_event(
      p_action          => 'invoice_settings.changed',
      p_target_type     => 'invoice_settings',
      p_organisation_id => p_org,
      p_target_id       => p_org,
      p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_changed)));
  end if;
  if pg_catalog.cardinality(v_bank) > 0 then
    perform private.log_audit_event(
      p_action          => 'invoice_settings.bank_details_changed',
      p_target_type     => 'invoice_settings',
      p_organisation_id => p_org,
      p_target_id       => p_org,
      p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_bank)));
  end if;
  return pg_catalog.cardinality(v_bank) > 0;
end;
$$;

comment on function public.save_invoice_settings(uuid, text, text, text, text, text, text, text, integer) is
  'Upserts a workspace''s invoice settings (never next_number). Requires manage_finance and the Pro entitlement; step-up is enforced by the calling Server Action. Audits invoice_settings.changed and, on any bank change, invoice_settings.bank_details_changed -- both carry {changed: [column names]} and no value -- the latter the subject of the Owner/Admin email. Returns whether a bank field changed.';
revoke all on function public.save_invoice_settings(uuid, text, text, text, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_invoice_settings(uuid, text, text, text, text, text, text, text, integer)
  to authenticated;

comment on table public.invoice_settings is
  'One row per workspace: the seller block, bank details and numbering for its invoices (Invoices part 1). Read by view_finance; written only by public.save_invoice_settings() (step-up in the app; every bank change audited by column name and emailed to the Owners and Admins with the CURRENT account''s last four digits) and, for next_number, by public.issue_invoice().';

-- ---------------------------------------------------------------------------
-- THE LEDGER LEARNS ONE NOTICE, keyed on its audit row (20261022001000's
-- audit_event_id branch).
-- ---------------------------------------------------------------------------
alter table private.notification_deliveries
  drop constraint notification_deliveries_notice_check,
  add constraint notification_deliveries_notice_check
    check (notice in ('connection_received', 'connection_accepted', 'connection_declined',
                      'task_reminder',
                      'workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                      'invoice_bank_details_changed')),
  drop constraint notification_deliveries_one_subject,
  add constraint notification_deliveries_one_subject check (
    case when notice = 'task_reminder'
           then task_id is not null and request_id is null and audit_event_id is null
         when notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                         'invoice_bank_details_changed')
           then audit_event_id is not null and request_id is null and task_id is null
         else request_id is not null and task_id is null and audit_event_id is null end);

-- The notice -> audit action map, one more arm.
create or replace function private.closure_notice_action(p_notice text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_notice
           when 'workspace_closed'             then 'organisation.closed_by_owner'
           when 'workspace_reassigned'         then 'organisation.closure_reassigned'
           when 'workspace_deleted'            then 'organisation.closure_deleted'
           when 'invoice_bank_details_changed' then 'invoice_settings.bank_details_changed'
         end
$$;
revoke all on function private.closure_notice_action(text) from public, anon, authenticated, service_role;

-- THE TWO WRITE PATHS, rebuilt from 20261022001000 (their latest definition)
-- with ONE change each: the audit-row branch accepts the new notice.
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
  else
    raise exception 'mark_notices_undeliverable: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- THE RESOLVER the delivery tick reads.
-- ---------------------------------------------------------------------------
create or replace function public.pending_invoice_bank_change_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, emails text[], organisation_slug text, organisation_name text,
               account_last4 text, changed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_invoice_bank_change_notifications: read by the sender, never from a person''s session'
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
           -- The CURRENT account, read at send time; never stored in the audit row.
           pg_catalog.right(s.bank_account_number, 4),
           a.created_at
      from public.audit_events a
      join public.organisations o on o.id = a.organisation_id
      left join public.invoice_settings s on s.organisation_id = a.organisation_id
     where a.action = 'invoice_settings.bank_details_changed'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and not exists (select 1 from private.notification_deliveries d
                        where d.audit_event_id = a.id and d.notice = 'invoice_bank_details_changed')
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;
comment on function public.pending_invoice_bank_change_notifications(integer) is
  'service_role only: invoice_settings.bank_details_changed audit rows from the last seven days not yet in the notice ledger, each with the CURRENT active Owners'' and Admins'' addresses (tombstone excluded), the workspace, and the last four digits of the account the workspace holds NOW (the audit row carries column names only). lib/email/invoice-notifications.ts sends one email per row on the delivery tick.';
revoke all on function public.pending_invoice_bank_change_notifications(integer) from public, anon, authenticated;
grant execute on function public.pending_invoice_bank_change_notifications(integer) to service_role;
