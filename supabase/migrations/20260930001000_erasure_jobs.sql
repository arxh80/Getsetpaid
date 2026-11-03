-- ===========================================================================
-- PHASE 8 TASK 5 -- ERASURE, PART 2: THE REGISTER.
--
-- public.erasure_jobs is public.export_jobs' sibling and is deliberately
-- shaped like it: a person (or, for a workspace, the platform) asks; the row
-- is the ask; a sessionless runner claims it, does the work in ONE
-- transaction, and writes the outcome back; no client session may ever write
-- a job's progress.
--
-- ===========================================================================
-- THE ONE PLACE IT IS NOT LIKE export_jobs, AND WHY
-- ===========================================================================
-- `export_jobs.requested_by` is ON DELETE CASCADE. An erasure register cannot
-- be: the job's whole purpose is to delete the `auth.users` row it points at,
-- and a cascade would delete the record of the erasure AS PART OF the erasure.
-- The evidence that a statutory deletion was performed would be destroyed by
-- performing it. So BOTH user columns and the organisation column are
-- ON DELETE SET NULL, and a completed account erasure leaves a row that says
-- WHAT was erased -- in counts, never in content -- and no longer says WHO.
-- That is the same pseudonymisation the tombstone gives the audit log, reached
-- by the foreign key rather than by a rewrite.
--
-- Which means the register is ALSO how the data subject request seam survives:
-- `data_subject_requests.fulfilment_reference` holds this job's id, the job id
-- is not a person's identifier, and both rows outlive the account.
--
-- ===========================================================================
-- WHAT A SUMMARY MAY SAY
-- ===========================================================================
-- `summary` is counts. Table name -> number of rows. No values, no names, no
-- email addresses, no note bodies -- an erasure record that quoted what it
-- erased would be a copy of the thing the person asked to be rid of, kept for
-- ever in the one table nobody can delete. A CHECK enforces the shape (a flat
-- object of non-negative integers plus a small closed set of booleans), so
-- "counts, never content" is a rule of the schema rather than a habit of the
-- runner.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE METER. Three account erasures per day per person.
--
--    An erasure is nearly always a once-ever act, so the budget is not there
--    to stop a legitimate user: it is there because every REFUSED attempt --
--    the last-owner guard, a workspace that will not purge -- is a cheap way
--    to make the runner do real work, and because the insert carries a client
--    grant and is therefore reachable by a scripted POST.
-- ---------------------------------------------------------------------------

insert into public.rate_limit_policies
  (category, subject_scope, max_requests, window_seconds, description)
values
  ('account_erasure', 'user', 3, 86400,
   'Account erasure jobs started per user per 24 hours (Phase 8 Task 5). Enforced at the insert by private.erasure_jobs_before_insert(), never in the app -- public.erasure_jobs carries a client INSERT grant, so the meter lives where every writer passes. Three rather than one because a refusal (the Q131 last-owner guard) must leave the person able to fix the problem and try again the same day.')
on conflict (category) do nothing;


-- ---------------------------------------------------------------------------
-- 2. COUNTS, NEVER CONTENT -- as a function, because a CHECK constraint may
--    not contain a subquery and the rule is a walk over the object's values.
-- ---------------------------------------------------------------------------

create or replace function private.jsonb_is_count_map(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1 from pg_catalog.jsonb_each(p_value) e
        where not (
             (pg_catalog.jsonb_typeof(e.value) = 'number'
              and (e.value)::text ~ '^[0-9]+$')
          or (pg_catalog.jsonb_typeof(e.value) = 'boolean'
              and e.key in ('already_erased', 'bytes_purged', 'workspace_purged'))
        ))
$$;

comment on function private.jsonb_is_count_map(jsonb) is
  'True when a jsonb value is a FLAT object of non-negative integers, plus the three boolean flags public.erasure_jobs.summary is allowed to carry. It is a function rather than an inline CHECK because a CHECK may not contain a subquery, and the rule is a walk over every value. It is what makes "counts, never content" a rule of the schema: an erasure summary outlives the person and nothing may delete it, so a string quoted there would be a permanent copy of what they asked to be rid of.';

