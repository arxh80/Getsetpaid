-- Phase 7 Task 6: in-app feedback -- the platform-scoped `feedback` table, its
-- non-forgeable attribution, the 10/hour budget enforced AT THE WRITE, the
-- audit of every submission / status change / screenshot view, the
-- screenshot bucket, and the email seam (`notified_at`) the Brevo sender
-- stamps.
--
-- CLAUDE.md § In-app feedback is the binding spec. Restated in one line: any
-- logged-in user, on any tier, always identified, captured with user / org /
-- role / category / message / route / browser, optional single screenshot,
-- emailed to the founder AND stored in a platform-scoped table the superuser
-- dashboard reads directly, 10 submissions/hour/user, 2-year retention, and
-- every superuser view of a screenshot audited.
--
-- ===========================================================================
-- PLATFORM-SCOPED IS NOT UNPROTECTED -- THE SHAPE, AND WHY
-- ===========================================================================
-- `public.feedback` follows `public.incident_alerts` (20260909020000), the
-- phase's established shape for a platform table: no tenant RLS path,
-- superuser-read, column-narrow client grants, and every write that matters
-- routed through a trigger so a direct PostgREST call meets the same rule the
-- application does. The one difference from incident_alerts is that a
-- SUBMITTER must be able to write a row of their own -- so there IS a client
-- INSERT grant here, and everything below is about making that grant unable
-- to say anything false.
--
-- ===========================================================================
-- ATTRIBUTION IS NON-FORGEABLE BY CONSTRUCTION (Task 5, review finding I1)
-- ===========================================================================
-- Task 5's worst finding was a caller-supplied organisation id reaching a
-- platform table. Here the same three columns -- who, which workspace, in
-- what role -- are made unforgeable at three independent layers, none of
-- which is "the application validates it":
--
--   1. COLUMN PRIVILEGES. `authenticated` holds INSERT on the submission
--      columns ONLY. `user_id`, `user_email`, `organisation_role`, `status`,
--      `notified_at` and `created_at` are not in the grant, so an INSERT that
--      so much as NAMES `user_id` is a 42501 before any trigger or policy runs.
--   2. THE BEFORE INSERT TRIGGER overwrites `user_id`/`user_email` from the
--      session (`auth.uid()`, `auth.users.email`) and
--      `organisation_role` with the caller's OWN active membership row's
--      role in `organisation_id`, and RAISES 42501 if no such membership
--      exists. The caller supplies a workspace id (the one the route they
--      were on resolves to); the database decides whether that claim is
--      true and what role goes with it. A stranger naming a foreign
--      workspace gets a refusal, not a row that blames that workspace.
--   3. THE INSERT POLICY's WITH CHECK re-tests both facts on the row as it
--      will be stored, so the trigger being disabled, replaced or reordered
--      still leaves the policy refusing a forged row.
--
-- ===========================================================================
-- THE 10/HOUR METER IS A BEFORE INSERT TRIGGER (Task 5, review finding I2)
-- ===========================================================================
-- 20260909060000's lesson: metering a server action alone leaves the direct
-- PostgREST INSERT -- reachable with the anon key and a session JWT, and
-- exactly the path a scripted abuser uses -- unmetered. A POST runs in a
-- read-write transaction, so the database CAN meter it; it therefore does,
-- in the same trigger that stamps attribution, and the application does NOT
-- also call consume_rate_limit('feedback') -- two meters on one submit would
-- spend two units and silently halve the shipped limit. The shape is
-- private.meter_connection_request()'s, for its reasons: read-before-write so
-- a refusal has nothing to roll back, PT429 with the remaining seconds in
-- `hint`, the crossing alert filed by the LAST ACCEPTED submission, and the
-- counter not counting past the limit (Q115's semantics, second instance).
-- Metered AFTER attribution: a caller who could not have written the row
-- (no membership of the named workspace) spends no budget.
--
-- ===========================================================================
-- WHAT A SUBMITTER CAN READ: NOTHING
-- ===========================================================================
-- No SELECT policy names the submitter. The brief permits "their own row";
-- Q103's rule (RLS filters rows, not columns) means a submitter-readable row
-- would expose `status`, `notified_at` and `organisation_role` through
-- PostgREST, none of which is theirs to see, and the product needs none of
-- it -- the submit UI confirms with the action's own return value. So the
-- SELECT grant exists for the superuser policy alone.
--
-- ===========================================================================
-- RETENTION: 2 YEARS, READ-TIME, IN THE POLICY
-- ===========================================================================
-- The house pattern (Q88's network presence, every override in Task 4): a
-- row past its retention simply stops being returned, with nothing scheduled.
-- Here the cutoff is a term of the superuser SELECT policy itself, so an
-- expired row is invisible on every read path including a direct PostgREST
-- GET, and the screenshot-view RPC re-tests the same cutoff. The purge of the
-- rows and their screenshot bytes joins the Phase 8 retention job Q110/Q52
-- already owe (DECISIONS-QUEUE Q120).
--
-- ===========================================================================
-- THE SCREENSHOT PIPELINE IS THE DOCUMENTS PIPELINE, RE-POINTED
-- ===========================================================================
-- Private bucket, client-fenced, server-mediated I/O, magic-byte sniff
-- (images ONLY here -- the application refuses anything the sniff does not
-- read as PNG/JPEG/WebP/GIF), synchronous malware scan, opaque key with no
-- user input (`feedback/{id}`, pinned by CHECK), signed URL only after
-- authorisation AND an audit row, and a quarantine that files an incident
-- alert by trigger. SECURITY.md § 6, applied to a second bucket.
--
-- ===========================================================================
-- FOUR AUDITED ACTIONS, target_type = 'feedback'
-- ===========================================================================
--   feedback.submitted          AFTER INSERT trigger (every writer, incl. PostgREST)
--   feedback.status_changed     AFTER UPDATE trigger (every writer, incl. a raw PATCH)
--   feedback.screenshot_viewed  public.audit_feedback_screenshot_view(), called by
--                               the app BEFORE it mints the signed URL -- no
--                               audit row, no URL (the download-gate order)
--   (the quarantine files an incident alert, not an audit action -- the
--    submission row carries the scan verdict)
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE TABLE
-- ---------------------------------------------------------------------------

create table public.feedback (
  id                     uuid primary key default gen_random_uuid(),
  -- WHO. Forced to auth.uid() by the trigger; not in the client INSERT grant.
  -- ON DELETE CASCADE: feedback is low-sensitivity operational data with a
  -- 2-year clock, and a data-subject erasure must be able to take it with the
  -- account (unlike audit_events, which deliberately blocks that delete).
  user_id                uuid not null references auth.users (id) on delete cascade,
  -- THE SUBMITTER'S EMAIL AT SUBMISSION TIME, stamped by the trigger from
  -- auth.users. Stored rather than joined because the superuser holds no
  -- cross-tenant read of `profiles` (SECURITY.md § 4's enrolment-path
  -- exemption is per-organisation) and "always identified" means the founder
  -- must be able to see WHO without a policy widening elsewhere. Not in the
  -- INSERT grant.
  user_email             text check (pg_catalog.char_length(user_email) <= 254),
  -- WHICH WORKSPACE, if the submitter was inside one. Nullable: /invites,
  -- /onboarding and /super/* have no current organisation. SET NULL rather
  -- than CASCADE: the feedback outlives the workspace it was sent from.
  organisation_id        uuid references public.organisations (id) on delete set null,
  -- THE SUBMITTER'S ROLE IN THAT WORKSPACE, stamped by the trigger from their
  -- own membership row. Never client-supplied; not in the INSERT grant.
  organisation_role      text references public.roles (key),
  category               text not null check (category in ('bug', 'idea', 'other')),
  message                text not null
                           check (pg_catalog.btrim(message) <> ''
                                  and pg_catalog.char_length(message) <= 4000),
  -- WHERE THEY WERE: the request PATHNAME, never the query string. The app
  -- derives it from the middleware-stamped request path (lib/auth/current-path)
  -- and strips `?...` with the impersonation audit's own auditableRoute(),
  -- because a list page's search term lives in `?q=` and is content.
  route                  text not null
                           check (route ~ '^/' and pg_catalog.char_length(route) <= 512),
  -- The User-Agent header, server-read, length-capped.
  user_agent             text check (pg_catalog.char_length(user_agent) <= 512),
  -- THE OPTIONAL SCREENSHOT. Key is opaque and pinned to the row's own id --
  -- no filename, no user input, nothing to traverse. All-or-nothing with its
  -- sniffed MIME, size and scan verdict.
  screenshot_key         text,
  screenshot_mime        text check (screenshot_mime in
                           ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  screenshot_size_bytes  integer check (screenshot_size_bytes > 0
                                        and screenshot_size_bytes <= 5242880),
  -- Terminal only: the scan is synchronous at MVP (lib/crm/documents.ts's
  -- shape), so a row never exists in a 'pending' state.
  screenshot_scan_status text check (screenshot_scan_status in ('clean', 'quarantined', 'error')),
  screenshot_scanned_at  timestamptz,
  -- THE FOUNDER'S TRIAGE FLAG. Client-writable through UPDATE(status) alone,
  -- superuser only, audited by trigger.
  status                 text not null default 'new'
                           check (status in ('new', 'read', 'actioned', 'archived')),
  -- THE EMAIL SEAM, incident_alerts' twin (20260909070000): null = the
  -- founder has not been emailed about this row. Stamped by the Brevo sender
  -- (service_role, update on this column only) after a SUCCESSFUL send and
  -- never before; a failed send leaves it null, which is what makes the row
  -- re-sendable rather than silently lost.
  notified_at            timestamptz,
  created_at             timestamptz not null default pg_catalog.now(),
  constraint feedback_screenshot_key_shape
    check (screenshot_key is null or screenshot_key = 'feedback/' || id::text),
  constraint feedback_screenshot_all_or_nothing
    check ((screenshot_key is null) = (screenshot_mime is null)
       and (screenshot_key is null) = (screenshot_size_bytes is null)
       and (screenshot_key is null) = (screenshot_scan_status is null)
       and (screenshot_key is null) = (screenshot_scanned_at is null))
);

comment on table public.feedback is
  'In-app feedback (CLAUDE.md § In-app feedback): platform-scoped, NOT tenant-owned -- no org RLS path; the superuser dashboard reads it directly at /super/feedback. Always identified: user_id is forced to auth.uid() and organisation_role is stamped from the caller''s own membership by private.feedback_before_insert(), which also refuses (42501) an organisation_id the caller is not an active member of and meters the 10/hour budget AT THE WRITE (PT429) so a direct PostgREST INSERT is bound identically to the app''s form. No submitter can read any row, their own included (Q103: a row policy cannot hide status/notified_at/role). Superuser SELECT is bounded by the 2-year retention clock at read time. notified_at is the Brevo email seam (service_role stamps it after a successful send). Screenshot bytes live in the private, client-fenced feedback-screenshots bucket under feedback/{id}; every superuser view of one is audited BEFORE the signed URL is minted (public.audit_feedback_screenshot_view).';

comment on column public.feedback.route is
  'The request pathname the submitter was on, server-derived (middleware-stamped x-pathname), query string stripped: a `?q=` search term is tenant content and does not belong on a platform table. Path-segment record ids are kept, the impersonation page-audit precedent -- an id is not content.';

comment on column public.feedback.notified_at is
  'THE EMAIL SEAM (Q91), the incident_alerts.notified_at twin. Null = no founder email has been sent for this row. lib/email/feedback-notification.ts sends through the ONE Brevo sender (lib/email/send.ts) and stamps this ONLY on ok:true; a failed send logs, leaves null, and never fails the submission -- the row is stored either way, and the submitter is told their feedback is recorded because it is.';

-- Every FK indexed (CLAUDE.md), plus the pager's own (created_at desc, id desc).
create index feedback_user_id_idx         on public.feedback (user_id);
create index feedback_organisation_id_idx on public.feedback (organisation_id);
create index feedback_organisation_role_idx on public.feedback (organisation_role);
create index feedback_created_at_id_desc_idx on public.feedback (created_at desc, id desc);


-- ---------------------------------------------------------------------------
-- 2. GRANTS -- column-narrow, per role. See the header: the INSERT grant
--    deliberately omits every column the database owns.
-- ---------------------------------------------------------------------------

revoke all on public.feedback from public, anon, authenticated, service_role;

grant insert (id, organisation_id, category, message, route, user_agent,
              screenshot_key, screenshot_mime, screenshot_size_bytes,
              screenshot_scan_status, screenshot_scanned_at)
  on public.feedback to authenticated;
-- SELECT: for the superuser policy alone (no policy names a submitter).
grant select on public.feedback to authenticated;
-- UPDATE: the one triage column, superuser-policed below.
grant update (status) on public.feedback to authenticated;
-- The sender: read what to email, stamp that it was sent, nothing else --
-- the exact split 20260909070000 gave service_role on incident_alerts.
grant select on public.feedback to service_role;
grant update (notified_at) on public.feedback to service_role;

alter table public.feedback enable row level security;


-- ---------------------------------------------------------------------------
-- 3. RETENTION CUTOFF -- one function, read by the policy and the view RPC.
-- ---------------------------------------------------------------------------

create or replace function private.feedback_retention_cutoff()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select pg_catalog.now() - interval '2 years';
$$;

comment on function private.feedback_retention_cutoff() is
  'CLAUDE.md § In-app feedback: 2-year retention, the inactive-account default. Read-time expiry (the Q88/Task 4 pattern): feedback_select_platform and public.audit_feedback_screenshot_view() both refuse a row older than this, so an expired row is unreadable on every path with nothing scheduled. The purge of expired rows and their screenshot bytes joins the Phase 8 retention job (Q120).';

revoke all on function private.feedback_retention_cutoff() from public, anon, authenticated, service_role;
grant execute on function private.feedback_retention_cutoff() to authenticated;


-- ---------------------------------------------------------------------------
-- 4. POLICIES
-- ---------------------------------------------------------------------------

create policy feedback_insert_own
  on public.feedback for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (organisation_id is null or private.is_active_member(organisation_id))
  );

comment on policy feedback_insert_own on public.feedback is
  'A signed-in user writes a row attributed to THEMSELVES and, if a workspace is named, to one they are an active member of. Evaluated on the row AFTER private.feedback_before_insert() has stamped user_id/organisation_role, so it is the second gate on attribution, not the first: the column-level INSERT grant already stops a caller naming user_id, and the trigger already raised on a foreign organisation. Any tier, any role, no permission key -- CLAUDE.md: "any logged-in user, on any tier".';

create policy feedback_select_platform
  on public.feedback for select to authenticated
  using (
    (select private.has_platform_permission('view_feedback'))
    and created_at >= (select private.feedback_retention_cutoff())
  );

comment on policy feedback_select_platform on public.feedback is
  'The platform superuser (at aal2) reads feedback -- and ONLY rows inside the 2-year retention window; older rows are invisible on every read path with nothing scheduled. No policy names the submitter: they cannot read their own row (Q103 -- RLS filters rows, not columns, and status/notified_at/organisation_role are not theirs). Feedback message text IS user-entered content on a superuser surface; that is the product (the founder reads feedback), and the screenshot is the one deliberate tenant-data exception, audited per view.';

create policy feedback_update_platform_status
  on public.feedback for update to authenticated
  using      ( (select private.has_platform_permission('manage_feedback')) )
  with check ( (select private.has_platform_permission('manage_feedback')) );

comment on policy feedback_update_platform_status on public.feedback is
  'The founder''s manual New / Read / Actioned / Archived flag. WHICH column moves is not a policy''s to say: the UPDATE grant to authenticated is on `status` alone (a PATCH naming another column is 42501 at the grant), and private.feedback_update_guard() refuses any other column changing regardless of grants. Audited by private.audit_feedback_status_change() from an AFTER UPDATE trigger, so a raw PATCH is covered too.';

-- No DELETE policy for any role: a submission is kept for its retention
-- window and purged by the retention job, never removed by hand.


-- ---------------------------------------------------------------------------
-- 5. THE BEFORE INSERT TRIGGER: attribution, then the meter.
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
  -- nobody's budget. `auth.uid() is null`, the private.audit_crm_row() /
  -- private.meter_connection_request() test, deliberately NOT
  -- row_security_active(): this function is SECURITY DEFINER (the limiter
  -- core and the membership read are granted to no client role), so inside
  -- it row_security_active() is false for EVERY caller and the invoker-side
  -- guard idiom would make this trigger a no-op for browsers.
  if v_uid is null then
    return new;
  end if;

  -- (1) WHO. Whatever the caller sent (the column grant means they could
  -- not have sent anything), the row is theirs -- id and email both from
  -- the session, never from the request.
  new.user_id := v_uid;
  select u.email into new.user_email from auth.users u where u.id = v_uid;

  -- (2) WHICH WORKSPACE, IN WHAT ROLE. The organisation is the caller's
  -- CLAIM; the membership table is the TRUTH. A claim the table does not
  -- back is refused outright -- never stored with a null role, never
  -- silently re-pointed -- because an attribution the operator cannot trust
  -- is worse than no row (Task 5, finding I1).
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

  -- (3) THE DATABASE OWNS THESE, whatever arrived.
  new.status      := 'new';
  new.notified_at := null;
  new.created_at  := pg_catalog.now();

  -- (4) THE METER -- after attribution, so a refused stranger spent nothing.
  select * into v_policy from public.rate_limit_policies p where p.category = 'feedback';
  if not found then
    -- FAIL CLOSED: a missing policy row is a broken deployment, not a licence
    -- to submit without a budget.
    raise exception 'feedback: no rate-limit policy for feedback' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  -- `greatest` is a parser construct, unqualified on purpose under search_path = ''.
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

  -- (4a) BUDGET ALREADY SPENT: raise having written nothing, so the rollback
  -- this causes has nothing to undo and the refusal is repeatable.
  if v_count >= v_policy.max_requests then
    raise exception 'feedback: you have reached the feedback limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (4b) COUNT IT, through the shared core -- user-scoped, NO organisation
  -- (20260909050000's rule: a user-scoped budget attributes no workspace).
  select r.request_count into v_after
  from private.record_rate_limit_event('feedback', 'user', v_uid, null) r;

  -- (4c) THE RACE: two submissions can both pass (4a) at count = max - 1; the
  -- second one's own increment is what this rolls back.
  if v_after > v_policy.max_requests then
    raise exception 'feedback: you have reached the feedback limit (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  -- (4d) THE CROSSING ALERT, at the last accepted submission -- the core's
  -- own max+1 write can never commit on this path. Unattributed, like every
  -- user-scoped crossing; the operator's feed says so in words.
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
  'BEFORE INSERT on public.feedback, for every writer (the app''s form and a direct PostgREST INSERT alike). Attribution first: user_id := auth.uid(); organisation_role := the caller''s own ACTIVE membership role in organisation_id, or 42501 if they hold none -- so a row can never name a workspace the caller merely typed (Task 5 finding I1, closed by construction, not validation). Then the 10/hour meter (Task 5 finding I2: metered where every writer passes), private.meter_connection_request()''s read-before-write shape: PT429 with the remaining seconds in hint, crossing alert at the last accepted submission, no counting past the limit (Q115). Exempts sessionless writers (auth.uid() is null: migrations, seeds, fixtures) -- deliberately not row_security_active(), which is false for everyone inside a SECURITY DEFINER function.';

revoke all on function private.feedback_before_insert() from public, anon, authenticated, service_role;

create trigger feedback_before_insert
  before insert on public.feedback
  for each row execute function private.feedback_before_insert();


-- ---------------------------------------------------------------------------
-- 6. THE UPDATE GUARD: a client session may move `status` and nothing else.
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
     or new.created_at             is distinct from old.created_at then
    raise exception 'feedback: only status is client-writable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.feedback_update_guard() is
  'BEFORE UPDATE column gate behind feedback_update_platform_status: a session may move `status` and nothing else -- the submission content, its attribution and notified_at are immutable from any client path (notified_at belongs to the sender, which has no session and is grant-bound to that column). Defence in depth behind the column-level UPDATE grant, so a future widening of the grant does not silently widen what a PATCH can rewrite.';

revoke all on function private.feedback_update_guard() from public, anon, authenticated, service_role;

create trigger feedback_update_guard
  before update on public.feedback
  for each row execute function private.feedback_update_guard();


-- ---------------------------------------------------------------------------
-- 7. AUDIT: the submission, and every status change.
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
    p_organisation_id => new.organisation_id,
    p_target_id       => new.id,
    p_after           => pg_catalog.jsonb_build_object(
                           'category',               new.category,
                           'organisation_role',      new.organisation_role,
                           'route',                  new.route,
                           'screenshot',             new.screenshot_key is not null,
                           'screenshot_scan_status', new.screenshot_scan_status)
  );
  return null;
end;
$$;

comment on function private.audit_feedback_submission() is
  'AFTER INSERT on public.feedback: writes feedback.submitted to audit_events for every client writer (CLAUDE.md § In-app feedback: "the submission event itself is also audited like any other write"). A trigger rather than a call in the server action because the table carries a client INSERT grant and a direct PostgREST INSERT is a real submission path. Payload is category, role, route and the screenshot verdict -- never the message text.';

revoke all on function private.audit_feedback_submission() from public, anon, authenticated, service_role;

create trigger feedback_audit_submission
  after insert on public.feedback
  for each row execute function private.audit_feedback_submission();


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
    p_organisation_id => new.organisation_id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object('status', old.status),
    p_after           => pg_catalog.jsonb_build_object('status', new.status)
  );
  return null;
end;
$$;

comment on function private.audit_feedback_status_change() is
  'AFTER UPDATE on public.feedback when status moves: feedback.status_changed with before/after. The superuser''s one write on this surface, audited from a trigger so a raw PATCH from the operator''s own browser is covered too (the incident_alert.resolved precedent, 20260909080000).';

revoke all on function private.audit_feedback_status_change() from public, anon, authenticated, service_role;

create trigger feedback_audit_status_change
  after update on public.feedback
  for each row
  when (old.status is distinct from new.status)
  execute function private.audit_feedback_status_change();


-- ---------------------------------------------------------------------------
-- 8. THE QUARANTINE ALERT -- a screenshot the scanner flags files an incident
--    row by trigger, the documents pipeline's own shape (20260909020000 § 8).
-- ---------------------------------------------------------------------------

create or replace function private.feedback_quarantine_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.incident_alerts (alert_type, organisation_id, summary, details)
  values (
    'upload_quarantined',
    -- The attribution the trigger above VERIFIED, not one the caller typed.
    new.organisation_id,
    'A feedback screenshot was quarantined by the malware scanner.',
    -- The feedback id only. The message is user-entered content and this
    -- table renders on a platform surface.
    pg_catalog.jsonb_build_object('feedback_id', new.id)
  );
  return null;
end;
$$;

comment on function private.feedback_quarantine_alert() is
  'Files an upload_quarantined incident alert when a feedback screenshot lands screenshot_scan_status=''quarantined'' -- private.document_quarantine_alert()''s twin for the second bucket. A trigger so it holds for every writer. Identifiers only in details.';

revoke all on function private.feedback_quarantine_alert() from public, anon, authenticated, service_role;

create trigger feedback_quarantine_alert
  after insert on public.feedback
  for each row
  when (new.screenshot_scan_status = 'quarantined')
  execute function private.feedback_quarantine_alert();


-- ---------------------------------------------------------------------------
-- 9. THE SCREENSHOT-VIEW AUDIT RPC. The application calls this BEFORE it
--    mints a signed URL, and refuses to mint one if this refuses -- the
--    download gate's "no audit, no URL" order (lib/crm/documents.ts).
-- ---------------------------------------------------------------------------

create or replace function public.audit_feedback_screenshot_view(p_feedback_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not private.has_platform_permission('view_feedback') then
    raise exception 'audit_feedback_screenshot_view: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  -- The row must exist, carry a screenshot, and be inside retention -- the
  -- same three facts the read path checks, re-tested here so the audit row
  -- cannot name a screenshot that is not viewable.
  select f.organisation_id into v_org
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
    p_after           => '{}'::jsonb
  );
end;
$$;

comment on function public.audit_feedback_screenshot_view(uuid) is
  'The audited half of viewing a feedback screenshot -- CLAUDE.md § In-app feedback: "every superuser view of a feedback screenshot is itself an audited action (actor, feedback ID, timestamp) -- same audit discipline as impersonation". Guarded on has_platform_permission (42501 for anyone else, aal1 superuser included) and on the row being a real, in-retention row with a screenshot. lib/feedback/screenshot.ts calls it and mints the 60-second signed URL ONLY on success: no audit row, no URL. The actor is forced to auth.uid() by log_audit_event. VOLATILE, so not GET-reachable.';

revoke all on function public.audit_feedback_screenshot_view(uuid) from public, anon, service_role;
grant execute on function public.audit_feedback_screenshot_view(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 10. THE BUCKET -- private, 5 MiB, images only (belt-and-braces: the app's
--     magic-byte sniff is the allowlist), and the same restrictive deny-all
--     client fence 20260902030000 put on `documents`.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-screenshots', 'feedback-screenshots', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "feedback_screenshots_deny_client_select"
  on storage.objects as restrictive for select to authenticated, anon
  using (bucket_id <> 'feedback-screenshots');

create policy "feedback_screenshots_deny_client_insert"
  on storage.objects as restrictive for insert to authenticated, anon
  with check (bucket_id <> 'feedback-screenshots');

create policy "feedback_screenshots_deny_client_update"
  on storage.objects as restrictive for update to authenticated, anon
  using (bucket_id <> 'feedback-screenshots')
  with check (bucket_id <> 'feedback-screenshots');

create policy "feedback_screenshots_deny_client_delete"
  on storage.objects as restrictive for delete to authenticated, anon
  using (bucket_id <> 'feedback-screenshots');
