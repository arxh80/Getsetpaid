-- ===========================================================================
-- PHASE 7 PRE-MERGE FIX ROUND -- THE HEALTH COUNT MUST BE THE SENDER'S QUEUE.
--
-- Task 6c fix round 2 residual, carried into the final review. /super/health's
-- `lockout_notifications_pending` and `lockout_notifications_oldest_at` were
-- aggregates over public.incident_alerts filtered on TWO predicates:
--
--     alert_type = 'repeated_login_failures'  and  account_notified_at is null
--
-- while public.pending_lockout_notifications() -- the queue the sender actually
-- drains -- filters on EIGHT: those two, plus a uuid-shaped `subject_id`, plus
-- `^[0-9]+$` on `max_requests` and `window_seconds`, plus a join to auth.users,
-- plus `email is not null`, plus `email <> ''`.
--
-- So any pending alert whose subject cannot be resolved -- a deleted user, a
-- malformed `details` payload, a permanently undeliverable address -- is
-- COUNTED FOREVER AND SERVED NEVER. `lockout_notifications_pending` pins at at
-- least 1, `lockout_notifications_oldest_at` freezes, and that is precisely the
-- reading the migration header and app/(app)/super/health/page.tsx declare to
-- be the alarm: "if this stops moving, the delivery clock is not draining the
-- queue". The one diagnostic the fix exists to provide had an unbounded
-- false-positive mode.
--
-- THE FIX IS TO STOP HAVING TWO DEFINITIONS OF THE QUEUE. Both numbers are now
-- read off public.pending_lockout_notifications(500) itself -- the same
-- function, the same limit clamp -- so they cannot drift again by a predicate
-- being added on one side. The cost is one extra evaluation of a STABLE,
-- index-supported query inside an RPC that already runs a dozen aggregates.
--
-- WHY 500 rather than the sender's 30: 30 is the per-TICK budget
-- (LOCKOUT_NOTIFICATION_LIMIT), not the queue depth. The queue depth is what
-- the operator needs, and 500 is the function's own hard ceiling
-- (`limit least(greatest(p_limit,1),500)`), so this reads "the whole queue, up
-- to the most the function will ever return".
--
-- REBUILT FROM 20260921000000, which is this function's LATEST definition --
-- not from 20260918001000 (invalid UTF-8, finding I3) and not from
-- 20260909020000. Two keys inside `abuse` change and nothing else does.
--
-- supabase/tests/rls_phase7_rate_limits.sql § RD36-RD38 plants one alert whose
-- subject_id resolves to no auth.users row and requires the health count and
-- the sender's queue to agree about it.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


