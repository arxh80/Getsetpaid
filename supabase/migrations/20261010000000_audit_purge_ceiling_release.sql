-- ===========================================================================
-- PHASE 8 TASK 9a, JOB 3 -- THE RELEASE VALVE FOR THE AUDIT PURGE'S SANITY
-- CEILING (Q184, founder 2026-09-30: "build the audit-purge ceiling release.
-- It is step-up gated and lasts 3 days.")
--
-- THE PROBLEM. private.purge_audit_events() refuses (hint
-- audit_purge_over_ceiling) when more than a fifth of the audit log AND more
-- than 1,000 rows are past the period. It judges EVERY candidate while a run
-- deletes at most p_limit (500), so a genuine backlog -- the job switched off
-- for months, or first enabled on a database already older than a year --
-- refuses every hour for ever. Until now the only release was a reviewed
-- migration reissuing private.audit_purge_ceiling().
--
-- WHAT "RELEASE" MEANS, PRECISELY. While a release is ACTIVE (released_at <=
-- now() < expires_at), RAIL 3 -- the sanity ceiling -- is not applied. That
-- is all it does. It does not raise the ceiling, it does not change the cut,
-- and it does not touch:
--   RAIL 1  the hard floor: the period is still checked against
--           private.audit_retention_floor() AND the literal one year, and the
--           cut is still now() minus that period, so no row younger than the
--           declared period (>= 1 year, which contains the 30-day hot window)
--           can be a candidate under a release either.
--   RAIL 2  the audit purge's own kill switch.
--   RAIL 4  the per-run ceiling: p_limit still bounds every run, oldest
--           first. At 500 rows an hourly run, a release can drain at most
--           72 x 500 = 36,000 rows -- every one of them already past a year.
--   RAIL 5  the totals before and after, in the same transaction.
-- The run's summary carries `audit_events.ceiling_released` (a boolean, so
-- private.jsonb_is_retention_summary() admits it and the panel's
-- sweptLines() skips it), so the run log says which runs ran under one.
--
-- EXACTLY 72 HOURS, AND READ-TIME EXPIRY. The founder's "3 days" is stored as
-- `interval '72 hours'` rather than '3 days', because timestamptz + '3 days'
-- is a calendar addition in the session's TimeZone and is 71 or 73 hours
-- across a clock change. Expiry is READ-TIME, the pattern every other
-- override in this schema uses (private.active_billing_override(),
-- organisation_feature_overrides): private.audit_ceiling_release_active()
-- answers "is one active NOW", so a release that has passed its expiry stops
-- counting with no cron job to revert it and nothing to forget. The length is
-- held in TWO places on purpose, the house double-literal of rail 1: a CHECK
-- on the row (expires_at = released_at + 72 hours) and the reader's own
-- comparison, so editing either alone does not lengthen a release.
--
-- ONE ACTIVE RELEASE AT A TIME. The release lives on the one
-- public.retention_settings row (the kill switches' row), so there is
-- structurally at most one. A second release while one is active is REFUSED
-- (hint audit_ceiling_release_already_active) rather than extending it: an
-- extension would let three days be chained into an open-ended release by
-- pressing a button every third day without any fresh decision being
-- visible. After expiry a new release may be recorded; it is a new decision
-- with its own reason and its own audit row, and the history of every
-- release is the audit log (retention.audit_ceiling_released), not this row.
-- There is no early revoke: the release can only make runs proceed that the
-- floor already permits, and an operator who wants the purge to stop has the
-- audit purge's kill switch beside it.
--
-- WHO. public.release_audit_purge_ceiling(p_reason) is the only writer:
-- private.has_platform_permission() -- the single hardcoded superuser AND an
-- aal2 session (step-up), as public.set_retention_enabled() -- a mandatory
-- non-blank reason of at most 500 characters, and an audit row
-- (retention.audit_ceiling_released) carrying the reason and the window. The
-- operator is the audit row's actor (private.log_audit_event() takes it from
-- auth.uid(), never from an argument), so the row stores no user id: a new
-- uuid column would be a fresh row -> user path for the export and erasure
-- rolls to classify, for a fact the audit log already holds non-forgeably.
--
-- WHAT THE SETTINGS ROW'S updated_at NOW MEANS. The row's set_updated_at
-- trigger (20261003010000) fires on a release too, so updated_at is "the
-- row last changed", not "the switches last changed". The panel reads the
-- release columns for the release and the switches' own reason for theirs.
--
-- ADDITIVE. private.purge_audit_events() and private.platform_audit_actions()
-- are rebuilt from their LATEST definitions (pg_get_functiondef at 212
-- migrations), each with the one change named above. No applied migration is
-- edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The release, on the one settings row.
-- ---------------------------------------------------------------------------
alter table public.retention_settings
  add column audit_ceiling_released_at        timestamptz,
  add column audit_ceiling_release_expires_at timestamptz,
  add column audit_ceiling_release_reason     text;

