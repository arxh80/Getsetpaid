// =============================================================================
// PHASE 8 TASK 8 -- EVERY PRIVILEGE ON `public`, DECLARED
// =============================================================================
// The pinned answer to `publicPrivileges()` in ./catalogue-census.ts: one
// entry per (relation, grantee, privilege, column) that `anon`,
// `authenticated`, `service_role` or the pseudo-role PUBLIC holds on a
// relation in `public`, where column `*` is a TABLE-level grant.
//
// MEASURED, not written from memory: produced from the live catalogue at 210
// migrations after a clean `supabase db reset --local`, and asserted EQUAL to
// that catalogue by the permission matrix on every run.
//
// WHY A LITERAL AND NOT A RULE. The matrix's relation census asks "can a
// browser reach this relation at all?". Once a relation is on that list, a
// NEW privilege on it -- a column-level UPDATE on `consents`, an INSERT on a
// view, a second `service_role` column on the DSR seam -- changes nothing
// that census can see. Phase 8's controls are column grants almost
// everywhere (the anon eight-column read on `legal_documents`, the one-column
// INSERT on `erasure_jobs`, the two-column INSERT on `export_jobs`, the
// two-column seam UPDATE on `data_subject_requests`, the retention-clock
// narrowing on `documents`), so the only honest census is the full set.
//
// HOW TO CHANGE IT. A red here names the entry. If the grant is deliberate,
// add (or remove) exactly that entry, in the same change as the migration, and
// say in the commit why that role needs that privilege on that column. Do not
// regenerate this list wholesale to make a red go away: a regenerated list
// proves only that the catalogue equals itself.
export const DECLARED_PRIVILEGES: readonly string[] = [
  // activity_events
  "activity_events|authenticated|SELECT|*",
  // agencies
  "agencies|authenticated|INSERT|*",
  "agencies|authenticated|SELECT|*",
  "agencies|authenticated|UPDATE|*",
  // artist_fee_history
  "artist_fee_history|authenticated|INSERT|*",
  "artist_fee_history|authenticated|SELECT|*",
  "artist_fee_history|authenticated|UPDATE|*",
  // artist_representations
  "artist_representations|authenticated|INSERT|*",
  "artist_representations|authenticated|SELECT|*",
  "artist_representations|authenticated|UPDATE|*",
  // artists
  "artists|authenticated|INSERT|*",
  "artists|authenticated|SELECT|*",
  "artists|authenticated|UPDATE|*",
  // audit_events
  "audit_events|authenticated|SELECT|*",
  // companies
  "companies|authenticated|INSERT|*",
  "companies|authenticated|SELECT|*",
  "companies|authenticated|UPDATE|*",
  // consents
  "consents|authenticated|SELECT|*",
  // contact_companies
  "contact_companies|authenticated|DELETE|*",
  "contact_companies|authenticated|INSERT|*",
  "contact_companies|authenticated|SELECT|*",
  "contact_companies|authenticated|UPDATE|*",
  // contacts
  "contacts|authenticated|INSERT|*",
  "contacts|authenticated|SELECT|*",
  "contacts|authenticated|UPDATE|*",
  // custom_field_definitions
  "custom_field_definitions|authenticated|INSERT|*",
  "custom_field_definitions|authenticated|SELECT|*",
  "custom_field_definitions|authenticated|UPDATE|*",
  // custom_field_values
  "custom_field_values|authenticated|DELETE|*",
  "custom_field_values|authenticated|INSERT|*",
  "custom_field_values|authenticated|SELECT|*",
  "custom_field_values|authenticated|UPDATE|*",
  // data_subject_request_notes
  "data_subject_request_notes|authenticated|SELECT|*",
  // data_subject_requests
  "data_subject_requests|authenticated|SELECT|*",
  "data_subject_requests|service_role|SELECT|closed_notified_at",
  "data_subject_requests|service_role|SELECT|fulfilment_kind",
  "data_subject_requests|service_role|SELECT|fulfilment_recorded_at",
  "data_subject_requests|service_role|SELECT|fulfilment_reference",
  "data_subject_requests|service_role|SELECT|id",
  "data_subject_requests|service_role|SELECT|received_notified_at",
  "data_subject_requests|service_role|SELECT|requested_at",
  "data_subject_requests|service_role|SELECT|right_type",
  "data_subject_requests|service_role|SELECT|status",
  "data_subject_requests|service_role|SELECT|subject_scope",
  "data_subject_requests|service_role|SELECT|user_id",
  "data_subject_requests|service_role|UPDATE|closed_notified_at",
  "data_subject_requests|service_role|UPDATE|fulfilment_kind",
  "data_subject_requests|service_role|UPDATE|fulfilment_reference",
  "data_subject_requests|service_role|UPDATE|received_notified_at",
  // document_links
  "document_links|authenticated|INSERT|*",
  "document_links|authenticated|SELECT|*",
  "document_links|authenticated|UPDATE|*",
  // document_versions
  "document_versions|authenticated|SELECT|*",
  // documents
  "documents|authenticated|INSERT|filename",
  "documents|authenticated|INSERT|id",
  "documents|authenticated|INSERT|mime_type",
  "documents|authenticated|INSERT|organisation_id",
  "documents|authenticated|INSERT|owner_user_id",
  "documents|authenticated|INSERT|size_bytes",
  "documents|authenticated|INSERT|storage_key",
  "documents|authenticated|SELECT|*",
  "documents|authenticated|UPDATE|deleted_at",
  // erasure_jobs
  "erasure_jobs|authenticated|INSERT|kind",
  "erasure_jobs|authenticated|SELECT|*",
  "erasure_jobs|service_role|INSERT|kind",
  "erasure_jobs|service_role|INSERT|organisation_id",
  "erasure_jobs|service_role|SELECT|*",
  "erasure_jobs|service_role|UPDATE|completed_at",
  "erasure_jobs|service_role|UPDATE|failure_reason",
  "erasure_jobs|service_role|UPDATE|started_at",
  "erasure_jobs|service_role|UPDATE|status",
  // event_finance_summary
  "event_finance_summary|authenticated|SELECT|*",
  // event_lineup
  "event_lineup|authenticated|INSERT|*",
  "event_lineup|authenticated|SELECT|*",
  "event_lineup|authenticated|UPDATE|*",
  // event_status_changes
  "event_status_changes|authenticated|SELECT|*",
  // events
  "events|authenticated|INSERT|*",
  "events|authenticated|SELECT|*",
  "events|authenticated|UPDATE|*",
  // export_job_parts (Q228, 20261101000000): the requester reads its job's
  // parts (RLS); no client write at all. service_role stores a part
  // (INSERT), deletes a failed build's parts (DELETE, which needs SELECT for
  // its WHERE) and totals them (SELECT) -- and never rewrites one (no UPDATE).
  "export_job_parts|authenticated|SELECT|*",
  "export_job_parts|service_role|DELETE|*",
  "export_job_parts|service_role|INSERT|*",
  "export_job_parts|service_role|SELECT|*",
  // export_jobs
  "export_jobs|authenticated|INSERT|kind",
  "export_jobs|authenticated|INSERT|organisation_id",
  "export_jobs|authenticated|SELECT|*",
  "export_jobs|service_role|SELECT|*",
  "export_jobs|service_role|UPDATE|byte_size",
  "export_jobs|service_role|UPDATE|completed_at",
  "export_jobs|service_role|UPDATE|expires_at",
  "export_jobs|service_role|UPDATE|failure_reason",
  "export_jobs|service_role|UPDATE|manifest",
  // Q228: the closure-backup runner's part count and resume point.
  "export_jobs|service_role|UPDATE|part_count",
  "export_jobs|service_role|UPDATE|ready_notified_at",
  "export_jobs|service_role|UPDATE|resume_cursor",
  "export_jobs|service_role|UPDATE|row_count",
  "export_jobs|service_role|UPDATE|started_at",
  "export_jobs|service_role|UPDATE|status",
  "export_jobs|service_role|UPDATE|storage_key",
  "export_jobs|service_role|UPDATE|table_count",
  // feedback
  "feedback|authenticated|INSERT|category",
  "feedback|authenticated|INSERT|id",
  "feedback|authenticated|INSERT|message",
  "feedback|authenticated|INSERT|organisation_id",
  "feedback|authenticated|INSERT|route",
  "feedback|authenticated|INSERT|screenshot_key",
  "feedback|authenticated|INSERT|screenshot_mime",
  "feedback|authenticated|INSERT|screenshot_scan_status",
  "feedback|authenticated|INSERT|screenshot_scanned_at",
  "feedback|authenticated|INSERT|screenshot_size_bytes",
  "feedback|authenticated|INSERT|user_agent",
  "feedback|authenticated|SELECT|*",
  "feedback|authenticated|UPDATE|status",
  "feedback|service_role|SELECT|id",
  "feedback|service_role|SELECT|notified_at",
  "feedback|service_role|UPDATE|notified_at",
  // financial_entries
  "financial_entries|authenticated|INSERT|*",
  "financial_entries|authenticated|SELECT|*",
  "financial_entries|authenticated|UPDATE|*",
  // impersonation_sessions
  "impersonation_sessions|authenticated|SELECT|*",
  // incident_alerts
  "incident_alerts|authenticated|SELECT|*",
  "incident_alerts|authenticated|UPDATE|resolved_at",
  "incident_alerts|authenticated|UPDATE|resolved_by",
  "incident_alerts|service_role|SELECT|*",
  "incident_alerts|service_role|UPDATE|account_notified_at",
  "incident_alerts|service_role|UPDATE|notified_at",
  "incident_alerts|service_role|UPDATE|telegram_notified_at",
  // integration_connections -- Phase 9 Task 1 (20261030000000): SELECT only;
  // every write is a SECURITY DEFINER RPC. Task 2 (20261030001000) narrowed
  // it to COLUMNS: every column but token_secret_id, which no client reads.
  "integration_connections|authenticated|SELECT|created_at",
  "integration_connections|authenticated|SELECT|created_by",
  "integration_connections|authenticated|SELECT|id",
  "integration_connections|authenticated|SELECT|last_synced_at",
  "integration_connections|authenticated|SELECT|organisation_id",
  "integration_connections|authenticated|SELECT|owner_user_id",
  "integration_connections|authenticated|SELECT|provider",
  "integration_connections|authenticated|SELECT|revoked_at",
  "integration_connections|authenticated|SELECT|revoked_by",
  "integration_connections|authenticated|SELECT|scopes",
  "integration_connections|authenticated|SELECT|status",
  "integration_connections|authenticated|SELECT|token_expires_at",
  // integration_sync_runs -- Phase 9 Task 1: SELECT only, same reason.
  "integration_sync_runs|authenticated|SELECT|*",
  // Invoices part 1 (20261107000000): SELECT only on all four; every write
  // is a SECURITY DEFINER RPC (rls_invoices.sql IT3-IT5, IB).
  "invoice_lines|authenticated|SELECT|*",
  "invoice_sends|authenticated|SELECT|*",
  "invoice_settings|authenticated|SELECT|*",
  "invoices|authenticated|SELECT|*",
  // legal_documents
  "legal_documents|anon|SELECT|body",
  "legal_documents|anon|SELECT|counsel_reviewed_at",
  "legal_documents|anon|SELECT|effective_date",
  "legal_documents|anon|SELECT|id",
  "legal_documents|anon|SELECT|published_at",
  "legal_documents|anon|SELECT|slug",
  "legal_documents|anon|SELECT|title",
  "legal_documents|anon|SELECT|version",
  "legal_documents|authenticated|SELECT|body",
  "legal_documents|authenticated|SELECT|counsel_reviewed_at",
  "legal_documents|authenticated|SELECT|effective_date",
  "legal_documents|authenticated|SELECT|id",
  "legal_documents|authenticated|SELECT|published_at",
  "legal_documents|authenticated|SELECT|slug",
  "legal_documents|authenticated|SELECT|title",
  "legal_documents|authenticated|SELECT|version",
  // meeting_links
  "meeting_links|authenticated|INSERT|*",
  "meeting_links|authenticated|SELECT|*",
  "meeting_links|authenticated|UPDATE|*",
  // meetings
  "meetings|authenticated|INSERT|*",
  "meetings|authenticated|SELECT|*",
  "meetings|authenticated|UPDATE|*",
  // merge_candidates
  "merge_candidates|authenticated|SELECT|*",
  "merge_candidates|authenticated|UPDATE|*",
  // merges
  "merges|authenticated|SELECT|*",
  // network_connected_profiles
  "network_connected_profiles|authenticated|SELECT|*",
  // network_connection_requests
  "network_connection_requests|authenticated|INSERT|*",
  "network_connection_requests|authenticated|SELECT|*",
  // 20261020000000 (Task 9b fix round 2, N1): the answer columns only -- a
  // party column is no longer nameable in a PATCH.
  "network_connection_requests|authenticated|UPDATE|responded_at",
  "network_connection_requests|authenticated|UPDATE|responded_by",
  "network_connection_requests|authenticated|UPDATE|status",
  // network_directory
  "network_directory|authenticated|SELECT|*",
  // network_links
  "network_links|authenticated|INSERT|*",
  "network_links|authenticated|SELECT|*",
  "network_links|authenticated|UPDATE|*",
  // network_profiles
  "network_profiles|authenticated|INSERT|*",
  "network_profiles|authenticated|SELECT|*",
  "network_profiles|authenticated|UPDATE|*",
  // note_links
  "note_links|authenticated|INSERT|*",
  "note_links|authenticated|SELECT|*",
  "note_links|authenticated|UPDATE|*",
  // notes
  "notes|authenticated|INSERT|*",
  "notes|authenticated|SELECT|*",
  "notes|authenticated|UPDATE|*",
  // organisation_billing_overrides
  "organisation_billing_overrides|authenticated|INSERT|*",
  "organisation_billing_overrides|authenticated|SELECT|*",
  "organisation_billing_overrides|authenticated|UPDATE|revoked_at",
  "organisation_billing_overrides|authenticated|UPDATE|revoked_by",
  "organisation_billing_overrides|authenticated|UPDATE|revoked_reason",
  // organisation_feature_overrides
  "organisation_feature_overrides|authenticated|INSERT|*",
  "organisation_feature_overrides|authenticated|SELECT|*",
  "organisation_feature_overrides|authenticated|UPDATE|revoked_at",
  "organisation_feature_overrides|authenticated|UPDATE|revoked_by",
  "organisation_feature_overrides|authenticated|UPDATE|revoked_reason",
  // organisation_memberships
  "organisation_memberships|authenticated|DELETE|*",
  "organisation_memberships|authenticated|INSERT|*",
  "organisation_memberships|authenticated|SELECT|*",
  "organisation_memberships|authenticated|UPDATE|*",
  // organisation_subscriptions
  "organisation_subscriptions|authenticated|INSERT|*",
  "organisation_subscriptions|authenticated|SELECT|*",
  "organisation_subscriptions|authenticated|UPDATE|*",
  // organisations
  "organisations|authenticated|SELECT|*",
  "organisations|authenticated|UPDATE|*",
  // permissions
  "permissions|authenticated|SELECT|*",
  // profiles
  "profiles|authenticated|SELECT|*",
  "profiles|authenticated|UPDATE|*",
  // rate_limit_counters
  "rate_limit_counters|authenticated|SELECT|*",
  // rate_limit_policies
  "rate_limit_policies|authenticated|SELECT|*",
  // retention_runs
  "retention_runs|authenticated|SELECT|*",
  // retention_settings
  "retention_settings|authenticated|SELECT|*",
  // role_permissions
  "role_permissions|authenticated|SELECT|*",
  // roles
  "roles|authenticated|SELECT|*",
  // subscription_plans
  "subscription_plans|anon|SELECT|*",
  "subscription_plans|authenticated|SELECT|*",
  // task_links
  "task_links|authenticated|INSERT|*",
  "task_links|authenticated|SELECT|*",
  "task_links|authenticated|UPDATE|*",
  // tasks
  "tasks|authenticated|INSERT|*",
  "tasks|authenticated|SELECT|*",
  "tasks|authenticated|UPDATE|*",
  // venue_rooms
  "venue_rooms|authenticated|INSERT|*",
  "venue_rooms|authenticated|SELECT|*",
  "venue_rooms|authenticated|UPDATE|*",
  // venues
  "venues|authenticated|INSERT|*",
  "venues|authenticated|SELECT|*",
  "venues|authenticated|UPDATE|*",
];
