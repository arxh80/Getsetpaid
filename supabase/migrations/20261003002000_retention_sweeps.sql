-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 3: THE SWEEPS THAT DO NOT DESTROY
-- EVIDENCE.
--
-- The audit purge is part 4, on its own, with its own rails. Everything else
-- is here:
--
--   private.sweep_rate_limit_counters()   Q110
--   private.sweep_feedback()              Q120 (rows; the bytes are the
--                                         runner's, and this refuses a row
--                                         whose bytes are still there)
--   private.sweep_incident_alerts()       Q117
--   private.sweep_erasure_jobs()          Q175
--   private.reap_stuck_jobs()             Q166 -- NOT a deletion
--   private.sweep_document_bytes()        Q52
--   private.sweep_expired_workspaces()    Q88/Q92/Q102, by CALLING
--                                         private.erase_organisation()
--
-- and the thing that makes the storage half possible at all:
--
--   public.retention_object_manifest()    what the runner deletes from the
--                                         buckets, derived in the database
--
-- ===========================================================================
-- EVERY SWEEP HAS THE SAME SHAPE, AND THE SHAPE IS THE CONTRACT
-- ===========================================================================
--   private.sweep_x(p_dry boolean, p_limit integer) returns jsonb
--
--   * p_dry = true    COUNT what would go and delete nothing. Requirement 4:
--                     the founder must be able to see what a run would do.
--                     The count is taken from the SAME query the delete uses,
--                     so a dry run that reports 12 and a live run that deletes
--                     9 is a bug and not a rounding difference.
--   * p_limit         the per-run ceiling (requirement 2: bounded, so one run
--                     cannot lock the database for minutes). Rows are taken
--                     OLDEST FIRST, so a run that hits its ceiling leaves the
--                     NEWER remainder for the next run -- resumable, and in
--                     the right order. Skipping is what an unordered LIMIT
--                     does and it is the failure mode the brief names.
--   * returns         {"<table>.rows": n, "<table>.capped": true?} -- counts,
--                     never content, and `capped` says the ceiling was hit so
--                     the run log shows a backlog rather than a quiet number.
--
-- ===========================================================================
-- STORAGE IS THE HARD PART, AND THE SPLIT IS HANDLED IN BOTH DIRECTIONS
-- ===========================================================================
-- Row deletion is transactional; object deletion is not. So:
--
--   THE OBJECT IS DELETED AND THE ROW SURVIVES. This is the direction the
--   whole design leans, deliberately, because it errs towards "the data is
--   gone" rather than "the data is still there". Every row-side sweep is
--   therefore written to be able to finish the job on a LATER run: a document
--   whose bytes are already absent gets its bytes_purged_at stamped by the
--   next sweep, whether or not the run that deleted the object survived long
--   enough to stamp it.
--
--   THE ROW IS DELETED AND THE OBJECT SURVIVES. This is the direction that
--   leaves bytes nothing in the database names, and it is closed twice: the
--   feedback sweep REFUSES to delete a row whose screenshot is still in the
--   bucket (the erase_organisation() gate, same shape), and the manifest has
--   an ORPHAN half that finds objects with no row at all and hands them to
--   the runner anyway.
--
-- ADDITIVE. private.retention_periods() is reissued from its LATEST
-- definition with one class added (storage_orphan); no previously applied
-- migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. THE ELEVENTH CLASS, AND WHY THE ORPHAN SWEEP NEEDS ONE.
--
--    An object with no row is USUALLY rubbish. It is not always: an upload
--    writes the object and then the row, so for a fraction of a second every
--    healthy upload IS an orphan, and a sweep with no grace period would
--    occasionally delete a file somebody was in the middle of uploading. The
--    grace period is that window, made enormous.
-- ---------------------------------------------------------------------------

create or replace function private.retention_periods()
returns table (
  class      text,
  period     interval,
  applies_to text,
  clock_from text,
  authority  text)
