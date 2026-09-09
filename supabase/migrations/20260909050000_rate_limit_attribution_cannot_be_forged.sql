-- Phase 7 Task 5, fix round 1, review finding I1: an incident alert's
-- organisation attribution was CALLER-SUPPLIED for user-scoped categories.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- public.consume_rate_limit() validated p_organisation_id ONLY when the
-- category was organisation-scoped (membership required, so a stranger could
-- not burn a foreign tenant's allowance -- § RS7/RS8/RS9). For a USER-scoped
-- category it validated nothing and still passed the value straight through
-- to private.record_rate_limit_event(), which writes it into
-- public.incident_alerts.organisation_id.
--
-- Reproduced by the reviewer on a local stack: a manager of one workspace
-- called `consume_rate_limit('search', '<a foreign org id>')` 61 times and
-- produced a `rate_limit_tripped` alert ATTRIBUTED TO THE FOREIGN WORKSPACE.
-- The reachable form is `POST /rest/v1/rpc/consume_rate_limit` with the anon
-- key and a session JWT -- the function is granted to `authenticated` and its
-- own comment says it is callable directly.
--
-- Targeting was not a UUID-guessing problem: public.network_profiles carries
-- organisation_id, is SELECT-granted to `authenticated`, and carries the
-- deliberately cross-tenant network_profiles_select_published_directory
-- policy. RLS filters ROWS, NOT COLUMNS (Q103's own rule), so
-- `GET /rest/v1/network_profiles?select=organisation_id` hands any
-- authenticated caller the organisation id of every published profile on the
-- platform.
--
-- It mattered more than a wrong label: app/(app)/super/health/page.tsx renders
-- alertType, organisationName, summary and createdAt and does NOT render
-- `details`, so the forged workspace name was the ONLY attribution the
-- operator ever saw, and CLAUDE.md § Superuser dashboard's next moves off an
-- alert are suspend/close or an impersonation request -- aimed, here, at the
-- wrong tenant. Two categories at 60/min and 30/min meant one account could
-- also file ~2,880 forged alerts a day into a 50-row unpaginated list.
--
-- ===========================================================================
-- THE FIX: NON-FORGEABLE, NOT MERELY VALIDATED
-- ===========================================================================
-- A user-scoped budget HAS no organisation -- a user belongs to many
-- workspaces and the request being counted names none of them -- so there is
-- nothing to derive and the honest value is NULL. Two changes, belt and
-- braces:
--
--   1. The call into the core passes p_organisation_id ONLY on the
--      organisation-scoped branch, where membership has already been checked.
--      Every other branch passes a literal null. Nothing a caller supplies can
--      reach incident_alerts.organisation_id on a path that did not verify it.
--   2. Supplying an organisation to a user-scoped category is now a LOUD
--      caller bug (22023) rather than a silently-ignored argument. The
--      application never does this (lib/list/query.ts calls with the category
--      alone), so a call that does is either a mistake or an attempt, and
--      both are better answered than absorbed.
--
-- The UI half is in the same commit: an alert with no organisation now renders
-- as "not attributed to a workspace", with the subject scope from `details`
-- beside it, instead of rendering nothing and leaving the operator to assume.
--
-- The suite gains § RS7d/RS7e/RS7f, beside the RS7c the reviewer correctly
-- says stopped one column short: RS7c proved a foreign org id is refused for
-- an ORGANISATION-scoped category, and nothing asserted the user-scoped
-- combination, which is the one that worked.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function public.consume_rate_limit(
  p_category        text,
  p_organisation_id uuid default null
)
returns table (allowed boolean, retry_after_seconds integer, request_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope   text;
  v_subject uuid;
  -- What is attributed to a workspace. Set ONLY on the organisation-scoped
  -- branch, after membership has been verified; null everywhere else.
  v_organisation_id uuid := null;
begin
  if (select auth.uid()) is null then
    raise exception 'consume_rate_limit: no session' using errcode = '28000';
  end if;

  select p.subject_scope into v_scope
  from public.rate_limit_policies p where p.category = p_category;
  if not found then
    raise exception 'consume_rate_limit: unknown rate-limit category %', p_category
      using errcode = '22023';
  end if;

  if v_scope = 'account' then
    -- Account-scoped budgets (login, recovery) belong to the auth layer's
    -- own hooks -- letting a session burn them would let a signed-in
    -- attacker lock an account they already control into looking attacked.
    raise exception 'consume_rate_limit: category % is not consumable from a client session', p_category
      using errcode = '42501';
  elsif v_scope = 'organisation' then
    if p_organisation_id is null then
      raise exception 'consume_rate_limit: category % needs an organisation', p_category
        using errcode = '22023';
    end if;
    -- Membership required: an organisation's budget is burnable only by its
    -- own members, or any authenticated stranger could exhaust another
    -- tenant's export allowance -- a denial of service through the limiter.
    -- It is ALSO what makes the attribution honest: this is the only branch
    -- on which a caller-supplied organisation id reaches an alert row, and it
    -- reaches one only after this check.
    if not private.is_active_member(p_organisation_id) then
      raise exception 'consume_rate_limit: not a member of that organisation'
        using errcode = '42501';
    end if;
    v_subject         := p_organisation_id;
    v_organisation_id := p_organisation_id;
  else
    -- USER-SCOPED. The subject is the caller, and the ATTRIBUTION IS NOT THE
    -- CALLER'S TO SUPPLY (fix round 1, I1). A user-scoped request has no
    -- workspace: the same person may hold five memberships and this request
    -- names none of them. So the alert's organisation_id stays null and the
    -- health view says so, rather than naming a workspace a caller chose.
    if p_organisation_id is not null then
      raise exception 'consume_rate_limit: category % is user-scoped and takes no organisation', p_category
        using errcode = '22023';
    end if;
    v_subject := (select auth.uid());
  end if;

  return query select * from private.record_rate_limit_event(
    p_category, v_scope, v_subject, v_organisation_id);
end;
$$;

comment on function public.consume_rate_limit(text, uuid) is
  'The application''s one rate-limiting call (lib/security/rate-limit.ts): counts this request against the caller''s own budget for p_category and returns the verdict. User-scoped categories bind to auth.uid() and take NO organisation -- supplying one is a caller bug (22023) and can never reach an incident alert''s organisation_id, which is fix round 1''s I1: attribution is non-forgeable, not merely validated. Organisation-scoped categories require p_organisation_id plus active membership (so a stranger cannot burn another tenant''s budget, and so the one branch that DOES attribute an alert to a workspace has verified the caller belongs to it); account-scoped ones refuse (42501 -- they belong to the auth hooks). Returns a verdict rather than raising a 429-alike, deliberately: the refusal must COMMIT its own increment and possible alert row (see 20260909020000''s header), and the app shapes the 429. Callable directly over PostgREST -- a caller doing so can only spend their own budget faster, and can no longer name anybody else''s workspace while doing it.';

revoke all on function public.consume_rate_limit(text, uuid) from public, anon, service_role;
grant execute on function public.consume_rate_limit(text, uuid) to authenticated;
