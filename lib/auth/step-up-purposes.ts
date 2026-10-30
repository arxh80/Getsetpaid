// The closed list of step-up purposes (Phase 10 Task 6, G13): the CHECK on
// private.step_up_tokens in supabase/migrations/20261108001000_step_up_tokens.sql,
// whose header names the RPC or insert each one guards. One per gated family.
// Not server-only so tests/unit/security/step-up-token-callers.test.ts can
// bind it to that CHECK and to the app's mint calls.
export const STEP_UP_PURPOSES = [
  "organisation_lifecycle",
  "closure_decision",
  "workspace_close",
  "override",
  "impersonation",
  "retention_settings",
  "legal_document",
  "dsr_rejection",
  "account_erasure",
  "workspace_export",
] as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];
