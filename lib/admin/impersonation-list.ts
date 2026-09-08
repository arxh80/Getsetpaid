import "server-only";

// The two read queries behind the two impersonation surfaces.
//
// A SEPARATE MODULE FROM lib/admin/impersonation.ts because that file is
// `"use server"`: every export of a "use server" module becomes a callable
// Server Action endpoint, so a read helper living there would be published as
// an RPC for no reason. Same split, same reason, as lib/network/requests-list.ts
// sitting beside lib/network/connections.ts.
//
// BOTH QUERIES READ THROUGH THE CALLER'S OWN RLS and add no filter that is an
// access decision. public.impersonation_sessions carries exactly two SELECT
// policies (20260908020000): the superuser sees their own rows, a
// manage_organisation holder sees rows for their own organisation. So
// `listMyImpersonationSessions()` returns nothing at all for a non-superuser
// and `listOrganisationImpersonationRequests()` returns nothing for a member
// who cannot administer the workspace -- without either function saying so.
//
// NO PAGINATION, AND THAT IS BOUNDED RATHER THAN UNBOUNDED (CLAUDE.md
// § Non-negotiable rules, "paginate everything"): both queries carry an
// explicit `.limit()`, and both are over a table whose rows are created one
// per support engagement by ONE account at MVP. The audit log
// (/super/audit-log, filterable by action = impersonation.*) is the complete,
// paginated history; these two lists are the working surfaces for what is
// live and what is recent.

import { createClient } from "@/lib/supabase/server";

/** The cap on both lists. Not a page size -- there is no "next" -- but the
 *  ceiling that keeps either query bounded no matter how the table grows. */
export const IMPERSONATION_LIST_LIMIT = 50;

export type ImpersonationStatus =
  | "requested"
  | "accepted"
  | "declined"
  | "active"
  | "ended"
  | "expired";

export interface ImpersonationSessionRow {
  readonly id: string;
  readonly targetOrganisationId: string;
  readonly reason: string;
  readonly status: ImpersonationStatus;
  readonly requestedAt: string;
  readonly acceptedAt: string | null;
  readonly declinedAt: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
}

/** A superuser's own row, with the target workspace named. */
export interface SuperuserImpersonationRow extends ImpersonationSessionRow {
  readonly organisationName: string;
  readonly organisationSlug: string;
}

const COLUMNS =
  "id, target_organisation_id, reason, status, requested_at, accepted_at, declined_at, started_at, expires_at, ended_at";

