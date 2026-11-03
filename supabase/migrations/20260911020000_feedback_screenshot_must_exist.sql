-- Phase 7 Task 6, fix round 1, review finding M1: a client cannot DECLARE a
-- screenshot -- and its scan verdict -- with no bytes behind it.
--
-- ===========================================================================
-- THE HOLE
-- ===========================================================================
-- The client INSERT grant on public.feedback (20260911000000 § 2) includes
-- the five screenshot columns, because the application writes them after it
-- has uploaded and scanned the bytes. The bucket fence means no client can
-- put bytes in `feedback-screenshots`, so nothing unscanned can ever be
-- served -- but on the direct PostgREST path the VERDICT was client-supplied:
-- `screenshot_key = 'feedback/<own id>', screenshot_scan_status = 'clean'`
-- passed every CHECK and the trigger. /super/feedback then rendered "View
-- screenshot"; following it wrote a feedback.screenshot_viewed audit row and
-- answered 500 when createSignedUrl found no object. The audit log recorded
-- a view that did not happen. The same request with 'quarantined' filed an
-- upload_quarantined incident alert against the caller's own workspace with
-- no upload -- noise on /super/health.
--
-- ===========================================================================
-- THE RULE: "the row says there is a screenshot" => "the server put bytes there"
-- ===========================================================================
-- private.feedback_before_insert() is SECURITY DEFINER and can read
-- storage.objects. For a SESSION writer (auth.uid() is not null -- every
-- PostgREST caller, the application included) that names a screenshot_key,
-- the object must already exist in the feedback bucket, or the INSERT is
-- refused with 42501 like every other forged attribution. The application
-- uploads before it inserts, so its path is unaffected. Sessionless writers
-- (fixtures, seeds, the psql suite's planted rows) keep their exemption, as
-- for every other stamp in this trigger.
--
-- Placed AFTER attribution and BEFORE the meter, so a refused forgery spends
-- no budget -- the same order the membership refusal already has.
--
-- The application side (lib/feedback/screenshot.ts) additionally checks the
-- object exists BEFORE it calls audit_feedback_screenshot_view(), so a row
-- whose bytes are gone for any other reason (a future GC, a manual delete) is
-- a 404 with no audit row rather than an audit row with a 500.
--
-- ADDITIVE: `create or replace` of the trigger function only; the trigger
-- itself (feedback_before_insert, 20260911000000 § 5) is untouched and keeps
-- pointing at it. The body below is 20260911000000's verbatim plus step (2b).
-- ===========================================================================

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

  -- (3) THE DATABASE OWNS THESE, whatever arrived.
  new.status      := 'new';
  new.notified_at := null;
  new.created_at  := pg_catalog.now();

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
  'BEFORE INSERT on public.feedback, for every writer (the app''s form and a direct PostgREST INSERT alike). Attribution first: user_id := auth.uid(); organisation_role := the caller''s own ACTIVE membership role in organisation_id, or 42501 if they hold none (Task 5 finding I1, closed by construction). Since fix round 1 (20260911020000, finding M1) a session writer naming a screenshot_key must have a stored object under it in the feedback-screenshots bucket, or 42501 -- so a client cannot declare a screenshot or its scan verdict with no bytes behind them. Then the 10/hour meter (Task 5 finding I2: metered where every writer passes): PT429 with the remaining seconds in hint, crossing alert at the last accepted submission, no counting past the limit (Q115). Exempts sessionless writers (auth.uid() is null: migrations, seeds, fixtures).';