language sql
immutable
set search_path = ''
as $$
  values
    ('financial',
     interval '7 years',
     'Financial records, and a document attached to an event that carries financial entries (private.document_retention_class()).',
     'the record''s deleted_at',
     'CLAUDE.md § Non-negotiable rules ("7 years for financial records"); Q133.'),

    ('operational',
     interval '2 years',
     'A soft-deleted document with no financial parent: its BYTES, once this has run from its deletion. The row stays as the record that the file existed.',
     'documents.deleted_at',
     'CLAUDE.md § Non-negotiable rules ("2 years for inactive-account data"); Q52; Q133.'),

    ('feedback',
     interval '2 years',
     'public.feedback rows and their feedback-screenshots objects. Already enforced at READ time by private.feedback_retention_cutoff(); the sweep is what makes an expired row actually absent.',
     'feedback.created_at',
     'CLAUDE.md § In-app feedback ("Retention: 2 years"); Q120; Q133.'),

    ('audit_hot',
     interval '30 days',
     'public.audit_events stay in the audit-log viewer''s DEFAULT range for this long. Nothing is deleted at this age -- Q135: at MVP "archived" means the rows are still in Postgres and simply fall out of the default window.',
     'audit_events.created_at',
     'CLAUDE.md § Non-negotiable rules ("hot/queryable for 30 days"); Q135.'),

    ('audit_total',
     interval '1 year',
     'public.audit_events are DELETED at this age. THE ONE SWEEP THAT DESTROYS EVIDENCE -- private.purge_audit_events() carries a hard floor that refuses a period shorter than this whatever this row says (part 4).',
     'audit_events.created_at',
     'CLAUDE.md § Non-negotiable rules ("archived (cold storage) for up to 1 year total, then purged"); Q135; SECURITY.md § 7.'),

    ('workspace',
     interval '60 days',
     'A suspended or closed workspace, then hard-purged by private.erase_organisation(). Reinstating it any time inside the window clears the clock outright (private.organisation_lifecycle_sync()).',
     'organisations.lifecycle_changed_at, through retention_expires_at',
     'FOUNDER RULING Q88 (2026-09-07); Q92; Q102; Q133.'),

    ('rate_limit_counter',
     interval '7 days',
     'A fixed-window counter whose window closed this long ago. The longest live window is 24h (account_erasure, account_lockout), so seven days is a week of slack past the longest thing that could still be counting.',
     'rate_limit_counters.window_start',
     'Q110. No founder ruling: the counters are enforcement state, not records about anybody, and the only cost of a longer period is table size.'),

    ('incident_alert',
     interval '1 year',
     'A RESOLVED incident alert and its details JSON (which carries subject ids). An OPEN alert is never purged at any age -- it is an outstanding operational problem, and deleting it would delete the reason somebody has not looked at it yet.',
     'incident_alerts.resolved_at',
     'Q117, proposed here and queued: nothing had been written. One year matches audit_total, which is what an alert is evidence alongside.'),

    ('erasure_job_failed',
     interval '90 days',
     'A FAILED public.erasure_jobs row, which still names the person and the reason. A SUCCEEDED row is kept FOR EVER and is deliberately not on this list: both its user columns are already null, so it is pseudonymous, and it is the proof the deletion happened.',
     'erasure_jobs.completed_at',
     'Q175, recommended by Task 5 for this task.'),

    ('stuck_job',
     interval '1 hour',
     'A public.export_jobs or public.erasure_jobs row left `running` this long is marked `failed` with a recorded reason. NOT A DELETION: the row survives, and the point is to release the one-live-job index so the subject can ask again.',
     'the job''s started_at',
     'Q166, recommended by Task 4 for this task; Task 5 recorded the same shape, worse, for an erasure.'),

    -- ADDED IN 20261003002000, with the sweep that needs it.
    ('storage_orphan',
     interval '1 day',
     'A stored object that NO row in the database names. Deleted by the runner once it is this old. The grace period is not caution for its own sake: an upload writes the object and THEN the row, so for a fraction of a second every healthy upload is an orphan, and a sweep with no grace would occasionally delete a file somebody was in the middle of sending.',
     'storage.objects.created_at',
     'Q52 and Q120 both ask for the orphan half; the grace period is engineering, not a legal period, and it is the one entry on this list counsel has no view on.')
$$;

comment on function private.retention_periods() is
  'THE ONE DECLARED PLACE EVERY RETENTION PERIOD LIVES (Phase 8 Task 6, requirement 1). ELEVEN classes since 20261003002000 added `storage_orphan`, each with its interval, what it applies to, which column its clock runs from and the authority that set it. Read by private.retention_period(), by every sweep in private.run_retention_sweep(), by private.organisation_retention_days() and private.feedback_retention_cutoff() (the two read-time expiry paths that predate it and were rebuilt to derive their numbers from here), and by the psql suite. A FUNCTION rather than a settings table ON PURPOSE: these numbers are a legal position stated on a published page, and a row anybody can UPDATE is a legal position that can change with no diff, no review and no record. EVERY PERIOD IS A WORKING DEFAULT PENDING A COUNSEL REVIEW (CLAUDE.md § Legal and regulatory compliance, Q133) -- which is the whole reason they are in one place: counsel''s answer is a reissue of this one function.';

revoke all on function private.retention_periods() from public, anon, authenticated, service_role;
grant execute on function private.retention_periods() to authenticated;


alter table public.documents add column bytes_purged_at timestamptz;

comment on column public.documents.bytes_purged_at is
  'When this document''s bytes were deleted from the `documents` bucket under the retention policy (Q52, Phase 8 Task 6). Null means the file is still there, or was never successfully uploaded. It is the difference between "we deleted this file because we are no longer allowed to keep it" and "this file is missing and we do not know why", which the schema could not previously express at all. Stamped by private.sweep_document_bytes() for any soft-deleted, expired document whose object is ALREADY ABSENT -- so a run that deleted the object and then died is finished by the next run rather than leaving the row wrong for ever.';

-- ---------------------------------------------------------------------------
-- 1. A DOCUMENT'S RETENTION CLASS (Q52: "the parent record's retention
--    class", financial 7 years, everything else 2).
--
--    THE MEASUREMENT THAT SHAPES THIS. public.document_links.entity_type is
--    allowlisted to six CRM entities and `financial_entry` IS NOT ONE OF THEM
--    -- a document cannot be attached to a financial entry at all. So "the
--    parent record is financial" has exactly one reachable meaning in the
--    schema as built: the document is attached to an EVENT that carries
--    financial entries. A fee agreement, a settlement sheet or an invoice
--    lives on the event whose money it is about, because there is nowhere
--    else for it to live.
--
--    IT ERRS LONG, AND THAT IS THE SAFE DIRECTION. A document whose class is
--    misread as financial survives five years longer than it needed to; one
--    misread as operational is destroyed five years before it was allowed to
--    be. So a SOFT-DELETED financial entry still counts, and a soft-deleted
--    link still counts: the workspace deleting the evidence does not shorten
--    how long we are obliged to be able to produce it.
-- ---------------------------------------------------------------------------

create or replace function private.document_retention_class(p_document_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1
      from public.document_links l
      join public.financial_entries f
        on f.event_id = l.entity_id
       and f.organisation_id = l.organisation_id
     where l.parent_id = p_document_id
       and l.entity_type = 'event'
  ) then 'financial' else 'operational' end
$$;

comment on function private.document_retention_class(uuid) is
  'A document''s retention class under Q52: `financial` (7 years) when it is attached to an event that carries financial entries, `operational` (2 years) otherwise. THE SCHEMA DECIDES THE SHAPE OF THIS QUESTION: public.document_links.entity_type is allowlisted to six CRM entities and `financial_entry` is not one of them, so "attached to a financial record" has exactly one reachable meaning -- attached to the EVENT whose money it is about, which is where a fee agreement or a settlement sheet necessarily lives. It counts SOFT-DELETED links and SOFT-DELETED financial entries too, deliberately: misreading a class as financial costs five years of storage, misreading it as operational destroys a record five years early, and a workspace deleting its own evidence does not shorten how long we are obliged to be able to produce it.';

