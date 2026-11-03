-- PHASE 8 TASK 9b FIX ROUND 1, I2 -- ONE WORKSPACE CANNOT STARVE THE NOTICE QUEUES.
--
-- The finding: the connection-request and task-reminder resolvers return the
-- 30 OLDEST owed notices platform-wide. A notice whose content made its
-- builder throw (a task titled `https://`) was counted `failed`, stamped
-- nothing, and was offered again on every tick -- so 30 such rows from ONE
-- workspace were the 30 oldest for seven days and nobody else's reminder was
-- ever reached.
--
-- Three layers, each sufficient for the case it names:
--
--   1. CONTENT IS TOTAL (lib/email/notice-render.ts, the I3 commit): a
--      person's text is neutralised, never refused, so hostile user content
--      no longer throws at all.
--   2. A DETERMINISTIC REFUSAL IS TERMINAL. Whatever can still refuse a
--      notice's render (a builder invariant, no recipient) is recorded in the
--      SAME ledger as a delivery, with outcome `undeliverable` and a reason
--      from a closed list, through a second service_role-only write path,
--      public.mark_notices_undeliverable(). The resolvers already skip any
--      subject with a ledger row, so a refused notice leaves the queue after
--      ONE attempt instead of seven days. A refusal is not a delivery and the
--      row says so; nothing about it is sent anywhere.
--   3. THE QUEUE IS FAIR PER WORKSPACE. Both resolvers now order by each
--      notice's RANK WITHIN ITS OWN WORKSPACE first (row_number() over the
--      recipient workspace, oldest first), then by age. One workspace's
--      backlog -- poison, a Brevo permanent rejection retried until the
--      seven-day window closes, or simply volume -- takes at most one slot
--      per round of workspaces: with W workspaces owed anything, each is
--      served before any is served twice. A single workspace still drains
--      oldest-first. A tenant with 30+ workspaces could still fill a batch;
--      that costs 30 paid workspaces and is bounded by the same seven days.
--
-- A transient SEND failure (Brevo 5xx, a timeout) is NOT made terminal: it is
-- retried as before, and layer 3 is what stops it monopolising the batch.
--
-- ADDITIVE: two columns on the private ledger (defaulted, so every existing
-- row reads `delivered`), one RPC, and the two resolvers reissued from their
-- LATEST definition (20261016000000) with only the ordering changed.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE LEDGER RECORDS WHAT HAPPENED, NOT ONLY THAT SOMETHING DID.
-- ---------------------------------------------------------------------------

alter table private.notification_deliveries
  add column outcome text not null default 'delivered'
    check (outcome in ('delivered', 'undeliverable')),
  add column reason  text
    check (reason is null or reason in ('content_refused', 'no_recipient')),
  add constraint notification_deliveries_reason_iff_undeliverable
    check ((outcome = 'undeliverable') = (reason is not null));

comment on column private.notification_deliveries.outcome is
  '`delivered`: Brevo answered ok:true (public.mark_notices_delivered()). `undeliverable`: the sender refused to render or address it, deterministically, and recorded that once so it leaves the queue (public.mark_notices_undeliverable(), 20261018000000, Task 9b review I2). Either way the subject is never offered again.';
comment on column private.notification_deliveries.reason is
  'Why an `undeliverable` notice was not sent, from a closed list: content_refused (its builder refused the content) or no_recipient. NULL exactly when the outcome is `delivered`. Never the content itself.';


-- ---------------------------------------------------------------------------
-- 2. THE SECOND WRITE PATH: RECORD A DETERMINISTIC REFUSAL, ONCE.
--
--    Same controls as mark_notices_delivered(): service_role only, refuses
--    any session, ON CONFLICT DO NOTHING, and ONLY for a subject still in the
--    state its email is about -- so it can never pre-empt a notice that is not
--    owed yet. The ledger guard still forces notified_at to now().
-- ---------------------------------------------------------------------------

create or replace function public.mark_notices_undeliverable(p_notice text, p_subject_ids uuid[], p_reason text)
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
    raise exception 'mark_notices_undeliverable: a delivery stamp is written by the sender, never from a person''s session'
      using errcode = '42501', hint = 'notification_stamp_is_server_only';
  end if;

  if p_reason is null or p_reason not in ('content_refused', 'no_recipient') then
    raise exception 'mark_notices_undeliverable: unknown reason %', p_reason
      using errcode = '22023', hint = 'notification_reason_unknown';
  end if;

  if p_notice = 'task_reminder' then
    insert into private.notification_deliveries (notice, task_id, outcome, reason)
    select 'task_reminder', t.id, 'undeliverable', p_reason
      from public.tasks t
     where t.id = any (coalesce(p_subject_ids, '{}'))
       and t.deleted_at is null
       and t.status in ('open', 'in_progress', 'blocked')
       and t.reminder_at is not null
       and t.reminder_at <= pg_catalog.now()
    on conflict do nothing;
  elsif p_notice in ('connection_received', 'connection_accepted', 'connection_declined') then
    insert into private.notification_deliveries (notice, request_id, outcome, reason)
    select p_notice, r.id, 'undeliverable', p_reason
      from public.network_connection_requests r
     where r.id = any (coalesce(p_subject_ids, '{}'))
       and r.status = case p_notice
                        when 'connection_received' then 'pending'
                        when 'connection_accepted' then 'accepted'
                        else 'declined' end
    on conflict do nothing;
  else
    raise exception 'mark_notices_undeliverable: unknown notice %', p_notice
      using errcode = '22023', hint = 'notification_notice_unknown';
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notices_undeliverable(text, uuid[], text) from public, anon, authenticated;
grant execute on function public.mark_notices_undeliverable(text, uuid[], text) to service_role;

