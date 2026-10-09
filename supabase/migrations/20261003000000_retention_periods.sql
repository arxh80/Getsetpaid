-- ===========================================================================
-- PHASE 8 TASK 6 -- RETENTION, PART 1: THE ONE DECLARED PLACE EVERY PERIOD
-- LIVES IN.
--
-- Requirement 1 of the task brief, and the reason it is requirement 1: the
-- periods in this product are a WORKING DEFAULT pending a counsel review
-- (CLAUDE.md § Legal and regulatory compliance, Q133). When counsel answers
-- "seven years is six" the change must be ONE migration that reissues ONE
-- function, not a hunt through a sweep, two read-time expiry paths, a
-- TypeScript constant and three test fixtures.
--
-- So:
--
--   private.retention_periods()   the declaration. Class, period, what it
--                                 applies to, which column the clock runs
--                                 from, and who said so.
--   private.retention_period(t)   one class's interval, refusing an unknown
--                                 class rather than returning null -- a null
--                                 interval in `now() - $1` is a null cutoff,
--                                 and `where created_at < null` deletes
--                                 nothing, silently, for ever.
--   private.retention_subjects()  THE ROLL. Every table in `public`, each one
--                                 either swept by a named class or excused
--                                 with a reason.
--   private.assert_retention_roll()
--                                 THE DERIVATION. A table the roll does not
--                                 classify raises before a row moves.
--
-- AND THE TWO EXISTING READ-TIME PATHS ARE REBUILT TO READ FROM IT, because a
-- declaration nothing reads is a comment:
--   private.organisation_retention_days()  (20260908030000) -> 'workspace'
--   private.feedback_retention_cutoff()    (20260911000000) -> 'feedback'
-- Both keep their signature, their grants and their meaning; each now derives
-- its number instead of carrying its own literal. The psql suites that pin 60
-- and 2 years go on passing unchanged, which is the check that this migration
-- changed no answer.
--
-- ===========================================================================
-- WHY A FUNCTION AND NOT A TABLE
-- ===========================================================================
-- A settings TABLE would let the periods be edited without a deploy, which
-- sounds like a feature and is the opposite of one here. These numbers are a
-- LEGAL position: "we keep financial records for seven years" is a sentence on
-- a published page (/legal/data-retention), and a row somebody can UPDATE is a
-- legal position that can be changed with no diff, no review and no record.
-- The kill switch in part 2 IS a table, because stopping a destructive job is
-- an operational emergency and waiting for a deploy is the wrong answer; the
-- periods are not, and the audit purge's hard floor (part 4) is not
-- configurable at all.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. THE DECLARATION.
--
--    IMMUTABLE: it is a constant list. That lets it be called from another
--    immutable function (private.organisation_retention_days() below is
--    immutable and stays that way) and from a generated expression later.
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
     'erasure_jobs.finished_at',
     'Q175, recommended by Task 5 for this task.'),

    ('stuck_job',
     interval '1 hour',
     'A public.export_jobs or public.erasure_jobs row left `running` this long is marked `failed` with a recorded reason. NOT A DELETION: the row survives, and the point is to release the one-live-job index so the subject can ask again.',
     'the job''s started_at',
     'Q166, recommended by Task 4 for this task; Task 5 recorded the same shape, worse, for an erasure.')
$$;

comment on function private.retention_periods() is
  'THE ONE DECLARED PLACE EVERY RETENTION PERIOD LIVES (Phase 8 Task 6, requirement 1). Ten classes, each with its interval, what it applies to, which column its clock runs from and the authority that set it. Read by private.retention_period(), by every sweep in private.run_retention_sweep(), by private.organisation_retention_days() and private.feedback_retention_cutoff() (the two read-time expiry paths that predate it and were rebuilt to derive their numbers from here), and by the psql suite. A FUNCTION rather than a settings table ON PURPOSE: these numbers are a legal position stated on a published page, and a row anybody can UPDATE is a legal position that can change with no diff, no review and no record. EVERY PERIOD IS A WORKING DEFAULT PENDING A COUNSEL REVIEW (CLAUDE.md § Legal and regulatory compliance, Q133) -- which is the whole reason they are in one place: counsel''s answer is a reissue of this one function.';

revoke all on function private.retention_periods() from public, anon, authenticated, service_role;
grant execute on function private.retention_periods() to authenticated;


-- ---------------------------------------------------------------------------
-- 2. ONE CLASS'S PERIOD, AND WHAT HAPPENS WHEN THE CLASS IS NOT A CLASS.
--
--    IT RAISES. This is not defensive decoration: the caller shape is
--    `now() - private.retention_period('...')`, and a NULL interval makes
--    that expression NULL, and `where created_at < null` matches no row. A
--    typo would therefore make a sweep delete NOTHING, FOR EVER, with no
--    error anywhere -- the exact "a check that cannot see its own subject"
--    failure this phase keeps measuring. Refusing is the only outcome a
--    reader ever finds out about.
-- ---------------------------------------------------------------------------

