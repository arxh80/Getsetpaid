-- ===========================================================================
-- PHASE 8 TASK 6, FIX ROUND 2 -- RE-REVIEW FINDING m-N4.
--
-- THE AUDIT ACTION CATALOGUE, IN THE DATABASE, BOUND TO THE TYPESCRIPT ONE.
--
-- Fix round 1's RA-I1 ("the purge exempts no action") plants every action
-- the product writes either side of the retention period and asserts the
-- purged and surviving SETS. Its action set was DERIVED by regex from
-- function source, trigger arguments and whatever was already in the table.
-- The re-review compared that set with lib/admin/audit-actions.ts's
-- knownAuditActions() -- the product's own catalogue, already bound to the
-- database by tests/integration/admin/audit-actions-match-db.test.ts -- and
-- found ELEVEN catalogue names outside it: the five DSR transitions built as
-- 'data_subject_request.' || status, impersonation.ended / .expired built
-- from the terminal state, and the four dot-less document_* actions passed
-- in from TypeScript to private.audit_document_action(). The regexes could
-- see none of them from any side, and the "already in the table" arm
-- contributes nothing in the standalone loop every mutation is measured in.
-- Measured: exempting three of the eleven by name -- keep
-- document_downloaded, impersonation.ended and data_subject_request.rejected
-- for ever -- reddened 0 of 221.
--
-- So the catalogue now exists in the database, and the planted set is the
-- regex derivation UNION the catalogue:
--
--   private.platform_audit_actions()
--       The hand-listed half, IMMUTABLE, a `values` list: the platform
--       actions and the four irreversible CRM ones. The SAME list as
--       PLATFORM_AUDIT_ACTIONS + CRM_IRREVERSIBLE_AUDIT_ACTIONS in
--       lib/admin/audit-actions.ts, and bound to it in BOTH directions:
--         * in CI, with no database:
--           tests/unit/admin/audit-action-catalogue.test.ts reads this
--           function's LATEST body from the migrations (the
--           sql-definitions.ts walk) and asserts the two lists are equal;
--         * against the live database: catalogue-bindings-match-db.test.ts
--           asserts that body IS pg_proc.prosrc, and
--           audit-actions-match-db.test.ts asserts the whole
--           private.audit_action_catalogue() equals knownAuditActions().
--       A name added on either side and not the other is a red test.
--
--   private.audit_action_catalogue()
--       The whole catalogue: the list above UNION the CRM half DERIVED from
--       the same two facts lib/admin/audit-actions.ts derives it from -- the
--       target argument of every private.audit_crm_change() trigger, and
--       whether the table carries deleted_at (created/updated for every
--       target; soft_deleted/restored only where it can).
--
-- Then rls_phase8_retention.sql § RA-I1 plants
--   rt.i1_actions := <regex derivation> UNION private.audit_action_catalogue()
-- asserts the eleven by name (RA-I1a2), and the three-name exemption reds
-- RA-I1c and RA-I1d.
--
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

create or replace function private.platform_audit_actions()
returns setof text
language sql
immutable
set search_path = ''
as $$
  values
    -- The four irreversible CRM actions (CRM_IRREVERSIBLE_AUDIT_ACTIONS).
    ('contact_company.deleted'),
    ('custom_field_value.deleted'),
    ('records.merged'),
    ('records.merged.fields'),
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
    ('retention.swept')
$$;

comment on function private.platform_audit_actions() is
  'THE HAND-LISTED HALF OF THE AUDIT ACTION CATALOGUE (Phase 8 Task 6 fix round 2, re-review finding m-N4): the platform actions and the four irreversible CRM actions, the same list as PLATFORM_AUDIT_ACTIONS + CRM_IRREVERSIBLE_AUDIT_ACTIONS in lib/admin/audit-actions.ts, bound to it in CI by tests/unit/admin/audit-action-catalogue.test.ts (which reads this body from the migrations) and against the live database by catalogue-bindings-match-db.test.ts and audit-actions-match-db.test.ts. IMMUTABLE and a `values` list on purpose: the catalogue is a fact about what the product writes, and a name that exists on one side only is a red test. Read by private.audit_action_catalogue().';

revoke all on function private.platform_audit_actions() from public, anon, authenticated, service_role;


create or replace function private.audit_action_catalogue()
returns setof text
language sql
stable
set search_path = ''
as $$
  select a from private.platform_audit_actions() a
  union
  -- THE CRM HALF, DERIVED from the same two facts lib/admin/audit-actions.ts
  -- derives it from: the target argument of every audit_crm_change trigger,
  -- and whether the table soft-deletes.
  select t.target || '.' || v.verb
    from (select distinct
                 pg_catalog.replace(pg_catalog.encode(g.tgargs, 'escape'), '\000', '') as target,
                 exists (select 1 from pg_catalog.pg_attribute a
                          where a.attrelid = g.tgrelid and a.attname = 'deleted_at'
                            and not a.attisdropped) as soft_deletable
            from pg_catalog.pg_trigger g
            join pg_catalog.pg_proc p on p.oid = g.tgfoid
           where not g.tgisinternal
             and p.pronamespace = 'private'::pg_catalog.regnamespace
             and p.proname = 'audit_crm_change') t
    cross join (values ('created', false), ('updated', false),
                       ('soft_deleted', true), ('restored', true)) v(verb, needs_deleted_at)
   where not v.needs_deleted_at or t.soft_deletable
$$;

comment on function private.audit_action_catalogue() is
  'EVERY AUDIT ACTION NAME THE PRODUCT WRITES, as one set (Phase 8 Task 6 fix round 2, m-N4): private.platform_audit_actions() UNION the CRM half derived from the audit_crm_change triggers'' target arguments and each table''s deleted_at column -- the same derivation as crmAuditActions() in lib/admin/audit-actions.ts. Asserted equal to knownAuditActions() by tests/integration/admin/audit-actions-match-db.test.ts, and unioned into the set rls_phase8_retention.sql § RA-I1 plants either side of the audit period, so that the purge''s "exempts no action" is measured over the whole catalogue and not only over what a regex could read out of function source.';

revoke all on function private.audit_action_catalogue() from public, anon, authenticated, service_role;