revoke all on function private.jsonb_is_count_map(jsonb) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. THE TABLE.
-- ---------------------------------------------------------------------------

create table public.erasure_jobs (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  kind             text not null check (kind in ('account', 'workspace')),

  -- SET NULL, not CASCADE. See the header: the cascade would delete the
  -- evidence of the erasure as part of the erasure.
  subject_user_id  uuid references auth.users(id) on delete set null,
  organisation_id  uuid references public.organisations(id) on delete set null,
  requested_by     uuid references auth.users(id) on delete set null,

  requested_aal    text not null default 'aal1' check (requested_aal in ('aal1', 'aal2')),
  status           text not null default 'queued'
                     check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_at     timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  failure_reason   text,
  summary          jsonb,

  constraint erasure_jobs_failure_reason_length
    check (failure_reason is null or length(failure_reason) <= 2000),

  -- The same outcome shape export_jobs carries: a succeeded job has a summary
  -- and a completion time, a failed one has a reason, and neither of the two
  -- open states has any of it.
  constraint erasure_jobs_outcome_shape check (
        (status <> 'succeeded' or (summary is not null and completed_at is not null))
    and (status <> 'failed'    or (failure_reason is not null
                                   and btrim(failure_reason) <> ''
                                   and completed_at is not null))
    and (status in ('succeeded', 'failed') or (summary is null and completed_at is null))
  ),

  -- COUNTS, NEVER CONTENT. A flat object whose values are non-negative
  -- integers, except for a closed set of boolean flags the runner records.
  -- Anything else -- a string, an array, a nested object -- is refused, which
  -- is what stops a well-meaning later change from putting an email address
  -- or a note body in the one table nothing may delete. (A CHECK may not hold
  -- a subquery, so the walk lives in the IMMUTABLE function above.)
  constraint erasure_jobs_summary_is_counts
    check (summary is null or private.jsonb_is_count_map(summary))
);

-- One live job per subject, the export register's rule: a second erasure of
-- the same account while the first is in flight is a double delete, and a
-- second purge of the same workspace is a doomed one.
create unique index erasure_jobs_one_live_account_job
  on public.erasure_jobs (subject_user_id)
  where kind = 'account' and status in ('queued', 'running');

create unique index erasure_jobs_one_live_workspace_job
  on public.erasure_jobs (organisation_id)
  where kind = 'workspace' and status in ('queued', 'running');

create index erasure_jobs_queued_idx on public.erasure_jobs (requested_at)
  where status = 'queued';
create index erasure_jobs_subject_idx on public.erasure_jobs (subject_user_id, requested_at desc);
create index erasure_jobs_requested_by_idx on public.erasure_jobs (requested_by, requested_at desc);
create index erasure_jobs_organisation_id_idx on public.erasure_jobs (organisation_id);

comment on table public.erasure_jobs is
  'The erasure register (Phase 8 Task 5), public.export_jobs'' sibling. One row per account erasure or workspace purge: who asked, when, what happened, in COUNTS. Its three user/organisation references are ON DELETE SET NULL rather than CASCADE -- the export register''s cascade would, here, delete the evidence of the erasure as part of performing it -- so a completed account erasure leaves a row that says what was erased and no longer says whose it was. That is the same pseudonymisation the Q130 tombstone gives the audit log, reached through the foreign key instead of a rewrite, and it is what lets public.data_subject_requests.fulfilment_reference still point at something after the account is gone.';

comment on column public.erasure_jobs.subject_user_id is
  'Whose account this erases -- NULL once it has, by the foreign key''s own ON DELETE SET NULL. A job whose subject_user_id is null and whose status is `succeeded` is a completed erasure; that is the only pair of facts about the person the register keeps.';
comment on column public.erasure_jobs.summary is
  'COUNTS, NEVER CONTENT: table name -> rows affected, plus the closed set of boolean flags in erasure_jobs_summary_is_counts. The CHECK is the rule, not the runner''s good manners: this row outlives the person and nothing may delete it, so a value quoted here would be a permanent copy of the thing they asked to be rid of.';
