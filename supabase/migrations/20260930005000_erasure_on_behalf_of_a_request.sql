-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 6: THE OPERATOR ANSWERS AN ERASURE REQUEST.
--
-- Task 3 built the statutory route: a person files an `erasure` request at
-- /account/data-requests and the operator works it at /super/data-requests.
-- Until now the only thing the operator could do with one was mark it
-- fulfilled by hand -- and since 20260930004000 they cannot even do that,
-- because the seam is awake and requires a job to have run.
--
-- So the operator needs to be able to START one for somebody else. That is a
-- real power and it is bounded by DATA, not by a flag:
--
--   * the caller must hold `oversee_data_subject_requests` at aal2 (the same
--     gate every other operator action on that queue carries);
--   * the subject must be the requester of an OPEN, account-scope, `erasure`
--     request. Not "a user id the operator typed" -- the RPC takes the
--     REQUEST's id and derives the subject from the row.
--
-- Both are conditions on rows, so neither is forgeable from a session: there
-- is no GUC, no marker and no "the application checked" involved.
--
-- `private.erasure_jobs_before_insert()` is rebuilt from its LATEST
-- definition (20260930001000 § 4). The only change is that the `account`
-- branch, which used to require the session to BE the subject, now also
-- admits the operator-on-behalf shape.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.erasure_jobs_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_role      text := coalesce(pg_catalog.current_setting('role', true), '');
  v_on_behalf boolean := false;
  v_policy    public.rate_limit_policies%rowtype;
  v_window    timestamptz;
  v_count     integer;
  v_after     integer;
  v_retry     integer;
begin
  if new.kind is null or new.kind not in ('account', 'workspace') then
    raise exception 'erasure_jobs: kind must be account or workspace'
      using errcode = '22023', hint = 'unknown_erasure_kind';
  end if;

  if new.kind = 'account' then
    if v_uid is null then
      raise exception 'erasure_jobs: an account erasure can only be started from the account''s own session'
        using errcode = '42501', hint = 'erasure_needs_a_session';
    end if;

    -- THE OPERATOR ON BEHALF OF A REQUEST (20260930005000). Admitted only
    -- when the caller holds the oversight permission at aal2 AND the named
    -- subject is the requester of an OPEN account-scope erasure request.
    -- Both are facts about rows; neither can be asserted by a session.
    if new.subject_user_id is not null
       and new.subject_user_id <> v_uid
       and (select private.has_platform_permission('oversee_data_subject_requests'))
       and exists (select 1 from public.data_subject_requests d
                    where d.user_id = new.subject_user_id
                      and d.subject_scope = 'account'
                      and d.right_type = 'erasure'
                      and d.status in ('open', 'in_progress')) then
      v_on_behalf := true;
    end if;

    if not v_on_behalf then
      -- ATTRIBUTION IS NOT THE CALLER'S TO SUPPLY.
      new.subject_user_id := v_uid;
    end if;
    new.requested_by    := v_uid;
    new.organisation_id := null;
    new.requested_aal   := case
      when coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2' then 'aal2' else 'aal1' end;

    if new.subject_user_id = private.erased_user_id() then
      raise exception 'erasure_jobs: the tombstone is not a person and cannot be erased'
        using errcode = '42501', hint = 'tombstone_is_nobody';
    end if;

    -- THE Q131 LAST-OWNER GUARD, asked about the SUBJECT (which is the caller
    -- unless the operator is acting on a request), so the refusal arrives
    -- while somebody is still on a page that can act on it.
    perform private.assert_account_is_erasable(new.subject_user_id);
  else
    if not (v_uid is null and v_role in ('postgres', 'service_role', 'none', '')) then
      raise exception 'erasure_jobs: a workspace purge is started by the platform, never from a person''s session'
        using errcode = '42501', hint = 'purge_is_server_only';
    end if;
    if new.organisation_id is null then
      raise exception 'erasure_jobs: a workspace purge must name the workspace'
        using errcode = '22023', hint = 'purge_needs_a_workspace';
    end if;
    new.subject_user_id := null;
    new.requested_by    := null;
    new.requested_aal   := 'aal2';
  end if;

  new.status         := 'queued';
  new.requested_at   := pg_catalog.now();
  new.started_at     := null;
  new.completed_at   := null;
  new.summary        := null;
  new.failure_reason := null;

  -- THE METER IS THE REQUESTER'S BUDGET, not the subject's. An operator
  -- answering ten different people's requests is not spending any of their
  -- budgets, and an account cannot be locked out of its own erasure by
  -- somebody else's attempts.
  if new.kind = 'account' then
    select * into v_policy from public.rate_limit_policies p where p.category = 'account_erasure';
    if not found then
      raise exception 'erasure_jobs: no rate-limit policy for account_erasure' using errcode = '22023';
    end if;

    v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
    v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                  (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                    - pg_catalog.now())))::integer);

    select c.request_count into v_count
      from public.rate_limit_counters c
     where c.category = 'account_erasure' and c.subject_scope = 'user'
       and c.subject_id = v_uid and c.window_start = v_window;
    v_count := coalesce(v_count, 0);

    if v_count >= v_policy.max_requests then
      raise exception 'erasure_jobs: too many erasure attempts (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;

    select r.request_count into v_after
      from private.record_rate_limit_event('account_erasure', 'user', v_uid, null) r;

    if v_after > v_policy.max_requests then
      raise exception 'erasure_jobs: too many erasure attempts (% per % seconds)',
        v_policy.max_requests, v_policy.window_seconds
        using errcode = 'PT429', hint = v_retry::text;
    end if;
  end if;

  return new;
