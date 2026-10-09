-- ===========================================================================
-- PHASE 8 TASK 4 -- EXPORT, PART 2: THE JOB REGISTER, THE BUCKET AND THE
-- BUDGETS.
--
-- public.export_jobs is the whole of "async and bounded": a request writes a
-- row and returns; the work happens elsewhere; the row is the only thing that
-- says what happened. It is deliberately shaped like the register Task 3
-- built -- attribution stamped from the session at a BEFORE INSERT trigger
-- every writer passes, a state the client cannot write at all, and an outcome
-- written only from a session with no person on it.
--
-- ===========================================================================
-- WHO MAY DOWNLOAD: THE REQUESTER, AND NOBODY ELSE
-- ===========================================================================
-- The SELECT policy is `requested_by = auth.uid()`, for BOTH kinds. Not "any
-- Admin of that workspace": an archive is a snapshot taken under ONE person's
-- read rights at ONE moment (§ the requester_rls design in 20260927000000),
-- so handing it to a second Admin would hand them rows resolved against
-- somebody else's record scope -- including, for the Owner who ran it, rows a
-- record-scoped colleague cannot see. An Admin who wants a copy starts their
-- own job, under their own rights, and pays for it out of the same budget.
--
-- There is therefore NO cross-member read of this table at all, which also
-- means the row's existence is not an oracle: a second Admin cannot even see
-- that an export was taken. The AUDIT is where that is visible, which is the
-- surface designed for it.
--
-- ===========================================================================
-- WHAT IS AND IS NOT AUDITED, AND WHY THE GAP IS NOT AN OVERSIGHT
-- ===========================================================================
-- `export_job.requested` and `export_job.downloaded` are audited: both happen
-- in a person's session and private.log_audit_event() can attribute them.
-- COMPLETION AND FAILURE ARE NOT, and cannot be: they happen in a session
-- with no person on it, public.audit_events.actor_user_id is NOT NULL, and
-- there is no system actor in this product (the same wall Task 3 hit at its
-- fulfilment seam -- 20260925000000 § 6 -- and answered the same way). The
-- job row itself carries status, timestamps, byte and row counts and a
-- failure reason, and it is the record.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. A SECOND BUDGET, BECAUSE AN ACCOUNT EXPORT HAS NO WORKSPACE.
--
--    `exports` already exists (5/hour per ORGANISATION, seeded 20260909020000
--    from SECURITY.md § 5) and is the workspace export's budget -- its
--    description said "mechanism only, no endpoint exists yet", which this
--    task makes false, so the seeded row's description is corrected here.
--
--    An ACCOUNT export is nobody's workspace: the person may hold five
--    memberships or none, and metering it against one of them would be the
--    caller-supplied attribution Phase 7 finding I1 closed. So a second,
--    user-scoped category with the same number, which is also the number the
--    two sibling per-user write budgets already use (feedback, consent
--    grants). A proposed number, like Q112 -- see Q164.
-- ---------------------------------------------------------------------------

insert into public.rate_limit_policies (category, subject_scope, max_requests, window_seconds, description) values
  ('account_export', 'user', 5, 3600,
   'ACCOUNT data exports started per user (Phase 8 Task 4). Enforced at the insert by private.export_jobs_before_insert(), never in the app -- two meters on one click would halve the limit. The sibling of `exports`, which is the WORKSPACE export''s budget and is organisation-scoped; an account export belongs to no workspace, so metering it against one would be a caller-supplied attribution.')
on conflict (category) do nothing;

update public.rate_limit_policies
   set description = 'Data exports per organisation. The WORKSPACE export''s budget (Phase 8 Task 4 is the consumer): enforced at the insert by private.export_jobs_before_insert(). An ACCOUNT export is metered under `account_export` instead, because it belongs to no workspace.'
 where category = 'exports';


-- ---------------------------------------------------------------------------
-- 2. THE REGISTER.
-- ---------------------------------------------------------------------------

