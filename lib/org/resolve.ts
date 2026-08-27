import type { Membership } from "@/lib/auth";

/**
 * Picks which of the caller's OWN active memberships a client-supplied
 * organisation id should resolve to.
 *
 * Used identically for two inputs that are exactly as untrusted as each
 * other, on purpose:
 *   - the "last used workspace" cookie app/page.tsx reads to decide where to
 *     send a returning multi-org user (lib/org/current-org.ts)
 *   - the workspace switcher's submitted form field
 *     (lib/org/actions.ts's switchWorkspaceAction)
 *
 * A cookie and a form field are both things the browser fully controls, so
 * neither gets to skip this check just because one of them "should" already
 * be correct.
 *
 * `active` MUST already be the caller's own RLS-filtered active memberships
 * (lib/auth's getActiveMemberships()). This function does no database access
 * and grants nothing on its own -- it only decides which element of a list
 * the caller could already see to prefer. THIS IS WHAT MAKES THE COOKIE
 * STRUCTURALLY NOT AN AUTHORIZATION MECHANISM: it is never used to query
 * organisations or organisation_memberships directly, only to look itself up
 * inside a result the database already filtered.
 *
 * candidateOrgId not found in `active` -- because it names another tenant's
 * real org, a revoked or invited-only membership, or is simply garbage --
 * degrades to the exact same fallback as candidateOrgId being absent
 * entirely: the first active membership, in whatever order `active` was
 * given. That is deliberately the SAME arbitrary-first-membership behaviour
 * app/page.tsx had before this feature existed, so a bad candidate can never
 * do worse than "no cookie at all" already did -- never a 500, never a
 * distinguishable error, never a hint about whether the named org exists.
 */
export function resolveTargetMembership(
  candidateOrgId: string | null,
  active: Membership[],
): Membership | null {
  if (candidateOrgId) {
    const found = active.find((m) => m.organisationId === candidateOrgId);
    if (found) return found;
  }
  return active[0] ?? null;
}
