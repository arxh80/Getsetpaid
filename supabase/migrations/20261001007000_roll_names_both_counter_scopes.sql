-- ===========================================================================
-- PHASE 8 TASK 5, FIX ROUND 1 -- THE ROLL GAINS THE ROW IT WAS MISSING.
--
-- private.fkless_identifier_columns() (20261001000000) classified
-- public.rate_limit_counters.subject_id on its `user` scope only. The column
-- is polymorphic -- `subject_scope` says whether the uuid is a person's or a
-- workspace's -- so the workspace purge, which runs the roll's
-- `organisation` half since 20261001004000, found nothing to do and a purged
-- workspace kept its counters. Measured by the suite's own EO18, which is
-- what a derived roll is for: the assertion existed before the row did.
--
-- ADDITIVE. Rebuilt from its LATEST definition; one row added, nothing else
-- moves. The derivation assertion is unaffected (the column was already
-- classified once, which is what it checks), so this is about the erasure
-- DOING the work rather than about refusing.
-- ===========================================================================

create or replace function private.fkless_identifier_columns()
returns table (table_name text, column_name text, identifies text,
               treatment text, predicate text, note text)
language sql
immutable
security definer
set search_path = ''
as $$
  select *
    from (values
      -- THE PERSON-BEARING ONES. Every one of these is why this roll exists.
      ('public.merges',           'winner_owner_user_id',    'user', 'null_on_match', null,
       'who owned the surviving record at the moment of the merge'),
      ('public.merges',           'loser_owner_user_id',     'user', 'null_on_match', null,
       'who owned the discarded record at the moment of the merge'),
      ('public.merge_candidates', 'keep_owner_user_id',      'user', 'null_on_match', null,
       'C1: written by public.screen_for_duplicates() on EVERY flagged duplicate'),
      ('public.merge_candidates', 'duplicate_owner_user_id', 'user', 'null_on_match', null,
       'C1: the same, for the proposed duplicate'),
      ('public.rate_limit_counters', 'subject_id',           'user', 'delete_row',
       'subject_scope = ''user''',
       'enforcement state about somebody who will not be asking for anything else; deleted rather than re-pointed, so an erased budget cannot throttle the tombstone'),
      ('public.rate_limit_counters', 'subject_id',           'organisation', 'delete_row',
       'subject_scope = ''organisation''',
       'the same column again, on its other scope: enforcement state about a workspace that has been purged, which the workspace purge deletes (fix round 1 -- the roll named only the `user` scope, so a purged workspace kept its counters)'),
      ('public.audit_events',     'target_id',               'polymorphic', 'handled_explicitly', null,
       'erase_account() step 6b re-points it at the tombstone AND drops the payload; a workspace purge leaves it, because a workspace is not a data subject'),

      -- THE WORKSPACE-BEARING ONE.
      ('public.feedback', 'support_access_organisation_id', 'organisation', 'null_on_match', null,
       'a snapshot of the workspace a superuser was inside when the feedback was written; no foreign key, so a purge would leave it naming a workspace that is gone'),

      -- AND THE REST, CLASSIFIED SO THAT THE DENOMINATOR IS THE CATALOGUE AND
      -- NOT A HABIT. None of these can hold a person or a workspace.
      ('public.audit_events',         'correlation_id',       'other',  'not_a_person', null, 'a thread id'),
      ('public.data_subject_requests','fulfilment_reference', 'other',  'not_a_person', null, 'an export or erasure job id'),
      ('public.feedback',             'support_access_session_id','other','not_a_person', null, 'an impersonation session id'),
      ('public.custom_field_values',  'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.document_links',       'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.meeting_links',        'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.note_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.task_links',           'entity_id',            'record', 'not_a_person', null, 'the polymorphic CRM row'),
      ('public.network_links',        'private_entity_id',    'record', 'not_a_person', null, 'this workspace''s own CRM row'),
      ('public.network_profiles',     'entity_id',            'record', 'not_a_person', null, 'the published entity'),
      ('public.merges',               'winner_id',            'record', 'not_a_person', null, 'the surviving CRM row'),
      ('public.merges',               'loser_id',             'record', 'not_a_person', null, 'the discarded CRM row'),
      ('public.merge_candidates',     'keep_id',              'record', 'not_a_person', null, 'the proposed survivor'),
      ('public.merge_candidates',     'duplicate_id',         'record', 'not_a_person', null, 'the proposed duplicate')
    ) as r(table_name, column_name, identifies, treatment, predicate, note)
$$;

comment on function private.fkless_identifier_columns() is
  'THE ROLL OF UUID COLUMNS NO FOREIGN KEY PROTECTS (Phase 8 Task 5 fix round 1, C1). Every uuid column in public/private that is not its own table''s primary key and is in no foreign key, classified by WHOSE identifier it can hold and given the treatment an erasure applies. private.erase_account() and private.erase_organisation() RUN this roll instead of a hand-written list, and private.assert_fkless_identifier_roll() makes the catalogue agree with it -- because a column with no foreign key is invisible to every pg_constraint walk in both functions, which is exactly how merge_candidates'' two owner-id snapshots survived a completed erasure while the code''s own comment said they did not.';

comment on function private.fkless_identifier_columns() is
  'THE ROLL OF UUID COLUMNS NO FOREIGN KEY PROTECTS (Phase 8 Task 5 fix round 1, C1; the organisation-scoped rate_limit_counters row added in 20261001007000). Every uuid column in public/private that is not its own table''s primary key and is in no foreign key, classified by WHOSE identifier it can hold and given the treatment an erasure applies -- and public.rate_limit_counters.subject_id appears TWICE, once per scope, because one column there holds either a person''s id or a workspace''s. private.erase_account() and private.erase_organisation() RUN this roll instead of a hand-written list, and private.assert_fkless_identifier_roll() makes the catalogue agree with it -- because a column with no foreign key is invisible to every pg_constraint walk in both functions, which is exactly how merge_candidates'' two owner-id snapshots survived a completed erasure while the code''s own comment said they did not.';

revoke all on function private.fkless_identifier_columns() from public, anon, authenticated, service_role;
