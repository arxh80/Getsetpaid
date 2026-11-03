-- ===========================================================================
-- PHASE 8 TASK 6 -- THE ERASURE'S FK-LESS IDENTIFIER ROLL LEARNS THIS TASK'S
-- OWN NEW COLUMN.
--
-- NOT A TIDY-UP. `private.assert_fkless_identifier_roll()` runs at step 0 of
-- BOTH private.erase_account() and private.erase_organisation(), and it
-- REFUSES when the catalogue has grown a uuid column in no foreign key that
-- the roll does not classify. 20261003001000 added
-- public.retention_runs.correlation_id, which is exactly that shape -- so from
-- the moment that table existed, EVERY ACCOUNT ERASURE AND EVERY WORKSPACE
-- PURGE IN THE PRODUCT REFUSED:
--
--   ERROR:  erase_organisation: public.retention_runs.correlation_id is a uuid
--           column in no foreign key that the roll does not classify
--   HINT:   unclassified_fkless_identifier
--
-- Measured, not imagined: rls_phase8_retention.sql § RW went red on its first
-- run with that hint, on four assertions, and § RR9 counted seven sweeps where
-- eight were expected because the workspace purge had raised. Task 5's C1 fix
-- is doing precisely the job it was built for -- refusing rather than silently
-- leaving an identifier behind -- one task later and against the task that
-- added the column.
--
-- THE CLASSIFICATION IS `other` / `not_a_person`, beside
-- public.audit_events.correlation_id, its twin: a correlation id identifies a
-- RUN OF A JOB. It cannot name a person or a workspace, and re-pointing or
-- deleting it would break the one thing it is for, which is tying a run's
-- audit rows together.
--
-- ADDITIVE. private.fkless_identifier_columns() is rebuilt from its LATEST
-- definition, read out of pg_get_functiondef rather than out of the migration
-- that created it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION private.fkless_identifier_columns()
 RETURNS TABLE(table_name text, column_name text, identifies text, treatment text, predicate text, note text)
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      ('public.merge_candidates',     'duplicate_id',         'record', 'not_a_person', null, 'the proposed duplicate'),
      -- PHASE 8 TASK 6. public.retention_runs.correlation_id is the thread a
      -- retention run's audit rows are written on -- audit_events.correlation_id's
      -- twin, and classified the same way for the same reason: it identifies a
      -- RUN OF A JOB and can never name a person or a workspace. It is on this
      -- roll because it MADE THE ERASURE REFUSE the moment the table existed
      -- (55000 / unclassified_fkless_identifier, measured by
      -- rls_phase8_retention.sql § RW on its first run), which is exactly what
      -- the derivation is for.
      ('public.retention_runs',       'correlation_id',       'other',  'not_a_person', null, 'the thread one retention run''s audit rows are written on')
    ) as r(table_name, column_name, identifies, treatment, predicate, note)
$function$;
