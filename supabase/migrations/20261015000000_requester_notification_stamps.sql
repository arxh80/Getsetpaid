-- PHASE 8 TASK 9b, JOB 2 -- THE DSR, EXPORT AND ERASURE NOTIFICATION EMAILS.
--
-- Founder 2026-09-30, Q157(3)/Q174/Q45: build ALL notification emails through
-- the one Brevo sender. This migration is the database half of four of them:
--
--   email              recipient         stamp column
--   -----------------  ----------------  ------------------------------------------
--   DSR received       the requester     data_subject_requests.received_notified_at
--   DSR closed         the requester     data_subject_requests.closed_notified_at
--   export ready       the requester     export_jobs.ready_notified_at
--   erasure failure    the superuser     erasure_jobs.failure_notified_at
--
-- (Connection-request and task-reminder emails are a later job.)
--
-- ===========================================================================
-- THE CONTRACT: STAMP ONLY AFTER ok:true, AND ONLY THE SENDER MAY STAMP
-- ===========================================================================
-- The same contract incident_alerts.notified_at has run on since Task 5:
-- null = not yet emailed; lib/email/requester-notifications.ts reads the
-- null rows, sends, and stamps ONLY the rows an accepted send carried. A
-- failed send stamps nothing and the next pg_cron tick retries it.
--
-- WHO MAY MOVE A STAMP -- three independent controls:
--   1. THE GRANT. `service_role` gets UPDATE on each stamp column and nothing
--      wider (erasure_jobs' stamp goes through a service_role-only definer
--      RPC instead -- section 1 says why). No client role holds ANY update grant on these three tables, so
--      the new columns are outside every client grant by construction.
--   2. THE STAMP GUARD (private.notification_stamp_guard(), section 3), one
--      BEFORE UPDATE trigger per column: a stamp moves only from a
--      sessionless server role, only from null to a value (written once,
--      never cleared or rewritten), only ALONE (nothing else on the row moves
--      in the same update), only when the row is in the state the email is
--      about (a closed request, a succeeded export, a failed erasure), and
--      its value is the database's clock, never the caller's.
--   3. THE TABLE GUARDS ARE UNTOUCHED. Each table's existing BEFORE UPDATE
--      guard refuses any write to a finished row ("a finished job is not
--      rewritten") -- which is exactly the row a notification stamps. Rather
--      than rebuild three long, hardened guard functions (standing lesson 4:
--      that is how checks get lost), each guard's TRIGGER is recreated with a
--      WHEN clause that skips it for an update whose ONLY change is to the
--      stamp columns. Every other update -- including a no-op one -- still
--      reaches the guard exactly as before; the guard FUNCTIONS are not
--      edited at all. The stamp guard then owns that one shape.
--
-- RECIPIENTS ARE THE DATABASE'S. The requester's address is read from
-- auth.users through the row's own user column, inside a SECURITY DEFINER
-- function granted to service_role alone that takes no user argument -- the
-- shape public.pending_lockout_notifications() set (Q114). It never comes
-- from client input, it is never the `user_email` SNAPSHOT (an address the
-- account may since have given up), and the Q130 tombstone -- which has an
-- address of its own -- is excluded by name.
--
-- ADDITIVE. New objects; three triggers dropped and recreated with the SAME
-- name, the SAME function and a WHEN clause.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE FOUR STAMP COLUMNS.
-- ---------------------------------------------------------------------------

alter table public.data_subject_requests
  add column received_notified_at timestamptz,
  add column closed_notified_at   timestamptz;

alter table public.export_jobs
  add column ready_notified_at timestamptz;

alter table public.erasure_jobs
  add column failure_notified_at timestamptz;

comment on column public.data_subject_requests.received_notified_at is
  'THE "WE RECEIVED YOUR REQUEST" EMAIL SEAM (founder 2026-09-30, Q157(3)/Q174/Q45). Null = the requester has not been emailed. lib/email/requester-notifications.ts stamps it ONLY after Brevo answered ok:true; a failed send leaves it null and the next pg_cron tick retries. Writable by service_role alone (column grant), once, alone, and to the database''s clock (private.notification_stamp_guard()).';
comment on column public.data_subject_requests.closed_notified_at is
  'THE "YOUR REQUEST IS CLOSED" EMAIL SEAM (fulfilled, rejected or withdrawn). Same contract as received_notified_at; the stamp guard additionally refuses it on a request that is not closed. An ERASED requester is never emailed (their address is gone by the act itself) and the column stays null -- Q199.';
comment on column public.export_jobs.ready_notified_at is
  'THE "YOUR EXPORT IS READY" EMAIL SEAM. The email links to the in-app export page ONLY -- never the archive, never a signed URL. Stamped by service_role ONLY after ok:true, once, alone, to the database''s clock, and only on a succeeded job (private.notification_stamp_guard()).';
comment on column public.erasure_jobs.failure_notified_at is
  'THE "AN ERASURE FAILED" EMAIL SEAM, to the platform superuser. The email carries a COUNT and a /super link only -- no subject, no workspace, no reason. Stamped by service_role ONLY after ok:true, once, alone, to the database''s clock, and only on a failed job (private.notification_stamp_guard()).';

-- The grant: UPDATE on each stamp and nothing wider. data_subject_requests'
-- service_role SELECT is column-narrow, so the two stamps are added to it --
-- an UPDATE ... WHERE <stamp> IS NULL must be able to read the column it
-- filters on. export_jobs and erasure_jobs already grant service_role SELECT
-- on the whole table.
grant select (received_notified_at, closed_notified_at) on public.data_subject_requests to service_role;
grant update (received_notified_at, closed_notified_at) on public.data_subject_requests to service_role;
grant update (ready_notified_at)   on public.export_jobs  to service_role;
-- erasure_jobs is the exception, and the reason is measured: its CHECK
-- `erasure_jobs_summary_is_counts` calls private.jsonb_is_count_map(), which
-- service_role may not execute, and a CHECK is re-evaluated on EVERY update
-- -- so a direct service_role UPDATE of any column of that table is 42501,
-- which is why the erasure runner writes it only through definer RPCs. The
-- failure stamp therefore gets one too, public.mark_erasure_failures_notified()
-- (section 5), granted to service_role alone, and NO column grant: a grant
-- that cannot be used would be a control that only looks like one.

-- Partial indexes over the work that is left.
create index data_subject_requests_received_pending_idx
  on public.data_subject_requests (requested_at, id)
  where received_notified_at is null;
create index data_subject_requests_closed_pending_idx
  on public.data_subject_requests (id)
  where closed_notified_at is null and status in ('fulfilled', 'rejected', 'withdrawn');
create index export_jobs_ready_pending_idx
  on public.export_jobs (completed_at, id)
  where ready_notified_at is null and status = 'succeeded';
create index erasure_jobs_failure_pending_idx
  on public.erasure_jobs (completed_at, id)
  where failure_notified_at is null and status = 'failed';


-- ---------------------------------------------------------------------------
-- 2. THE TABLE GUARDS SKIP AN UPDATE THAT MOVES A STAMP -- WHICH THE STAMP
--    GUARD THEN PROVES MOVED ALONE.
--
--    The WHEN clause is true for every update that leaves the stamp columns
--    as they were -- so every update the guards saw before this migration,
--    no-op ones included, still reaches them. An update that moves a stamp
--    skips the table guard and meets private.notification_stamp_guard(),
--    which refuses it unless the stamp is the ONLY thing that moved
--    (notification_stamp_moves_alone). So "skip the table guard" is never
--    "skip a guard": the shape the table guard would refuse (a finished row
--    being written) is admitted only when the write is a stamp and nothing
--    else. (The WHEN cannot compare whole rows: data_subject_requests has a
--    generated column, and a BEFORE trigger's WHEN may not reference NEW as
--    a whole row there -- hence the per-column form.)
-- ---------------------------------------------------------------------------

drop trigger data_subject_requests_before_update on public.data_subject_requests;
create trigger data_subject_requests_before_update
  before update on public.data_subject_requests
  for each row
  when (    old.received_notified_at is not distinct from new.received_notified_at
        and old.closed_notified_at   is not distinct from new.closed_notified_at)
  execute function private.data_subject_requests_before_update();

drop trigger export_jobs_before_update on public.export_jobs;
create trigger export_jobs_before_update
  before update on public.export_jobs
  for each row
  when (old.ready_notified_at is not distinct from new.ready_notified_at)
  execute function private.export_jobs_before_update();

drop trigger erasure_jobs_before_update on public.erasure_jobs;
create trigger erasure_jobs_before_update
  before update on public.erasure_jobs
  for each row
  when (old.failure_notified_at is not distinct from new.failure_notified_at)
  execute function private.erasure_jobs_before_update();


-- ---------------------------------------------------------------------------
-- 3. THE STAMP GUARD. One function, one trigger per stamp column.
--
--    TG_ARGV[0] = the stamp column; TG_ARGV[1] = the comma-separated statuses
--    the row must be in for that email to be true.
-- ---------------------------------------------------------------------------

create or replace function private.notification_stamp_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_col    text  := tg_argv[0];
  v_states text[] := pg_catalog.string_to_array(tg_argv[1], ',');
  v_old    jsonb := pg_catalog.to_jsonb(old);
  v_new    jsonb := pg_catalog.to_jsonb(new);
  v_role   text  := coalesce(pg_catalog.current_setting('role', true), '');
  v_gen    text[];
begin
  -- A BEFORE trigger sees NEW's generated columns as null (due_by on the
  -- register), so they are not part of the "moves alone" comparison; they
  -- cannot be written by anybody anyway (428C9).
  select coalesce(pg_catalog.array_agg(a.attname::text), '{}') into v_gen
    from pg_catalog.pg_attribute a
   where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped
     and a.attgenerated <> '';
  v_old := v_old - v_gen;
  v_new := v_new - v_gen;

  if (v_old -> v_col) is not distinct from (v_new -> v_col) then
    return new;
  end if;

  if (select auth.uid()) is not null
     or v_role not in ('service_role', 'postgres', 'none', '') then
    raise exception '%: a delivery stamp is written by the sender, never from a person''s session', v_col
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if v_old ->> v_col is not null then
    raise exception '%: a delivery stamp is written once and never cleared or rewritten', v_col
      using errcode = '22023', hint = 'notification_stamp_is_written_once';
  end if;

  if (v_old - v_col) is distinct from (v_new - v_col) then
    raise exception '%: a delivery stamp moves alone', v_col
      using errcode = '22023', hint = 'notification_stamp_moves_alone';
  end if;

  if not ((v_new ->> 'status') = any (v_states)) then
    raise exception '%: this row is not in a state that email is about (%)', v_col, v_new ->> 'status'
      using errcode = '22023', hint = 'notification_stamp_wrong_state';
  end if;

  -- The database's clock, never the caller's.
  new := pg_catalog.jsonb_populate_record(
           new, pg_catalog.jsonb_build_object(v_col, pg_catalog.now()));
  return new;