create table public.export_jobs (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,

  -- Q132's two controllers. `account` carries no organisation; `workspace`
  -- must carry one, and the CHECK is an equivalence rather than two
  -- implications so neither shape can drift.
  kind            text not null,
  organisation_id uuid references public.organisations (id) on delete cascade,

  -- NEVER CALLER-SUPPLIED: outside the client INSERT grant (§ 5) and stamped
  -- from auth.uid() by the BEFORE INSERT trigger.
  requested_by    uuid not null references auth.users (id) on delete cascade,

  -- THE ASSURANCE LEVEL THE REQUEST WAS MADE AT, stamped from the session's
  -- own `aal` claim and outside the client INSERT grant. The runner replays
  -- the requester's claims to read under their RLS (20260927002000), and
  -- replaying a FIXED 'aal2' would have been a quiet widening: the platform
  -- superuser's own reads are gated on aal2, so a job that always claimed it
  -- would give an account export more than the session that asked for it had.
  -- This column is what makes the replay a replay.
  requested_aal   text not null default 'aal1',

  status          text not null default 'queued',
  requested_at    timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  -- completed_at + private.export_limits().archive_days, stamped by the
  -- database. The download path compares against now() at READ TIME -- the
  -- house pattern -- and Task 6 purges the bytes.
  expires_at      timestamptz,

  storage_key     text,
  byte_size       bigint,
  row_count       bigint,
  table_count     integer,
  -- What was withheld and why, the row counts per table, the schema version
  -- and the generated-at instant. The same object the archive's
  -- manifest.json carries, kept here so the register can answer without
  -- opening the archive.
  manifest        jsonb,
  failure_reason  text,

  constraint export_jobs_kind_check
    check (kind in ('account', 'workspace')),
  constraint export_jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint export_jobs_requested_aal_check
    check (requested_aal in ('aal1', 'aal2')),
  -- The equivalence: exactly the workspace kind carries an organisation.
  constraint export_jobs_scope_pair
    check ((kind = 'workspace') = (organisation_id is not null)),
  -- The key carries no user input and is derived from the row's own id, the
  -- documents pipeline's rule (lib/crm/storage-keys.ts) expressed as a CHECK
  -- so a raw writer cannot invent one either.
  constraint export_jobs_storage_key_shape
    check (storage_key is null or storage_key = 'exports/' || id::text || '.zip'),
  -- A succeeded job has an archive and a clock; a failed one has a reason.
  constraint export_jobs_outcome_shape
    check (
      (status <> 'succeeded' or (storage_key is not null and byte_size is not null
                                 and row_count is not null and completed_at is not null
                                 and expires_at is not null and manifest is not null))
      and (status <> 'failed' or (failure_reason is not null
                                  and pg_catalog.btrim(failure_reason) <> ''
                                  and completed_at is not null))
      and (status not in ('queued', 'running') or (storage_key is null and completed_at is null))
    ),
  constraint export_jobs_failure_reason_length
    check (failure_reason is null or pg_catalog.length(failure_reason) <= 2000)
);

comment on table public.export_jobs is
  'One row per data export (Phase 8 Task 4), of the TWO kinds Q132 makes necessary: `account` (GetSetPaid is the controller -- the person''s own account data) and `workspace` (the customer is the controller and we are the processor -- every tenant-owned table of one organisation). Attribution is stamped from the session by private.export_jobs_before_insert() and is outside the client INSERT grant. The client holds NO update or delete privilege at all: the state and the outcome are written only from a session with no person on it, the Task 3 seam''s rule. The SELECT policy is the requester''s own rows for both kinds -- not "any Admin of that workspace" -- because an archive is a snapshot taken under ONE person''s read rights.';

comment on column public.export_jobs.kind is
  'account | workspace -- Q132''s two controllers. The scope_pair CHECK makes exactly the workspace kind carry an organisation_id.';
comment on column public.export_jobs.requested_by is
  'Stamped from auth.uid() by the BEFORE INSERT trigger and outside the client INSERT grant, so it cannot be forged by a raw PostgREST writer. ON DELETE CASCADE: an archive of an erased person''s data must not outlive them -- Task 5 deletes the account and this row and its bytes go with it (the bytes through Task 6''s orphan sweep, which this task leaves as a named seam).';
