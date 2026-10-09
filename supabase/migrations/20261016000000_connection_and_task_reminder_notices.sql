-- PHASE 8 TASK 9b, JOB 3 -- THE CONNECTION-REQUEST AND TASK-REMINDER EMAILS.
--
-- Founder 2026-09-30, Q157(3)/Q174/Q45: build ALL notification emails through
-- the one Brevo sender. This migration is the database half of the last four:
--
--   notice                 recipient                                   subject row
--   ---------------------  ------------------------------------------  ---------------------------
--   connection_received    the REQUESTED org's active Owner + Admins   network_connection_requests
--   connection_accepted    the SENDER (requested_by) if still an        network_connection_requests
--                          active member of the requesting org, else
--                          that org's active Owner + Admins
--   connection_declined    the same as accepted                        network_connection_requests
--   task_reminder          the task's assignee (owner_user_id) if       tasks
--                          still an active member; no assignee = NOBODY
--
-- The PRD (§ 6/§ 9) names connection requests and a task "reminder" but no
-- recipient for either; the choice above is recorded as Q202 with its reasons.
--
-- ===========================================================================
-- WHY A LEDGER AND NOT A *_notified_at COLUMN ON THE TWO TABLES (Q203)
-- ===========================================================================
-- Job 2 put each stamp on its own row as a column (data_subject_requests,
-- export_jobs, erasure_jobs) because NO client role holds any UPDATE on those
-- tables -- a new column is outside every client grant by construction.
-- public.tasks and public.network_connection_requests are the opposite: BOTH
-- grant `authenticated` TABLE-LEVEL INSERT and UPDATE (measured at 218
-- migrations), so a stamp column added to either is writable from the browser
-- THE MOMENT IT EXISTS -- the exact Q125 shape the permission matrix names as
-- the bug class -- and insertable pre-stamped, which would silence a reminder
-- before it was ever due. Both tables also carry set_updated_at and an AFTER
-- UPDATE audit trigger, so a stamp UPDATE would bump updated_at and write an
-- audit row nobody did.
--
-- So the stamp lives in private.notification_deliveries: one row per (notice,
-- subject) that was ACCEPTED by Brevo. The `private` schema is not exposed to
-- PostgREST and grants nothing to any client role or to service_role; the ONE
-- write path is public.mark_notices_delivered(), service_role only. The job-2
-- stamp-guard rules hold, each by a named control:
--
--   server only     the RPC refuses any session (42501, same hint as
--                   private.notification_stamp_guard(): notification_stamp_is_server_only),
--                   and no role but the owner can reach the table at all
--   written once    the primary key (notice, subject) + ON CONFLICT DO NOTHING
--   never cleared   a BEFORE UPDATE guard refuses every UPDATE
--                   (notification_stamp_is_written_once); nothing grants DELETE --
--                   the only deletes are the FK cascades when the task or the
--                   request itself is purged, which is when the stamp stops
--                   meaning anything
--   right state     the RPC stamps only a subject still in the state its email
--                   is about (a pending / accepted / declined request; an
--                   open, live, due task) -- so a stamp can never be written
--                   AHEAD of its event and silence an email that was not sent
--   db clock        notified_at defaults to now() and the insert guard forces it
--
-- RECIPIENTS ARE THE DATABASE'S: two SECURITY DEFINER resolvers, service_role
-- only, no user argument, at most 30 notices a call, reading auth.users.email
-- through an ACTIVE organisation_memberships row (a revoked or invited member
-- is not a recipient), excluding the Q130 tombstone by name, and never a
-- deleted workspace. A seven-day window (Q201's) bounds the first-deploy
-- backlog.
--
-- CONTENT IS THE DATABASE'S TOO, AND NARROW: the connection resolver returns
-- the counterparty's display_name ONLY while its profile is published and
-- live (display_name is the one field every published profile shows on the
-- directory, network_directory's own projection) -- never an organisation
-- name, never a member, never responded_by, never a field of any visibility.
-- The task resolver returns the title (which the assignee reads in-app on the
-- same task) and due_at -- never `detail`, never a linked record.
--
-- ADDITIVE: one private table, one guard, one RPC, two resolvers, the
-- clock's comment reissued with the new worst case, and the retention roll
-- reissued with the ledger classified. Neither tenant table is
-- altered.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE LEDGER.
-- ---------------------------------------------------------------------------

create table private.notification_deliveries (
  notice      text not null
                check (notice in ('connection_received', 'connection_accepted',
                                  'connection_declined', 'task_reminder')),
  request_id  uuid references public.network_connection_requests (id) on delete cascade,
  task_id     uuid references public.tasks (id) on delete cascade,
  notified_at timestamptz not null default now(),
  constraint notification_deliveries_one_subject check (
    case when notice = 'task_reminder'
         then task_id is not null and request_id is null
         else request_id is not null and task_id is null end)
);

-- WRITTEN ONCE: one row per (notice, subject). Each also serves its FK's
-- cascade (the FK column leads).
create unique index notification_deliveries_request_once
  on private.notification_deliveries (request_id, notice) where request_id is not null;
create unique index notification_deliveries_task_once
  on private.notification_deliveries (task_id, notice) where task_id is not null;

revoke all on table private.notification_deliveries from public, anon, authenticated, service_role;

comment on table private.notification_deliveries is
  'THE DELIVERY STAMPS FOR THE CONNECTION-REQUEST AND TASK-REMINDER EMAILS (20261016000000; founder 2026-09-30, Q157(3)/Q174/Q45). One row per (notice, subject) that Brevo ACCEPTED (ok:true): no row = not yet emailed, and the next pg_cron tick sends it. A ledger rather than a column because public.tasks and public.network_connection_requests grant authenticated table-level INSERT/UPDATE, so a column there would be browser-writable the moment it existed (Q125, Q203). Not exposed, granted to nobody; written ONLY by public.mark_notices_delivered() (service_role, sessionless); never updated (private.notification_delivery_guard()); deleted only by the FK cascade when the subject row itself is purged.';


-- ---------------------------------------------------------------------------
-- 2. THE LEDGER'S GUARD -- the job-2 stamp guard's rules for an insert-only row.
-- ---------------------------------------------------------------------------

create or replace function private.notification_delivery_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'notification_deliveries: a delivery stamp is written once and never cleared or rewritten'
      using errcode = '22023', hint = 'notification_stamp_is_written_once';
  end if;

  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), '') not in ('service_role', 'postgres', 'none', '') then
    raise exception 'notification_deliveries: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  -- The database's clock, never the caller's.
  new.notified_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function private.notification_delivery_guard() from public, anon, authenticated, service_role;

