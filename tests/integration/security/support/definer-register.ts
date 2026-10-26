// =============================================================================
// PHASE 10 TASK 12 (G26) -- THE PRIVATE DEFINERS A BROWSER ROLE MAY EXECUTE
// =============================================================================
// Every SECURITY DEFINER function in `private` that `anon`, `authenticated` or
// PUBLIC may EXECUTE, with why. They are unreachable from a browser only
// because `private` is not an exposed schema (a hosted dashboard setting, G31);
// the grant exists so a policy, a CHECK or an invoker RPC can call them under
// the caller's own role. definer-register.test.ts asserts this list EQUALS the
// live set, so a new one lands red until someone writes its line here.
//
// HOW TO CHANGE IT. Add the signature with a one-line reason in the same
// change as the migration. If no policy, CHECK or invoker body needs to call
// it as the caller, revoke the grant instead.
export const PRIVATE_POLICY_HELPERS: Readonly<Record<string, string>> = {
  "private.is_active_member(uuid)": "membership test inside organisation_memberships policies; definer to avoid RLS recursion",
  "private.shares_active_organisation(uuid)": "profiles read policy: does the caller share an active organisation with this user",
  "private.has_platform_permission(text)": "superuser allowlist + aal2 test behind every platform policy",
  "private.membership_update_is_permitted(uuid, uuid, uuid, text, timestamp with time zone)": "WITH CHECK guard of the membership UPDATE policy; compares against the stored row",
  "private.permitted_organisations(text)": "set form of has_permission() used by tenant policies",
  "private.full_scope_organisations()": "record-scope policies (Q3): organisations where the caller sees every row",
  "private.entity_is_visible(text, uuid, uuid)": "polymorphic read dispatch for notes/tasks/documents policies",
  "private.entity_is_manageable(text, uuid, uuid)": "polymorphic write dispatch for notes/tasks/documents policies",
  "private.entity_org_unchanged(text, uuid, uuid)": "UPDATE WITH CHECK guard: a row cannot change organisation",
  "private.crm_write_organisations()": "CRM write entitlement (tier) inside write policies",
  "private.organisation_is_live(uuid)": "suspended-workspace gate inside foundation write policies",
  "private.custom_field_limit(uuid)": "custom-field tier cap read by the slot check",
  "private.custom_field_slot_available(uuid, text)": "custom-field definitions INSERT policy: tier slot left",
  "private.entity_is_live(text, uuid, uuid)": "polymorphic soft-delete gate inside child-row policies",
  "private.custom_field_definition_type_unchanged(uuid, text)": "UPDATE WITH CHECK guard: a definition cannot change entity type",
  "private.duplicate_matches(uuid, text, uuid)": "dedup review called from invoker RPCs, with record scope applied",
  "private.record_merge(uuid, text, uuid, uuid, uuid, uuid, jsonb, jsonb)": "sole write path into public.merges, called by the invoker merge RPCs",
  "private.finance_module_organisations()": "finance module entitlement (Pro) inside finance policies",
  "private.network_publish_organisations()": "network publishing entitlement inside network_profiles policies",
  "private.impersonation_time_box()": "the 60-minute constant read by impersonation policies and RPCs",
  "private.impersonated_organisations(text)": "the impersonation grant inside tenant read policies",
  "private.impersonation_counterparty_organisations()": "organisations_select_impersonation_counterparty policy",
  "private.lifecycle_transition_in_progress()": "second term of the platform lifecycle UPDATE policy",
  "private.log_organisation_lifecycle_event(uuid, text, uuid, jsonb, text)": "audit row for the invoker lifecycle RPCs",
  "private.organisation_network_presence_active(uuid)": "network directory presence of a suspended workspace (Q88)",
  "private.organisation_id_for_slug(text)": "slug lookup shared by the invoker override RPCs",
  "private.active_billing_override(uuid)": "read-time-expiry billing override, under effective_organisation_plan()",
  "private.active_feature_override(uuid, text)": "read-time-expiry feature override, under the entitlement gates",
  "private.effective_organisation_plan(uuid)": "the SQL half's one effective-tier function, read by every tier gate",
  "private.log_override_event(text, text, uuid, uuid, jsonb)": "audit bridge for the invoker override RPCs",
  "private.is_impersonating_route(text)": "route-level impersonation test for the audited page reads",
  "private.document_retention_class(uuid)": "a document's retention class (Q52), read by its policies and the retention view",
  "private.closure_backup_read_admits(uuid)": "admits a closure backup's reads inside export_read_page() only",
  "private.lifecycle_lock(uuid)": "row lock behind private.lifecycle_target() for the invoker lifecycle RPCs",
  "private.lifecycle_has_active_owner(uuid)": "reinstate_organisation() refuses a workspace with no active Owner",
  "private.network_profile_is_discoverable(uuid, uuid)": "is this profile visible to the caller through network_directory",
  "private.is_active_owner(uuid)": "Q248: only an Owner may create, change or remove a membership role",
  "private.consume_step_up(text)": "G13: every step-up RPC takes the caller's one-use step-up token",
};
