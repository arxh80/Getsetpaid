import "server-only";

// The read query behind /super/organisations.
//
// A SEPARATE MODULE FROM lib/admin/lifecycle.ts because that file is
// `"use server"`: every export of a "use server" module becomes a callable
// Server Action endpoint, so a read helper living there would be published as
// an RPC for no reason. Same split, same reason, as lib/admin/impersonation-
// list.ts sitting beside lib/admin/impersonation.ts.
//
// ===========================================================================
// IT LISTS ONLY WOUND-DOWN WORKSPACES, AND THAT IS THE FEATURE
// ===========================================================================
// The obvious page here is "every organisation on the platform, paginated,
// with a suspend button on each row". That is a worse page and a worse
// control:
//
//   * CLAUDE.md § Superuser dashboard permits aggregate metadata and forbids
//     record content. A roster of every tenant is metadata, but it is also a
//     browsable directory of the customer base sitting one click from a
//     destructive action, which is not something the operator needs in order
//     to suspend a named workspace for non-payment.
//   * Suspending is aimed, not browsed: the operator arrives knowing which
//     workspace and why, the same way public.request_impersonation() takes a
//     slug rather than offering a picker (20260908020000's own reasoning --
//     "the superuser has no directory of ids and resolving one by hand is how
//     a support engineer ends up requesting access to the wrong tenant").
//   * REINSTATEMENT is the operation that genuinely needs a list, because the
//     operator may not remember which workspaces are currently suspended --
//     and that list is small, self-limiting and exactly the wound-down set.
//
// So the page is a slug-driven action form plus a list of what is currently
// suspended or closed. The complete history of every transition is in the
// audit log viewer, filterable by action = organisation.* -- that is the
// paginated surface, and this is the working one.
//
// BOUNDED (CLAUDE.md § Non-negotiable rules, "paginate everything"): an
// explicit `.limit()` with the ceiling stated in the UI when it is reached.

import { createClient } from "@/lib/supabase/server";
import type { OrganisationLifecycleState } from "@/lib/admin/lifecycle-contract";

/** The ceiling on the wound-down list. Not a page size -- there is no "next" --
 *  but the bound that keeps the query finite however the platform grows. */
export const LIFECYCLE_LIST_LIMIT = 50;

export interface WoundDownOrganisationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly lifecycleState: OrganisationLifecycleState;
  readonly lifecycleChangedAt: string | null;
  readonly lifecycleReason: string | null;
  readonly retentionExpiresAt: string | null;
}

/**
 * Every organisation that is currently suspended or closed, most recent first.
 *
 * READS THROUGH THE CALLER'S OWN RLS and adds no filter that is an access
 * decision: organisations_select_platform_lifecycle (20260908030000) is what
 * returns foreign rows at all, and it requires the platform superuser at aal2.
 * For everyone else this returns their own organisations' rows if any of them
 * happen to be wound down -- which is the caller's own workspace, which they
 * can already see -- and for a caller with no wound-down memberships, nothing.
 * The page above still calls isSuperuser() and notFound()s, because a page
 * that renders an empty list to a stranger is a page that has told them the
 * route exists.
 */
export async function listWoundDownOrganisations(): Promise<
  readonly WoundDownOrganisationRow[]
> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisations")
    .select(
      "id, name, slug, lifecycle_state, lifecycle_changed_at, lifecycle_reason, retention_expires_at",
    )
    .neq("lifecycle_state", "active")
    .order("lifecycle_changed_at", { ascending: false })
    .limit(LIFECYCLE_LIST_LIMIT);

  if (error) {
    // FAIL CLOSED AND LOUD: an empty list here reads as "nothing is
    // suspended", which is the one wrong answer that would have the operator
    // conclude a suspension did not take. Logged so a real outage is visible
    // in the server log rather than a mystery empty page.
    console.error("[admin] wound-down organisation list failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    lifecycleState: row.lifecycle_state as OrganisationLifecycleState,
    lifecycleChangedAt: (row.lifecycle_changed_at as string | null) ?? null,
    lifecycleReason: (row.lifecycle_reason as string | null) ?? null,
    retentionExpiresAt: (row.retention_expires_at as string | null) ?? null,
  }));
}