create or replace function private.retention_period(p_class text)
returns interval
language plpgsql
immutable
set search_path = ''
as $$
declare v_period interval;
begin
  select r.period into v_period
    from private.retention_periods() r
   where r.class = p_class;

  if v_period is null then
    raise exception 'retention_period: % is not a declared retention class', coalesce(p_class, '<null>')
      using errcode = '22023', hint = 'unknown_retention_class';
  end if;

  return v_period;
end;
$$;

comment on function private.retention_period(text) is
  'One declared class''s retention interval. RAISES 22023 (hint unknown_retention_class) on a class that is not declared, rather than returning null -- every caller''s shape is `now() - retention_period(...)`, a null interval makes that cutoff null, and `where created_at < null` matches no row: a misspelt class would make its sweep delete nothing, silently, for ever. IMMUTABLE, so it can be called from private.organisation_retention_days(), which is.';

revoke all on function private.retention_period(text) from public, anon, authenticated, service_role;
grant execute on function private.retention_period(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. THE ROLL: EVERY TABLE IN `public`, CLASSIFIED.
--
--    The fkless-identifier roll's shape (20261001000000), for the same reason
--    it has that shape: a LIST goes stale the moment somebody adds a table,
--    and a list that has gone stale is silent. This roll is paired with a
--    DERIVATION over pg_class in § 4, so a new table is a REFUSAL rather than
--    a thing nobody remembered to retain.
--
--    `treatment` is one of:
--      swept                  a sweep in private.run_retention_sweep() deletes
--                             or purges rows of this table, under `class`
--      cascades               it goes when its parent goes; no sweep of its
--                             own, and the parent's purge is asserted
--      retained_with_workspace
--                             a tenant record. It is soft-deleted, it stays
--                             readable to its workspace, and the only thing
--                             that removes it is the workspace purge. NOT a
--                             gap -- see the note below and Q180.
--      platform_reference     the product's own reference data (roles,
--                             permissions, plans, policies). Nobody's records.
--      never_purged           kept deliberately and for ever, with the reason.
--
--    WHY EVERY SOFT-DELETED CRM ROW IS NOT ON A 2-YEAR CLOCK. CLAUDE.md says
--    "soft-delete operational records ... subject to the retention policy",
--    and the honest reading of that is that a contact a workspace deleted in
--    2026 should eventually stop existing. This task does NOT build that
--    sweep, and says so rather than implying it is covered: the brief names
--    six sweeps and that is not one of them, and a job that silently began
--    hard-deleting customers' own soft-deleted CRM records two years on is
--    exactly the kind of thing that wants a founder's signature first. Q180
--    asks for it. Every such table is classified `retained_with_workspace`
--    here, so the question is visible in the roll instead of absent from it.
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
  'THE ROLL: every table in `public`, each one either swept under a declared class or excused with a reason (Phase 8 Task 6). Paired with private.assert_retention_roll(), which DERIVES the same list from pg_class and refuses a table the roll does not carry -- so a table added by a later phase stops the retention job rather than being quietly un-retained, which is the whole point. Treatments: `swept` (a named sweep deletes or purges it), `cascades` (it goes when its parent goes), `retained_with_workspace` (a tenant record, removed only by the workspace purge -- Q180 asks whether soft-deleted CRM rows should expire on their own, and this task deliberately does NOT build that), `platform_reference` (the product''s own catalogues) and `never_purged` (kept for ever, with the reason).';

revoke all on function private.retention_subjects() from public, anon, authenticated, service_role;
grant execute on function private.retention_subjects() to authenticated;


-- ---------------------------------------------------------------------------
-- 4. THE DERIVATION. "Handle or refuse each one", the C1 contract.
--
--    Two directions, because each catches a different mistake:
--      * a TABLE the roll does not classify            -> unclassified_retention_subject
--      * a ROLL ENTRY naming a table that is not there -> stale_retention_subject
--    The second matters as much as the first: a roll that has drifted off the
--    schema is a roll nobody has read, and a `swept` entry for a table that no
--    longer exists is a sweep that has been silently doing nothing.
--    And a `swept` entry whose class is not declared is refused too -- that is
--    the typo private.retention_period() would otherwise only catch at the
--    moment the sweep ran.
-- ---------------------------------------------------------------------------

create or replace function private.unclassified_retention_subjects()
returns setof text
language sql
stable
set search_path = ''
as $$
  select c.relname::text
    from pg_catalog.pg_class c
   where c.relnamespace = 'public'::pg_catalog.regnamespace
     and c.relkind in ('r', 'p')
     and not exists (
       select 1 from private.retention_subjects() s where s.table_name = c.relname::text)
   order by 1
$$;

