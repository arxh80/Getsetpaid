import "server-only";

// The signed-in person's OWN data subject requests, read under their own
// session.
//
// `data_subject_requests_select_own` admits only the caller's rows, so this
// needs no user argument and could not read anybody else's if it had one.
// (The superuser's oversight policy would ALSO admit every row for an aal2
// superuser, which is why the query still filters on the caller's id: the
// account page shows the viewer's own requests, whoever the viewer is — the
// consent ledger's rule, for the same reason.)
//
// OPERATOR NOTES ARE NOT REACHABLE FROM HERE AT ALL. They are a different
// table with no own-rows policy (Q103); there is nothing to omit, which is
// the point of the split.

import { createClient } from "@/lib/supabase/server";
import type { DsrRight, DsrScope, DsrStatus } from "./contract";

export interface OwnDsrRequest {
  readonly id: string;
  readonly rightType: DsrRight | string;
  readonly subjectScope: DsrScope | string;
  readonly detail: string;
  readonly status: DsrStatus | string;
  readonly requestedAt: string;
  readonly dueBy: string;
  readonly closedAt: string | null;
  readonly rejectionReason: string | null;
  readonly routedAt: string | null;
  /**
   * WHICH BUSINESS WAS ASKED (review finding I7 / Q160b). Snapshotted onto the
   * row by the transition trigger, because the requester holds no read of
   * public.organisations for a workspace they do not belong to -- so before
   * this they were told "we passed this to the business that holds the
   * records" and never which one.
   */
  readonly routedToOrganisationName: string | null;
}

/**
 * Paginate-everything: bounded. Submissions are metered at 10 a day, so
 * twenty-five is weeks of an unusually busy requester — and the page says so
 * when it truncates.
 */
export const OWN_REQUEST_LIMIT = 25;

interface Row {
  id: string;
  right_type: string;
  subject_scope: string;
  detail: string;
  status: string;
  requested_at: string;
  due_by: string;
  fulfilled_at: string | null;
  rejected_at: string | null;
  withdrawn_at: string | null;
  rejection_reason: string | null;
  routed_at: string | null;
  routed_to_organisation_name: string | null;
}

export interface OwnDsrState {
  readonly requests: readonly OwnDsrRequest[];
  readonly truncated: boolean;
}

/**
 * FAILS LOUDLY on a query error. A page that rendered "you have made no
 * requests" during a database blip would tell someone their statutory request
 * had vanished.
 */
export async function getOwnDataSubjectRequests(userId: string): Promise<OwnDsrState> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("data_subject_requests")
    .select(
      "id, right_type, subject_scope, detail, status, requested_at, due_by, fulfilled_at, rejected_at, withdrawn_at, rejection_reason, routed_at, routed_to_organisation_name",
    )
    .eq("user_id", userId)
    .order("seq", { ascending: false })
    .limit(OWN_REQUEST_LIMIT + 1);
  if (error) {
    throw new Error(`data_subject_requests: could not read your requests: ${error.message}`);
  }
  const rows = (data ?? []) as Row[];
  return {
    requests: rows.slice(0, OWN_REQUEST_LIMIT).map(toRequest),
    truncated: rows.length > OWN_REQUEST_LIMIT,
  };
}

function toRequest(row: Row): OwnDsrRequest {
  return {
    id: row.id,
    rightType: row.right_type,
    subjectScope: row.subject_scope,
    detail: row.detail,
    status: row.status,
    requestedAt: row.requested_at,
    dueBy: row.due_by,
    closedAt: row.fulfilled_at ?? row.rejected_at ?? row.withdrawn_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
    routedAt: row.routed_at ?? null,
    routedToOrganisationName: row.routed_to_organisation_name ?? null,
  };
}
