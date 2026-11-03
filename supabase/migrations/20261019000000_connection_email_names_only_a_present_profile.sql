-- PHASE 8 TASK 9b FIX ROUND 1, m1 -- A CONNECTION EMAIL NAMES ONLY WHAT THE
-- REQUESTS PAGE CAN NAME.
--
-- The resolver named the counterparty while its profile was `published` and
-- not deleted. The requests page resolves names through public.network_directory,
-- whose base policy (network_profiles_select_published_directory, latest
-- 20260908031000) ALSO requires private.organisation_network_presence_active():
-- a CLOSED workspace's profile disappears at once (Q101), a SUSPENDED one's at
-- its period end or the 60-day retention deadline (Q88/Q92). So an email could
-- name a profile the page shows as "No longer available". The resolver now
-- applies the same predicate -- the function itself, not a copy of it, so the
-- two cannot drift. The resolver runs as its definer and the counterparty's
-- own-member disjunct of that policy cannot apply (the recipient is, by
-- construction, the OTHER workspace).
--
-- Rebuilt from its LATEST definition (20261018000000); the one change is the
-- predicate on the counterparty join, and its comment reissued.
-- ===========================================================================

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
     -- m1: the SAME lifecycle predicate the directory's cross-tenant policy
     -- uses, so the email names exactly what the requests page can name.
     and private.organisation_network_presence_active(p.organisation_id)
   order by u.org_rank, u.since, u.id, u.notice
   limit greatest(1, least(coalesce(p_limit, 30), 30));
$$;

comment on function public.pending_connection_request_notifications(integer) is
  'The connection-request notices owed (20261016000000; Q202): connection_received for a pending request, to the REQUESTED workspace''s active owners and admins; connection_accepted / connection_declined to the request''s sender while they are an active member of the requesting workspace, otherwise that workspace''s active owners and admins. Within seven days of the event, with no row in private.notification_deliveries (delivered OR recorded undeliverable), never a deleted workspace, never the Q130 tombstone, at most 10 addresses a notice and 30 notices a call. ORDERED FAIRLY since 20261018000000 (Task 9b review I2): by each notice''s rank within its recipient workspace, then by age, so one workspace''s backlog takes one slot per round of workspaces and cannot starve the rest. Content: the recipient workspace''s slug (for the /<slug>/network/requests link) and the counterparty''s display_name ONLY while its profile is published and live AND its organisation still has network presence (private.organisation_network_presence_active(), the directory policy''s own predicate, since 20261019000000 -- review m1: a closed workspace''s profile, or a suspended one''s past its period end, is "No longer available" on the requests page and is not named in the email either) -- nothing else from either side. service_role only, no user argument.';