comment on column public.erasure_jobs.failure_reason is
  'Why the whole transaction rolled back. An erasure is all-or-nothing: there is no partial outcome to describe, so this says which step refused and with which hint -- never a row value.';


-- ---------------------------------------------------------------------------
-- 4. WRITING A JOB: ATTRIBUTION, THE KIND'S OWN RULES, THE METER.
-- ---------------------------------------------------------------------------

create or replace function private.erasure_jobs_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_role     text := coalesce(pg_catalog.current_setting('role', true), '');
  v_policy   public.rate_limit_policies%rowtype;
  v_window   timestamptz;
  v_count    integer;
  v_after    integer;
  v_retry    integer;
begin
  if new.kind is null or new.kind not in ('account', 'workspace') then
    raise exception 'erasure_jobs: kind must be account or workspace'
      using errcode = '22023', hint = 'unknown_erasure_kind';
  end if;

  if new.kind = 'account' then
    -- (1) WHO. An account erasure is the person's own act. ATTRIBUTION IS NOT
    -- THE CALLER'S TO SUPPLY: whatever the insert named, the subject and the
    -- requester are the session's. Erasing somebody else's account by naming
    -- their id is the single worst thing this table could be made to do.
    if v_uid is null then
      raise exception 'erasure_jobs: an account erasure can only be started from the account''s own session'
        using errcode = '42501', hint = 'erasure_needs_a_session';
    end if;
    if v_uid = private.erased_user_id() then
      raise exception 'erasure_jobs: the tombstone is not a person and cannot be erased'
        using errcode = '42501', hint = 'tombstone_is_nobody';
    end if;
    new.subject_user_id := v_uid;
    new.requested_by    := v_uid;
    new.organisation_id := null;
    new.requested_aal   := case
      when coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2' then 'aal2' else 'aal1' end;

    -- (2) THE Q131 LAST-OWNER GUARD, ASKED AT THE INSERT so the refusal
    -- arrives while the person is still on the page and can act on it. It is
    -- asked AGAIN inside the erasure itself -- this one is a courtesy, that
    -- one is the enforcement, because a workspace can lose its other Owner
    -- between the two.
    perform private.assert_account_is_erasable(v_uid);
  else
    -- (3) A WORKSPACE PURGE IS THE PLATFORM'S, NEVER A CLIENT'S. The INSERT
    -- policy below admits only `account` from `authenticated`, and this is the
    -- second lock: an open list of SERVER roles, so a client role added by a
    -- later phase arrives refused rather than admitted by omission.
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

  -- (4) THE STATE AND THE CLOCK ARE THE DATABASE'S.
  new.status         := 'queued';
  new.requested_at   := pg_catalog.now();
  new.started_at     := null;
  new.completed_at   := null;
  new.summary        := null;
  new.failure_reason := null;

  -- (5) THE METER, after every refusal above so a malformed or unauthorised
  -- post spends nothing. Only the account kind is metered: a workspace purge
  -- comes from the one scheduled job, which is its own budget.
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
  'BEFORE INSERT on public.erasure_jobs, for EVERY writer including a direct PostgREST POST. Attribution is the session''s and never the caller''s (erasing somebody else by naming their id is the worst thing this table could be made to do); the Q131 last-owner guard is asked here as a courtesy so the refusal reaches the person on the page, and again inside the erasure as the enforcement; a `workspace` job is refused from any session with a person on it (42501, hint purge_is_server_only); the status and every clock are the database''s; and the account_erasure meter is spent last, after every refusal, so an unauthorised post costs nothing.';


-- ---------------------------------------------------------------------------
-- 5. A JOB'S PROGRESS IS THE RUNNER'S, NEVER A PERSON'S.
-- ---------------------------------------------------------------------------

create or replace function private.erasure_jobs_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_role           text := coalesce(pg_catalog.current_setting('role', true), '');
  v_server_session boolean;
  v_fk_nulling     boolean;
