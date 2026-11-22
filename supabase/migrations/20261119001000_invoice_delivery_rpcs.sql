-- ===========================================================================
-- INVOICES PART 3 -- TASK 2: DELIVER, WITHDRAW, AND THE PAGE'S STATE READ.
-- ONE eligibility predicate (plan decision 5), called by the write and by the
-- read the sender's invoice page makes. EVERY refusal is one error (plan
-- decision 6): 42501 / invoice_delivery_refused.
-- ===========================================================================

-- Rules 2 to 6 of the spec, for the CALLER: the invoice's workspace is Pro and
-- not read-only (private.finance_module_organisations() is both), the invoice
-- is issued or paid and to a company, the caller's workspace has a live link
-- from that company to p_profile_id, the profile is published, live and in
-- another workspace that is not read-only, and the two workspaces have an
-- accepted connection either way round. Returns that workspace, or null.
-- Rule 1 (manage_finance) is the caller's to check. Not a definer: it runs
-- with the privileges of the definer that calls it. No grants.
create function private.invoice_delivery_target(p_invoice_id uuid, p_profile_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select p.organisation_id
    from public.invoices i
    join public.network_links l
      on l.organisation_id     = i.organisation_id
     and l.private_entity_type = 'company'
     and l.private_entity_id   = i.recipient_company_id
     and l.network_profile_id  = p_profile_id
     and l.deleted_at is null
    join public.network_profiles p
      on p.id = l.network_profile_id
     and p.status = 'published'
     and p.deleted_at is null
     and p.organisation_id <> i.organisation_id
    join public.organisations o
      on o.id = p.organisation_id
     and o.deleted_at is null
   where i.id = p_invoice_id
     and i.status in ('issued', 'paid')
     and i.recipient_company_id is not null
     and i.organisation_id in (select private.finance_module_organisations())
     and exists (
       select 1 from public.network_connection_requests r
        where r.status = 'accepted'
          and (   (r.from_organisation_id = i.organisation_id and r.to_organisation_id   = p.organisation_id)
               or (r.to_organisation_id   = i.organisation_id and r.from_organisation_id = p.organisation_id)))
   limit 1;
$$;
comment on function private.invoice_delivery_target(uuid, uuid) is
  'Invoices part 3: the workspace p_profile_id belongs to, when the CALLER''s invoice may be delivered there (spec rules 2-6), else null. The one eligibility predicate: public.deliver_invoice and public.invoice_delivery_state both call it. Rule 1 (manage_finance) is the caller''s.';
revoke all on function private.invoice_delivery_target(uuid, uuid) from public, anon, authenticated, service_role;

create function public.deliver_invoice(p_invoice_id uuid, p_network_profile_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_org    uuid;
  v_number text;
  v_to     uuid;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'deliver_invoice: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select i.organisation_id, i.number into v_org, v_number
    from public.invoices i where i.id = p_invoice_id for update;
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'deliver_invoice: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  v_to := private.invoice_delivery_target(p_invoice_id, p_network_profile_id);
  if v_to is null then
    raise exception 'deliver_invoice: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  -- Idempotent: the same invoice to the same workspace is the live row already there.
  select d.id into v_id from public.invoice_deliveries d
   where d.invoice_id = p_invoice_id and d.to_organisation_id = v_to and d.withdrawn_at is null;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.invoice_deliveries (invoice_id, from_organisation_id, to_organisation_id, delivered_by)
  values (p_invoice_id, v_org, v_to, v_uid)
  returning id into v_id;
  perform private.log_audit_event(
    p_action          => 'invoice.delivered',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => v_id,
    p_after           => pg_catalog.jsonb_build_object('number', v_number));
  return v_id;
end;
$$;
comment on function public.deliver_invoice(uuid, uuid) is
  'Invoices part 3: delivers the caller''s issued or paid invoice into the connected workspace that owns p_network_profile_id (manage_finance, then private.invoice_delivery_target). Every refusal is 42501 invoice_delivery_refused. A repeat returns the live delivery. Audits invoice.delivered (target the delivery, payload the number). Budget: private.meter_invoice_delivery, 30/h/user.';
revoke all on function public.deliver_invoice(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.deliver_invoice(uuid, uuid) to authenticated;

create function public.withdraw_invoice_delivery(p_delivery_id uuid)
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
    raise exception 'withdraw_invoice_delivery: no authenticated user'
      using errcode = '28000', hint = 'not_authenticated';
  end if;
  select d.from_organisation_id into v_org from public.invoice_deliveries d
   where d.id = p_delivery_id and d.withdrawn_at is null for update;
  -- No tier gate: a downgraded workspace can still pull back what it sent.
  -- has_permission refuses a read-only workspace (manage_finance does not survive suspension).
  if v_org is null or not public.has_permission(v_org, 'manage_finance') then
    raise exception 'withdraw_invoice_delivery: refused'
      using errcode = '42501', hint = 'invoice_delivery_refused';
  end if;
  update public.invoice_deliveries d
     set withdrawn_at = pg_catalog.now(), withdrawn_by = v_uid
   where d.id = p_delivery_id;
  perform private.log_audit_event(
    p_action          => 'invoice.delivery_withdrawn',
    p_target_type     => 'invoice_delivery',
    p_organisation_id => v_org,
    p_target_id       => p_delivery_id,
    p_after           => pg_catalog.jsonb_build_object('changed', pg_catalog.jsonb_build_array('withdrawn_at')));
end;
$$;
comment on function public.withdraw_invoice_delivery(uuid) is
  'Invoices part 3: the sender pulls back a live delivery (manage_finance, not read-only, no tier gate). Stamps withdrawn_at/by; the receiver''s view drops it at once. Audits invoice.delivery_withdrawn. The invoice may then be delivered again.';
revoke all on function public.withdraw_invoice_delivery(uuid) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_invoice_delivery(uuid) to authenticated;

-- The sender's invoice page reads this and nothing else of the network: one
-- row per live delivery (named by a linked live profile of that workspace if
-- one still exists) and one per eligible profile not yet delivered to. Empty
-- for a caller without view_finance in the invoice's workspace.
create function public.invoice_delivery_state(p_invoice_id uuid)
returns table (network_profile_id uuid, display_name text, delivery_id uuid, delivered_at timestamptz, can_deliver boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.id, i.organisation_id, i.recipient_company_id
      from public.invoices i
     where i.id = p_invoice_id
       and i.organisation_id in (select private.permitted_organisations('view_finance'))
  ),
  candidates as (
    select p.id as profile_id, p.display_name, p.organisation_id as to_org,
           private.invoice_delivery_target(inv.id, p.id) as target
      from inv
      join public.network_links l
        on l.organisation_id = inv.organisation_id
       and l.private_entity_type = 'company'
       and l.private_entity_id = inv.recipient_company_id
       and l.deleted_at is null
      join public.network_profiles p
        on p.id = l.network_profile_id and p.status = 'published' and p.deleted_at is null
  ),
  live as (
    select d.id, d.to_organisation_id, d.delivered_at
      from inv join public.invoice_deliveries d on d.invoice_id = inv.id
     where d.withdrawn_at is null
  )
  select (select c.profile_id   from candidates c where c.to_org = lv.to_organisation_id order by c.display_name limit 1),
         (select c.display_name from candidates c where c.to_org = lv.to_organisation_id order by c.display_name limit 1),
         lv.id, lv.delivered_at, false
    from live lv
  union all
  select c.profile_id, c.display_name, null, null, true
    from candidates c
   where c.target is not null
     and not exists (select 1 from live lv where lv.to_organisation_id = c.target);
$$;
comment on function public.invoice_delivery_state(uuid) is
  'Invoices part 3: what the sender''s invoice page shows -- each live delivery (with the display name of a linked, live profile of that workspace, or null) and each profile the invoice may be delivered to now (can_deliver, from private.invoice_delivery_target). Empty without view_finance in the invoice''s workspace. Exposes only display_name, which is always visible on a published profile (Q71).';
revoke all on function public.invoice_delivery_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.invoice_delivery_state(uuid) to authenticated;
