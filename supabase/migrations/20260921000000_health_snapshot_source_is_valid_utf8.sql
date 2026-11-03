-- ===========================================================================
-- PHASE 7 PRE-MERGE FIX ROUND, FINDING I3 -- 20260918001000 IS NOT VALID UTF-8,
-- AND THE CORRUPTION IS INSIDE A SHIPPED FUNCTION'S BODY.
--
-- `20260918001000_health_shows_the_deferred_lockout_queue.sql` carries two raw
-- `0xA7` bytes (Latin-1 `§`) at byte offsets 3039 and 3623, where every other
-- `§` in that file -- and in all 121 other migrations -- is the UTF-8 pair
-- `0xC2 0xA7`. It is the only migration in the tree that fails a strict UTF-8
-- decode, and both bad bytes sit INSIDE the `$$ ... $$` body of
-- public.platform_health_snapshot(), so they are part of the string the server
-- parses rather than a script comment psql could strip.
--
-- MEASURED BOTH WAYS, because the two paths disagree:
--
--   * `npx supabase db reset --local` APPLIES it. The CLI does not fail; it
--     SUBSTITUTES. Reading the result back out of pg_proc.prosrc:
--         hex:  ...434c415544452e6d6420 efbfbd 204e6f6e2d6e65676f746961626c65...
--         text: CLAUDE.md <U+FFFD> Non-negotiable rules) --
--     `efbfbd` is U+FFFD REPLACEMENT CHARACTER. A shipped security function's
--     stored source is mojibake on every environment built this way.
--   * `psql -f` REFUSES it:
--         ERROR:  invalid byte sequence for encoding "UTF8": 0xa7
--     The same byte inside a top-level `--` comment is accepted (psql strips
--     those client-side); it is specifically the dollar-quoted body that
--     breaks, which is where these two bytes are. Any path that applies
--     migrations with psql -- a restore, a CI job, a hosted SQL-editor paste --
--     aborts here, leaving 20260918001000 through 20260920000000 unapplied,
--     i.e. BOTH grant-narrowing fixes missing.
--
-- THE FIX IS ADDITIVE, NOT AN EDIT. A committed migration is immutable here,
-- so the two bytes are not corrected in place: the function is RE-CREATED from
-- 20260918001000's own body -- byte for byte, the two `0xA7` bytes written as
-- proper UTF-8 `§` and the file saved LF-only -- and nothing else changes. No
-- predicate, no key, no grant, no volatility, no comment text moves.
--
-- WHY THAT IS SAFE TO REBUILD HERE, given this phase lost a clause twice by
-- rebuilding from the wrong version: 20260918001000 is the LATEST definition of
-- this function (only two migrations ever define it -- 20260909020000 and that
-- one) and the body below was extracted from that file mechanically, not
-- retyped. Whoever reissues this function next starts from THIS file.
--
-- THE GATE THAT WOULD HAVE CAUGHT IT: tests/unit/security/migration-encoding.test.ts,
-- added in the same change -- every supabase/migrations/*.sql must decode as
-- strict UTF-8. This class of defect was invisible to all five existing gates.
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
  'The /super/health read: platform aggregates (org/user/membership counts, declared seats with the Task A M2 backfill caveat stated in the UI, storage totals and top-10 orgs by bytes, abuse counters from incident_alerts), queried LIVE with no snapshot table -- CLAUDE.md § Superuser dashboard''s "basic counts only ... no separate metrics pipeline". Since fix round 2 (review finding N4) `abuse` also carries `lockout_notifications_pending` (ACCOUNTS waiting for the Q114 account-holder email -- the length of public.pending_lockout_notifications()''s queue) and `lockout_notifications_oldest_at` (when the oldest of them crossed): the delivery run is bounded at 30 accounts per tick and nothing reads pg_net''s response, so without these two a backlog that never drains -- a wrong bearer, a stopped clock, a permanently squeezed budget -- is invisible on every operator surface. Guarded on has_platform_permission(''view_platform_health'') (42501 otherwise), and SELF-AUDITING: every call writes a platform_health.viewed audit row before reading anything, the audit_log.viewed discipline. Aggregates and organisation names only -- the same disclosure /super/organisations makes -- never record content, never an address, never an account id. VOLATILE (it writes the audit row), so it is not callable via GET; the app calls it via POST like every RPC.';

-- Unchanged, restated so `create or replace` cannot silently drift them.
revoke all on function public.platform_health_snapshot() from public, anon, service_role;
grant execute on function public.platform_health_snapshot() to authenticated;