comment on column public.export_jobs.requested_aal is
  'The assurance level of the session that asked, stamped from its own `aal` claim by the BEFORE INSERT trigger and outside the client INSERT grant. The runner REPLAYS the requester''s claims to read under their own RLS, and a replay that always claimed aal2 would be a quiet widening -- the platform superuser''s reads are gated on aal2, and an MFA-required role''s permissions are too. This column is what makes the replay a replay rather than a promotion.';

comment on column public.export_jobs.expires_at is
  'completed_at + private.export_limits().archive_days, stamped by the database. READ-TIME expiry, the house pattern: nothing sweeps it and the download path refuses a job past it. The BYTES are purged by Task 6 (the retention/GC job); until it lands an expired archive is unreachable but still stored, which is stated rather than implied.';
comment on column public.export_jobs.manifest is
  'The archive''s manifest.json: schema version, generated-at, per-table row counts, and what was WITHHELD and why (a quarantined or still-scanning document''s bytes; audit_events.before/after; a table excused by private.export_catalogue()). Kept on the row as well as in the zip so the register can answer without opening the archive.';
comment on column public.export_jobs.failure_reason is
  'Why a job FAILED, in words. A job that would exceed a ceiling in private.export_limits() fails with one of these; it never truncates silently, because a truncated statutory access response is a wrong answer given with confidence.';

create index export_jobs_requested_by_idx on public.export_jobs (requested_by, requested_at desc);
create index export_jobs_organisation_id_idx on public.export_jobs (organisation_id);
create index export_jobs_queued_idx on public.export_jobs (requested_at) where status = 'queued';

-- ONE LIVE JOB PER SUBJECT. Partial unique indexes rather than a trigger
-- check: a racing pair of inserts is refused by the index at commit, where a
-- `not exists` read would let both through.
create unique index export_jobs_one_live_account_job
  on public.export_jobs (requested_by)
  where kind = 'account' and status in ('queued', 'running');

create unique index export_jobs_one_live_workspace_job
  on public.export_jobs (organisation_id)
  where kind = 'workspace' and status in ('queued', 'running');

comment on index public.export_jobs_one_live_workspace_job is
  'One live WORKSPACE export per organisation, not per member: the expensive thing is the read of every tenant table, and two Admins pressing at once should queue rather than double it. The account twin is per requester.';


-- ---------------------------------------------------------------------------
-- 3. THE BUCKET. Private, fenced deny-all for every client role, the
--    documents pipeline's shape (20260902030000) and the feedback bucket's
--    (20260911000000).
--
--    50 MiB ceiling, above private.export_limits().max_archive_bytes (40 MiB)
--    so a job that is too big fails with ITS OWN recorded reason rather than
--    with a storage refusal nobody can read.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exports', 'exports', false, 52428800, array['application/zip'])
on conflict (id) do nothing;

create policy "exports_deny_client_select"
  on storage.objects as restrictive for select to authenticated, anon
  using (bucket_id <> 'exports');

create policy "exports_deny_client_insert"
  on storage.objects as restrictive for insert to authenticated, anon
  with check (bucket_id <> 'exports');

create policy "exports_deny_client_update"
  on storage.objects as restrictive for update to authenticated, anon
  using (bucket_id <> 'exports')
  with check (bucket_id <> 'exports');

create policy "exports_deny_client_delete"
  on storage.objects as restrictive for delete to authenticated, anon
  using (bucket_id <> 'exports');


-- ---------------------------------------------------------------------------
-- 4. BEFORE INSERT -- attribution, authorisation and the meter, at the one
--    chokepoint every writer passes.
-- ---------------------------------------------------------------------------

create or replace function private.export_jobs_before_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_category text;
  v_scope    text;
  v_subject  uuid;
  v_policy   public.rate_limit_policies%rowtype;
  v_window   timestamptz;
  v_count    integer;
  v_after    integer;
  v_retry    integer;