begin
  v_server_session := v_uid is null and v_role in ('postgres', 'service_role', 'none', '');

  -- THE FOREIGN KEYS' OWN NULLING. `ON DELETE SET NULL` is an UPDATE of this
  -- row, issued by the referential-integrity trigger at depth >= 2 -- and the
  -- erasure it is part of deletes the very account whose session could never
  -- have been on it anyway. Admitted only when nothing else moves AND the
  -- parent really is gone: the consent ledger's rule (20260923002000) and the
  -- data subject register's (20260925000000 § 5, clause 1a) -- prove the
  -- parent is absent rather than trust that "a trigger issued this".
  v_fk_nulling :=
       pg_catalog.pg_trigger_depth() >= 2
   and new.status is not distinct from old.status
   and new.summary is not distinct from old.summary
   and new.failure_reason is not distinct from old.failure_reason
   and new.started_at is not distinct from old.started_at
   and new.completed_at is not distinct from old.completed_at
   and (   (new.subject_user_id is null and old.subject_user_id is not null
            and not exists (select 1 from auth.users u where u.id = old.subject_user_id))
        or (new.requested_by is null and old.requested_by is not null
            and not exists (select 1 from auth.users u where u.id = old.requested_by))
        or (new.organisation_id is null and old.organisation_id is not null
            and not exists (select 1 from public.organisations o where o.id = old.organisation_id)));

  if v_fk_nulling then
    return new;
  end if;

  if not v_server_session then
    raise exception 'erasure_jobs: a job''s progress is written by the erasure runner, never from a person''s session'
      using errcode = '42501', hint = 'erasure_outcome_is_server_only';
  end if;

  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind
     or new.requested_aal is distinct from old.requested_aal
     or new.requested_at is distinct from old.requested_at then
    raise exception 'erasure_jobs: the request itself is immutable -- only its progress and its outcome may change'
      using errcode = '42501', hint = 'erasure_request_is_immutable';
  end if;

  -- The subject columns move in ONE direction and only by the foreign key,
  -- handled above. A runner may not re-point a job at somebody else.
  if (new.subject_user_id is distinct from old.subject_user_id)
     or (new.organisation_id is distinct from old.organisation_id)
     or (new.requested_by is distinct from old.requested_by) then
    raise exception 'erasure_jobs: a job cannot be re-pointed at another subject'
      using errcode = '42501', hint = 'erasure_subject_is_immutable';
  end if;

  if old.status in ('succeeded', 'failed') then
    raise exception 'erasure_jobs: a finished job is not rewritten'
      using errcode = '22023', hint = 'erasure_job_is_finished';
  end if;

  if not (   (old.status = 'queued'  and new.status in ('running', 'failed'))
          or (old.status = 'running' and new.status in ('succeeded', 'failed'))) then
    raise exception 'erasure_jobs: a job cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_erasure_transition';
  end if;

  if new.status = 'running' then
    new.started_at := pg_catalog.now();
  else
    new.started_at := old.started_at;
  end if;

  if new.status in ('succeeded', 'failed') then
    new.completed_at := pg_catalog.now();
  end if;

  if new.status = 'succeeded' then
    new.failure_reason := null;
  end if;

  return new;
end;
$$;

comment on function private.erasure_jobs_before_update() is
  'BEFORE UPDATE on public.erasure_jobs. A job''s progress is the sessionless runner''s: the admitted roles are an OPEN list of SERVER ones, so a client role a later phase adds arrives refused (42501, hint erasure_outcome_is_server_only). The request is immutable, a job may never be re-pointed at another subject (42501, erasure_subject_is_immutable), a finished job is never rewritten, the transition table is queued -> running -> succeeded|failed, and every stamp is the database''s. ONE exception is admitted at trigger depth >= 2 and nowhere else: the three foreign keys'' own ON DELETE SET NULL, each proved by the parent row being absent rather than by trusting that a trigger issued the update -- without it the erasure could not delete the account it is erasing.';