alter table public.retention_settings
  add constraint retention_settings_audit_ceiling_release_shape check (
    (audit_ceiling_released_at is null
       and audit_ceiling_release_expires_at is null
       and audit_ceiling_release_reason is null)
    or
    (audit_ceiling_released_at is not null
       and audit_ceiling_release_expires_at = audit_ceiling_released_at + interval '72 hours'
       and audit_ceiling_release_reason is not null
       and pg_catalog.btrim(audit_ceiling_release_reason) <> ''
       and pg_catalog.char_length(audit_ceiling_release_reason) <= 500));

comment on column public.retention_settings.audit_ceiling_released_at is
  'When the most recent release of the audit purge''s sanity ceiling (Q184, founder 2026-09-30) was recorded, by public.release_audit_purge_ceiling() alone. Null = never released. A release is ACTIVE while released_at <= now() < audit_ceiling_release_expires_at, asked at read time by private.audit_ceiling_release_active(); an expired release stays on the row as the last one recorded and counts for nothing.';
comment on column public.retention_settings.audit_ceiling_release_expires_at is
  'Exactly 72 hours after audit_ceiling_released_at (the founder''s "3 days", as hours so a clock change cannot make it 71 or 73), held by the CHECK retention_settings_audit_ceiling_release_shape AND re-checked by private.audit_ceiling_release_active() -- two places, so editing either alone does not lengthen a release.';
comment on column public.retention_settings.audit_ceiling_release_reason is
  'The operator''s mandatory reason for the most recent ceiling release (non-blank, at most 500 characters). Also in the payload of its retention.audit_ceiling_released audit row, which is where the history of every release lives; this column is only the latest.';

-- ---------------------------------------------------------------------------
-- 2. The read-time question the purge asks.
-- ---------------------------------------------------------------------------
create or replace function private.audit_ceiling_release_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.audit_ceiling_released_at <= pg_catalog.now()
       and pg_catalog.now() < s.audit_ceiling_release_expires_at
       and s.audit_ceiling_release_expires_at <= s.audit_ceiling_released_at + interval '72 hours'
      from public.retention_settings s
     where s.id), false);
$$;

revoke all on function private.audit_ceiling_release_active() from public, anon, authenticated;

comment on function private.audit_ceiling_release_active() is
  'Is a release of the audit purge''s sanity ceiling active NOW (Q184, founder 2026-09-30)? Read-time expiry: true only while audit_ceiling_released_at <= now() < audit_ceiling_release_expires_at AND the window is no longer than 72 hours -- the length checked here as well as in the row''s CHECK. STABLE, never IMMUTABLE: its answer changes with the clock, which is the whole point. Asked by private.purge_audit_events() before rail 3; reachable by no client role.';

-- ---------------------------------------------------------------------------
-- 3. The RPC.
-- ---------------------------------------------------------------------------
create or replace function public.release_audit_purge_ceiling(p_reason text)
returns public.retention_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.retention_settings%rowtype;
  v_after  public.retention_settings%rowtype;
