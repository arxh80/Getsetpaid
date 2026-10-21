-- PHASE 8 TASK 8 MUTANT 05b-dsr-attribution-sessionless
-- guard:  private.data_subject_requests_before_insert
-- change: the no-session refusal is removed
-- Generated from the LIVE definition at 210 migrations; applied after a fresh
-- reset by run-mutation.sh and removed by the next reset. Never a migration.
CREATE OR REPLACE FUNCTION private.data_subject_requests_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := (select auth.uid());
  v_email  text;
  v_policy public.rate_limit_policies%rowtype;
  v_window timestamptz;
  v_count  integer;
  v_after  integer;
  v_retry  integer;
begin
  -- (1) WHO. A data subject request is the data subject's own act, and the
  -- session IS the identity verification (see the header). No session, no
  -- request -- the consent ledger's posture, not feedback's "a sessionless
  -- writer is a fixture" one: a fixture that could file a request for anybody
  -- could start a statutory clock in somebody else's name.
  if v_uid is null then
    raise notice 'MUTANT: data_subject_requests: a request can only be made from the requester''s own session'
      using errcode = '42501';
  end if;
  new.user_id := v_uid;

  select u.email into v_email from auth.users u where u.id = v_uid;
  if v_email is null or pg_catalog.btrim(v_email) = '' then
    raise exception 'data_subject_requests: the requesting account has no email address'
      using errcode = '22023', hint = 'no_account_email';
  end if;
  new.user_email := v_email;

  -- (2) WHAT. Closed vocabularies, read from the catalogue rather than left
  -- to the CHECK, so the error names the input instead of a constraint.
  if not exists (select 1 from private.dsr_rights() r where r.right_type = new.right_type) then
    raise exception 'data_subject_requests: % is not one of the six rights', new.right_type
      using errcode = '22023', hint = 'unknown_right';
  end if;
  if new.subject_scope is null or new.subject_scope not in ('account', 'workspace_records') then
    raise exception 'data_subject_requests: subject_scope must be account or workspace_records'
      using errcode = '22023', hint = 'unknown_scope';
  end if;

  -- (3) THE STATE AND THE CLOCK ARE THE DATABASE'S. A new request is always
  -- open and always requested now, so the generated 30-day due_by can be
  -- neither back-dated nor pushed out.
  new.status       := 'open';
  new.requested_at := pg_catalog.now();
  new.fulfilled_at := null;
  new.rejected_at  := null;
  new.withdrawn_at := null;
  new.rejection_reason := null;
  new.routed_at    := null;
  new.routed_to_organisation_id   := null;
  new.routed_to_organisation_name := null;
  new.fulfilment_kind        := null;
  new.fulfilment_reference   := null;
  new.fulfilment_recorded_at := null;

  -- (4) THE METER -- submissions only, after every refusal above, so a
  -- malformed post spends nothing. The consent ledger's shape.
  select * into v_policy from public.rate_limit_policies p where p.category = 'data_subject_request';
  if not found then
    raise exception 'data_subject_requests: no rate-limit policy for data_subject_request' using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
    from public.rate_limit_counters c
   where c.category      = 'data_subject_request'
     and c.subject_scope = 'user'
     and c.subject_id    = v_uid
     and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  if v_count >= v_policy.max_requests then
    raise exception 'data_subject_requests: too many requests (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  select r.request_count into v_after
    from private.record_rate_limit_event('data_subject_request', 'user', v_uid, null) r;

  if v_after > v_policy.max_requests then
    raise exception 'data_subject_requests: too many requests (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  if v_after = v_policy.max_requests then
    insert into public.incident_alerts (alert_type, organisation_id, summary, details)
    values (
      'rate_limit_tripped',
      null,
      pg_catalog.format(
        'Rate limit reached: data_subject_request (limit %s per %s seconds).',
        v_policy.max_requests, v_policy.window_seconds),
      pg_catalog.jsonb_build_object(
        'category',        'data_subject_request',
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
$function$;