end;
$$;

revoke all on function private.notification_stamp_guard() from public, anon, authenticated, service_role;

comment on function private.notification_stamp_guard() is
  'BEFORE UPDATE (WHEN <stamp> moves) on the three notification seams (20261015000000; founder 2026-09-30, Q157(3)/Q174/Q45). A delivery stamp moves only from a sessionless server role (42501 notification_stamp_is_server_only), only from null (22023 notification_stamp_is_written_once), only alone (22023 notification_stamp_moves_alone), only on a row in the state the email is about (22023 notification_stamp_wrong_state), and always to now(). The table''s own BEFORE UPDATE guard is skipped by its trigger''s WHEN clause whenever a stamp moves, and this guard then refuses that update unless the stamp moved alone.';

create trigger data_subject_requests_stamp_received
  before update on public.data_subject_requests
  for each row
  when (old.received_notified_at is distinct from new.received_notified_at)
  execute function private.notification_stamp_guard(
    'received_notified_at', 'open,in_progress,routed,fulfilled,rejected,withdrawn');

create trigger data_subject_requests_stamp_closed
  before update on public.data_subject_requests
  for each row
  when (old.closed_notified_at is distinct from new.closed_notified_at)
  execute function private.notification_stamp_guard(
    'closed_notified_at', 'fulfilled,rejected,withdrawn');