begin
  -- THE PLATFORM SUPERUSER, AT aal2. private.has_platform_permission() is
  -- both halves: the one platform_admins row AND private.session_is_aal2().
  -- Step-up is "any high-risk admin/superuser function" (CLAUDE.md § Session
  -- security) and this one lets the largest delete in the product proceed.
  if not private.has_platform_permission('manage_retention') then
    raise exception 'release_audit_purge_ceiling: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'audit_ceiling_release_is_superuser_only';
  end if;
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'release_audit_purge_ceiling: a reason is required'
      using errcode = '22023', hint = 'audit_ceiling_release_needs_a_reason';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'release_audit_purge_ceiling: the reason is longer than 500 characters'
      using errcode = '22023', hint = 'audit_ceiling_release_reason_too_long';
  end if;

  -- ONE AT A TIME. The row lock serialises two presses; the check refuses a
  -- second release while one is active rather than extending it.
  select * into v_before from public.retention_settings s where s.id for update;
  if private.audit_ceiling_release_active() then
    raise exception 'release_audit_purge_ceiling: a release is already active until %',
      v_before.audit_ceiling_release_expires_at
      using errcode = '55000', hint = 'audit_ceiling_release_already_active';
  end if;

  update public.retention_settings s
     set audit_ceiling_released_at        = pg_catalog.now(),
         audit_ceiling_release_expires_at = pg_catalog.now() + interval '72 hours',
         audit_ceiling_release_reason     = pg_catalog.btrim(p_reason)
   where s.id
  returning * into v_after;

  perform private.log_audit_event(
    'retention.audit_ceiling_released', 'platform',
    null, null, null,
    pg_catalog.jsonb_build_object(
      'released_at', v_before.audit_ceiling_released_at,
      'expires_at',  v_before.audit_ceiling_release_expires_at),
    pg_catalog.jsonb_build_object(
      'released_at', v_after.audit_ceiling_released_at,
      'expires_at',  v_after.audit_ceiling_release_expires_at,
      'reason',      v_after.audit_ceiling_release_reason));

  return v_after;
end;
$$;

revoke all on function public.release_audit_purge_ceiling(text) from public, anon;
grant execute on function public.release_audit_purge_ceiling(text) to authenticated;

comment on function public.release_audit_purge_ceiling(text) is
  'Release the audit purge''s sanity ceiling (rail 3) for exactly 72 hours (Q184, founder 2026-09-30). Platform superuser at aal2 only (hint audit_ceiling_release_is_superuser_only); a non-blank reason of at most 500 characters (audit_ceiling_release_needs_a_reason / _reason_too_long); refused while a release is already active (audit_ceiling_release_already_active) -- no extension, no chaining. Audited as retention.audit_ceiling_released with the reason and the window. Lifts rail 3 ONLY: the hard floor, the kill switch, the per-run ceiling and the before/after totals all still apply, so a release can only let runs delete rows already past the declared (>= 1 year) period, at most p_limit per run. Expires by itself at read time (private.audit_ceiling_release_active()); nothing reverts it.';

