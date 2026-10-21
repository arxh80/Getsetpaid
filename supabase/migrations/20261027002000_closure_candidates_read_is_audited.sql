-- ===========================================================================
-- PHASE 8 TASK 9c, FIX ROUND 1b -- THE REASSIGN-CANDIDATES READ IS AUDITED
-- (review m1 / Q215, Q223 default).
--
-- public.closed_workspace_reassign_candidates() shows the superuser the
-- display names and roles of a closed workspace's active members. That is not
-- record content, but it IS personal data read outside impersonation, and
-- "superuser access audits itself" (CLAUDE.md § Non-negotiable rules). Each
-- successful read now writes one organisation.closure_candidates_viewed row
-- (actor, organisation, rows returned -- no names), so the function becomes
-- VOLATILE. A refused read writes nothing (it raises first).
-- The database copy of the audit catalogue gains the name (rebuilt from
-- LIVE); lib/admin/audit-actions.ts gains it in the same commit.
-- ADDITIVE. No previously applied migration is edited.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.closed_workspace_reassign_candidates(p_organisation_id uuid)
 RETURNS TABLE(user_id uuid, display_name text, role text)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_n bigint;
begin
  if not private.has_platform_permission('manage_organisation_lifecycle') then
    raise exception 'closed_workspace_reassign_candidates: caller is not the platform superuser at aal2'
      using errcode = '42501', hint = 'decision_needs_superuser';
  end if;

  if not exists (select 1 from public.organisations o
                  where o.id = p_organisation_id and o.lifecycle_state = 'owner_closed') then
    raise exception 'closed_workspace_reassign_candidates: only a workspace its Owner closed awaits this decision'
      using errcode = '22023', hint = 'closure_candidates_not_owner_closed';
  end if;

  return query
    select m.user_id, p.full_name, m.role
      from public.organisation_memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organisation_id = p_organisation_id
       and m.status = 'active'
       and m.user_id <> private.erased_user_id()
       -- 20261027001000 (Q222): never the platform superuser -- the set stays
       -- exactly what reassign_closed_workspace() accepts.
       and not exists (select 1 from public.platform_admins pa where pa.user_id = m.user_id)
     order by (m.role = 'owner') desc, (m.role = 'admin') desc, p.full_name nulls last, m.user_id
     limit 200;
  get diagnostics v_n = row_count;

  -- 20261027002000 (Task 9c fix round 1b, Q223 / review m1): THE READ AUDITS
  -- ITSELF. Display names and roles of a customer's members are personal data
  -- read outside impersonation, so -- like platform_health.viewed and
  -- feedback.screenshot_viewed -- the superuser's read writes its own row.
  -- Counts and ids only: no name, no role, no user id of any member.
  perform private.log_audit_event(
    p_action          => 'organisation.closure_candidates_viewed',
    p_target_type     => 'organisation',
    p_organisation_id => p_organisation_id,
    p_target_id       => p_organisation_id,
    p_after           => pg_catalog.jsonb_build_object('rows_returned', v_n));
end;
$function$
;

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
    ('retention.audit_ceiling_released')
$function$
;