create trigger export_jobs_stamp_ready
  before update on public.export_jobs
  for each row
  when (old.ready_notified_at is distinct from new.ready_notified_at)
  execute function private.notification_stamp_guard('ready_notified_at', 'succeeded');

create trigger erasure_jobs_stamp_failure
  before update on public.erasure_jobs
  for each row
  when (old.failure_notified_at is distinct from new.failure_notified_at)
  execute function private.notification_stamp_guard('failure_notified_at', 'failed');


-- ---------------------------------------------------------------------------
-- 4. RECIPIENT RESOLUTION, IN THE DATABASE.
--
--    Granted to service_role ALONE, no user argument -- it cannot be asked for
--    a chosen person's address, only for the rows that currently have an
--    unsent notice. The address is auth.users.email through the row's own
--    user column; the Q130 tombstone is excluded by name (it has an address).
--
--    A SEVEN-DAY WINDOW. A notice about an event more than a week old is not
--    sent: it bounds the first-deploy backlog and a long outage of the clock
--    to something a person would still recognise. Older rows stay null, which
--    is honest ("never emailed").
-- ---------------------------------------------------------------------------

create or replace function public.pending_dsr_notifications(p_limit integer default 30)
returns table (
  request_id   uuid,
  notice       text,
  email        text,
  reference    bigint,
  right_type   text,
  status       text,
  requested_at timestamptz,
  due_by       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select q.request_id, q.notice, q.email, q.reference, q.right_type, q.status,
         q.requested_at, q.due_by
    from (
      select r.id as request_id, 'received'::text as notice, u.email::text as email,
             r.seq as reference, r.right_type, r.status, r.requested_at, r.due_by,
             r.requested_at as since
        from public.data_subject_requests r
        join auth.users u on u.id = r.user_id
       where r.received_notified_at is null
         and r.user_id <> private.erased_user_id()
         and u.email is not null
         and r.requested_at > pg_catalog.now() - interval '7 days'
      union all
      select r.id, 'closed', u.email::text, r.seq, r.right_type, r.status,
             r.requested_at, r.due_by,
             coalesce(r.fulfilled_at, r.rejected_at, r.withdrawn_at)
        from public.data_subject_requests r
        join auth.users u on u.id = r.user_id
       where r.closed_notified_at is null
         and r.status in ('fulfilled', 'rejected', 'withdrawn')
         and r.user_id <> private.erased_user_id()
         and u.email is not null
         and coalesce(r.fulfilled_at, r.rejected_at, r.withdrawn_at)
               > pg_catalog.now() - interval '7 days'
    ) q
   order by q.since, (q.notice = 'closed'), q.request_id
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

create or replace function public.pending_export_ready_notifications(p_limit integer default 30)
returns table (
  job_id            uuid,
  email             text,
  kind              text,
  organisation_slug text,
  expires_at        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, u.email::text, j.kind, o.slug::text, j.expires_at
    from public.export_jobs j
    join auth.users u on u.id = j.requested_by
    left join public.organisations o on o.id = j.organisation_id
   where j.status = 'succeeded'
     and j.ready_notified_at is null
     and j.expires_at > pg_catalog.now()
     and j.completed_at > pg_catalog.now() - interval '7 days'
     and j.requested_by <> private.erased_user_id()
     and u.email is not null
     and (j.kind = 'account' or o.slug is not null)
   order by j.completed_at, j.id
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

revoke all on function public.pending_dsr_notifications(integer)          from public, anon, authenticated;
revoke all on function public.pending_export_ready_notifications(integer) from public, anon, authenticated;
grant execute on function public.pending_dsr_notifications(integer)          to service_role;
grant execute on function public.pending_export_ready_notifications(integer) to service_role;

comment on function public.pending_dsr_notifications(integer) is
  'The requester notices owed for data subject requests: `received` for a request whose received_notified_at is null, `closed` for a fulfilled/rejected/withdrawn one whose closed_notified_at is null, both within seven days of the event. The address is auth.users.email through user_id -- never the user_email snapshot, never client input -- and the Q130 tombstone is excluded by name. service_role only, no user argument, at most 30 rows.';
comment on function public.pending_export_ready_notifications(integer) is
  'The "your export is ready" notices owed: succeeded, unexpired, completed within seven days, ready_notified_at null. The address is auth.users.email through requested_by; the workspace slug is returned only so the email can link to the in-app export page -- the archive key and any signed URL are never returned. service_role only, no user argument, at most 30 rows.';


-- ---------------------------------------------------------------------------
-- 5. THE ERASURE-FAILURE STAMP'S WRITE PATH (section 1 says why it is an RPC).
--
--    service_role only; refuses any session; stamps only failed, unstamped
--    jobs among the ids given, and answers how many it stamped. The stamp
--    guard still runs on every row it touches.
-- ---------------------------------------------------------------------------

create or replace function public.mark_erasure_failures_notified(p_job_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_erasure_failures_notified: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  update public.erasure_jobs j
     set failure_notified_at = pg_catalog.now()
   where j.id = any (coalesce(p_job_ids, '{}'))
     and j.status = 'failed'
     and j.failure_notified_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_erasure_failures_notified(uuid[]) from public, anon, authenticated;
grant execute on function public.mark_erasure_failures_notified(uuid[]) to service_role;

comment on function public.mark_erasure_failures_notified(uuid[]) is
  'Stamps erasure_jobs.failure_notified_at for the failed, unstamped jobs among p_job_ids and answers how many (20261015000000). Called by lib/email/requester-notifications.ts ONLY after the superuser''s failure email was accepted (ok:true). service_role only; refuses any session (42501 notification_stamp_is_server_only). A definer RPC rather than a column grant because the table''s summary CHECK makes every direct service_role UPDATE 42501.';


-- ---------------------------------------------------------------------------
-- 6. THE CLOCK'S COMMENT, REISSUED WITH THE NEW WORST CASE (re-measured with
--    job 1's 10-second Telegram timeout included). Everything else is
--    20261014000000's text.
-- ---------------------------------------------------------------------------

comment on function private.deliver_incident_alerts() is
  'THE INCIDENT-ALERT CLOCK''S BODY (founder ruling Q118). Runs from pg_cron every 10 minutes and POSTs /api/incident-alerts/deliver with the bearer. That route runs SIX independent deliveries, each with its own stamp: the operator''s email digest (`notified_at`), the counts-only Telegram alert (`telegram_notified_at`, Q111, 20261014000000), the per-account lockout email (`account_notified_at`, Q114), and since 20261015000000 (founder 2026-09-30, Q157(3)/Q174/Q45) the requester''s DSR received/closed notices (`data_subject_requests.received_notified_at` / `closed_notified_at`), the requester''s export-ready notice (`export_jobs.ready_notified_at`) and the superuser''s erasure-failure notice (`erasure_jobs.failure_notified_at`). The URL and the bearer come from Supabase Vault (`incident_alert_delivery_url` / `incident_alert_delivery_secret`), created by hand once per environment and NEVER by a migration -- with either missing this function returns without building a request, which is what local dev and CI do on every tick. SECURITY DEFINER for the Vault read; granted to no client role. Failure needs no handling: each sender stamps nothing on a failed send, so the next tick retries the identical set for that channel alone. OVERLAP is ruled out in the ROUTE: one 10-second Brevo call for the digest, one 10-second Telegram call, the lockout loop capped at 30 accounts and a 120-second budget (~130 s), the DSR and export-ready loops each capped at 30 rows and a 60-second budget (~70 s each), and one 10-second call for the erasure-failure notice, so the worst case is ~300 s against a 600 s cadence. An advisory lock HERE would not help -- net.http_post is fire-and-forget, so this function returns before the route runs.';