create trigger notification_deliveries_guard_insert
  before insert on private.notification_deliveries
  for each row execute function private.notification_delivery_guard();
create trigger notification_deliveries_guard_update
  before update on private.notification_deliveries
  for each row execute function private.notification_delivery_guard();

comment on function private.notification_delivery_guard() is
  'BEFORE INSERT/UPDATE on private.notification_deliveries (20261016000000). INSERT: refused from any session (42501 notification_stamp_is_server_only), and notified_at is forced to now(). UPDATE: always refused (22023 notification_stamp_is_written_once) -- a stamp is never cleared or moved. The same hint vocabulary as private.notification_stamp_guard() (20261015000000), which guards the column-shaped stamps.';


-- ---------------------------------------------------------------------------
-- 3. THE ONE WRITE PATH.
--
--    Stamps the given subjects for one notice -- ONLY those still in the state
--    the email is about -- and answers how many it stamped. Already-stamped
--    subjects are left as they are (ON CONFLICT DO NOTHING) and not counted.
-- ---------------------------------------------------------------------------

create or replace function public.mark_notices_delivered(p_notice text, p_subject_ids uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if (select auth.uid()) is not null
     or coalesce(pg_catalog.current_setting('role', true), 'none')
          not in ('postgres', 'service_role', 'none') then
    raise exception 'mark_notices_delivered: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id)
    select 'task_reminder', t.id
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id)
    select p_notice, r.id
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  else
    raise exception 'mark_notices_delivered: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notices_delivered(text, uuid[]) from public, anon, authenticated;
grant execute on function public.mark_notices_delivered(text, uuid[]) to service_role;

comment on function public.mark_notices_delivered(text, uuid[]) is
  'Stamps private.notification_deliveries for one notice (connection_received / _accepted / _declined, task_reminder) and the subject ids given, ONLY for subjects still in the state that email is about (a pending/accepted/declined request; an open, undeleted task whose reminder_at has passed), and answers how many it stamped. Called by lib/email/network-notifications.ts and lib/email/task-reminder-notifications.ts ONLY after Brevo answered ok:true. service_role only; refuses any session (42501 notification_stamp_is_server_only); an unknown notice is 22023 notification_notice_unknown.';


-- ---------------------------------------------------------------------------
-- 4. RECIPIENT AND CONTENT RESOLUTION, IN THE DATABASE.
-- ---------------------------------------------------------------------------