-- ---------------------------------------------------------------------------
-- 6. THE REQUEST IS AUDITED. The outcome gets its own summary row, written by
--    the erasure itself (20260930002000), because only it knows the counts.
-- ---------------------------------------------------------------------------

create or replace function private.audit_erasure_job_requested()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- A workspace purge is inserted from a sessionless job, and
  -- private.log_audit_event() requires auth.uid(). The tombstone is the actor
  -- for every sessionless platform write in this task, for the same reason it
  -- is the actor for the summary row: the alternative is no audit row at all.
  insert into public.audit_events
    (organisation_id, actor_user_id, action, target_type, target_id, correlation_id, after)
  values (
    new.organisation_id,
    coalesce((select auth.uid()), private.erased_user_id()),
    'erasure_job.requested',
    'erasure_job',
    new.id,
    coalesce(private.bulk_audit_correlation_id(), pg_catalog.gen_random_uuid()),
    pg_catalog.jsonb_build_object('kind', new.kind));
  return null;
end;
$$;

comment on function private.audit_erasure_job_requested() is
  'AFTER INSERT on public.erasure_jobs: the ask is audited the moment it is made, with the kind and nothing else. It writes the row directly rather than through private.log_audit_event() because that function requires auth.uid() and a workspace purge is started sessionless; the actor for a sessionless platform write is the Q130 tombstone, which is also who the summary row names once the account is gone.';

create trigger erasure_jobs_before_insert
  before insert on public.erasure_jobs
  for each row execute function private.erasure_jobs_before_insert();

create trigger erasure_jobs_before_update
  before update on public.erasure_jobs
  for each row execute function private.erasure_jobs_before_update();

create trigger erasure_jobs_after_insert_audit
  after insert on public.erasure_jobs
  for each row execute function private.audit_erasure_job_requested();


-- ---------------------------------------------------------------------------
-- 7. RLS, POLICIES AND GRANTS.
--
--    The export register's shape: SELECT your own, INSERT one column, no
--    UPDATE and no DELETE for any client role at all. Plus one thing the
--    export register does not have -- the platform operator's oversight read,
--    because an erasure request arrives through /super/data-requests and the
--    operator has to be able to see whether the job ran.
-- ---------------------------------------------------------------------------

alter table public.erasure_jobs enable row level security;
alter table public.erasure_jobs force row level security;

create policy erasure_jobs_select_own on public.erasure_jobs
  for select to authenticated
  using (
    subject_user_id = (select auth.uid())
    or requested_by = (select auth.uid())
    or (select private.has_platform_permission('oversee_data_subject_requests'))
  );

create policy erasure_jobs_insert_own on public.erasure_jobs
  for insert to authenticated
  with check (kind = 'account');

comment on policy erasure_jobs_select_own on public.erasure_jobs is
  'Your own erasure jobs, plus the aal2 platform operator''s oversight read (an erasure request is fulfilled from /super/data-requests and the operator must be able to see whether the job ran). Once an account erasure succeeds BOTH user columns are null, so the row stops being any client''s own and only the operator sees it -- which is the register keeping what happened and losing whose it was.';
comment on policy erasure_jobs_insert_own on public.erasure_jobs is
  'A client may ask for ONE thing: the erasure of an account, and the trigger makes that account the session''s own whatever the insert named. `workspace` is refused here and again in private.erasure_jobs_before_insert() -- a workspace purge is the platform''s.';

revoke all on public.erasure_jobs from anon, authenticated, service_role;
grant select on public.erasure_jobs to authenticated;
grant insert (kind) on public.erasure_jobs to authenticated;
-- The runner reads every queued job and writes each one's outcome. The five
-- outcome columns and nothing wider: a service_role that could move
-- subject_user_id could re-point a job at somebody else, and the trigger's
-- refusal should not be the only thing between it and that.
grant select on public.erasure_jobs to service_role;
grant update (status, started_at, completed_at, summary, failure_reason)
  on public.erasure_jobs to service_role;
grant insert (kind, organisation_id) on public.erasure_jobs to service_role;
