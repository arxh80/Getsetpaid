-- ===========================================================================
-- Q189 (founder, 2026-10-10: YES): an Owner's or Admin's own edit of
-- public.organisations -- the workspace's name or slug -- is audited.
--
-- BEFORE THIS MIGRATION, organisations was the one table in the derived
-- coverage census (private.audit_coverage(), 20261006000000) still
-- `unaudited`: organisations_update_manage_organisation lets a holder of
-- manage_organisation PATCH the row, and nothing wrote an audit row for it.
--
-- WHY A DEDICATED WRITER AND NOT THE GENERIC PAIR. private.audit_crm_change()
-- on INSERT would write a second organisation.created beside the one
-- public.create_organisation() already writes, and on UPDATE it would emit
-- .soft_deleted / .restored beside every lifecycle summary row
-- (organisation.suspended / .deleted / .reinstated / .closed_by_owner /
-- .closure_reassigned / .closure_deleted), changing the shape of every
-- lifecycle thread the Phase 7 and Phase 8 suites pin. So:
--
--   * UPDATE only. No INSERT trigger: organisations has no INSERT policy and
--     create_organisation() already audits the birth.
--   * THE LIFECYCLE COLUMNS ARE NOT THIS WRITER'S. deleted_at,
--     lifecycle_state, lifecycle_changed_at, lifecycle_reason and
--     retention_expires_at are written only by the audited lifecycle RPCs
--     (private.organisation_lifecycle_guard refuses a client write of the
--     first three, and private.organisation_lifecycle_sync derives the other
--     two). They are left out of the changed set, so an UPDATE that touches
--     only them -- every lifecycle RPC, the Owner's close_my_workspace()
--     included, which runs outside private.begin_lifecycle_transition() --
--     writes nothing here. This is stronger than the queued default's "skip
--     inside private.lifecycle_transition_in_progress()": it covers the RPCs
--     that take no marker, and it does not let a marker-holding transaction
--     rename a workspace unaudited.
--   * updated_at is left out too: the BEFORE trigger moves it on every write.
--   * VALUES ARE CARRIED FOR name AND slug ONLY. They are workspace identity
--     the platform operator already sees on /super/organisations, not tenant
--     record content (Q189's queued default). Any other changed column is
--     NAMED, never valued. lifecycle_reason is therefore never carried.
--   * Sessionless writes (auth.uid() is null: migrations, seeds, DBA repair,
--     the retention and erasure runners) write nothing -- the same exemption
--     as private.audit_crm_change(), for the same reason.
--
-- Payload shape matches the generic .updated row so the audit viewer renders
-- it the same way: before = {values}, after = {changed, values}.
-- ===========================================================================

create or replace function private.audit_organisation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_valued  text[];
begin
  if (select auth.uid()) is null then
    return null;
  end if;

  v_old := pg_catalog.to_jsonb(old);
  v_new := pg_catalog.to_jsonb(new);

  select coalesce(pg_catalog.array_agg(n.key order by n.key), '{}'::text[])
    into v_changed
    from pg_catalog.jsonb_each(v_new) n
   where n.key not in ('updated_at', 'deleted_at', 'lifecycle_state', 'lifecycle_changed_at',
                       'lifecycle_reason', 'retention_expires_at')
     and (v_old -> n.key) is distinct from n.value;

  if pg_catalog.cardinality(v_changed) = 0 then
    return null;
  end if;

  select coalesce(pg_catalog.array_agg(c order by c), '{}'::text[])
    into v_valued
    from unnest(v_changed) c
   where c in ('name', 'slug');

  perform private.log_audit_event(
    p_action          => 'organisation.updated',
    p_target_type     => 'organisation',
    p_organisation_id => new.id,
    p_target_id       => new.id,
    p_before          => pg_catalog.jsonb_build_object(
                           'values', (select coalesce(pg_catalog.jsonb_object_agg(c, v_old -> c), '{}'::jsonb)
                                        from unnest(v_valued) c)),
    p_after           => pg_catalog.jsonb_build_object(
                           'changed', pg_catalog.to_jsonb(v_changed),
                           'values',  (select coalesce(pg_catalog.jsonb_object_agg(c, v_new -> c), '{}'::jsonb)
                                         from unnest(v_valued) c)));

  return null;
end;
$$;

comment on function private.audit_organisation_update() is
  'Q189 (20261031000000): the dedicated audit writer for a member''s edit of public.organisations, as organisation.updated. AFTER UPDATE only (create_organisation() audits the birth). The changed set excludes updated_at and the five lifecycle columns (deleted_at, lifecycle_state, lifecycle_changed_at, lifecycle_reason, retention_expires_at), which only the audited lifecycle RPCs write -- so no lifecycle RPC, marker or not, produces a second row here, and lifecycle_reason is never carried. Values are carried for name and slug only (workspace identity the operator already sees); any other changed column is named, never valued. Sessionless writes (auth.uid() null) and no-op updates write nothing. SECURITY DEFINER because private.log_audit_event() is granted to no client role. private.audit_coverage() classifies organisations as dedicated because of this trigger.';

revoke all on function private.audit_organisation_update() from public, anon, authenticated, service_role;

drop trigger if exists organisations_audit_update on public.organisations;
create trigger organisations_audit_update
  after update on public.organisations
  for each row execute function private.audit_organisation_update();

-- ---------------------------------------------------------------------------
-- THE AUDIT CATALOGUE (database copy), rebuilt from LIVE (20261030001000),
-- one name added: organisation.updated, after organisation.created.
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
    ('organisation.updated'),
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
    ('organisation.closed_by_owner'),
    ('organisation.closure_reassigned'),
    ('organisation.closure_deleted'),
    ('organisation.closure_candidates_viewed'),
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
    ('retention.audit_ceiling_released'),
    ('integration.connected'),
    ('integration.revoked'),
    ('integration.token_stored'),
    ('integration.sync_failed')
$function$

;
