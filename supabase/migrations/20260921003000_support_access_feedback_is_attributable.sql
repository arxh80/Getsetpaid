-- ===========================================================================
-- PHASE 7 PRE-MERGE FIX ROUND, FINDING I2 -- A SUPPORT-ACCESS SCREENSHOT HAD
-- LESS ATTRIBUTION THAN AN IMPERSONATED PAGE VIEW.
--
-- Founder ruling Q121 (20260916002000 / 20260917001000) makes a submission from
-- inside a support session land with `organisation_id = null` and
-- `during_support_access = true`. That is right -- it is the OPERATOR's
-- feedback, and an impersonator holds no membership to attribute it to -- but
-- both audit writers pass the row's own organisation_id:
--
--   private.audit_feedback_submission()      p_organisation_id => new.organisation_id
--   public.audit_feedback_screenshot_view()  p_organisation_id => v_org
--
-- For a support-access row that is NULL. So `feedback.submitted` and, worse,
-- `feedback.screenshot_viewed` -- the one deliberate exception to "no direct
-- tenant-data access outside impersonation", which CLAUDE.md says carries "the
-- same audit discipline as impersonation" -- appear under NEITHER the
-- workspace's organisation filter on /super/audit-log NOR the session's
-- correlation thread. An impersonated PAGE VIEW carries the organisation;
-- a screenshot of that page's content did not.
--
-- The only residual attribution was the `route` text column, rendered on
-- /super/feedback as a display string: not filterable, not joinable, and not on
-- the audit surface at all.
--
-- ===========================================================================
-- WHAT THIS ADDS: TWO DB-OWNED COLUMNS, AND THE THREE WRITERS THAT READ THEM
-- ===========================================================================
-- `support_access_session_id`      the impersonation session the submission
--                                  came from -- the correlation thread every
--                                  other event of that session already hangs
--                                  off (request/accept/start/page-view/end).
-- `support_access_organisation_id` the workspace that session names -- what
--                                  puts the row on /super/audit-log's own
--                                  organisation filter.
--
-- NON-FORGEABLE BY CONSTRUCTION, the same shape as `user_id`,
-- `organisation_role` and `during_support_access`: both are outside the
-- column-level INSERT grant, so an INSERT that so much as names one is 42501
-- before any trigger runs, and both are derived from the SESSION CATALOGUE
-- rather than from anything the request carried.
--
-- THEY DO NOT MAKE THE ROW THE WORKSPACE'S. `organisation_id` stays null:
-- the submission is still the operator's, /super/feedback still renders "Sent
-- during support access" rather than a workspace, the workspace's own members
-- still cannot read it (no policy admits them), and `organisation_role` is
-- still null because the operator holds no membership. What changes is only
-- that the AUDIT trail of the operator's own actions names the workspace whose
-- data they were looking at -- which is the discipline impersonation already
-- has.
--
-- ===========================================================================
-- SHOULD VIEWING BE REFUSED ONCE THE SESSION ENDS? NOT AT MVP -- QUEUED (Q127)
-- ===========================================================================
-- Considered and deliberately not taken here. /super/feedback is the founder's
-- own bug-report queue, and the whole purpose of a screenshot is that it is
-- looked at when the report is WORKED, not within the 60 minutes the session
-- happened to last. Refusing after the box would make a class of report
-- unreadable in the one product surface built to read it, and would do it by
-- an expiry rule nothing in the submission flow warns about.
--
-- The RISK the time-box closes is real (an operator holding a screenshot of a
-- customer's record for two years), so it is not argued away: it is queued as
-- DECISIONS-QUEUE Q127 with the shipped default written down, and the interim
-- control is this migration -- every such view is now attributable to the
-- workspace and to the session that produced it, which is what makes the
-- retention question answerable from the audit log rather than from memory.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE COLUMNS.
--
-- No FK to public.impersonation_sessions or public.organisations on purpose:
-- a feedback row is a permanent record of a submission and must not be
-- deletable-by-cascade or blocked-from-deletion by either of them, and the
-- Phase 8 retention job will purge the two tables on different clocks (60-day
-- workspace retention, 2-year feedback retention). They are recorded facts,
-- not live references -- the same posture audit_events.target_id has.
-- ---------------------------------------------------------------------------
alter table public.feedback
  add column if not exists support_access_session_id      uuid,
  add column if not exists support_access_organisation_id uuid;

comment on column public.feedback.support_access_session_id is
  'The break-glass impersonation session this submission was sent from, or NULL. Stamped by private.feedback_before_insert() from the session catalogue whenever during_support_access is true, and OUTSIDE the column-level INSERT grant, so no client can name it (pre-merge review finding I2). It is the correlation id every other event of that session hangs off -- impersonation.requested/accepted/started, every impersonated page view, impersonation.ended -- so feedback.submitted and feedback.screenshot_viewed now join that thread instead of starting one of their own. Deliberately NOT a foreign key: this is a recorded fact about a past submission, not a live reference, and the two tables are purged on different retention clocks.';

comment on column public.feedback.support_access_organisation_id is
  'The workspace the support-access session named, or NULL. NOT the row''s organisation -- public.feedback.organisation_id stays null for a support-access submission (founder ruling Q121), because the row is the OPERATOR''s and an impersonator holds no membership to attribute it to. This column exists so the AUDIT of the operator''s own actions names the workspace whose data was on screen: without it feedback.screenshot_viewed -- CLAUDE.md''s "one deliberate exception to no direct tenant-data access outside impersonation" -- carried strictly LESS attribution than an impersonated page view, appearing under no organisation filter at all (pre-merge review finding I2). Outside the INSERT grant, derived from the session catalogue, never from the request.';

-- CLAUDE.md § Non-negotiable rules: index every foreign key. These are not
-- literal FKs (see above) but they are the join keys the audit-log filters and
-- any future retention sweep will use, so they are indexed as if they were.
-- Partial: a support-access submission is a rounding error in this table.
create index if not exists feedback_support_access_session_id_idx
  on public.feedback (support_access_session_id)
  where support_access_session_id is not null;

create index if not exists feedback_support_access_organisation_id_idx
  on public.feedback (support_access_organisation_id)
  where support_access_organisation_id is not null;


-- ---------------------------------------------------------------------------
-- 2. WHICH SESSION. The id form of private.is_impersonating_route().
--
-- That function returns a BOOLEAN and the trigger still stamps the label from
-- it, unchanged -- this is its sibling, returning the row instead of the fact,
-- so the label's derivation is not rewritten to obtain the id. The predicate
-- is character-for-character 20260917001000's, so the two cannot disagree
-- about whether a route is inside a session.
-- ---------------------------------------------------------------------------
create or replace function private.impersonated_route_session(p_route text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
  from public.impersonation_sessions s
  join public.organisations o on o.id = s.target_organisation_id
  where private.has_platform_permission('impersonate')
    and s.superuser_user_id = (select auth.uid())
    and s.status = 'active'
    and s.expires_at > pg_catalog.now()
    and o.slug = pg_catalog.split_part(
                   pg_catalog.ltrim(
                     pg_catalog.split_part(coalesce(p_route, ''), '?', 1), '/'),
                   '/', 1)
  order by s.started_at desc
  limit 1;
$$;

comment on function private.impersonated_route_session(text) is
  'The id form of private.is_impersonating_route(): the LIVE, unexpired impersonation session held by auth.uid() over the workspace whose slug is the first path segment of p_route, or NULL. Same predicate, same allowlist and aal2 terms, same 60-minute time-box -- it returns the row instead of the boolean so private.feedback_before_insert() can stamp public.feedback.support_access_session_id / support_access_organisation_id without rewriting how the Q121 label is derived (pre-merge review finding I2). Grants nothing: it is a fact about the caller''s own sessions. NOT granted to any session role -- only the definer trigger calls it, and a future caller who needs it must re-grant it in a migration, the 20260918002000 discipline.';

revoke all on function private.impersonated_route_session(text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE TRIGGER, REISSUED FROM ITS LATEST DEFINITION -- 20260917001000.
--
-- Not from 20260911000000, not 20260911020000, not 20260916002000. Rebuilding
-- this trigger from the wrong version has already dropped the
-- screenshot-existence check once in this phase. The body below is
-- 20260917001000's, byte for byte, with FOUR LINES ADDED in section (3) and
-- nothing else touched. Whoever reissues this next starts from THIS file.
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

  -- (3b) ...AND, WHEN IT IS SUPPORT ACCESS, WHICH SESSION AND WHOSE WORKSPACE
  -- (pre-merge review finding I2). Not to attribute the ROW -- organisation_id
  -- stays null, Q121 -- but so the AUDIT of the operator's own actions on it
  -- names the workspace whose data was on screen and joins the session's own
  -- correlation thread. Without these two, feedback.screenshot_viewed carried
  -- strictly less attribution than an impersonated page view.
  new.support_access_session_id := case
    when new.during_support_access then private.impersonated_route_session(new.route)
  end;
  select s.target_organisation_id into new.support_access_organisation_id
  from public.impersonation_sessions s
  where s.id = new.support_access_session_id;

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
  'BEFORE INSERT on public.feedback: attributes the row from the SESSION (never the request), refuses an organisation the caller is not an active member of, refuses a screenshot key with no stored object behind it, stamps the Q121 support-access label AND (since the pre-merge fix round, finding I2) the session id and impersonated workspace that make the row''s audit trail attributable, and meters the submission (10/hour/user, PT429 with the retry in HINT). The label is stamped from private.is_impersonating_route(new.route) -- fix round 1 (M2) -- so it means "sent from a page inside the workspace I am impersonating"; the two new columns come from its id-returning sibling private.impersonated_route_session(), the same predicate. organisation_id is UNCHANGED and still null for a support-access row (Q121). REISSUE FROM THIS FILE, not from 20260911000000 or 20260911020000 or 20260916002000 or 20260917001000 -- rebuilding this trigger from an older version has already dropped a check once.';


-- ---------------------------------------------------------------------------
-- 4. THE UPDATE GUARD, reissued from 20260911000000 with the three
--    database-owned columns added by later migrations. `status` is still the
--    only client-writable one; the column-level UPDATE grant already says so,
--    and this is the defence-in-depth copy that survives a widening of it --
--    which is precisely the job it could not do for a column it did not list.
-- ---------------------------------------------------------------------------
create or replace function private.feedback_update_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The sender (service_role, no session) and DBA repair pass; the column
  -- grants already bound service_role to notified_at alone. Every session
  -- -- the superuser's browser included -- is bound to the one flag.
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.id                     is distinct from old.id
     or new.user_id                is distinct from old.user_id
     or new.user_email             is distinct from old.user_email
     or new.organisation_id        is distinct from old.organisation_id
     or new.organisation_role      is distinct from old.organisation_role
     or new.category               is distinct from old.category
     or new.message                is distinct from old.message
     or new.route                  is distinct from old.route
     or new.user_agent             is distinct from old.user_agent
     or new.screenshot_key         is distinct from old.screenshot_key
     or new.screenshot_mime        is distinct from old.screenshot_mime
     or new.screenshot_size_bytes  is distinct from old.screenshot_size_bytes
     or new.screenshot_scan_status is distinct from old.screenshot_scan_status
     or new.screenshot_scanned_at  is distinct from old.screenshot_scanned_at
     or new.notified_at            is distinct from old.notified_at
     or new.created_at             is distinct from old.created_at
     -- Added by 20260916002000 and 20260921003000; all three are stamped by
     -- private.feedback_before_insert() and were never in this list.
     or new.during_support_access           is distinct from old.during_support_access
     or new.support_access_session_id       is distinct from old.support_access_session_id
     or new.support_access_organisation_id  is distinct from old.support_access_organisation_id then
    raise exception 'feedback: only status is client-writable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.feedback_update_guard() is
  'BEFORE UPDATE column gate behind feedback_update_platform_status: a session may move `status` and nothing else -- the submission content, its attribution and notified_at are immutable from any client path (notified_at belongs to the sender, which has no session and is grant-bound to that column). Defence in depth behind the column-level UPDATE grant, so a future widening of the grant does not silently widen what a PATCH can rewrite. Since the pre-merge fix round the list also covers during_support_access (20260916002000) and the two support-access attribution columns (20260921003000), which were stamped by the insert trigger and never listed here.';

revoke all on function private.feedback_update_guard() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. THE THREE AUDIT WRITERS.
--
-- Each gains the same two arguments: the organisation falls back to the
-- support-access workspace, and the correlation id becomes the session's, so
-- the row joins the thread /super/audit-log already groups that session by.
-- For every ordinary submission both are NULL and nothing changes.
-- ---------------------------------------------------------------------------
create or replace function private.audit_feedback_submission()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- Sessionless writers (fixtures, seeds) have no actor to attribute and
  -- log_audit_event refuses to write an unattributable row.
  if (select auth.uid()) is null then
    return null;
  end if;

  -- Identifiers and enums only -- never the message: audit_events is the
  -- superuser's log and the message is user-entered content that already has
  -- its own, deliberately separate, surface.
  perform private.log_audit_event(
    p_action          => 'feedback.submitted',
    p_target_type     => 'feedback',
    -- FINDING I2: a support-access submission carries organisation_id = null
    -- by design (Q121), which put its audit row under no workspace filter at
    -- all. The fallback names the workspace the session was over; the row
    -- itself is still not that workspace's.
    p_organisation_id => coalesce(new.organisation_id, new.support_access_organisation_id),
    p_target_id       => new.id,
    p_correlation_id  => new.support_access_session_id,
    p_after           => pg_catalog.jsonb_build_object(
                           'category',               new.category,
                           'organisation_role',      new.organisation_role,
                           'route',                  new.route,
                           'support_access',         new.during_support_access,
                           'screenshot',             new.screenshot_key is not null,
                           'screenshot_scan_status', new.screenshot_scan_status)
  );
  return null;
end;
$$;

comment on function private.audit_feedback_submission() is
  'AFTER INSERT on public.feedback: writes feedback.submitted to audit_events for every client writer (CLAUDE.md § In-app feedback: "the submission event itself is also audited like any other write"). A trigger rather than a call in the server action because the table carries a client INSERT grant and a direct PostgREST INSERT is a real submission path. Payload is category, role, route, the Q121 support-access flag and the screenshot verdict -- never the message text. Since the pre-merge fix round (finding I2) the organisation falls back to feedback.support_access_organisation_id and the correlation id is feedback.support_access_session_id, so a submission sent from inside a support session lands on that workspace''s audit filter and on that session''s own thread instead of under nothing at all. Both are NULL for every ordinary submission.';

revoke all on function private.audit_feedback_submission() from public, anon, authenticated, service_role;


create or replace function private.audit_feedback_status_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return null;
  end if;

  perform private.log_audit_event(
    p_action          => 'feedback.status_changed',
    p_target_type     => 'feedback',
    p_organisation_id => coalesce(new.organisation_id, new.support_access_organisation_id),
    p_target_id       => new.id,
    p_correlation_id  => new.support_access_session_id,
    p_before          => pg_catalog.jsonb_build_object('status', old.status),
    p_after           => pg_catalog.jsonb_build_object('status', new.status)
  );
  return null;
end;
$$;

comment on function private.audit_feedback_status_change() is
  'AFTER UPDATE on public.feedback when status moves: feedback.status_changed with before/after. The superuser''s one write on this surface, audited from a trigger so a raw PATCH from the operator''s own browser is covered too (the incident_alert.resolved precedent, 20260909080000). Carries the same support-access attribution fallback as the other two feedback audit writers (pre-merge finding I2).';

revoke all on function private.audit_feedback_status_change() from public, anon, authenticated, service_role;


create or replace function public.audit_feedback_screenshot_view(p_feedback_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_session uuid;
begin
  if not private.has_platform_permission('view_feedback') then
    raise exception 'audit_feedback_screenshot_view: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  -- The row must exist, carry a screenshot, and be inside retention -- the
  -- same three facts the read path checks, re-tested here so the audit row
  -- cannot name a screenshot that is not viewable.
  --
  -- FINDING I2: the organisation is the row's own, FALLING BACK to the
  -- workspace the support-access session was over. This is the row that made
  -- the gap worst -- CLAUDE.md calls the screenshot "the one deliberate
  -- exception ... same audit discipline as impersonation", and for a
  -- support-access submission it carried strictly LESS attribution than an
  -- impersonated page view, which at least names the organisation.
  select coalesce(f.organisation_id, f.support_access_organisation_id),
         f.support_access_session_id
    into v_org, v_session
  from public.feedback f
  where f.id = p_feedback_id
    and f.screenshot_key is not null
    and f.created_at >= private.feedback_retention_cutoff();
  if not found then
    raise exception 'audit_feedback_screenshot_view: no viewable screenshot for feedback %', p_feedback_id
      using errcode = '42501';
  end if;

  return private.log_audit_event(
    p_action          => 'feedback.screenshot_viewed',
    p_target_type     => 'feedback',
    p_organisation_id => v_org,
    p_target_id       => p_feedback_id,
    p_correlation_id  => v_session,
    p_after           => '{}'::jsonb
  );
end;
$$;

comment on function public.audit_feedback_screenshot_view(uuid) is
  'The audited half of viewing a feedback screenshot -- CLAUDE.md § In-app feedback: "every superuser view of a feedback screenshot is itself an audited action (actor, feedback ID, timestamp) -- same audit discipline as impersonation". Guarded on has_platform_permission (42501 for anyone else, aal1 superuser included) and on the row being a real, in-retention row with a screenshot. lib/feedback/screenshot.ts calls it and mints the 60-second signed URL ONLY on success: no audit row, no URL. The actor is forced to auth.uid() by log_audit_event. VOLATILE, so not GET-reachable. SINCE THE PRE-MERGE FIX ROUND (finding I2) a support-access row -- which carries organisation_id = null by design (Q121) -- is audited under feedback.support_access_organisation_id and on feedback.support_access_session_id''s correlation thread, so the view appears on the impersonated workspace''s audit filter and beside the session''s own page-view rows. It was previously attributed to no organisation and no thread, i.e. LESS than an impersonated page view. WHETHER SUCH A SCREENSHOT SHOULD STILL BE VIEWABLE AFTER THE SESSION ENDS is DECISIONS-QUEUE Q127; the shipped default is yes -- /super/feedback is where a bug report is worked, not within the 60 minutes the session lasted -- and this attribution is what makes that question answerable from the audit log.';

-- Unchanged, restated so `create or replace` cannot silently drift them.
revoke all on function public.audit_feedback_screenshot_view(uuid) from public, anon, service_role;
grant execute on function public.audit_feedback_screenshot_view(uuid) to authenticated;