revoke all on function private.document_retention_class(uuid) from public, anon, authenticated, service_role;
grant execute on function private.document_retention_class(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. THE MANIFEST: what the runner deletes from the buckets.
--
--    THE KEYS COME FROM THE DATABASE, NEVER FROM TYPESCRIPT -- the erasure
--    runner's rule (20260930004000), and the reason is the same: a bug in the
--    runner cannot aim a delete at a prefix the database did not name.
--
--    It lists only objects that EXIST (it is a join against storage.objects),
--    which is what makes the whole storage half idempotent with no bookkeeping
--    column: a second run over the same subject returns nothing to do.
--
--    FIVE SOURCES, and the last two are the orphan half requirement 5 asks
--    for by name.
-- ---------------------------------------------------------------------------

create or replace function public.retention_object_manifest(p_limit integer default 500)
returns table (bucket text, object_key text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with expired_documents as (
    -- (a) A soft-deleted document whose class has run out.
    select 'documents'::text as bucket, d.storage_key as object_key,
           'document_expired'::text as reason, d.deleted_at as age
      from public.documents d
     where d.deleted_at is not null
       and d.bytes_purged_at is null
       and d.deleted_at < pg_catalog.now()
           - private.retention_period(private.document_retention_class(d.id))
  ),
  doomed_workspaces as (
    -- (b) EVERY document of a workspace whose 60 days are up, whatever its
    --     own class. The workspace is about to be hard-purged and
    --     private.erase_organisation() REFUSES to run while a single byte of
    --     it is still in the bucket -- so if these were not here, the
    --     workspace purge would refuse for ever and nothing would say why.
    select 'documents'::text, d.storage_key, 'workspace_purge'::text, o.retention_expires_at
      from public.documents d
      join public.organisations o on o.id = d.organisation_id
     where o.deleted_at is not null
       and o.retention_expires_at is not null
       and o.retention_expires_at < pg_catalog.now()
  ),
  expired_feedback as (
    -- (c) An expired feedback row's screenshot (Q120).
    select 'feedback-screenshots'::text, f.screenshot_key, 'feedback_expired'::text, f.created_at
      from public.feedback f
     where f.screenshot_key is not null
       and f.created_at < private.feedback_retention_cutoff()
  ),
  expired_exports as (
    -- (d) An export archive past its own expires_at. Task 4 enforced that
    --     expiry at READ time only -- public.record_export_download() refuses
    --     an expired job -- and nothing ever deleted the zip, so every export
    --     anyone has ever taken is still sitting in the bucket. Measured, not
    --     assumed: there is no other caller of storage.remove() for this
    --     bucket anywhere in the repository.
    select 'exports'::text, j.storage_key, 'export_expired'::text, j.expires_at
      from public.export_jobs j
     where j.storage_key is not null
       and j.expires_at is not null
       and j.expires_at < pg_catalog.now()
  ),
  candidates as (
    select * from expired_documents
    union all select * from doomed_workspaces
    union all select * from expired_feedback
    union all select * from expired_exports
  ),
  present as (
    -- ONLY WHAT IS ACTUALLY THERE. The join is what makes a second run over
    -- the same subject a no-op with no bookkeeping column to get out of step.
    select c.bucket, c.object_key, c.reason, c.age
      from candidates c
      join storage.objects s on s.bucket_id = c.bucket and s.name = c.object_key
  ),
  orphans as (
    -- (e) THE ORPHAN HALF (requirement 5): an object no row names at all,
    --     older than the grace period. This is the residue of a row delete
    --     whose object delete failed, and of any other way the two can come
    --     apart.
    select s.bucket_id::text as bucket, s.name as object_key,
           'orphan'::text as reason, s.created_at as age
      from storage.objects s
     where s.bucket_id in ('documents', 'feedback-screenshots', 'exports')
       and s.created_at < pg_catalog.now() - private.retention_period('storage_orphan')
       and not exists (select 1 from public.documents d where d.storage_key = s.name
                        and s.bucket_id = 'documents')
       and not exists (select 1 from public.feedback f where f.screenshot_key = s.name
                        and s.bucket_id = 'feedback-screenshots')
       and not exists (select 1 from public.export_jobs j where j.storage_key = s.name
                        and s.bucket_id = 'exports')
  )
  select bucket, object_key, reason
    from (select * from present union all select * from orphans) all_rows
   -- OLDEST FIRST, so a run that hits the ceiling leaves the newer remainder
   -- for the next one rather than skipping an arbitrary slice for ever.
   order by age, object_key
   limit greatest(coalesce(p_limit, 500), 0)
$$;

comment on function public.retention_object_manifest(integer) is
  'WHAT THE RETENTION RUNNER DELETES FROM THE BUCKETS, derived in the database (Phase 8 Task 6). The erasure runner''s rule, for the same reason: the keys come from here and never from TypeScript, so a bug in the runner cannot aim a delete at a prefix the database did not name. Five sources -- an expired document''s bytes (Q52), every document of a workspace whose 60 days are up (because private.erase_organisation() refuses to run while one byte remains), an expired feedback row''s screenshot (Q120), an export archive past its own expires_at (which Task 4 enforced at read time only, so every archive ever taken is still in the bucket), and ORPHANS in all three buckets: objects no row names, older than the storage_orphan grace period, which is the residue of a row delete whose object delete failed. It lists only objects that EXIST, which is what makes the storage half idempotent with no bookkeeping column, and it returns them OLDEST FIRST under a ceiling, so a capped run leaves a remainder rather than skipping a slice. service_role only.';

revoke all on function public.retention_object_manifest(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.retention_object_manifest(integer) to service_role;


-- ---------------------------------------------------------------------------
-- 3. Q110 -- STALE RATE-LIMIT COUNTERS.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_rate_limit_counters(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint; v_cut timestamptz;
begin
  v_cut := pg_catalog.now() - private.retention_period('rate_limit_counter');

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.rate_limit_counters c
             where c.window_start < v_cut
             order by c.window_start
             limit p_limit) t;
  else
    with doomed as (
      select c.category, c.subject_scope, c.subject_id, c.window_start
        from public.rate_limit_counters c
       where c.window_start < v_cut
       order by c.window_start
       limit p_limit
       for update skip locked)
    delete from public.rate_limit_counters c
     using doomed d
     where c.category = d.category and c.subject_scope = d.subject_scope
       and c.subject_id = d.subject_id and c.window_start = d.window_start;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'rate_limit_counters.rows', v_n,
    'rate_limit_counters.capped', v_n >= p_limit);
end;
$$;

comment on function private.sweep_rate_limit_counters(boolean, integer) is
  'Q110: fixed-window counters whose window closed more than private.retention_period(''rate_limit_counter'') ago. The table has no foreign key and nothing swept it -- stale windows for a subject are cleared opportunistically on that subject''s NEXT request, so a subject who never comes back leaves a row for ever and the table grows without bound. FOR UPDATE SKIP LOCKED, because a counter is written by every request in the product and a sweep must never make one wait.';

revoke all on function private.sweep_rate_limit_counters(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. Q120 -- FEEDBACK, AND THE GATE THAT KEEPS BYTES FROM OUTLIVING THE ROW.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_feedback(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint; v_waiting bigint;
begin
  -- A ROW WHOSE SCREENSHOT IS STILL IN THE BUCKET IS NOT DELETED. Deleting it
  -- now would leave an object nothing in the database names -- findable only
  -- by the orphan sweep, a day later, having been an untracked image of
  -- somebody's screen in the meantime. private.erase_organisation()'s
  -- bytes-first gate, in the one other place it applies.
  select pg_catalog.count(*) into v_waiting
    from public.feedback f
    join storage.objects s
      on s.bucket_id = 'feedback-screenshots' and s.name = f.screenshot_key
   where f.created_at < private.feedback_retention_cutoff();

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.feedback f
             where f.created_at < private.feedback_retention_cutoff()
               and not exists (select 1 from storage.objects s
                                where s.bucket_id = 'feedback-screenshots'
                                  and s.name = f.screenshot_key)
             order by f.created_at
             limit p_limit) t;
  else
    with doomed as (
      select f.id from public.feedback f
       where f.created_at < private.feedback_retention_cutoff()
         and not exists (select 1 from storage.objects s
                          where s.bucket_id = 'feedback-screenshots'
                            and s.name = f.screenshot_key)
       order by f.created_at
       limit p_limit)
    delete from public.feedback f using doomed d where f.id = d.id;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'feedback.rows', v_n,
    'feedback.capped', v_n >= p_limit,
    'feedback.waiting_on_bytes', v_waiting);
end;
$$;

comment on function private.sweep_feedback(boolean, integer) is
  'Q120: public.feedback rows past private.feedback_retention_cutoff() (two years), which until now was enforced at READ time only -- the row was unreadable and entirely present. A row whose screenshot object is STILL IN THE BUCKET is left alone and counted as `waiting_on_bytes` rather than deleted: deleting it would leave an untracked image of somebody''s screen that only the orphan sweep would find, a day later. The runner deletes the object first, from public.retention_object_manifest(), and the next pass takes the row.';

revoke all on function private.sweep_feedback(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. Q117 -- RESOLVED INCIDENT ALERTS. An OPEN one is never purged.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_incident_alerts(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint; v_cut timestamptz;
begin
  v_cut := pg_catalog.now() - private.retention_period('incident_alert');

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.incident_alerts a
             where a.resolved_at is not null and a.resolved_at < v_cut
             order by a.resolved_at
             limit p_limit) t;
  else
    with doomed as (
      select a.id from public.incident_alerts a
       where a.resolved_at is not null and a.resolved_at < v_cut
       order by a.resolved_at
       limit p_limit)
    delete from public.incident_alerts a using doomed d where a.id = d.id;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'incident_alerts.rows', v_n,
    'incident_alerts.capped', v_n >= p_limit);
end;
$$;

comment on function private.sweep_incident_alerts(boolean, integer) is
  'Q117, for which no rule had ever been written. A RESOLVED alert and its details JSON (which carries subject ids) go one year after resolution -- the same period as the audit rows they are evidence alongside. AN OPEN ALERT IS NEVER PURGED AT ANY AGE, and that is the whole of the rule that matters: an unresolved alert is an outstanding operational problem, and deleting it because it is old would delete the reason nobody has looked at it yet. The clock therefore runs from resolved_at and not from created_at.';

revoke all on function private.sweep_incident_alerts(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. Q175 -- FAILED ERASURE JOBS. A SUCCEEDED ONE IS KEPT FOR EVER.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_erasure_jobs(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint; v_cut timestamptz;
begin
  v_cut := pg_catalog.now() - private.retention_period('erasure_job_failed');

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.erasure_jobs j
             where j.status = 'failed' and j.completed_at is not null
               and j.completed_at < v_cut
             order by j.completed_at
             limit p_limit) t;
  else
    with doomed as (
      select j.id from public.erasure_jobs j
       where j.status = 'failed' and j.completed_at is not null
         and j.completed_at < v_cut
       order by j.completed_at
       limit p_limit)
    delete from public.erasure_jobs j using doomed d where j.id = d.id;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'erasure_jobs.rows', v_n,
    'erasure_jobs.capped', v_n >= p_limit);
end;
$$;

comment on function private.sweep_erasure_jobs(boolean, integer) is
  'Q175: a FAILED erasure job 90 days after it failed. It is the one erasure row that still names a person -- subject_user_id survives a failure, and failure_reason says why the deletion they asked for did not happen. A SUCCEEDED row is deliberately NOT swept at any age: both its user columns are already null, so it is pseudonymous, and it is the evidence that a statutory deletion was performed, which is the last thing a retention job should destroy.';

revoke all on function private.sweep_erasure_jobs(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. Q166 -- THE REAPER. NOT A DELETION.
--
--    A job left `running` because the WRITE of its own failure also failed
--    blocks its subject for ever behind the one-live-job partial unique
--    index: they read "an export is already being prepared" (or, worse, "your
--    account is being deleted") and no route they have can clear it. This
--    marks it failed. The row survives and says what happened; what is
--    released is the index.
--
--    THE GUARDS ON THOSE TABLES REFUSE A CLIENT WRITE, and this function is
--    not one: it runs from the cron tick with no auth.uid(), which is exactly
--    the session both guards admit. That is asserted, not assumed -- the psql
--    suite reaps as `postgres` AND proves an authenticated session cannot.
-- ---------------------------------------------------------------------------

create or replace function private.reap_stuck_jobs(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_exports bigint; v_erasures bigint; v_cut timestamptz;
begin
  v_cut := pg_catalog.now() - private.retention_period('stuck_job');

  if p_dry then
    select pg_catalog.count(*) into v_exports
      from public.export_jobs j
     where j.status = 'running' and j.started_at is not null and j.started_at < v_cut;
    select pg_catalog.count(*) into v_erasures
      from public.erasure_jobs j
     where j.status = 'running' and j.started_at is not null and j.started_at < v_cut;
  else
    update public.export_jobs j
       set status = 'failed',
           completed_at = pg_catalog.now(),
           failure_reason = 'This export was interrupted and never finished. Nothing was delivered. Ask for it again.'
     where j.id in (select k.id from public.export_jobs k
                     where k.status = 'running' and k.started_at is not null
                       and k.started_at < v_cut
                     order by k.started_at limit p_limit);
    get diagnostics v_exports = row_count;

    update public.erasure_jobs j
       set status = 'failed',
           completed_at = pg_catalog.now(),
           failure_reason = 'This deletion was interrupted and never finished. NOTHING WAS DELETED -- the whole erasure is one transaction, so an interrupted one leaves everything as it was. Ask again.'
     where j.id in (select k.id from public.erasure_jobs k
                     where k.status = 'running' and k.started_at is not null
                       and k.started_at < v_cut
                     order by k.started_at limit p_limit);
    get diagnostics v_erasures = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'export_jobs.reaped', v_exports,
    'erasure_jobs.reaped', v_erasures);
end;
$$;

comment on function private.reap_stuck_jobs(boolean, integer) is
  'Q166 (and the worse version of it Task 5 recorded for an erasure): a job left `running` for more than an hour is marked FAILED with a recorded reason. NOT A DELETION -- the row survives and now says what happened; what is released is the one-live-job partial unique index, which was permanently locking a person out of a statutory right because of a transient fault at exactly the wrong moment. The erasure sentence says NOTHING WAS DELETED and means it: public.run_erasure_job() does the whole sequence in one transaction, so an interrupted erasure rolled back. Runs with no auth.uid(), which is precisely the session both tables'' server-only outcome guards admit.';

revoke all on function private.reap_stuck_jobs(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 8. Q52 -- DOCUMENT BYTES. The row-side half; the runner does the objects.
--
--    THE COLUMN. `bytes_purged_at` is the honest record of a state the
--    schema could not previously express: "this document's file was deleted
--    under the retention policy", as distinct from "the file is missing and
--    we do not know why". It is also what lets the download path say
--    something true instead of erroring.
--
--    THE SELF-HEALING DIRECTION. The stamp is written for any expired
--    document whose object is ALREADY ABSENT -- so if the run that deleted the
--    object died before it could stamp, the next run stamps it. That is
--    requirement 5's "the object is gone and the row remains", handled rather
--    than described.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_document_bytes(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_n bigint; v_waiting bigint;
begin
  -- Expired, bytes still present: the runner's work, not this function's.
  select pg_catalog.count(*) into v_waiting
    from public.documents d
    join storage.objects s on s.bucket_id = 'documents' and s.name = d.storage_key
   where d.deleted_at is not null
     and d.bytes_purged_at is null
     and d.deleted_at < pg_catalog.now()
         - private.retention_period(private.document_retention_class(d.id));

  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.documents d
             where d.deleted_at is not null
               and d.bytes_purged_at is null
               and d.deleted_at < pg_catalog.now()
                   - private.retention_period(private.document_retention_class(d.id))
               and not exists (select 1 from storage.objects s
                                where s.bucket_id = 'documents' and s.name = d.storage_key)
             order by d.deleted_at
             limit p_limit) t;
  else
    with done as (
      select d.id from public.documents d
       where d.deleted_at is not null
         and d.bytes_purged_at is null
         and d.deleted_at < pg_catalog.now()
             - private.retention_period(private.document_retention_class(d.id))
         and not exists (select 1 from storage.objects s
                          where s.bucket_id = 'documents' and s.name = d.storage_key)
       order by d.deleted_at
       limit p_limit)
    update public.documents d
       set bytes_purged_at = pg_catalog.now()
      from done
     where d.id = done.id;
    get diagnostics v_n = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'documents.bytes_purged', v_n,
    'documents.capped', v_n >= p_limit,
    'documents.waiting_on_bytes', v_waiting);
end;
$$;

comment on function private.sweep_document_bytes(boolean, integer) is
  'Q52, the ROW side: stamps public.documents.bytes_purged_at on every soft-deleted, expired document whose object is already gone from the bucket. The OBJECT side is the runner''s, from public.retention_object_manifest(). Splitting it this way is what handles requirement 5''s harder direction -- the object deleted and the row not updated, because the run died in between -- WITHOUT a two-phase commit nobody can have: the stamp is derived from the object''s absence, so the next run finishes what the last one started. `waiting_on_bytes` counts expired documents whose file is still there, which is the number that says whether the storage half is keeping up.';

revoke all on function private.sweep_document_bytes(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 9. Q88/Q92/Q102 -- THE 60-DAY WORKSPACE PURGE.
--
--    IT CALLS TASK 5'S PRIMITIVE. There is no second erasure here and there
--    must never be one: private.erase_organisation() carries the `replica`
--    refusal, the polymorphic sweep, the field_resolution scrub, the FK-less
--    roll, the derived post-delete assertion and the summary audit row. This
--    function decides WHICH workspaces and WHEN, and nothing else.
--
--    THE THREE TRAPS ALREADY RECORDED, AND WHERE EACH ONE IS ANSWERED:
--      * reinstatement must work right up to the deadline
--          -> private.organisation_lifecycle_sync() CLEARS retention_expires_at
--             the moment deleted_at is cleared, so a reinstated workspace has
--             no deadline at all and this query cannot see it. The window is
--             not "59 days is fine and 60 is too late"; it is "while the
--             workspace is closed".
--      * closing an already-suspended workspace RESTARTS the clock
--          -> the same trigger re-stamps lifecycle_changed_at when the state
--             changes, and retention_expires_at with it. So a workspace
--             suspended on day 0 and closed on day 50 goes on day 110.
--      * no hard-purge path existed
--          -> this is it, and it is the first caller erase_organisation() has
--             ever had.
-- ---------------------------------------------------------------------------

create or replace function private.sweep_expired_workspaces(p_dry boolean, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_n       bigint := 0;
  v_blocked bigint := 0;
  v_bytes   bigint;
begin
  if p_dry then
    select pg_catalog.count(*) into v_n
      from (select 1 from public.organisations o
             where o.deleted_at is not null
               and o.retention_expires_at is not null
               and o.retention_expires_at < pg_catalog.now()
             order by o.retention_expires_at
             limit p_limit) t;
    return pg_catalog.jsonb_build_object(
      'organisations.purged', v_n, 'organisations.capped', v_n >= p_limit);
  end if;

  for v_id in
    select o.id from public.organisations o
     where o.deleted_at is not null
       and o.retention_expires_at is not null
       and o.retention_expires_at < pg_catalog.now()
     order by o.retention_expires_at
     limit p_limit
  loop
    -- The primitive refuses while any byte is still in the bucket, and that
    -- refusal would abort the whole run. Asked here first so a workspace
    -- whose objects the runner has not reached yet is COUNTED as blocked and
    -- left for the next run, rather than taking every other sweep down with
    -- it.
    select pg_catalog.count(*) into v_bytes
      from storage.objects s
     where s.bucket_id = 'documents'
       and s.name like v_id::text || '/%';
    if v_bytes > 0 then
      v_blocked := v_blocked + 1;
      continue;
    end if;

    perform private.erase_organisation(v_id, null, true);
    v_n := v_n + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organisations.purged', v_n,
    'organisations.capped', v_n >= p_limit,
    'organisations.waiting_on_bytes', v_blocked);
end;
$$;

comment on function private.sweep_expired_workspaces(boolean, integer) is
  'Q88/Q92/Q102, the 60-day hard purge -- THE FIRST CALLER private.erase_organisation() has ever had. It decides WHICH workspaces and WHEN and nothing else: there is no second erasure here and there must never be one, because the primitive carries the `replica` refusal, the polymorphic sweep, the merges.field_resolution scrub, the FK-less identifier roll, the derived post-delete assertion and the summary audit row. Reinstatement inside the window needs no special case at all: private.organisation_lifecycle_sync() clears retention_expires_at the moment deleted_at is cleared, so a reinstated workspace has no deadline for this query to find -- the rule is "while it is closed", not "59 days yes, 60 days no". Closing an already-suspended workspace restarts the clock by the same trigger. A workspace whose document bytes the runner has not reached yet is counted as `waiting_on_bytes` and left: the primitive would refuse, and that refusal would abort every other sweep in the run.';

revoke all on function private.sweep_expired_workspaces(boolean, integer)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 10. THE ROLL, REISSUED FROM ITS LATEST DEFINITION WITH THE RETENTION JOB'S
--     OWN TWO TABLES ON IT.
--
--     THIS IS THE DERIVATION EARNING ITS KEEP ON THE FIRST DAY IT EXISTED.
--     20261003001000 added public.retention_runs and public.retention_settings
--     and classified neither, and the very next call to
--     private.assert_retention_roll() refused with
--     `unclassified_retention_subject` naming both -- measured, not imagined:
--
--       ERROR:  assert_retention_roll: public.retention_runs,
--               retention_settings is not classified by
--               private.retention_subjects()
--       HINT:  unclassified_retention_subject
--
--     A list would have shipped silently one table short. The run log is
--     `never_purged` for a reason that is worth stating plainly: a garbage
--     collector that garbage-collects its own record of what it deleted is
--     the one thing on this roll that must not exist.
-- ---------------------------------------------------------------------------

create or replace function private.retention_subjects()
returns table (
  table_name text,
  treatment  text,
  class      text,
  reason     text)
language sql
immutable
set search_path = ''
as $$
  values
    -- ---- swept, each by a named class ------------------------------------
    ('audit_events',        'swept', 'audit_total',
     'private.purge_audit_events(), the one sweep that destroys evidence. Hard floor, sanity ceiling, dry run, counts either side.'),
    ('feedback',            'swept', 'feedback',
     'private.sweep_feedback(): the row and its feedback-screenshots object (Q120).'),
    ('rate_limit_counters', 'swept', 'rate_limit_counter',
     'private.sweep_rate_limit_counters(): closed windows nobody came back to (Q110).'),
    ('incident_alerts',     'swept', 'incident_alert',
     'private.sweep_incident_alerts(): RESOLVED alerts only; an open one is never purged at any age (Q117).'),
    ('erasure_jobs',        'swept', 'erasure_job_failed',
     'private.sweep_erasure_jobs(): FAILED rows only. A succeeded row is pseudonymous and is kept for ever as the proof (Q175).'),
    ('export_jobs',         'swept', 'stuck_job',
     'private.reap_stuck_jobs(): a row left `running` is failed, not deleted, so the one-live-job index stops blocking the subject (Q166). The archive bytes are already purged by the export runner''s own expiry.'),
    ('documents',           'swept', 'operational',
     'private.sweep_document_bytes(): the BYTES of a soft-deleted document, once its parent record''s class has run out (Q52). The row survives -- see the column comment on documents.bytes_purged_at.'),
    ('organisations',       'swept', 'workspace',
     'private.sweep_expired_workspaces() -> private.erase_organisation(): 60 days after suspension or closure (Q88/Q92/Q102). Everything classified `cascades` below goes with it.'),

    -- ---- goes with its parent --------------------------------------------
    ('document_links',              'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE.'),
    ('document_versions',           'cascades', null, 'Composite FK to public.documents, ON DELETE CASCADE. Dormant (SELECT-only, no write path) until Release 1.1.'),
    ('data_subject_request_notes',  'cascades', null, 'FK to public.data_subject_requests, ON DELETE CASCADE.'),
    ('organisation_memberships',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_subscriptions',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_billing_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('organisation_feature_overrides',  'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_values',         'cascades', null,
     'FK to public.organisations cascades, AND private.sweep_custom_field_values() runs first for the polymorphic half no foreign key protects (20260930002000).'),
    ('impersonation_sessions',      'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('event_status_changes',        'cascades', null, 'Composite FK to public.events, ON DELETE CASCADE.'),
    ('artist_fee_history',          'cascades', null, 'Composite FK to public.artists, ON DELETE CASCADE.'),
    ('contact_companies',           'cascades', null, 'Composite FKs to public.contacts and public.companies, ON DELETE CASCADE.'),
    ('artist_representations',      'cascades', null, 'Composite FKs to public.artists and public.agencies, ON DELETE CASCADE.'),
    ('event_lineup',                'cascades', null, 'Composite FKs to public.events and public.artists, ON DELETE CASCADE.'),
    ('task_links',                  'cascades', null, 'Composite FK to public.tasks, ON DELETE CASCADE.'),
    ('meeting_links',               'cascades', null, 'Composite FK to public.meetings, ON DELETE CASCADE.'),
    ('note_links',                  'cascades', null, 'Composite FK to public.notes, ON DELETE CASCADE.'),
    ('network_links',               'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('network_connection_requests', 'cascades', null, 'FKs to public.organisations, ON DELETE CASCADE.'),
    ('network_profiles',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('custom_field_definitions',    'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),
    ('merges',                      'cascades', null,
     'FK to public.organisations, ON DELETE CASCADE -- and field_resolution is scrubbed first, because it holds the discarded record''s values verbatim.'),
    ('merge_candidates',            'cascades', null, 'FK to public.organisations, ON DELETE CASCADE.'),

    -- ---- tenant records: retained with their workspace (Q180) -------------
    ('contacts',          'retained_with_workspace', null, 'A soft-deleted CRM record stays readable to its workspace. Q180 asks whether it should expire on its own.'),
    ('companies',         'retained_with_workspace', null, 'See contacts.'),
    ('artists',           'retained_with_workspace', null, 'See contacts.'),
    ('agencies',          'retained_with_workspace', null, 'See contacts.'),
    ('venues',            'retained_with_workspace', null, 'See contacts.'),
    ('venue_rooms',       'retained_with_workspace', null, 'See contacts.'),
    ('events',            'retained_with_workspace', null, 'See contacts.'),
    ('tasks',             'retained_with_workspace', null, 'See contacts.'),
    ('meetings',          'retained_with_workspace', null, 'See contacts.'),
    ('notes',             'retained_with_workspace', null, 'See contacts.'),
    ('financial_entries', 'retained_with_workspace', null,
     'And the LONGEST class if Q180 is ever taken: seven years, not two. A financial entry is the thing CLAUDE.md''s "7 years for financial records" is about.'),

    -- ---- the person's own records ----------------------------------------
    ('consents',              'never_purged', null,
     'A consent record is the evidence of a lawful basis (UK GDPR Art 7(1)); deleting it destroys the proof that processing was lawful. It goes with the ACCOUNT, in private.erase_account(), and on no clock of its own (Q173).'),
    ('data_subject_requests', 'never_purged', null,
     'The statutory register: the evidence that a request was answered inside 30 days. It SURVIVES the erasure it answered, anonymised (Q173), and is on no clock.'),
    ('profiles',              'cascades', null, 'FK to auth.users, ON DELETE CASCADE -- and private.erase_account() is what makes that happen.'),

    -- ---- the retention job's own bookkeeping (added in 20261003002000) ---
    ('retention_runs',     'never_purged', null,
     'The run log itself. It is the evidence of what the garbage collector deleted and when, and a garbage collector that garbage-collects its own record of what it deleted is the one thing on this list that must not exist. Counts only -- the table has no column that could hold a record -- so it grows by one row per run and nothing else.'),
    ('retention_settings', 'platform_reference', null,
     'One enforced row: the two kill switches. Not a record about anybody.'),

    -- ---- the platform's own ----------------------------------------------
    ('legal_documents',  'never_purged', null,
     'A PUBLISHED legal version is immutable and permanent: it is what the product promised on a given date, and a consent points at it by version.'),
    ('platform_admins',  'platform_reference', null, 'Who the superuser is. One row.'),
    ('permissions',      'platform_reference', null, 'The permission catalogue.'),
    ('roles',            'platform_reference', null, 'The role catalogue.'),
    ('role_permissions', 'platform_reference', null, 'The role/permission matrix.'),
    ('subscription_plans',   'platform_reference', null, 'The tier catalogue.'),
    ('rate_limit_policies',  'platform_reference', null, 'The rate-limit budgets. The COUNTERS are swept; the policies are the catalogue.')
$$;

comment on function private.retention_subjects() is
  'THE ROLL: every table in `public` (fifty-three since 20261003002000 reissued it with the retention job''s own two), each one either swept under a declared class or excused with a reason (Phase 8 Task 6). Paired with private.assert_retention_roll(), which DERIVES the same list from pg_class and refuses a table the roll does not carry -- so a table added by a later phase stops the retention job rather than being quietly un-retained, which is the whole point. Treatments: `swept` (a named sweep deletes or purges it), `cascades` (it goes when its parent goes), `retained_with_workspace` (a tenant record, removed only by the workspace purge -- Q180 asks whether soft-deleted CRM rows should expire on their own, and this task deliberately does NOT build that), `platform_reference` (the product''s own catalogues) and `never_purged` (kept for ever, with the reason).';

revoke all on function private.retention_subjects() from public, anon, authenticated, service_role;
grant execute on function private.retention_subjects() to authenticated;


-- ---------------------------------------------------------------------------
-- 11. THE DERIVATION, REISSUED WITH THE ONE CHECK IT WAS MISSING.
--
--     20261003000000's assert asks two questions -- is any table unclassified,
--     and does the roll name a table that does not exist -- and between them
--     they DO NOT establish that the roll and the catalogue are the same set.
--     A roll carrying `feedback` twice passes both: every table is
--     classified, every entry names a real table. It would then be possible
--     for a table to be classified twice with two different treatments, one
--     of which is wrong, and for nothing to say so.
--
--     MEASURED ON THE LIVE CATALOGUE at 188 migrations: 54 tables in `public`,
--     54 roll entries, 0 duplicates. The third check is what keeps those
--     three numbers a fact rather than a coincidence.
-- ---------------------------------------------------------------------------

create or replace function private.assert_retention_roll()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_missing text;
  v_stale   text;
  v_badclass text;
  v_dupe    text;
  v_seen    bigint;
begin
  -- THE DENOMINATOR FIRST (standing lesson 1). If the catalogue query
  -- resolves nothing, every assertion below passes perfectly while seeing
  -- nothing at all. Fifty-four tables exist in `public` today; a floor of
  -- forty is loose enough never to need touching and tight enough that a
  -- derivation which resolved nothing cannot get past it.
  select pg_catalog.count(*) into v_seen
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::pg_catalog.regnamespace
     and c.relkind in ('r', 'p');
  if v_seen < 40 then
    raise exception 'assert_retention_roll: only % table(s) found in `public` -- the derivation is not seeing the schema', v_seen
      using errcode = '55000', hint = 'retention_roll_saw_nothing';
  end if;

  select pg_catalog.string_agg(t, ', ' order by t) into v_missing
    from private.unclassified_retention_subjects() t;
  if v_missing is not null then
    raise exception 'assert_retention_roll: public.% is not classified by private.retention_subjects()', v_missing
      using errcode = '55000', hint = 'unclassified_retention_subject';
  end if;

  select pg_catalog.string_agg(s.table_name, ', ' order by s.table_name) into v_stale
    from private.retention_subjects() s
   where not exists (
     select 1 from pg_catalog.pg_class c
      where c.relnamespace = 'public'::pg_catalog.regnamespace
        and c.relkind in ('r', 'p')
        and c.relname::text = s.table_name);
  if v_stale is not null then
    raise exception 'assert_retention_roll: the roll names public.%, which does not exist', v_stale
      using errcode = '55000', hint = 'stale_retention_subject';
  end if;

  -- THE THIRD CHECK (20261003002000). Without it the first two can both pass
  -- on a roll that classifies one table twice, under two different
  -- treatments, one of which is wrong.
  select pg_catalog.string_agg(d.table_name, ', ' order by d.table_name) into v_dupe
    from (select s.table_name from private.retention_subjects() s
           group by s.table_name having pg_catalog.count(*) > 1) d;
  if v_dupe is not null then
    raise exception 'assert_retention_roll: public.% is classified more than once', v_dupe
      using errcode = '55000', hint = 'duplicate_retention_subject';
  end if;

  select pg_catalog.string_agg(s.table_name || '/' || coalesce(s.class, '<null>'), ', ' order by s.table_name)
    into v_badclass
    from private.retention_subjects() s
   where s.treatment = 'swept'
     and (s.class is null
          or not exists (select 1 from private.retention_periods() p where p.class = s.class));
  if v_badclass is not null then
    raise exception 'assert_retention_roll: % is swept under a class that is not declared', v_badclass
      using errcode = '55000', hint = 'unknown_retention_class';
  end if;
end;
$$;

comment on function private.assert_retention_roll() is
  'THE DERIVATION BESIDE THE ROLL (Phase 8 Task 6; the private.assert_fkless_identifier_roll() contract, for tables instead of columns). Run at step 0 of every retention sweep, before a row moves. FOUR refusals since 20261003002000: a table in `public` the roll does not classify (unclassified_retention_subject -- which caught public.retention_runs and public.retention_settings on the first call after they were created, which is what it is for), a roll entry naming a table that does not exist (stale_retention_subject -- a roll that has drifted off the schema is a roll nobody has read), a table classified MORE THAN ONCE (duplicate_retention_subject: the first two checks can both pass on a roll with a duplicate, and then one table carries two treatments and one of them is wrong), and a `swept` entry whose class is not declared (unknown_retention_class, which private.retention_period() would otherwise only raise at the moment that sweep ran). It asserts its own DENOMINATOR first: fewer than forty tables in `public` means the catalogue query is not seeing the schema, and every check below it would pass perfectly on an empty set.';

revoke all on function private.assert_retention_roll() from public, anon, authenticated, service_role;
grant execute on function private.assert_retention_roll() to authenticated;