comment on function public.mark_notices_undeliverable(text, uuid[], text) is
  'Records in private.notification_deliveries that a connection-request / task-reminder notice was REFUSED by its sender, deterministically (reason content_refused or no_recipient), so the resolvers never offer it again -- one workspace''s unrenderable rows cannot hold the head of the queue (20261018000000, Task 9b review I2). Only for subjects still in that email''s state; written once; service_role only, refusing any session (42501 notification_stamp_is_server_only); an unknown reason or notice is 22023. A transient send failure is NOT recorded here -- it is retried.';


-- ---------------------------------------------------------------------------
-- 3. THE RESOLVERS, FAIR PER WORKSPACE. Rebuilt from 20261016000000 (their
--    only definition); the one change is the `ranked` step and the ORDER BY.
-- ---------------------------------------------------------------------------

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
  ),
  -- FAIRNESS (I2): each notice's place in its own workspace's queue.
  ranked as (
    select u.*, pg_catalog.row_number() over (
             partition by u.recipient_org order by u.since, u.id, u.notice) as org_rank
      from unsent u
     where exists (select 1 from recipients rc where rc.id = u.id and rc.notice = u.notice)
  )
  select u.id, u.notice,
         (select pg_catalog.array_agg(x.email order by x.email)
            from (select distinct rc.email from recipients rc
                   where rc.id = u.id and rc.notice = u.notice
                   order by rc.email limit 10) x),
         org.slug::text,
         p.display_name
    from ranked u
    join public.organisations org on org.id = u.recipient_org and org.deleted_at is null
    left join public.network_profiles p
      on p.id = u.counterparty_profile and p.status = 'published' and p.deleted_at is null
   order by u.org_rank, u.since, u.id, u.notice
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
  select q.id, q.email, q.slug, q.title, q.due_at
    from (
      select t.id, au.email::text as email, org.slug::text as slug, t.title, t.due_at, t.reminder_at,
             -- FAIRNESS (I2): each reminder's place in its own workspace's queue.
             pg_catalog.row_number() over (
               partition by t.organisation_id order by t.reminder_at, t.id) as org_rank
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
    ) q
   order by q.org_rank, q.reminder_at, q.id
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

comment on function public.pending_connection_request_notifications(integer) is
  'The connection-request notices owed (20261016000000; Q202): connection_received for a pending request, to the REQUESTED workspace''s active owners and admins; connection_accepted / connection_declined to the request''s sender while they are an active member of the requesting workspace, otherwise that workspace''s active owners and admins. Within seven days of the event, with no row in private.notification_deliveries (delivered OR recorded undeliverable), never a deleted workspace, never the Q130 tombstone, at most 10 addresses a notice and 30 notices a call. ORDERED FAIRLY since 20261018000000 (Task 9b review I2): by each notice''s rank within its recipient workspace, then by age, so one workspace''s backlog takes one slot per round of workspaces and cannot starve the rest. Content: the recipient workspace''s slug (for the /<slug>/network/requests link) and the counterparty''s display_name ONLY while its profile is published and live -- nothing else from either side. service_role only, no user argument.';
comment on function public.pending_task_reminder_notifications(integer) is
  'The task reminders owed (20261016000000; Q202): an open/in_progress/blocked, undeleted task whose reminder_at has passed within the last seven days, with no row in private.notification_deliveries (delivered OR recorded undeliverable), to its assignee (owner_user_id) while they are an active member of the task''s workspace. A task with no assignee is reminded to NOBODY. A completed, cancelled, deleted or reassigned-away task is not returned -- the check runs at send time, so the reminder follows the task''s CURRENT state and assignee. ORDERED FAIRLY since 20261018000000 (Task 9b review I2): by each reminder''s rank within its workspace, then by reminder_at, so one workspace cannot fill the 30-row batch. Returns the title and due_at (both readable by the assignee in-app) and never `detail`. service_role only, no user argument, at most 30 rows.';
