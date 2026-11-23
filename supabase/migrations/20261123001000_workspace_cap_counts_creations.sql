-- ===========================================================================
-- THE WORKSPACE CAP COUNTS WHAT THE ACCOUNT CREATED, NOT ONLY WHAT IT OWNS
-- ===========================================================================
-- 20261116002000 capped create_organisation at 5 workspaces an account and 3
-- an hour, counted on the caller's active Owner memberships. Its header said
-- this function is the only client path to one; that is true, but the caller
-- can also LOSE one. A workspace is empty straight after creation, and
-- private.membership_keeps_an_owner() lets the sole Owner of an empty
-- workspace demote themselves or delete their own row. Either drops the count,
-- so create, demote, repeat had no limit and left ownerless workspaces behind.
--
-- The count now also reads the organisation.created audit row. Its
-- actor_user_id is forced to auth.uid() by private.log_audit_event(), no
-- client role can insert, update or delete public.audit_events, and nothing
-- a member does to a membership touches it. A workspace counts once if either
-- source names it, and only while the workspace row still exists (a purged
-- workspace frees its slot, exactly as its cascaded memberships did before).
--
-- Residual: audit rows are purged after the audit period (at least a year),
-- so a workspace the account created and no longer owns stops counting then.
--
-- Body is 20261116002000's, unchanged apart from the count. Grants are
-- unchanged (create or replace keeps them).
-- ===========================================================================

create or replace function public.create_organisation(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_org   uuid;
  v_owned  integer;
  v_recent integer;
begin
  -- Defence in depth: this function bypasses RLS, so it re-checks the one
  -- thing RLS would otherwise have guaranteed.
  if v_actor is null then
    raise exception 'create_organisation: no authenticated user (auth.uid() is null)'
      using errcode = '28000';
  end if;

  if v_name = '' then
    raise exception 'create_organisation: name is required' using errcode = '22023';
  end if;

  -- Slugs address organisations in URLs; constrain the shape here rather than
  -- accepting whatever a client sends into a user-facing identifier.
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.length(v_slug) < 2 or pg_catalog.length(v_slug) > 63 then
    raise exception 'create_organisation: slug must be 2-63 chars of lowercase letters, digits and single hyphens (got %)', p_slug
      using errcode = '22023';
  end if;

  -- 5 workspaces an account, 3 an hour: every workspace is born with a Starter
  -- plan and its own per-workspace budgets. Counted on the creation audit row
  -- as well as the Owner memberships, because the caller can shed an Owner
  -- membership of an empty workspace but cannot touch an audit row.
  select count(distinct x.org),
         count(distinct x.org) filter (where x.at > pg_catalog.now() - interval '1 hour')
    into v_owned, v_recent
    from (
      select a.target_id as org, a.created_at as at
        from public.audit_events a
       where a.actor_user_id = v_actor
         and a.action = 'organisation.created'
      union all
      select m.organisation_id, m.joined_at
        from public.organisation_memberships m
       where m.user_id = v_actor and m.role = 'owner' and m.status = 'active'
    ) x
    join public.organisations o on o.id = x.org;
  if v_owned >= 5 then
    raise exception 'create_organisation: this account already owns 5 workspaces'
      using errcode = '22023', hint = 'workspace_limit_reached';
  end if;
  if v_recent >= 3 then
    raise exception 'create_organisation: this account has created 3 workspaces in the last hour'
      using errcode = 'PT429', hint = 'workspace_rate_limited';
  end if;

  insert into public.organisations (name, slug)
  values (v_name, v_slug)
  returning id into v_org;

  insert into public.organisation_memberships
    (organisation_id, user_id, role, status, joined_at)
  values
    (v_org, v_actor, 'owner', 'active', now());

  -- Every organisation carries a subscription row from birth, so
  -- private.crm_write_organisations() and private.custom_field_limit() never
  -- read a workspace as "not yet billed, therefore not yet gated".
  insert into public.organisation_subscriptions
    (organisation_id, plan_id, billing_cycle, seat_count, status, current_period_end)
  values
    (v_org, 'starter', 'monthly', 1, 'active', now() + interval '30 days');

  perform private.log_audit_event(
    p_action          => 'organisation.created',
    p_target_type     => 'organisation',
    p_organisation_id => v_org,
    p_target_id       => v_org,
    p_after           => pg_catalog.jsonb_build_object('name', v_name, 'slug', v_slug)
  );

  return v_org;
end;
$$;

comment on function public.create_organisation(text, text) is
  'Creates an organisation plus the caller''s owner membership and a Starter-tier organisation_subscriptions row, atomically, and audits it. The only sanctioned path -- public.organisations has no INSERT policy. Refuses an account that already has 5 workspaces (22023 workspace_limit_reached) or 3 in the last hour (PT429 workspace_rate_limited), counting each still-existing workspace once if the caller created it (its organisation.created audit row, which no client can write or remove) or holds an active Owner membership of it.';