comment on function private.unclassified_retention_subjects() is
  'Every ordinary or partitioned table in `public` that private.retention_subjects() does not carry. Must be empty; private.assert_retention_roll() raises when it is not. This is the half that makes "a new retained thing appears without a declared period" a loud failure instead of a silent one.';

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
  v_seen    bigint;
begin
  -- THE DENOMINATOR FIRST (standing lesson 1). If the roll is empty, or the
  -- catalogue query resolves nothing, every assertion below passes perfectly
  -- while seeing nothing at all. Fifty-one tables exist in `public` today; a
  -- floor of forty is loose enough never to need touching and tight enough
  -- that a derivation which resolved nothing cannot get past it.
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
  'THE DERIVATION BESIDE THE ROLL (Phase 8 Task 6; the private.assert_fkless_identifier_roll() contract, for tables instead of columns). Run at step 0 of every retention sweep, before a row moves. Three refusals: a table in `public` the roll does not classify (unclassified_retention_subject), a roll entry naming a table that does not exist (stale_retention_subject -- a roll that has drifted off the schema is a roll nobody has read), and a `swept` entry whose class is not declared (unknown_retention_class, which private.retention_period() would otherwise only raise at the moment that sweep ran). It asserts its own DENOMINATOR first: fewer than forty tables in `public` means the catalogue query is not seeing the schema, and every check below it would pass perfectly on an empty set.';

revoke all on function private.unclassified_retention_subjects() from public, anon, authenticated, service_role;
revoke all on function private.assert_retention_roll() from public, anon, authenticated, service_role;
grant execute on function private.unclassified_retention_subjects() to authenticated;
grant execute on function private.assert_retention_roll() to authenticated;


-- ---------------------------------------------------------------------------
-- 5. THE TWO READ-TIME PATHS THAT PREDATE THE DECLARATION NOW READ IT.
--
--    Both are rebuilt from their LATEST definition; neither changes its
--    signature, its volatility, its grants or its answer. That last part is
--    the check: rls_phase7_lifecycle.sql pins 60, rls_phase7_feedback.sql
--    pins the 2-year cutoff and tests/integration/rls/lifecycle-matches-db.ts
--    binds the TypeScript constant to the function. All of them go on passing,
--    which is how this migration proves it moved no number while moving where
--    the number lives.
-- ---------------------------------------------------------------------------

create or replace function private.organisation_retention_days()
returns integer
language sql
immutable
set search_path = ''
as $$
  -- date_part() rather than `extract(day from ...)`: EXTRACT is a SQL
  -- CONSTRUCT with its own grammar, so `pg_catalog.extract(day from x)` is a
  -- syntax error, and the unqualified spelling is the pg_catalog trap the CI
  -- guard exists for. date_part is an ordinary function and takes the
  -- qualification. The `workspace` period is declared in whole days, so the
  -- cast is exact rather than a truncation.
  select (pg_catalog.date_part('day', private.retention_period('workspace')))::integer
$$;

comment on function private.organisation_retention_days() is
  'The organisation wind-down retention window in days. FOUNDER RULING Q88 (2026-09-07): a suspended or deleted organisation retains its data for 60 days and may be reactivated within that window. SINCE PHASE 8 TASK 6 THE NUMBER IS NOT HERE: it is derived from private.retention_periods()''s `workspace` class, the one declared place every period in this product lives, so counsel''s answer to Q133 is a reissue of that one function and not a hunt. The function survives with its signature, its volatility and its grants unchanged because the number exists in TypeScript too (ORGANISATION_RETENTION_DAYS, lib/admin/lifecycle-contract.ts) and tests/integration/rls/lifecycle-matches-db.test.ts is the binding between them. IMMUTABLE so it can appear in a generated expression or an index predicate later. NOT legal advice: CLAUDE.md § Legal and regulatory compliance still owes a counsel review of every retention period.';

revoke all on function private.organisation_retention_days() from public, anon, authenticated, service_role;
grant execute on function private.organisation_retention_days() to authenticated;

create or replace function private.feedback_retention_cutoff()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select pg_catalog.now() - private.retention_period('feedback');
$$;

comment on function private.feedback_retention_cutoff() is
  'CLAUDE.md § In-app feedback: 2-year retention, the inactive-account default. Read-time expiry (the Q88/Task 4 pattern): feedback_select_platform and public.audit_feedback_screenshot_view() both refuse a row older than this, so an expired row is unreadable on every path. SINCE PHASE 8 TASK 6 the interval is derived from private.retention_periods()''s `feedback` class rather than written here, and the PURGE that makes an expired row absent rather than merely unreadable -- the row and its screenshot object both (Q120) -- is private.sweep_feedback(), on the one retention run.';

revoke all on function private.feedback_retention_cutoff() from public, anon, authenticated, service_role;
grant execute on function private.feedback_retention_cutoff() to authenticated;
