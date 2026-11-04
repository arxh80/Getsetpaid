// Phase 10 Task 6 (G13): every step-up-gated RPC, and the export_jobs /
// erasure_jobs inserts, spend a single-use database token that the app's
// server mints right after checkStepUp() passes (lib/auth/step-up-gate.ts).
// A test that drives one of those writes directly mints first, through here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepUpPurpose } from "@/lib/auth/step-up-purposes";

/** On a persona client, which carries the server mark (./fixtures.ts). */
export async function mintStepUp(client: SupabaseClient, purpose: StepUpPurpose): Promise<void> {
  const { error } = await client.rpc("mint_step_up_token", { p_purpose: purpose });
  if (error) throw new Error(`step-up mint (${purpose}) refused: ${error.message}`);
}

/** On a pg connection inside a transaction that already holds the person's
 *  claims: what a server-marked request runs. One parameter, the purpose. */
export const MINT_STEP_UP_SQL =
  "select set_config('getsetpaid.from_server', 'on', true), public.mint_step_up_token($1)";

/** Each step-up-gated RPC's purpose (20261108001000's header). The DSR
 *  transition is gated only for p_status 'rejected'. */
export const STEP_UP_PURPOSE_OF_RPC: Partial<Record<string, StepUpPurpose>> = {
  suspend_organisation: "organisation_lifecycle",
  delete_organisation: "organisation_lifecycle",
  reinstate_organisation: "organisation_lifecycle",
  reassign_closed_workspace: "closure_decision",
  delete_closed_workspace: "closure_decision",
  close_my_workspace: "workspace_close",
  grant_billing_override: "override",
  revoke_billing_override: "override",
  grant_feature_override: "override",
  revoke_feature_override: "override",
  request_impersonation: "impersonation",
  start_impersonation_session: "impersonation",
  set_retention_enabled: "retention_settings",
  release_audit_purge_ceiling: "retention_settings",
  publish_legal_document: "legal_document",
  record_legal_document_counsel_review: "legal_document",
  start_erasure_for_request: "account_erasure",
};
