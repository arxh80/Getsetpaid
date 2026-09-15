-- ===========================================================================
-- PHASE 7 TASK 6c -- FOUNDER RULING Q121: FEEDBACK SENT FROM INSIDE A
-- SUPPORT-ACCESS SESSION IS ACCEPTED AND LABELLED, NOT HIDDEN AND REFUSED.
-- THIS REVERSES TASK 6 FIX ROUND 1 (finding M4).
--
-- Task 6's fix round shipped hide-and-refuse: app/(app)/layout.tsx hid the
-- Feedback control when the render knew the request was impersonated, and
-- submitFeedbackAction refused early with IMPERSONATION_REFUSAL. The founder
-- chose the alternative that fix round queued: the submission is ACCEPTED with
-- `organisation_id = null`, attributed to the founder (as every submission is
-- attributed -- to whoever is signed in), the route captured as usual, and
-- clearly labelled "sent during support access" on the row and on
-- /super/feedback.
--
-- ===========================================================================
-- THE LABEL IS THE THING THAT MUST NOT BE FORGEABLE (Task 6's I1 class)
-- ===========================================================================
-- A workspace attribution is a CLAIM ABOUT SOMEBODY ELSE, which is why
-- private.feedback_before_insert() refuses an organisation the caller is not
-- an active member of. "Sent during support access" is the same kind of claim:
-- it tells the founder "this row is mine, from inside a customer's workspace",
-- and a member who could stamp it would be planting a row that reads as the
-- operator's own. So it is built the way every other attribution on this table
-- is built -- BY CONSTRUCTION, NOT BY VALIDATION:
--
--   * `during_support_access` is NOT in the column-level INSERT grant, so an
--     INSERT that so much as names it is 42501 before any trigger runs
--     (the user_id/user_email/organisation_role/status precedent);
--   * the trigger DERIVES it, from private.is_impersonating() -- a live,
--     unexpired, still-allowlisted, still-aal2 impersonation session belonging
--     to the caller -- and overwrites whatever arrived;
--   * so a normal member's row is `false` on every path: the app's dialog, a
--     stripped form post, and a direct PostgREST INSERT alike.
--
-- ===========================================================================
-- WHAT THIS DOES *NOT* DO, AND WHY -- READ BEFORE "TIGHTENING" IT
-- ===========================================================================
-- The ruling's working text says the trigger should allow the NULL-ORG ROW
-- only for an impersonating superuser. Implemented literally that would refuse
-- feedback from two real, signed-in, non-impersonated surfaces that have no
-- workspace in their path and never did:
--
--   /invites     -- a signed-in user reading invitations, including a user who
--                   already belongs to one workspace and is being invited to a
--                   second, so "has no membership" is not a usable proxy;
--   /onboarding  -- a user who has no workspace yet, by definition;
--
-- and /super itself, where the founder's own feedback resolves to no
-- workspace. Those rows are null-org today, have been since Task 6, and are
-- not a claim about anyone -- an ABSENT attribution is not a false one. The
-- security property the ruling is protecting is the LABEL, and the label is
-- enforced exactly as asked: it is reachable only by an impersonating platform
-- superuser and by nobody else. A blanket ban on null-org rows would delete a
-- working feature to close nothing.
--
-- Queued as DECISIONS-QUEUE **Q124** with this as the default, rather than
-- taken silently in either direction.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. "IS THIS CALLER INSIDE A LIVE SUPPORT-ACCESS SESSION?"
--
--    The same four conditions private.impersonated_organisations() applies,
--    minus the per-organisation and per-permission parts: this asks only
--    whether the caller is CURRENTLY IMPERSONATING SOMETHING, which is the
--    question the label answers. has_platform_permission() carries the aal2
--    and allowlist checks, so de-allowlisting or dropping below aal2 makes
--    this false instantly, with no row to update.
-- ---------------------------------------------------------------------------

create or replace function private.is_impersonating()
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
       where s.superuser_user_id = (select auth.uid())
         and s.status = 'active'
         and s.expires_at > pg_catalog.now()
     );
$$;

comment on function private.is_impersonating() is
  'True when auth.uid() is a platform superuser (allowlisted, at aal2) with a LIVE, unexpired impersonation session -- private.impersonated_organisations()''s conditions without the organisation and permission terms. Grants nothing: it is a fact about the caller, read by private.feedback_before_insert() to stamp feedback.during_support_access (Q121). The 60-minute time-box is evaluated here too, so an expired session reads `active` in the column and false here -- the clock is the grant (Q95).';

revoke all on function private.is_impersonating() from public, anon, authenticated, service_role;
grant execute on function private.is_impersonating() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE LABEL COLUMN -- derived, never granted.
-- ---------------------------------------------------------------------------

alter table public.feedback
  add column during_support_access boolean not null default false;

comment on column public.feedback.during_support_access is
  'Founder ruling Q121: this submission was sent from inside a break-glass support-access session, so it is the OPERATOR''s own feedback about a customer''s workspace and carries no organisation_id. NON-FORGEABLE BY CONSTRUCTION: outside the column-level INSERT grant (an INSERT naming it is 42501 before any trigger runs) and stamped by private.feedback_before_insert() from private.is_impersonating(), never from the request. False on every ordinary submission, including the null-org ones from /invites, /onboarding and /super. Rendered as "Sent during support access" on /super/feedback.';

create index feedback_during_support_access_idx
  on public.feedback (during_support_access)
  where during_support_access;


-- ---------------------------------------------------------------------------
-- 3. THE TRIGGER, REISSUED.
--
--    THE BODY IS COPIED FROM 20260911020000 -- THE LATEST VERSION -- NOT FROM
--    20260911000000, WHICH FIRST CREATED IT. That distinction cost a gate-3
--    run: reissuing from the ORIGINAL silently dropped fix round 1's
--    screenshot-existence check (M1), and the feedback suite caught it as four
--    refusals turning into accepts. A `create or replace` of a function that
--    has been reissued once is a REGRESSION RISK, not a copy -- whoever
--    reissues this next must start from the most recent definition, which is
--    now THIS file.
--
--    The only change here is (3): the Q121 label, stamped beside the other
--    database-owned columns. Attribution, the membership refusal, the
--    screenshot-existence check and the whole meter are byte-identical.
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
                               and private.is_impersonating();

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
  'THE ONE CHOKEPOINT every feedback writer passes (20260911000000; reissued by 20260916002000 for founder ruling Q121). Stamps user_id and user_email from the session, organisation_role from the caller''s OWN active membership, refuses (42501) a workspace they are not a member of, refuses (42501) a declared screenshot with no stored object behind its key (20260911020000''s M1, carried forward unchanged), stamps status/notified_at/created_at, stamps `during_support_access` from private.is_impersonating() -- so the "sent during support access" label is reachable only by a platform superuser inside a live break-glass session and by nobody else -- and spends the 10/hour budget (PT429, remaining seconds in `hint`). A null organisation is accepted from any caller, as before: /invites, /onboarding and /super are real signed-in surfaces with no workspace in their path, and an ABSENT attribution is not a false one (see 20260916002000''s header; Q124).';

revoke all on function private.feedback_before_insert() from public, anon, authenticated, service_role;