end;
$$;

comment on function private.erasure_jobs_before_insert() is
  'BEFORE INSERT on public.erasure_jobs, for EVERY writer including a direct PostgREST POST (rebuilt in 20260930005000 from 20260930001000 § 4). The subject is the SESSION''s, whatever the insert named -- with ONE exception added here: the platform operator, holding oversee_data_subject_requests at aal2, may name a subject who is the requester of an OPEN account-scope `erasure` request, because since 20260930004000 the seam requires a job to have run before such a request can be marked fulfilled and the operator therefore has to be able to start one. Both halves of that exception are conditions on ROWS rather than on a session, so neither is forgeable. The Q131 last-owner guard is asked about the subject; a `workspace` job is refused from any session with a person on it; the status and every clock are the database''s; and the account_erasure meter is spent LAST and against the REQUESTER''s budget, so answering ten people''s requests spends none of theirs and nobody can be locked out of their own erasure by somebody else''s attempts.';


-- ---------------------------------------------------------------------------
-- THE OPERATOR'S ENTRY POINT. Takes the REQUEST, derives the subject.
-- ---------------------------------------------------------------------------

create or replace function public.start_erasure_for_request(p_request_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_req public.data_subject_requests%rowtype;
  v_id  uuid;
begin
  if not (select private.has_platform_permission('oversee_data_subject_requests')) then
    raise exception 'start_erasure_for_request: only the platform operator may run an erasure'
      using errcode = '42501', hint = 'not_the_operator';
  end if;

  select * into v_req from public.data_subject_requests d where d.id = p_request_id;
  if not found then
    raise exception 'start_erasure_for_request: no such request'
      using errcode = '22023', hint = 'unknown_request';
  end if;
  if v_req.subject_scope <> 'account' or v_req.right_type <> 'erasure' then
    raise exception 'start_erasure_for_request: that request does not ask for an account to be erased'
      using errcode = '22023', hint = 'not_an_erasure_request';
  end if;
  if v_req.status not in ('open', 'in_progress') then
    raise exception 'start_erasure_for_request: that request is already closed'
      using errcode = '22023', hint = 'request_is_closed';
  end if;

  -- The trigger re-checks every one of the conditions above from the row
  -- itself; this is the same check made early so the operator gets a sentence
  -- rather than a constraint.
  insert into public.erasure_jobs (kind, subject_user_id)
  values ('account', v_req.user_id)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.start_erasure_for_request(uuid) is
  'The operator runs the erasure a statutory request asked for. It takes the REQUEST''s id and derives the subject from the row -- there is no way to name a user directly -- and refuses anything but an open, account-scope `erasure` request (22023) and anyone but the aal2 operator (42501, hint not_the_operator). The insert trigger re-checks every condition independently, so this function''s checks are for the sentence and not for the safety. Since 20260930004000 the fulfilment seam requires a job to have RUN before such a request can be marked fulfilled, which is precisely why this exists.';

revoke all on function public.start_erasure_for_request(uuid) from public, anon, service_role;
grant execute on function public.start_erasure_for_request(uuid) to authenticated;
