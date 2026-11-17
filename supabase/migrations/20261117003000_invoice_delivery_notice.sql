-- ===========================================================================
-- INVOICES PART 3 -- TASK 4: THE ONE EMAIL TO THE RECEIVER.
--
-- Delivering an invoice (public.deliver_invoice, 20261117001000) audits
-- invoice.delivered against the delivery id. This migration lets the delivery
-- tick tell the RECEIVING workspace about it, once:
--
--   1. the notice ledger learns 'invoice_delivered'
--   2. mark_notices_delivered / mark_notices_undeliverable gain its branch
--   3. public.pending_invoice_delivery_notifications (service_role) is the
--      queue: one row per live delivery, with the receiver's current
--      view_finance holders' addresses, the receiver's slug and name, and the
--      sender's business name from the snapshot. NO amount, number or line.
--
-- The 20261107004000 / 20261110001000 machinery, one more notice.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. THE LEDGER LEARNS ONE MORE NOTICE (20261110001000's shape).
-- ---------------------------------------------------------------------------
alter table private.notification_deliveries
  drop constraint notification_deliveries_notice_check,
  add constraint notification_deliveries_notice_check
    check (notice in ('connection_received', 'connection_accepted', 'connection_declined',
                      'task_reminder',
                      'workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                      'invoice_bank_details_changed',
                      'invoice_stripe_account_changed',
                      'invoice_delivered')),
  drop constraint notification_deliveries_one_subject,
  add constraint notification_deliveries_one_subject check (
    case when notice = 'task_reminder'
           then task_id is not null and request_id is null and audit_event_id is null
         when notice in ('workspace_closed', 'workspace_reassigned', 'workspace_deleted',
                         'invoice_bank_details_changed', 'invoice_stripe_account_changed',
                         'invoice_delivered')
           then audit_event_id is not null and request_id is null and task_id is null
         else request_id is not null and task_id is null and audit_event_id is null end);

-- ---------------------------------------------------------------------------
-- 2. THE TWO WRITE PATHS, rebuilt from their live definitions (diffed identical
--    to 20261110001000 first). Only the invoice_delivered branch is new.
-- ---------------------------------------------------------------------------
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
  elsif p_notice = 'invoice_delivered' then
    insert into private.notification_deliveries (notice, audit_event_id)
    select p_notice, a.id
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = 'invoice.delivered'
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
  elsif p_notice = 'invoice_delivered' then
    insert into private.notification_deliveries (notice, audit_event_id, outcome, reason)
    select p_notice, a.id, 'undeliverable', p_reason
      from public.audit_events a
     where a.id = any (coalesce(p_subject_ids, '{}'))
       and a.action = 'invoice.delivered'
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
-- 3. THE RESOLVER the delivery tick reads. A withdrawn delivery, a read-only
--    receiver and a deleted receiver produce nothing.
-- ---------------------------------------------------------------------------
create or replace function public.pending_invoice_delivery_notifications(p_limit integer default 30)
returns table (audit_event_id uuid, emails text[], organisation_slug text, organisation_name text,
               sender_name text, delivered_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none') not in ('postgres', 'service_role', 'none') then
    raise exception 'pending_invoice_delivery_notifications: read by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;
  return query
    select a.id,
           (select pg_catalog.array_agg(u.email::text order by u.email)
              from public.organisation_memberships m
              join public.role_permissions rp
                on rp.role_key = m.role and rp.permission_key = 'view_finance'
              join auth.users u on u.id = m.user_id
             where m.organisation_id = d.to_organisation_id
               and m.status = 'active'
               and u.id <> private.erased_user_id()
               and u.email is not null),
           o.slug, o.name,
           i.snapshot -> 'seller' ->> 'name',
           d.delivered_at
      from public.audit_events a
      join public.invoice_deliveries d on d.id = a.target_id
      join public.invoices i on i.id = d.invoice_id and i.organisation_id = d.from_organisation_id
      join public.organisations o on o.id = d.to_organisation_id and o.deleted_at is null
     where a.action = 'invoice.delivered'
       and a.created_at > pg_catalog.now() - interval '7 days'
       and d.withdrawn_at is null
       and not exists (select 1 from private.notification_deliveries nd
                        where nd.audit_event_id = a.id and nd.notice = 'invoice_delivered')
     order by a.created_at, a.id
     limit greatest(1, least(coalesce(p_limit, 30), 30));
end;
$$;

comment on function public.pending_invoice_delivery_notifications(integer) is
  'service_role only: invoice.delivered audit rows from the last seven days, still live and not yet in the notice ledger, each with the RECEIVING workspace''s current view_finance holders'' addresses (tombstone excluded; nothing while that workspace is read-only), its slug and name, and the sender''s business name from the snapshot. No amount, number or line. lib/email/invoice-notifications.ts sends one email per row on the delivery tick.';
revoke all on function public.pending_invoice_delivery_notifications(integer) from public, anon, authenticated, service_role;
grant execute on function public.pending_invoice_delivery_notifications(integer) to service_role;
