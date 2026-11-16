-- ===========================================================================
-- WORKSPACE CREATION IS CAPPED (audit 2026-11-16; founder ruling the same day)
-- ===========================================================================
-- create_organisation had no count or rate check. Every workspace is born with
-- a Starter subscription and its own per-organisation budgets (connection
-- requests, storage), so one free sign-up could mint workspaces to multiply
-- those budgets and to hold workspace addresses in bulk.
--
-- Ruling: at most 5 workspaces an account owns, and at most 3 created in an
-- hour. Both are counted on the caller's active Owner memberships: this
-- function is the only client path to one, and it stamps joined_at = now().
-- Nothing new to keep in step. An account already over 5 keeps what it has.
--
-- Body is 20260908000000's, unchanged, plus the two counts and refusals.
-- Grants are unchanged (create or replace keeps them).
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

  -- Audit 2026-11-16 (founder ruling, same day): 5 workspaces an account, 3 an
  -- hour. Every workspace is born with a Starter plan and its own per-workspace
  -- budgets, so uncapped creation multiplied them and let one sign-up hold
  -- workspace addresses in bulk. Counted on the caller's own active Owner
  -- memberships, which this function is the only client path to.
  select count(*),
         count(*) filter (where m.joined_at > pg_catalog.now() - interval '1 hour')
    into v_owned, v_recent
    from public.organisation_memberships m
   where m.user_id = v_actor and m.role = 'owner' and m.status = 'active';
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

  -- Phase 7, Task A: every organisation now carries a subscription row from
  -- birth, closing the gap private.crm_write_organisations() and
  -- private.custom_field_limit() used to read as "not yet billed, therefore
  -- not yet gated". Starter -- see this migration's header for why.
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
  'Creates an organisation plus the caller''s owner membership and a Starter-tier organisation_subscriptions row, atomically, and audits it. The only sanctioned path -- public.organisations has no INSERT policy. Since 20261116002000 it refuses an account that already holds 5 active Owner memberships (22023 workspace_limit_reached) or gained 3 in the last hour (PT429 workspace_rate_limited).';
