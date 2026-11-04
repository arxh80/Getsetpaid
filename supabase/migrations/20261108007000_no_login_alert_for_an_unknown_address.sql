-- ===========================================================================
-- Phase 10 Task 18 (final review finding 5): an address with no account
-- cannot flood incident_alerts.
--
-- public.meter_password_sign_in (20261108002000) budgets every address
-- before GoTrue, including addresses that have no account (keyed on the
-- address's hash, so the refusal looks the same). Its crossing filed a
-- repeated_login_failures alert either way, so six requests per invented
-- address produced one alert row each, without limit, burying real alerts on
-- /super/health and in the digest. private.record_rate_limit_event() is
-- rebuilt from its live definition with one change: a login_email crossing
-- files an alert only when the subject is a real auth.users id.
-- ===========================================================================

CREATE OR REPLACE FUNCTION private.record_rate_limit_event(p_category text, p_subject_scope text, p_subject_id uuid, p_organisation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(allowed boolean, retry_after_seconds integer, request_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
begin
  select * into v_policy from public.rate_limit_policies p where p.category = p_category;
  if not found then
    raise exception 'record_rate_limit_event: unknown rate-limit category %', p_category
      using errcode = '22023';
  end if;
  if v_policy.subject_scope <> p_subject_scope then
    raise exception 'record_rate_limit_event: category % is %-scoped, not %-scoped',
      p_category, v_policy.subject_scope, p_subject_scope
      using errcode = '22023';
  end if;
  if p_subject_id is null then
    raise exception 'record_rate_limit_event: a subject is required' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);

  -- OPPORTUNISTIC CLEANUP, the no-scheduler pattern: this subject's dead
  -- windows go when the subject next shows up. Bounded by the PK index.
  delete from public.rate_limit_counters c
  where c.category = p_category
    and c.subject_scope = p_subject_scope
    and c.subject_id = p_subject_id
    and c.window_start < v_window;

  -- THE ATOMIC INCREMENT. ON CONFLICT serialises concurrent callers on the
  -- row (tests/integration/rls/rate-limits.test.ts).
  insert into public.rate_limit_counters as c
    (category, subject_scope, subject_id, window_start, request_count)
  values
    (p_category, p_subject_scope, p_subject_id, v_window, 1)
  on conflict (category, subject_scope, subject_id, window_start)
  do update set request_count = c.request_count + 1,
                updated_at    = pg_catalog.now()
  returning c.request_count into v_count;

  -- THE EXACTLY-ONCE CROSSING WRITE. Both login budgets file the login alert
  -- (Phase 10 Task 8 added login_email).
  -- Phase 10 Task 18 (review finding 5): login_email budgets an address with
  -- NO account too (keyed on its hash, so the refusal is the same), but its
  -- crossing files no alert: six requests per invented address would
  -- otherwise bury real alerts. The refusal itself is unchanged.
  if v_count = v_policy.max_requests + 1
     and not (p_category = 'login_email'
              and not exists (select 1 from auth.users u where u.id = p_subject_id)) then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      case when p_category in ('login_account', 'login_email')
           then 'repeated_login_failures'
           else 'rate_limit_tripped' end,
      p_organisation_id,
      case when p_category in ('login_account', 'login_email')
           then pg_catalog.format(
             'Repeated failed sign-in attempts on one account (limit %s per %s seconds).',
             v_policy.max_requests, v_policy.window_seconds)
           else pg_catalog.format(
             'Rate limit exceeded: %s (limit %s per %s seconds).',
             p_category, v_policy.max_requests, v_policy.window_seconds) end,
      pg_catalog.jsonb_build_object(
        'category',       p_category,
        'subject_scope',  p_subject_scope,
        'subject_id',     p_subject_id,
        'window_start',   v_window,
        'max_requests',   v_policy.max_requests,
        'window_seconds', v_policy.window_seconds
      )
    );
  end if;

  return query select
    v_count <= v_policy.max_requests,
    greatest(0, pg_catalog.ceil(extract(epoch from
      (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
        - pg_catalog.now())))::integer),
    v_count;
end;
$function$;
