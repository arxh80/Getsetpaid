import "server-only";

// ===========================================================================
// THE MALWARE VERDICT IS THE SCANNER'S (Phase 8 final review A, I1).
// ===========================================================================
//
// Until 20261029000000 the upload action wrote `scan_status` through the
// uploader's own RLS-bound client, which meant the uploader's BROWSER could
// write it too: a Manager PATCHed `clean` mid-scan, the server's quarantine
// write then failed as "terminal and immutable", and the download gate served
// the file. The verdict columns are now outside every client grant and the
// database refuses any session write to them; the one writer is
// public.record_document_scan_verdict(), executable by `service_role` alone.
//
// This module is that call and nothing else. It is the only lib/crm importer
// of the service-role table client (tests/unit/email/service-client-census
// names it), and it can ask the RPC for exactly one thing: move ONE live
// pending document of ONE organisation to a terminal verdict.

import { createServiceClient } from "@/lib/supabase/service";

export type TerminalScanStatus = "clean" | "quarantined" | "error";

/**
 * Records the scanner's verdict. Returns true only when the row moved
 * pending -> terminal; a refusal (not pending, deleted, wrong org) or a fault
 * is false and is logged, never swallowed into a success.
 */
export async function recordScanVerdict(
  organisationId: string,
  documentId: string,
  status: TerminalScanStatus,
): Promise<boolean> {
  const { error } = await createServiceClient().rpc("record_document_scan_verdict", {
    p_organisation_id: organisationId,
    p_document_id: documentId,
    p_status: status,
  });
  if (error) {
    console.error(`[crm] document ${documentId} scan verdict did not land:`, error.message);
    return false;
  }
  return true;
}
