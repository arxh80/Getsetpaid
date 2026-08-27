/**
 * The first path segment of a request path, or null for "/" itself.
 *
 * Used by app/(app)/layout.tsx to work out which org (if any) the current
 * request concerns, WITHOUT hardcoding a list of "reserved" top-level routes
 * (invites, onboarding, ...) to exclude first. That exclusion is unnecessary:
 * the candidate this returns is only ever treated as a real org once it
 * survives getCurrentOrg()'s own RLS-gated lookup, so a non-org route (or an
 * org slug that isn't the caller's) both come back null from THAT call
 * regardless of what this function handed it -- see the layout for where it
 * is used.
 *
 * Pure and synchronous so it is trivially unit-testable without a request
 * context -- see lib/auth/current-path.ts for where the raw pathname comes
 * from in real use (a header stamped by middleware).
 */
export function firstPathSegment(pathname: string): string | null {
  const path = pathname.split("?")[0]!.split("#")[0]!;
  const [, first] = path.split("/");
  return first || null;
}