-- ---------------------------------------------------------------------------
-- 4. The purge, rebuilt from its LATEST definition with rail 3 asking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.purge_audit_events(p_dry boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_period    interval;
  v_floor     interval;
  v_cut       timestamptz;
  v_before    bigint;
  v_after     bigint;
  v_candidates bigint;
  v_n         bigint;
  v_share     numeric;
  v_min_rows  bigint;
  v_enabled   boolean;
  v_released  boolean;
begin
  -- (0) NEVER UNDER `replica`. The house control, and here for the reason
  -- private.erase_organisation() carries it: `replica` is the standard advice
  -- for making a large delete fast, this is the largest delete in the
  -- product, and a delete that does not fire its triggers is a delete nobody
  -- can reason about afterwards.
  if pg_catalog.current_setting('session_replication_role', true) is distinct from 'origin' then
    raise exception 'purge_audit_events: refuses to run with session_replication_role = %',
      pg_catalog.current_setting('session_replication_role', true)
      using errcode = '55000', hint = 'replication_role_must_be_origin';
  end if;

  -- RAIL 2 -- THE KILL SWITCH, asked before anything is counted.
  select s.audit_purge_enabled into v_enabled from public.retention_settings s where s.id;
  if v_enabled is distinct from true then
    return pg_catalog.jsonb_build_object('audit_events.refused', true,
                                         'audit_events.refused_because', 'audit_purge_disabled');
  end if;

  v_period := private.retention_period('audit_total');
  v_floor  := private.audit_retention_floor();

  -- RAIL 1 -- THE HARD FLOOR, compared against BOTH the function and this
  -- function's own literal. Two comparisons rather than one because a single
  -- one would be lowered by editing private.audit_retention_floor() alone,
  -- which is a one-line migration that does not look like what it is.
  if v_period < v_floor or v_period < interval '1 year' then
    raise exception 'purge_audit_events: the declared audit retention period (%) is below the hard floor (%)',
      v_period, greatest(v_floor, interval '1 year')
      using errcode = '55000', hint = 'audit_retention_below_floor';
  end if;

  v_cut := pg_catalog.now() - v_period;

  -- RAIL 5 -- THE COUNT BEFORE. In the same transaction as the delete, so
  -- the arithmetic in the run log is a fact about one moment and not two.
  select pg_catalog.count(*) into v_before from public.audit_events;
  select pg_catalog.count(*) into v_candidates
    from public.audit_events a where a.created_at < v_cut;

  -- RAIL 3 -- THE SANITY CEILING, and its RELEASE (Q184, founder
  -- 2026-09-30). A release recorded by public.release_audit_purge_ceiling()
  -- lifts THIS rail alone, and only while it is active NOW: the question is
  -- asked at read time, so a release that has passed its 72 hours stops
  -- counting without any job reverting it. Rails 1, 2, 4 and 5 are untouched
  -- by it -- the cut above is still now() minus a period the hard floor has
  -- already held to at least a year, and p_limit still bounds the run.
  v_released := private.audit_ceiling_release_active();
  select c.max_share, c.min_rows into v_share, v_min_rows
    from private.audit_purge_ceiling() c;
  if not v_released
     and v_candidates > v_min_rows and v_candidates > 1000
     and v_before > 0
     and (v_candidates::numeric / v_before::numeric) > least(v_share, 0.20) then
    raise exception 'purge_audit_events: % of % audit rows -- % per cent -- is past the sanity ceiling',
      v_candidates, v_before,
      pg_catalog.round(100.0 * v_candidates::numeric / v_before::numeric, 1)
      using errcode = '55000', hint = 'audit_purge_over_ceiling';
  end if;

  if p_dry then
    -- The same query the delete uses, bounded the same way. A dry run that
    -- reports a different number from the live run that follows it is a bug,
    -- not a rounding difference.
    select pg_catalog.count(*) into v_n
      from (select 1 from public.audit_events a
             where a.created_at < v_cut
             order by a.created_at
             limit p_limit) t;
    v_after := v_before;
  else
    -- RAIL 4 -- BOUNDED AND RESUMABLE. Oldest first: a backlog drains in
    -- order, and a run that hits the ceiling leaves the NEWER remainder
    -- rather than skipping an arbitrary slice for ever.
    with doomed as (
      select a.id from public.audit_events a
       where a.created_at < v_cut
       order by a.created_at
       limit p_limit)
    delete from public.audit_events a using doomed d where a.id = d.id;
    get diagnostics v_n = row_count;
    select pg_catalog.count(*) into v_after from public.audit_events;
  end if;

  return pg_catalog.jsonb_build_object(
    'audit_events.rows',          v_n,
    'audit_events.capped',        v_n >= p_limit,
    'audit_events.total_before',  v_before,
    'audit_events.total_after',   v_after,
    'audit_events.candidates',    v_candidates,
    'audit_events.ceiling_released', v_released);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The audit action catalogue, rebuilt from its LATEST definition with the
--    one new action (lib/admin/audit-actions.ts PLATFORM_AUDIT_ACTIONS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.platform_audit_actions()
 RETURNS SETOF text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
    ('membership.deleted'),
    -- PLATFORM_AUDIT_ACTIONS, in catalogue order.
    ('organisation.created'),
    ('membership.accepted'),
    ('document_uploaded'),
    ('document_downloaded'),
    ('document_deleted'),
    ('document_quarantined'),
    ('network_profile.published'),
    ('network_profile.unpublished'),
    ('network_profile.visibility_changed'),
    ('network_connection.requested'),
    ('network_connection.accepted'),
    ('network_connection.declined'),
    ('network_connection.withdrawn'),
    ('network_connection.updated'),
    ('audit_log.viewed'),
    ('impersonation.requested'),
    ('impersonation.accepted'),
    ('impersonation.declined'),
    ('impersonation.started'),
    ('impersonation.page_viewed'),
    ('impersonation.ended'),
    ('impersonation.expired'),
    ('organisation.suspended'),
    ('organisation.deleted'),
    ('organisation.reinstated'),
    ('organisation.billing_override_granted'),
    ('organisation.billing_override_revoked'),
    ('organisation.feature_override_granted'),
    ('organisation.feature_override_revoked'),
    ('platform_health.viewed'),
    ('incident_alert.resolved'),
    ('incident_alert.reopened'),
    ('feedback.submitted'),
    ('feedback.status_changed'),
    ('feedback.screenshot_viewed'),
    ('legal_document.draft_created'),
    ('legal_document.draft_updated'),
    ('legal_document.published'),
    ('legal_document.counsel_review_recorded'),
    ('consent.granted'),
    ('consent.withdrawn'),
    ('data_subject_request.submitted'),
    ('data_subject_request.in_progress'),
    ('data_subject_request.routed'),
    ('data_subject_request.fulfilled'),
    ('data_subject_request.rejected'),
    ('data_subject_request.withdrawn'),
    ('data_subject_request.fulfilment_recorded'),
    ('data_subject_request.note_added'),
    ('data_subject_request.rerouted'),
    ('export_job.requested'),
    ('export_job.downloaded'),
    ('erasure_job.requested'),
    ('account.erased'),
    ('organisation.erased'),
    ('retention_settings.changed'),
    ('retention.swept'),
    ('retention.audit_ceiling_released')
$function$;

-- ---------------------------------------------------------------------------
-- 6. The clock roll (20261004001000, RK26), rebuilt from its LATEST
--    definition with the release's two timestamps classified. The roll found
--    them on this migration's first run: a retention function now reads them,
--    and an unclassified column it reads refuses every run
--    (undeclared_retention_clock) -- the derivation doing its job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.retention_clock_columns()
 RETURNS TABLE(schema_name text, table_name text, column_name text, role text, guard text, note text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  values
    ('public', 'audit_events', 'created_at', 'clock', null,
     'audit_total. No client role holds INSERT or UPDATE on the table; rows are written by definer functions and triggers.'),

    ('public', 'documents', 'deleted_at', 'clock',
     'trigger:private.guard_document_retention_columns',
     'operational / financial. THE COLUMN REVIEW FINDING C1 WAS ABOUT. A client holds UPDATE on it because soft-delete and restore are its own writes; the guard overwrites a null -> value transition with now() and refuses a re-date (20261004000000). Not in the INSERT grant.'),
    ('public', 'documents', 'retention_class', 'clock',
     'trigger:private.guard_document_retention_columns',
     'THE PERIOD HALF OF THE SAME CLOCK (fix round 2, I-N1 / Q186): which of operational / financial applies, frozen by the guard when deleted_at is set, cleared on restore, immutable otherwise for every writer. No client grant at all; derived onto this roll as the column the sweep hands to retention_period().'),
    ('public', 'documents', 'bytes_purged_at', 'clock', null,
     'The record that the sweep ran, and the term that takes a document OUT of every future sweep. No client grant at all since 20261004000000; the guard refuses it too if one is ever added.'),
    ('public', 'documents', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s. No client grant since 20261004000000 either.'),

    ('public', 'erasure_jobs', 'completed_at', 'clock', null,
     'erasure_job_failed. No client write path: the table''s outcome columns are server-only (20260930001000).'),
    ('public', 'erasure_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),
    ('public', 'export_jobs', 'completed_at', 'clock', null,
     'Written by the reaper, read by nothing as a cutoff; classified `clock` rather than excused because no client can write it and the stricter answer costs nothing.'),
    ('public', 'export_jobs', 'expires_at', 'clock', null,
     'The export archive''s own expiry, which the manifest reads. No client write path.'),
    ('public', 'export_jobs', 'started_at', 'clock', null,
     'stuck_job (the reaper). No client write path.'),

    ('public', 'feedback', 'created_at', 'clock', null,
     'feedback. Outside the column-level INSERT grant (20260911000000); no client UPDATE at all.'),

    ('public', 'incident_alerts', 'resolved_at', 'clock',
     'trigger:private.incident_alert_resolution_guard',
     'incident_alert. A client (the aal2 operator) holds UPDATE on it, column-level; the guard forces it to now() whenever resolved_by is set and refuses a resolved_by that is not the caller (fix round 2 of Phase 8 Task 3, Q162).'),

    ('public', 'merge_candidates', 'deleted_at', 'not_a_clock', null,
     'A false candidate the fixed-point walk (m-N1) reaches through private.erase_account(): that function''s `deleted_at` is organisations'', read as a filter on which workspaces are live, never as a cutoff. No client role holds UPDATE on merge_candidates.deleted_at.'),
    ('public', 'notes', 'deleted_at', 'not_a_clock', null,
     'A false candidate reached the same way: erase_account() hard-deletes a private note by ownership, not by age. A client holds UPDATE on notes.deleted_at (soft-delete/restore are its own writes), which is harmless because nothing judges a note on it.'),

    ('public', 'organisations', 'deleted_at', 'clock',
     'trigger:private.organisation_lifecycle_guard',
     'workspace. The guard refuses any session write to it outside an audited lifecycle RPC, with the hint organisation_lifecycle_is_the_rpcs (m-N2) so the probe can tell it from organisations_update_manage_organisation''s WITH CHECK, which carries `deleted_at is null` and refuses the same write with the same SQLSTATE -- a second layer, not the named one.'),
    ('public', 'organisations', 'retention_expires_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace. RECOMPUTED on every write by the sync trigger from lifecycle_changed_at, and nulled whenever the workspace is live -- so a written value never survives the statement that wrote it.'),
    ('public', 'organisations', 'lifecycle_changed_at', 'clock',
     'trigger:private.organisation_lifecycle_sync',
     'workspace -- THE REAL CLOCK, and one the derivation cannot reach: no retention function names it, the sync trigger computes retention_expires_at from it. Nulled on a live workspace; on a closed one it is writable only by a session the UPDATE policies admit, which is the audited lifecycle RPCs and nobody else.'),
    ('public', 'organisations', 'created_at', 'not_a_clock', null,
     'A false candidate: the manifest''s `created_at` is storage.objects'' and feedback''s.'),

    ('public', 'rate_limit_counters', 'window_start', 'clock', null,
     'rate_limit_counter. No client role can write or read a counter (20260909020000).'),

    ('public', 'retention_settings', 'audit_ceiling_released_at', 'clock', null,
     'The start of an audit-purge ceiling release (Q184, founder 2026-09-30, 20261010000000), read by private.audit_ceiling_release_active() -- not a cutoff for any row, but it decides whether rail 3 applies, so it is classified as a clock rather than excused. No client role holds INSERT or UPDATE on retention_settings (RC4); written only by public.release_audit_purge_ceiling(), with now().'),
    ('public', 'retention_settings', 'audit_ceiling_release_expires_at', 'clock', null,
     'The end of that release: released_at + 72 hours, held by the CHECK retention_settings_audit_ceiling_release_shape and re-checked by the reader. Same writer, same absence of any client grant.'),

    ('storage', 'objects', 'created_at', 'clock',
     'no_permissive_policy,policy:documents_deny_client_insert,policy:documents_deny_client_update,policy:feedback_screenshots_deny_client_insert,policy:feedback_screenshots_deny_client_update,policy:exports_deny_client_insert,policy:exports_deny_client_update',
     'storage_orphan. Supabase grants client roles table-wide privileges on storage.objects and this product fences its three buckets with RESTRICTIVE deny-all policies; the six named here are the INSERT and UPDATE halves of that fence. THE LAYER THAT ACTUALLY REFUSES TODAY IS DEFAULT DENY -- no permissive policy admits a client role at all (m-N2) -- so `no_permissive_policy` is named first: adding one is a forgeable_retention_clock refusal, and the restrictive six are the layer behind it. The probe measures their composite.')
$function$;