create or replace function public.platform_health_snapshot()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.has_platform_permission('view_platform_health') then
    raise exception 'platform_health_snapshot: caller is not the platform superuser at aal2'
      using errcode = '42501';
  end if;

  -- SUPERUSER ACCESS AUDITS ITSELF (CLAUDE.md § Non-negotiable rules) --
  -- the same discipline as audit_log.viewed (20260908010000). This RPC is a
  -- definer function, so it reaches private.log_audit_event directly; the
  -- payload is empty because the snapshot takes no parameters and returns no
  -- record content worth restating.
  perform private.log_audit_event(
    p_action          => 'platform_health.viewed',
    p_target_type     => 'platform_health',
    p_organisation_id => null,
    p_target_id       => null,
    p_after           => '{}'::jsonb
  );

  -- LIVE QUERIES, ON DEMAND -- CLAUDE.md § Superuser dashboard: "queried
  -- on-demand/daily from Postgres directly -- no separate metrics/
  -- observability pipeline". Every number below is an aggregate: counts,
  -- sums, and (for storage) organisation names -- the same disclosure
  -- /super/organisations already makes -- never a record, a filename, or a
  -- user-entered field.
  select pg_catalog.jsonb_build_object(
    'generated_at', pg_catalog.now(),

    'organisations', (
      select pg_catalog.jsonb_build_object(
        'active',      count(*) filter (where o.lifecycle_state = 'active'),
        'suspended',   count(*) filter (where o.lifecycle_state = 'suspended'),
        'deleted',     count(*) filter (where o.lifecycle_state = 'deleted'),
        'total',       count(*),
        'created_7d',  count(*) filter (where o.created_at >= pg_catalog.now() - interval '7 days'),
        'created_30d', count(*) filter (where o.created_at >= pg_catalog.now() - interval '30 days')
      )
      from public.organisations o
    ),

    'users', (
      select pg_catalog.jsonb_build_object(
        'total',       count(*),
        'created_7d',  count(*) filter (where u.created_at >= pg_catalog.now() - interval '7 days'),
        'created_30d', count(*) filter (where u.created_at >= pg_catalog.now() - interval '30 days')
      )
      from auth.users u
      where u.deleted_at is null
    ),

    'memberships_active', (
      select count(*) from public.organisation_memberships m where m.status = 'active'
    ),

    -- DECLARED seats, not billed truth: Phase 7 Task A's backfill stamped
    -- seat_count = 1 and current_period_end = migration + 30 days onto every
    -- pre-existing organisation (ledger minor M2), and nothing reconciles
    -- these against a payment processor yet. The UI carries this caveat in
    -- as many words -- presenting the number as more than it is would be the
    -- health view's own version of an unimplemented control listed as live.
    'subscriptions', (
      select pg_catalog.jsonb_build_object(
        'declared_seats', coalesce(sum(s.seat_count), 0),
        'past_period_end', count(*) filter (where s.current_period_end < pg_catalog.now()),
        'by_plan', (
          select coalesce(pg_catalog.jsonb_object_agg(q.plan_id, q.n), '{}'::jsonb)
          from (
            select s2.plan_id, count(*) as n
            from public.organisation_subscriptions s2
            group by s2.plan_id
          ) q
        )
      )
      from public.organisation_subscriptions s
    ),

    'storage', (
      select pg_catalog.jsonb_build_object(
        'total_bytes', coalesce(sum(d.size_bytes), 0),
        'documents',   count(*)
      )
      from public.documents d
      where d.deleted_at is null
    ),

    'storage_top_organisations', (
      select coalesce(pg_catalog.jsonb_agg(t), '[]'::jsonb)
      from (
        select o.name, o.slug,
               sum(d.size_bytes)::bigint as bytes,
               count(*)::integer          as documents
        from public.documents d
        join public.organisations o on o.id = d.organisation_id
        where d.deleted_at is null
        group by o.id, o.name, o.slug
        order by sum(d.size_bytes) desc
        limit 10
      ) t
    ),

    'abuse', (
      select pg_catalog.jsonb_build_object(
        'rate_limit_trips_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'rate_limit_tripped'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'repeated_login_failures_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'repeated_login_failures'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'quarantined_uploads_24h', (
          select count(*) from public.incident_alerts a
          where a.alert_type = 'upload_quarantined'
            and a.created_at >= pg_catalog.now() - interval '24 hours'),
        'quarantined_documents_total', (
          select count(*) from public.documents d
          where d.scan_status = 'quarantined' and d.deleted_at is null),
        'open_alerts', (
          select count(*) from public.incident_alerts a where a.resolved_at is null),
        -- THE ACCOUNT-HOLDER NOTIFICATION QUEUE (fix round 2, N4). Counted in
        -- ACCOUNTS, because that is the unit the sender works in:
        -- public.pending_lockout_notifications() groups by account, so this is
        -- literally the length of the queue it will be offered next tick.
        -- READ OFF THE SENDER'S OWN PREDICATE SET (pre-merge fix round).
        -- Until now this counted every unnotified `repeated_login_failures`
        -- alert on two predicates, while public.pending_lockout_notifications()
        -- additionally requires a uuid-shaped subject_id, integer-shaped
        -- max_requests/window_seconds, a resolvable auth.users row and a
        -- non-empty address. Any alert failing one of those is counted here
        -- forever and served there never -- so the number pins at >= 1 and the
        -- age freezes, which is EXACTLY the reading /super/health declares to
        -- be the alarm ("if this stops moving, the delivery clock is not
        -- draining the queue"). The one diagnostic the count exists to provide
        -- had an unbounded false-positive mode. The queue is now defined once,
        -- as a lateral over the sender's function, so the two cannot drift.
        'lockout_notifications_pending', (
          select count(*) from public.pending_lockout_notifications(500)),
        -- ...AND ITS AGE, which is the half that diagnoses. A count alone
        -- cannot tell a normal one-tick backlog from a queue that is not
        -- draining at all (a wrong bearer, a stopped clock, a budget squeezed
        -- every tick). An oldest-pending timestamp that keeps receding can.
        'lockout_notifications_oldest_at', (
          select pg_catalog.min(a.created_at)
          from public.pending_lockout_notifications(500) p
          join public.incident_alerts a on a.id = any(p.alert_ids))
      )
    )
  ) into v_result;

  return v_result;
end;
$$;


comment on function public.platform_health_snapshot() is
  'The /super/health read: platform aggregates (org/user/membership counts, declared seats with the Task A M2 backfill caveat stated in the UI, storage totals and top-10 orgs by bytes, abuse counters from incident_alerts), queried LIVE with no snapshot table -- CLAUDE.md § Superuser dashboard''s "basic counts only ... no separate metrics pipeline". Since fix round 2 (review finding N4) `abuse` also carries `lockout_notifications_pending` (ACCOUNTS waiting for the Q114 account-holder email) and `lockout_notifications_oldest_at` (when the oldest of them crossed); since the pre-merge fix round BOTH are read straight off public.pending_lockout_notifications(500) rather than off a two-predicate aggregate of their own, because an alert the sender cannot resolve to an address -- a deleted user, a malformed details payload, an empty address -- was otherwise counted here forever and served there never, pinning the count at >= 1 and freezing the age, which is precisely the signal the page tells the operator to read as a stalled delivery clock: the delivery run is bounded at 30 accounts per tick and nothing reads pg_net''s response, so without these two a backlog that never drains -- a wrong bearer, a stopped clock, a permanently squeezed budget -- is invisible on every operator surface. Guarded on has_platform_permission(''view_platform_health'') (42501 otherwise), and SELF-AUDITING: every call writes a platform_health.viewed audit row before reading anything, the audit_log.viewed discipline. Aggregates and organisation names only -- the same disclosure /super/organisations makes -- never record content, never an address, never an account id. VOLATILE (it writes the audit row), so it is not callable via GET; the app calls it via POST like every RPC.';

-- Unchanged, restated so `create or replace` cannot silently drift them.
revoke all on function public.platform_health_snapshot() from public, anon, service_role;
grant execute on function public.platform_health_snapshot() to authenticated;
