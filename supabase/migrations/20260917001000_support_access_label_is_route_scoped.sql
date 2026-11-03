-- ===========================================================================
-- PHASE 7 TASK 6c, FIX ROUND 1, FINDING M2 -- THE Q121 LABEL MUST MEAN "THIS
-- REQUEST WAS IMPERSONATED", NOT "THIS PERSON HAS A SESSION OPEN SOMEWHERE".
--
-- 20260916002000 stamped the label as
--
--     (new.organisation_id is null) and private.is_impersonating()
--
-- and private.is_impersonating() asks only whether the caller holds ANY live
-- impersonation session. So the founder submitting feedback from
-- /super/feedback, /invites or /onboarding while a support-access session
-- happened to be running in another tab got a row reading "Sent during support
-- access" -- a row about the operator's OWN screens, labelled as being about a
-- customer's workspace. Nobody else can be affected (nobody else can hold a
-- session), so this was never a security defect; it is an ACCURACY defect on
-- the operator's own list, and the list is what the label exists for.
--
-- ===========================================================================
-- WHERE THE TRUTH COMES FROM -- THE SAME PLACE THE APP READS IT
-- ===========================================================================
-- lib/feedback/actions.ts already computes exactly the right thing:
--
--     const route = auditableRoute(await currentPath());
--     const slug  = firstPathSegment(route);
--     const org   = slug ? await getCurrentOrg(slug) : null;
--     const supportAccess = org?.isImpersonated === true;
--
-- i.e. "the workspace this request was IN is one I am impersonating". The
-- database cannot be TOLD that -- a flag from the client is a claim, which is
-- the whole reason the label is derived -- but it can derive the same thing
-- from the two facts it already has: the captured `route`, and the set of
-- organisations this caller is actively impersonating. That is
-- private.is_impersonating_route() below.
--
-- IS THE ROUTE NOT CLIENT-SUPPLIED? It is, and that is fine, because it is not
-- load-bearing for the SECURITY property. The label still requires
-- private.has_platform_permission('impersonate') (allowlist + aal2) AND a
-- live, unexpired session row, so a member cannot reach it by any route at
-- all: the section (3) test in rls_phase7_feedback.sql § FX is unchanged and
-- still passes. All the route does is NARROW the label from "while a session
-- was open" to "on a page inside the workspace that session names". The only
-- person who could spoof it is the operator the label describes, about their
-- own row. Narrower and forgeable-by-the-subject beats wider and exact.
--
-- ===========================================================================
-- THE TRIGGER IS REBUILT FROM ITS LATEST DEFINITION -- 20260916002000
-- ===========================================================================
-- Not from 20260911000000, which created it, and not from 20260911020000,
-- which reissued it once. Rebuilding from the wrong version cost a gate-3 run
-- in this very task (the screenshot-existence check vanished). The body below
-- is 20260916002000's, byte for byte, with ONE line changed: section (3)'s
-- label call. Whoever reissues this next starts from THIS file.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. "IS THIS CALLER IMPERSONATING THE WORKSPACE THIS ROUTE IS IN?"
--
--    private.is_impersonating() stays exactly as it is -- it answers a
--    different, still-useful question (§ FX9/FX15 read it directly, and it is
--    the honest primitive for "am I in a session at all"). This is the
--    route-scoped form the label needs.
--
--    The first path segment IS the workspace slug everywhere in this app:
--    app/(app)/[org]/* is the only org-scoped tree, and lib/feedback/actions.ts
--    resolves the current organisation from exactly this segment. A query
--    string never arrives (auditableRoute strips it before the row is built)
--    but is stripped again here, because a function that trusts its caller's
--    sanitising is one refactor from being wrong.
-- ---------------------------------------------------------------------------

create or replace function private.is_impersonating_route(p_route text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_platform_permission('impersonate')
     and exists (
       select 1
       from public.impersonation_sessions s
       join public.organisations o on o.id = s.target_organisation_id
       where s.superuser_user_id = (select auth.uid())
         and s.status = 'active'
         and s.expires_at > pg_catalog.now()
         and o.slug = pg_catalog.split_part(
                        pg_catalog.ltrim(
                          pg_catalog.split_part(coalesce(p_route, ''), '?', 1), '/'),
                        '/', 1)
     );
$$;

comment on function private.is_impersonating_route(text) is
  'True when auth.uid() is a platform superuser (allowlisted, at aal2) with a LIVE, unexpired impersonation session of the organisation whose slug is the FIRST PATH SEGMENT of p_route. The route-scoped form of private.is_impersonating(), and what public.feedback.during_support_access is stamped from since fix round 1 (M2): the label means "this submission came from a page inside the workspace I am impersonating", not "I had a session open somewhere while I typed this". The route is client-supplied and is deliberately NOT load-bearing -- the permission and session checks are, so a member reaches this by no route; the segment only narrows a label the operator could otherwise only widen about themselves.';

revoke all on function private.is_impersonating_route(text) from public, anon, authenticated, service_role;
grant execute on function private.is_impersonating_route(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE TRIGGER, REISSUED FROM 20260916002000 WITH ONE LINE CHANGED.
-- ---------------------------------------------------------------------------

create or replace function private.feedback_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_role   text;
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
  v_after  integer;
  v_retry  integer;
begin
  -- NOT A CLIENT SUBMISSION: a migration, a seed or a test fixture inserting
  -- as `postgres` has no session, is attributed by what it wrote, and spends
  -- nobody's budget. `auth.uid() is null`, deliberately NOT
  -- row_security_active() (false for every caller inside SECURITY DEFINER).
  if v_uid is null then
    return new;
  end if;

  -- (1) WHO. The row is the session's -- id and email both from the session,
  -- never from the request (the column grant means nothing could arrive).
  new.user_id := v_uid;
  select u.email into new.user_email from auth.users u where u.id = v_uid;

  -- (2) WHICH WORKSPACE, IN WHAT ROLE. The organisation is the caller's
  -- CLAIM; the membership table is the TRUTH.
  if new.organisation_id is null then
    new.organisation_role := null;
  else
    select m.role into v_role
    from public.organisation_memberships m
    where m.organisation_id = new.organisation_id
      and m.user_id = v_uid
      and m.status = 'active';
    if not found then
      raise exception 'feedback: not an active member of organisation %', new.organisation_id
        using errcode = '42501';
    end if;
    new.organisation_role := v_role;
  end if;

  -- (2b) A DECLARED SCREENSHOT MUST HAVE BYTES BEHIND IT (fix round 1, M1).
  -- The key's SHAPE is pinned by CHECK (feedback/{id}); its EXISTENCE is
  -- pinned here. No client can write the bucket (the restrictive fence), so
  -- an object under this key was put there by the server, after the sniff
  -- and the scan -- which is what makes the verdict column trustworthy.
  if new.screenshot_key is not null and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'feedback-screenshots'
          and o.name      = new.screenshot_key) then
    raise exception 'feedback: screenshot % has no stored object', new.screenshot_key
      using errcode = '42501';
  end if;

  -- (3) THE DATABASE OWNS THESE, whatever arrived -- the Q121 label included.
  -- An impersonating superuser holds no membership of the workspace they are
  -- inside, so their row is null-org by construction as well as by choice:
  -- the branch above would have refused a named one.
  new.status                := 'new';
  new.notified_at           := null;
  new.created_at            := pg_catalog.now();
  new.during_support_access := (new.organisation_id is null)
                               and private.is_impersonating_route(new.route);

  -- (4) THE METER -- after attribution, so a refused stranger spent nothing.
  select * into v_policy from public.rate_limit_policies p where p.category = 'feedback';
  if not found then
    raise exception 'feedback: no rate-limit policy for feedback' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
  from public.rate_limit_counters c
  where c.category      = 'feedback'
    and c.subject_scope = 'user'
    and c.subject_id    = v_uid
    and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  -- (4a) BUDGET ALREADY SPENT: raise having written nothing.
  if v_count >= v_policy.max_requests then
    raise exception 'feedback: you have reached the feedback limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (4b) COUNT IT, through the shared core -- user-scoped, NO organisation.
  select r.request_count into v_after
  from private.record_rate_limit_event('feedback', 'user', v_uid, null) r;

  -- (4c) THE RACE: the second of two that both passed (4a) at max - 1.
  if v_after > v_policy.max_requests then
    raise exception 'feedback: you have reached the feedback limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (4d) THE CROSSING ALERT, at the last accepted submission. Unattributed.
  if v_after = v_policy.max_requests then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'rate_limit_tripped',
      null,
      pg_catalog.format(
        'Rate limit reached: feedback (limit %s per %s seconds).',
        v_policy.max_requests, v_policy.window_seconds),
      pg_catalog.jsonb_build_object(
        'category',        'feedback',
        'subject_scope',   'user',
        'subject_id',      v_uid,
        'window_start',    v_window,
        'max_requests',    v_policy.max_requests,
        'window_seconds',  v_policy.window_seconds,
        'counts_refusals', false
      )
    );
  end if;

  return new;
end;
$$;

comment on function private.feedback_before_insert() is
  'BEFORE INSERT on public.feedback: attributes the row from the SESSION (never the request), refuses an organisation the caller is not an active member of, refuses a screenshot key with no stored object behind it, stamps the Q121 support-access label, and meters the submission (10/hour/user, PT429 with the retry in HINT). Fix round 1 (M2): the label is now stamped from private.is_impersonating_route(new.route) rather than private.is_impersonating(), so it means "sent from a page inside the workspace I am impersonating" rather than "sent while I had some session open". Everything else is 20260916002000''s body unchanged. REISSUE FROM THIS FILE, not from 20260911000000 or 20260911020000 or 20260916002000 -- rebuilding this trigger from an older version has already dropped a check once.';

comment on column public.feedback.during_support_access is
  'Founder ruling Q121: this submission was sent FROM A PAGE INSIDE a workspace the submitter is currently impersonating under break-glass support access, so it is the OPERATOR''s own feedback about a customer''s workspace and carries no organisation_id. NON-FORGEABLE BY CONSTRUCTION: outside the column-level INSERT grant (an INSERT naming it is 42501 before any trigger runs) and stamped by private.feedback_before_insert() from private.is_impersonating_route(route), never from the request. Fix round 1 (M2) added the ROUTE scoping: before it, any submission by an operator who happened to have a session open anywhere -- including their own /super pages -- was labelled. False on every ordinary submission, including the null-org ones from /invites, /onboarding and /super. Rendered as "Sent during support access" on /super/feedback.';
