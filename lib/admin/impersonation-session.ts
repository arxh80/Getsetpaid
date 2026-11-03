import "server-only";

// The READ half of break-glass impersonation, and the one place the app asks
// "is this request an impersonated one?".
//
// ===========================================================================
// WHY THIS IS A LEAF MODULE AND NOT PART OF lib/admin/impersonation.ts
// ===========================================================================
// lib/auth/index.ts's getCurrentOrg() has to consult it -- that is the whole
// point, see below -- and lib/admin/impersonation.ts (the Server Actions) has
// to consult getCurrentOrg()'s neighbours in lib/auth. Splitting the read out
// keeps the dependency a straight line (lib/auth -> here) instead of a cycle,
// which is also why this file reaches for `supabase.auth.getClaims()` directly
// rather than importing getCurrentUser().
//
// ===========================================================================
// WHY THE PAGE-ACCESS AUDIT LIVES HERE, IN A FUNCTION NAMED "resolve"
// ===========================================================================
// The brief requires "every impersonated page access (route only, no
// content)" to be audited. There are exactly two candidate choke points in a
// Next.js App Router tree, and only one of them fires on every page:
//
//   * app/(app)/[orgSlug]/layout.tsx -- does NOT re-run on a client-side
//     navigation between two routes that share it, which is most of the
//     navigation an impersonating superuser will do. A layout-level audit
//     would record the first page of a session and none of the rest.
//   * getCurrentOrg(slug) -- called by the org layout AND by every org-scoped
//     page/generateMetadata under it, and cache()-wrapped, so it runs exactly
//     once per request and does run on every one.
//
// So the audit is a documented side effect of RESOLVING an impersonated
// organisation, which is precisely the event the audit is about: the
// superuser reached an org-scoped route. The function is named `resolve`
// rather than `get` to say that it does something.
//
// IT FAILS CLOSED. If the audit RPC refuses (no live session, expired,
// de-allowlisted, dropped below aal2) this returns null, getCurrentOrg()
// returns null, and the route renders the ordinary tenant-isolation 404. There
// is no path that serves an impersonated page without a matching audit row --
// the same fail-closed direction app/(app)/super/audit-log/page.tsx takes for
// its own self-audit, and for the same reason.
//
// KNOWN AND DELIBERATE: THIS OVER-RECORDS RATHER THAN UNDER-RECORDS. A Next.js
// prefetch of an org route renders the org layout (down to its loading.tsx
// boundary), which calls getCurrentOrg(), which lands a page_viewed row for a
// page the superuser may never look at. Task 1 measured the equivalent
// question for the audit-log viewer and engineered the row AWAY; here the
// trade runs the other way round. An impersonation trail that lists a route
// nobody read is noise; one that misses a route somebody did read is a hole in
// the product's only sanctioned deep-access path. tests/e2e/impersonation
// .spec.ts records the behaviour so a future change to it is a decision.

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { currentPath } from "@/lib/auth/current-path";
// THE PURE HALF LIVES NEXT DOOR, AND HAS TO. Three Client Components need
// the time-box for their copy; importing it from THIS file dragged
// lib/supabase/server into the client graph and failed the build on the
// `server-only` marker above. See lib/admin/impersonation-contract.ts.
// Re-exported here so server callers have one import for the whole
// contract.
import {
  IMPERSONATION_ROLE_ENVELOPE,
  IMPERSONATION_TIME_BOX_MINUTES,
  auditableRoute,
} from "@/lib/admin/impersonation-contract";

export {
  IMPERSONATION_ROLE_ENVELOPE,
  IMPERSONATION_TIME_BOX_MINUTES,
  auditableRoute,
};

export interface ActiveImpersonation {
  readonly sessionId: string;
  readonly organisationId: string;
  readonly reason: string;
  /** ISO instant. The DATABASE's answer, stamped at start. */
  readonly expiresAt: string;
}

/**
 * Is THIS request an impersonation of `organisationId` -- and, if so, record
 * the page access.
 *
 * Returns null for every ordinary caller, which is every caller who is not
 * the platform superuser mid-session. Called by getCurrentOrg() only after a
 * membership lookup has already come back empty, so an ordinary member pays
 * nothing for it at all.
 */
export const resolveImpersonationForOrg = cache(
  async (organisationId: string): Promise<ActiveImpersonation | null> => {
    const supabase = await createClient();

    const { data: claims } = await supabase.auth.getClaims();
    const userId = claims?.claims?.sub;
    if (typeof userId !== "string") return null;

    // THE `.eq("superuser_user_id", ...)` IS LOAD-BEARING, for the same reason
    // lib/auth/index.ts's getMemberships() documents at length. There are TWO
    // select policies on impersonation_sessions: the superuser sees their own
    // rows, and a manage_organisation holder sees every row FOR THEIR
    // ORGANISATION. Without this filter an Owner of an organisation that
    // currently has an active session would read that row back and be told
    // they were impersonating themselves.
    //
    // The expires_at comparison uses the APP's clock and is a RENDER decision
    // only -- it decides whether to show a workspace, never whether one may be
    // read. The enforcement is private.impersonated_organisations()'s own
    // `expires_at > now()`, evaluated in the database on every permission
    // check, plus the audit RPC's identical guard below.
    const { data, error } = await supabase
      .from("impersonation_sessions")
      .select("id, reason, expires_at")
      .eq("superuser_user_id", userId)
      .eq("target_organisation_id", organisationId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error || !data) return null;

    // AUDIT BEFORE RETURNING, AND FAIL CLOSED IF IT REFUSES. The RPC's own
    // guard is the GRANT itself (private.impersonated_organisations), so a
    // refusal here means the database disagrees that this session is live --
    // a de-allowlisted account, a session that dropped below aal2, or a clock
    // that ran out between the query above and this call. In every one of
    // those cases the honest answer is "not impersonating", which renders the
    // ordinary tenant-isolation 404.
    const route = auditableRoute(await currentPath());
    const { error: auditError } = await supabase.rpc(
      "audit_impersonated_page_view",
      { p_organisation_id: organisationId, p_route: route },
    );
    if (auditError) {
      console.error(
        "[admin] audit_impersonated_page_view() refused; treating this request as NOT impersonating rather than serving an unaudited page:",
        auditError.message,
      );
      return null;
    }

    return {
      sessionId: data.id as string,
      organisationId,
      reason: data.reason as string,
      expiresAt: data.expires_at as string,
    };
  },
);