function toRow(row: Record<string, unknown>): ImpersonationSessionRow {
  return {
    id: String(row.id),
    targetOrganisationId: String(row.target_organisation_id),
    reason: String(row.reason),
    status: row.status as ImpersonationStatus,
    requestedAt: String(row.requested_at),
    acceptedAt: (row.accepted_at as string | null) ?? null,
    declinedAt: (row.declined_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

/**
 * A session is USABLE RIGHT NOW iff the database would still grant on it.
 *
 * Restates private.impersonated_organisations()'s own two conditions
 * (status = 'active' AND expires_at > now()) for RENDERING only. The
 * database's copy is the enforcement and is evaluated on every permission
 * check; this one decides whether to draw an "Open workspace" link or an
 * "Expired" chip, and getting it wrong shows the wrong label, never the wrong
 * data. tests/unit/admin/impersonation-status.test.ts drives the boundary.
 */
export function isLive(
  row: Pick<ImpersonationSessionRow, "status" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  if (row.status !== "active") return false;
  if (!row.expiresAt) return false;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

/**
 * What the chip should say -- which is NOT always `status`.
 *
 * An 'active' row whose clock has run out grants nothing but still reads
 * 'active' in the column (20260908020000: the status is bookkeeping, the
 * clock is enforcement). Showing "Active" there would be the UI telling a
 * user they have access they do not have, which is the one direction a status
 * label must never be wrong in.
 */
export function displayStatus(
  row: Pick<ImpersonationSessionRow, "status" | "expiresAt">,
  now: Date = new Date(),
): ImpersonationStatus {
  if (row.status === "active" && !isLive(row, now)) return "expired";
  return row.status;
}

/**
 * Would the caller's role in this organisation grant `manage_organisation`
 * IF the workspace were not suspended?
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND WHAT IT MUST NEVER BE USED FOR
 * ===========================================================================
 * FIX ROUND 1, IMPORTANT 2. `manage_organisation` has
 * `survives_suspension = false` (20260828210000), so in a SUSPENDED workspace
 * its own Owner/Admin holds it not at all -- which is consequence P7 working
 * as designed, and which meant the one piece of UI written to explain that
 * consequence (DECISIONS-QUEUE Q98) could never render: the page's permission
 * gate fired first and the customer got a bare 404 on a page they had been
 * told exists.
 *
 * This answers the narrower question the page needs to tell those two cases
 * apart: "is this a suspended workspace's own administrator?" rather than "may
 * this caller administer?". It is a RENDER decision between two refusal-shaped
 * outcomes -- a 404, or a page whose entire content is the sentence "requests
 * are paused" -- and it authorises NOTHING. Every write is still
 * `public.accept_impersonation_request()`, which asks
 * `public.has_permission(org, 'manage_organisation')` and therefore still
 * refuses a suspended workspace's admin, exactly as Q98 describes.
 *
 * ===========================================================================
 * IT IS DERIVED FROM THE CATALOGUE, NOT FROM A HARDCODED ROLE LIST
 * ===========================================================================
 * The tempting version is `org.role === "owner" || org.role === "admin"`.
 * That hardcodes today's answer to a question `public.role_permissions` owns,
 * and goes stale silently the day a migration grants `manage_organisation` to
 * another role -- showing that role a 404 where it should see the explanation.
 * So it joins the catalogue, which is ordinary authenticated-readable
 * reference data (`role_permissions_select_authenticated`), against the
 * caller's OWN membership row (always visible to them).
 *
 * ===========================================================================
 * IT DELIBERATELY OMITS THE aal2 TERM, AND THAT IS SAFE HERE
 * ===========================================================================
 * `public.has_permission()` also requires aal2 for MFA-required roles. This
 * does not, so an aal1 Owner of a SUSPENDED workspace reaches the explanation
 * too. That discloses nothing: they are already an active member who can see
 * the suspension banner on every route, and the page in that state contains no
 * request data at all -- the list queries return nothing for them, because RLS
 * has not moved. Its caller ANDs it with `org.isSuspended`, so on a live
 * workspace this path is never taken and an aal1 Owner still gets the same
 * 404 as anyone else.
 */
export async function roleWouldAdministerOrganisation(
  organisationId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (typeof userId !== "string") return false;

  // TWO PLAIN QUERIES RATHER THAN ONE EMBED. PostgREST can only embed across a
  // relationship it can infer from a foreign key, and there is none from
  // organisation_memberships straight to role_permissions -- both reference
  // public.roles, they do not reference each other. An embed would resolve as
  // a 400 at runtime, which this function's fail-closed branch would then
  // report as "not an administrator" and nobody would ever see the
  // explanation. Two round trips, on a path taken only when a permission check
  // has already failed AND the workspace is suspended.
  const { data: membership, error: membershipError } = await supabase
    .from("organisation_memberships")
    .select("role")
    .eq("organisation_id", organisationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError || !membership) {
    if (membershipError) {
      console.error(
        "[admin] membership lookup failed; treating the caller as not an administrator:",
        membershipError.message,
      );
    }
    return false;
  }

  const { data: grant, error: grantError } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role_key", membership.role as string)
    .eq("permission_key", "manage_organisation")
    .maybeSingle();

  if (grantError) {
    // FAIL CLOSED: "could not tell" reads as "not an administrator", which
    // renders the same 404 a stranger gets. The failure mode is a suspended
    // Owner missing an explanation, never a stranger gaining one.
    console.error(
      "[admin] role/permission lookup failed; treating the caller as not an administrator:",
      grantError.message,
    );
    return false;
  }
  return grant !== null;
}

/**
 * Every impersonation session the calling superuser holds, newest first.
 *
 * The join to public.organisations resolves through
 * organisations_select_impersonation_counterparty (20260908020000), which is
 * keyed on exactly these rows -- so the name comes back for a workspace the
 * caller has a session against and for no other.
 */
export async function listMyImpersonationSessions(): Promise<
  readonly SuperuserImpersonationRow[]
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("impersonation_sessions")
    .select(`${COLUMNS}, organisations ( name, slug )`)
    .order("requested_at", { ascending: false })
    .limit(IMPERSONATION_LIST_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[admin] impersonation session list failed:", error.message);
    }
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => {
    const org = row.organisations as { name: string; slug: string } | null;
    return {
      ...toRow(row),
      organisationName: org?.name ?? "",
      organisationSlug: org?.slug ?? "",
    };
  });
}

/**
 * Every impersonation session against ONE organisation, newest first -- the
 * accept/decline surface.
 *
 * The `.eq("target_organisation_id", ...)` is a LOOKUP WITHIN WHAT THE CALLER
 * MAY ALREADY SEE, not an access decision:
 * impersonation_sessions_select_target_admin has already narrowed the
 * readable set to organisations where the caller holds manage_organisation.
 * A member without that permission gets an empty list from a query that looks
 * identical, which is the shape every list in this product uses.
 */
export async function listOrganisationImpersonationRequests(
  organisationId: string,
): Promise<readonly ImpersonationSessionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("impersonation_sessions")
    .select(COLUMNS)
    .eq("target_organisation_id", organisationId)
    .order("requested_at", { ascending: false })
    .limit(IMPERSONATION_LIST_LIMIT);

  if (error || !data) {
    if (error) {
      console.error("[admin] organisation impersonation list failed:", error.message);
    }
    return [];
  }
  return (data as Record<string, unknown>[]).map(toRow);
}