begin
  -- (1) WHO. An export is the requester's own act: no session, no job. The
  -- register's whole download authorisation rests on requested_by, so a
  -- sessionless writer would be a row nobody owns and everybody's 404.
  if v_uid is null then
    raise exception 'export_jobs: an export can only be started from the requester''s own session'
      using errcode = '42501', hint = 'export_needs_a_session';
  end if;
  new.requested_by := v_uid;
  -- The session's OWN assurance level, not a constant. See the column comment.
  new.requested_aal := case
    when coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2' then 'aal2' else 'aal1' end;

  if new.kind is null or new.kind not in ('account', 'workspace') then
    raise exception 'export_jobs: kind must be account or workspace'
      using errcode = '22023', hint = 'unknown_export_kind';
  end if;

  -- (2) MAY THEY. An account export needs nothing but the session -- it is
  -- the person's own data and the statutory route must not be the only route
  -- (the brief's requirement 5). A WORKSPACE export needs the key, and the
  -- key is checked through private.permitted_organisations(), which is the
  -- same function every policy in the schema uses: active membership, the
  -- role's MFA requirement, and the suspension rule (export_organisation_data
  -- is survives_suspension = true, deliberately).
  if new.kind = 'account' then
    new.organisation_id := null;
  else
    if new.organisation_id is null then
      raise exception 'export_jobs: a workspace export must name the workspace'
        using errcode = '22023', hint = 'export_needs_a_workspace';
    end if;
    if new.organisation_id not in (
         select o from private.permitted_organisations('export_organisation_data') o) then
      raise exception 'export_jobs: you cannot export that workspace'
        using errcode = '42501', hint = 'export_not_permitted';
    end if;
  end if;

  -- (3) THE STATE AND THE CLOCK ARE THE DATABASE'S. Everything a job's own
  -- outcome would write is nulled here, so an insert cannot arrive already
  -- claiming to have succeeded.
  new.status         := 'queued';
  new.requested_at   := pg_catalog.now();
  new.started_at     := null;
  new.completed_at   := null;
  new.expires_at     := null;
  new.storage_key    := null;
  new.byte_size      := null;
  new.row_count      := null;
  new.table_count    := null;
  new.manifest       := null;
  new.failure_reason := null;

  -- (4) THE METER -- after every refusal above, so a malformed or
  -- unauthorised post spends nothing. The consent ledger's and the data
  -- subject register's shape, and enforced HERE rather than in the server
  -- action because public.export_jobs carries a client INSERT grant: a
  -- scripted POST straight to PostgREST is a real path, and two meters on one
  -- click would halve the shipped limit.
  if new.kind = 'account' then
    v_category := 'account_export';
    v_scope    := 'user';
    v_subject  := v_uid;
  else
    v_category := 'exports';
    v_scope    := 'organisation';
    v_subject  := new.organisation_id;
  end if;

  select * into v_policy from public.rate_limit_policies p where p.category = v_category;
  if not found then
    raise exception 'export_jobs: no rate-limit policy for %', v_category using errcode = '22023';
  end if;

  v_window := private.rate_limit_window_start(pg_catalog.now(), v_policy.window_seconds);
  v_retry  := greatest(0, pg_catalog.ceil(extract(epoch from
                (v_window + pg_catalog.make_interval(secs => v_policy.window_seconds)
                  - pg_catalog.now())))::integer);

  select c.request_count into v_count
    from public.rate_limit_counters c
   where c.category      = v_category
     and c.subject_scope = v_scope
     and c.subject_id    = v_subject
     and c.window_start  = v_window;
  v_count := coalesce(v_count, 0);

  if v_count >= v_policy.max_requests then
    raise exception 'export_jobs: too many exports (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  select r.request_count into v_after
    from private.record_rate_limit_event(
           v_category, v_scope, v_subject,
           case when v_scope = 'organisation' then v_subject end) r;

  if v_after > v_policy.max_requests then
    raise exception 'export_jobs: too many exports (% per % seconds)',
      v_policy.max_requests, v_policy.window_seconds
      using errcode = 'PT429', hint = v_retry::text;
  end if;

  return new;
