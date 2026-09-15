-- ===========================================================================
-- PHASE 7 TASK 6c -- FIX ROUND 2, REVIEW FINDING N4: A DEFERRED LOCKOUT
-- NOTIFICATION MUST BE VISIBLE TO THE OPERATOR.
--
-- Fix round 1 bounded the lockout-notification run (30 accounts, 120 s), and
-- the accounts a squeezed tick does not reach stay pending for the next one.
-- That is correct behaviour with NO WITNESS. The route returns `deferred` in
-- its JSON body, but the caller is `private.deliver_incident_alerts()` over
-- pg_net, which is fire-and-forget and reads no response at all -- so a wrong
-- bearer (404 every tick) and a healthy tick look identical from here, and a
-- backlog that never drains is silent on every operator surface. The only
-- other trace is a console.error in the Next.js server log, which is not a
-- surface anyone watches.
--
-- THE CHEAP HONEST FIX, TAKEN: two numbers on /super/health, beside the alert
-- list the operator already reads.
--
--   `lockout_notifications_pending`  -- how many ACCOUNTS are waiting to be
--                                       told (the unit the sender works in:
--                                       public.pending_lockout_notifications()
--                                       groups by account, so this is the
--                                       length of its queue).
--   `lockout_notifications_oldest_at`-- when the oldest still-unnotified
--                                       lockout crossed.
--
-- The SECOND is what makes the first diagnostic rather than decorative. A
-- backlog is normal under a spray and drains within a tick or two, so a
-- non-zero count alone says nothing. An oldest-pending timestamp that keeps
-- receding says the queue is NOT draining -- which is what a wrong bearer, a
-- dead clock or a permanently-squeezed budget all look like, and the operator
-- can read it without knowing that net._http_response exists.
--
-- Both are aggregates over a table /super/health already reports on, so this
-- adds no disclosure: no address, no account id, no attempt detail. It is the
-- same "basic counts only at MVP" shape as every other number on that page.
--
-- Body copied verbatim from its LATEST definition (20260909020000 ยง the health
-- snapshot); the `abuse` object gains two keys and nothing else changes. The
-- guard, the self-audit, the volatility and the grants are unchanged and
-- restated below so `create or replace` cannot drift them.
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

  -- SUPERUSER ACCESS AUDITS ITSELF (CLAUDE.md ง Non-negotiable rules) --
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

  -- LIVE QUERIES, ON DEMAND -- CLAUDE.md ง Superuser dashboard: "queried
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
        'lockout_notifications_pending', (
          select count(distinct a.details->>'subject_id') from public.incident_alerts a
          where a.alert_type = 'repeated_login_failures'
            and a.account_notified_at is null),
        -- ...AND ITS AGE, which is the half that diagnoses. A count alone
        -- cannot tell a normal one-tick backlog from a queue that is not
        -- draining at all (a wrong bearer, a stopped clock, a budget squeezed
        -- every tick). An oldest-pending timestamp that keeps receding can.
        'lockout_notifications_oldest_at', (
          select pg_catalog.min(a.created_at) from public.incident_alerts a
          where a.alert_type = 'repeated_login_failures'
            and a.account_notified_at is null)
      )
    )
  ) into v_result;

  return v_result;
end;
$$;


comment on function public.platform_health_snapshot() is
  'The /super/health read: platform aggregates (org/user/membership counts, declared seats with the Task A M2 backfill caveat stated in the UI, storage totals and top-10 orgs by bytes, abuse counters from incident_alerts), queried LIVE with no snapshot table -- CLAUDE.md ยง Superuser dashboard''s "basic counts only ... no separate metrics pipeline". Since fix round 2 (review finding N4) `abuse` also carries `lockout_notifications_pending` (ACCOUNTS waiting for the Q114 account-holder email -- the length of public.pending_lockout_notifications()''s queue) and `lockout_notifications_oldest_at` (when the oldest of them crossed): the delivery run is bounded at 30 accounts per tick and nothing reads pg_net''s response, so without these two a backlog that never drains -- a wrong bearer, a stopped clock, a permanently squeezed budget -- is invisible on every operator surface. Guarded on has_platform_permission(''view_platform_health'') (42501 otherwise), and SELF-AUDITING: every call writes a platform_health.viewed audit row before reading anything, the audit_log.viewed discipline. Aggregates and organisation names only -- the same disclosure /super/organisations makes -- never record content, never an address, never an account id. VOLATILE (it writes the audit row), so it is not callable via GET; the app calls it via POST like every RPC.';

-- Unchanged, restated so `create or replace` cannot silently drift them.
revoke all on function public.platform_health_snapshot() from public, anon, service_role;
grant execute on function public.platform_health_snapshot() to authenticated;