-- One row per NOTICE (not per recipient): the email goes to every address in
-- `emails` at once -- colleagues in one workspace, who see each other on its
-- members page already -- so a notice is sent, and stamped, as one unit.
create or replace function public.pending_connection_request_notifications(p_limit integer default 30)
returns table (
  request_id        uuid,
  notice            text,
  emails            text[],
  organisation_slug text,
  counterparty_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with owed as (
    select r.id, 'connection_received'::text as notice,
           r.to_organisation_id as recipient_org, null::uuid as sender,
           r.from_network_profile_id as counterparty_profile,
           r.requested_at as since
      from public.network_connection_requests r
     where r.status = 'pending'
       and r.requested_at > pg_catalog.now() - interval '7 days'
    union all
    select r.id, 'connection_' || r.status,
           r.from_organisation_id, r.requested_by,
           r.to_network_profile_id,
           r.responded_at
      from public.network_connection_requests r
     where r.status in ('accepted', 'declined')
       and r.responded_at > pg_catalog.now() - interval '7 days'
  ),
  unsent as (
    select o.* from owed o
     where not exists (
       select 1 from private.notification_deliveries d
        where d.request_id = o.id and d.notice = o.notice)
  ),
  -- The SENDER, if still an active member of the requesting workspace.
  sender_member as (
    select u.id as request_id, m.user_id
      from unsent u
      join public.organisation_memberships m
        on m.organisation_id = u.recipient_org and m.user_id = u.sender
       and m.status = 'active'
  ),
  recipients as (
    select u.id, u.notice, au.email::text as email
      from unsent u
      join public.organisation_memberships m
        on m.organisation_id = u.recipient_org and m.status = 'active'
      join auth.users au on au.id = m.user_id
     where au.email is not null
       and m.user_id <> private.erased_user_id()
       and case
             when u.notice = 'connection_received' then m.role in ('owner', 'admin')
             when exists (select 1 from sender_member s where s.request_id = u.id)
               then m.user_id = u.sender
             else m.role in ('owner', 'admin')
           end
  )
  select u.id, u.notice,
         (select pg_catalog.array_agg(x.email order by x.email)
            from (select distinct rc.email from recipients rc
                   where rc.id = u.id and rc.notice = u.notice
                   order by rc.email limit 10) x),
         org.slug::text,
         p.display_name
    from unsent u
    join public.organisations org on org.id = u.recipient_org and org.deleted_at is null
    left join public.network_profiles p
      on p.id = u.counterparty_profile and p.status = 'published' and p.deleted_at is null
   where exists (select 1 from recipients rc where rc.id = u.id and rc.notice = u.notice)
   order by u.since, u.id, u.notice
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

create or replace function public.pending_task_reminder_notifications(p_limit integer default 30)
returns table (
  task_id           uuid,
  email             text,
  organisation_slug text,
  title             text,
  due_at            timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, au.email::text, org.slug::text, t.title, t.due_at
    from public.tasks t
    join public.organisations org on org.id = t.organisation_id and org.deleted_at is null
    join public.organisation_memberships m
      on m.organisation_id = t.organisation_id and m.user_id = t.owner_user_id
     and m.status = 'active'
    join auth.users au on au.id = t.owner_user_id
   where t.deleted_at is null
     and t.status in ('open', 'in_progress', 'blocked')
     and t.reminder_at is not null
     and t.reminder_at <= pg_catalog.now()
     and t.reminder_at > pg_catalog.now() - interval '7 days'
     and t.owner_user_id <> private.erased_user_id()
     and au.email is not null
     and not exists (
       select 1 from private.notification_deliveries d
        where d.task_id = t.id and d.notice = 'task_reminder')
   order by t.reminder_at, t.id
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

revoke all on function public.pending_connection_request_notifications(integer) from public, anon, authenticated;
revoke all on function public.pending_task_reminder_notifications(integer)      from public, anon, authenticated;
grant execute on function public.pending_connection_request_notifications(integer) to service_role;
grant execute on function public.pending_task_reminder_notifications(integer)      to service_role;

comment on function public.pending_connection_request_notifications(integer) is
  'The connection-request notices owed (20261016000000; Q202): connection_received for a pending request, to the REQUESTED workspace''s active owners and admins; connection_accepted / connection_declined to the request''s sender while they are an active member of the requesting workspace, otherwise that workspace''s active owners and admins. Within seven days of the event, unstamped in private.notification_deliveries, never a deleted workspace, never the Q130 tombstone, at most 10 addresses a notice and 30 notices a call. Content: the recipient workspace''s slug (for the /<slug>/network/requests link) and the counterparty''s display_name ONLY while its profile is published and live -- nothing else from either side. service_role only, no user argument.';
comment on function public.pending_task_reminder_notifications(integer) is
  'The task reminders owed (20261016000000; Q202): an open/in_progress/blocked, undeleted task whose reminder_at has passed within the last seven days, unstamped in private.notification_deliveries, to its assignee (owner_user_id) while they are an active member of the task''s workspace. A task with no assignee is reminded to NOBODY. A completed, cancelled, deleted or reassigned-away task is not returned -- the check runs at send time, so the reminder follows the task''s CURRENT state and assignee. Returns the title and due_at (both readable by the assignee in-app) and never `detail`. service_role only, no user argument, at most 30 rows.';


-- ---------------------------------------------------------------------------
-- 5. THE CLOCK'S COMMENT, REISSUED WITH THE NEW WORST CASE. Everything else is
--    20261015000000's text.
-- ---------------------------------------------------------------------------

comment on function private.deliver_incident_alerts() is
  'THE INCIDENT-ALERT CLOCK''S BODY (founder ruling Q118). Runs from pg_cron every 10 minutes and POSTs /api/incident-alerts/deliver with the bearer. That route runs EIGHT independent deliveries, each with its own stamp: the operator''s email digest (`notified_at`), the counts-only Telegram alert (`telegram_notified_at`, Q111, 20261014000000), the per-account lockout email (`account_notified_at`, Q114), the requester''s DSR received/closed notices (`data_subject_requests.received_notified_at` / `closed_notified_at`), the requester''s export-ready notice (`export_jobs.ready_notified_at`) and the superuser''s erasure-failure notice (`erasure_jobs.failure_notified_at`) since 20261015000000, and since 20261016000000 the connection-request received/accepted/declined notices and the task reminder (rows in private.notification_deliveries) -- all founder 2026-09-30, Q157(3)/Q174/Q45. The URL and the bearer come from Supabase Vault (`incident_alert_delivery_url` / `incident_alert_delivery_secret`), created by hand once per environment and NEVER by a migration -- with either missing this function returns without building a request, which is what local dev and CI do on every tick. SECURITY DEFINER for the Vault read; granted to no client role. Failure needs no handling: each sender stamps nothing on a failed send, so the next tick retries the identical set for that channel alone. OVERLAP is ruled out in the ROUTE: one 10-second Brevo call for the digest, one 10-second Telegram call, the lockout loop capped at 30 accounts and a 120-second budget (~130 s), the DSR and export-ready loops each capped at 30 rows and a 60-second budget (~70 s each), one 10-second call for the erasure-failure notice, and the connection-request and task-reminder loops each capped at 30 notices and a 60-second budget (~70 s each), so the worst case is ~440 s against a 600 s cadence. An advisory lock HERE would not help -- net.http_post is fire-and-forget, so this function returns before the route runs.';


-- ---------------------------------------------------------------------------
-- 6. THE RETENTION ROLL CLASSIFIES THE LEDGER.
--
--    private.retention_roll_relations() sees `private` since 20261004005000,
--    so the first table there REFUSES the retention job until it is
--    classified -- measured: start_retention_run() answered
--    {"*": "unclassified_retention_subject"} the moment the ledger existed.
--    Rebuilt from its LATEST definition (20261003002000, read back from the
--    live catalogue at 219 migrations) with one row added; nothing else moves.
-- ---------------------------------------------------------------------------

create or replace function private.retention_subjects()
 RETURNS TABLE(table_name text, treatment text, class text, reason text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are already purged by the export runner''s own expiry.'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.'),

    -- ---- the notice ledger (added in 20261016000000) ----------------------
    ('private.notification_deliveries', 'cascades', null,
     'One row per connection-request / task-reminder email accepted by Brevo: a notice name, a subject id and a time -- no address, no content. FKs to public.tasks and public.network_connection_requests, ON DELETE CASCADE: a stamp goes with the row it is about, and both of those go with their workspace.')
$function$;

comment on function private.retention_subjects() is
  'THE ROLL: every table in `public` and `private` (fifty-five since 20261016000000 added private.notification_deliveries), each one either swept under a declared class or excused with a reason (Phase 8 Task 6). Paired with private.assert_retention_roll(), which DERIVES the same list from pg_class and refuses a table the roll does not carry -- so a table added by a later phase stops the retention job rather than being quietly un-retained, which is the whole point. Treatments: `swept` (a named sweep deletes or purges it), `cascades` (it goes when its parent goes), `retained_with_workspace` (a tenant record, removed only by the workspace purge -- Q180 asks whether soft-deleted CRM rows should expire on their own, and this task deliberately does NOT build that), `platform_reference` (the product''s own catalogues) and `never_purged` (kept for ever, with the reason).';

revoke all on function private.retention_subjects() from public, anon, authenticated, service_role;
grant execute on function private.retention_subjects() to authenticated;