end;
$$;

comment on function private.export_jobs_before_insert() is
  'BEFORE INSERT on public.export_jobs, for EVERY writer. Refuses a sessionless insert (42501 export_needs_a_session); stamps requested_by from auth.uid(); refuses an unknown kind; nulls the organisation on an account export and requires export_organisation_data on a workspace one, through private.permitted_organisations() -- the same function every policy uses, so membership, the role''s MFA requirement and the suspension rule are all the schema''s answers rather than this function''s; nulls every outcome column so an insert cannot arrive claiming success; and METERS the job (PT429, seconds in `hint`) under `exports` for a workspace and `account_export` for an account. The meter is here and not in the server action because the table carries a client INSERT grant, so a raw PostgREST POST is a real submission path and two meters would halve the limit.';

revoke all on function private.export_jobs_before_insert() from public, anon, authenticated, service_role;

create trigger export_jobs_before_insert
  before insert on public.export_jobs
  for each row execute function private.export_jobs_before_insert();


-- ---------------------------------------------------------------------------
-- 5. BEFORE UPDATE -- the outcome is the job's, never a person's.
--
--    The same session test as the data subject register's fulfilment seam
--    (20260925000000 § 5), for the same reason and with its own hint so a
--    test can tell this refusal from a missing grant's 42501: SECURITY
--    DEFINER changes the current USER and touches neither the JWT claims nor
--    the `role` SETTING, so both still describe whoever issued the statement.
-- ---------------------------------------------------------------------------

create or replace function private.export_jobs_before_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_session_role   text := coalesce(pg_catalog.current_setting('role', true), '');
  v_client_session boolean;
  v_days           integer;
begin
  v_client_session := v_uid is not null or v_session_role in ('authenticated', 'anon');

  if v_client_session then
    raise exception 'export_jobs: a job''s progress is written by the export runner, never from a person''s session'
      using errcode = '42501', hint = 'export_outcome_is_server_only';
  end if;

  -- THE REQUEST ITSELF IS IMMUTABLE. Who asked, which kind, which workspace
  -- and when: the archive's provenance, and nothing may rewrite it.
  if new.id is distinct from old.id
     or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind
     or new.organisation_id is distinct from old.organisation_id
     or new.requested_by is distinct from old.requested_by
     or new.requested_aal is distinct from old.requested_aal
     or new.requested_at is distinct from old.requested_at then
    raise exception 'export_jobs: the request itself is immutable -- only its progress and its outcome may change'
      using errcode = '42501', hint = 'export_request_is_immutable';
  end if;

  -- A CLOSED JOB IS IMMUTABLE. A succeeded archive cannot be re-pointed at
  -- another key, and a failure cannot be quietly turned into a success.
  if old.status in ('succeeded', 'failed') then
    raise exception 'export_jobs: a finished job is not rewritten'
      using errcode = '22023', hint = 'export_job_is_finished';
  end if;

  if not (   (old.status = 'queued'  and new.status in ('running', 'failed'))
          or (old.status = 'running' and new.status in ('succeeded', 'failed'))) then
    raise exception 'export_jobs: a job cannot go from % to %', old.status, new.status
      using errcode = '22023', hint = 'illegal_export_transition';
  end if;

  -- THE STAMPS ARE THE DATABASE'S, so a finished job's times say when it
  -- finished rather than what a runner claimed.
  if new.status = 'running' then
    new.started_at := pg_catalog.now();
  else
    new.started_at := old.started_at;
  end if;

  if new.status in ('succeeded', 'failed') then
    new.completed_at := pg_catalog.now();
  end if;

  if new.status = 'succeeded' then
    select l.archive_days into v_days from private.export_limits() l;
    new.expires_at := pg_catalog.now() + pg_catalog.make_interval(days => v_days);
    new.failure_reason := null;
  else
    new.expires_at := null;
  end if;

  return new;
end;
$$;

comment on function private.export_jobs_before_update() is
  'BEFORE UPDATE on public.export_jobs, for EVERY writer. Refuses ANY write from a session with a person on it -- auth.uid() not null, or the session role setting authenticated/anon, neither of which SECURITY DEFINER changes (42501, hint export_outcome_is_server_only, its own hint so a test can tell it from a missing grant). Refuses a change to the request itself (export_request_is_immutable), a write to a finished job (export_job_is_finished) and a transition that is not queued->running->succeeded/failed (illegal_export_transition). Stamps started_at, completed_at and expires_at (completed_at + private.export_limits().archive_days) from the database clock.';

revoke all on function private.export_jobs_before_update() from public, anon, authenticated, service_role;

create trigger export_jobs_before_update
  before update on public.export_jobs
  for each row execute function private.export_jobs_before_update();


-- ---------------------------------------------------------------------------
-- 6. THE AUDIT of the one event that HAS a person on it.
--
--    Completion and failure are not audited and cannot be: they happen
--    sessionless and private.log_audit_event() refuses an unattributable row
--    (28000 -- audit_events.actor_user_id is NOT NULL and there is no system
--    actor). The job row is the record of those. `export_job.downloaded` is
--    written by the download path, which does have a session.
-- ---------------------------------------------------------------------------

create or replace function private.audit_export_job_requested()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.log_audit_event(
    p_action          => 'export_job.requested',
    p_target_type     => 'export_job',
    p_organisation_id => new.organisation_id,
    p_target_id       => new.id,
    p_after           => pg_catalog.jsonb_build_object('kind', new.kind));
  return null;
end;
$$;

comment on function private.audit_export_job_requested() is
  'AFTER INSERT on public.export_jobs: one identifier-only audit row. The payload is the export KIND and nothing else -- an export names no record and holds no user text, so there is nothing further that could be logged without logging tenant content onto a superuser-readable surface (SECURITY.md section 7).';

revoke all on function private.audit_export_job_requested() from public, anon, authenticated, service_role;

create trigger export_jobs_after_insert_audit
  after insert on public.export_jobs
  for each row execute function private.audit_export_job_requested();


-- ---------------------------------------------------------------------------
-- 7. RLS AND GRANTS.
--
--    authenticated: SELECT its own rows, INSERT the two columns a request
--    consists of, and NOTHING ELSE -- no update, no delete, at any column.
--    service_role: SELECT, and UPDATE on exactly the columns the runner
--    writes. The narrow grant is the incident_alerts precedent
--    (20260909070000, `update (notified_at)` and nothing else).
-- ---------------------------------------------------------------------------

alter table public.export_jobs enable row level security;

create policy "export_jobs_select_own"
  on public.export_jobs for select to authenticated
  using (requested_by = (select auth.uid()));

comment on policy "export_jobs_select_own" on public.export_jobs is
  'The requester''s own jobs, for BOTH kinds. Deliberately not "any Admin of that workspace": an archive is a snapshot taken under ONE person''s read rights at ONE moment, so a second Admin reading it would be reading rows resolved against somebody else''s record scope. They start their own job instead. A consequence worth stating: no member can see that a colleague exported the workspace -- the audit log is the surface designed for that.';

create policy "export_jobs_insert_own"
  on public.export_jobs for insert to authenticated
  with check (
    kind = 'account'
    or organisation_id in (select o from private.permitted_organisations('export_organisation_data') o)
  );

comment on policy "export_jobs_insert_own" on public.export_jobs is
  'The policy and private.export_jobs_before_insert() say the same thing on purpose: the policy is the one a raw PostgREST POST meets first, and the trigger is the one a future SECURITY DEFINER caller would still meet. Task 3''s measurement -- that the INSERT POLICY and not the grant is the gate -- is why both exist.';

grant select on public.export_jobs to authenticated;
grant insert (kind, organisation_id) on public.export_jobs to authenticated;

grant select on public.export_jobs to service_role;
grant update (status, started_at, completed_at, expires_at, storage_key,
              byte_size, row_count, table_count, manifest, failure_reason)
  on public.export_jobs to service_role;
