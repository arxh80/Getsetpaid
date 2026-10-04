// The organisation-lifecycle contract's PURE half: the states, the retention
// constant and two date helpers, with no `server-only` marker and no Supabase
// import.
//
// SAME SPLIT, SAME REASON as lib/admin/impersonation-contract.ts, whose header
// explains it in full: Client Components need these values to write "60 days"
// and a deadline into their copy, and importing them from a `server-only`
// module drags cookies() and the server Supabase client into the client
// bundle, which Next.js refuses at build time.
//
// NOTHING HERE IS A CONTROL. The database owns every value in this file:
// private.organisation_retention_days() is what actually stamps
// public.organisations.retention_expires_at, the lifecycle state is a CHECK
// constraint, and every rendered deadline on a real workspace comes from the
// stored column rather than from this number plus a clock.
// tests/integration/rls/lifecycle-matches-db.test.ts reads the real value out
// of Postgres and asserts the two agree -- the fourth instance of the pattern
// past-due-grace-matches-db.test.ts names, and for the same reason: a constant
// in two languages with nothing binding them is how this gets broken in six
// months.

/**
 * The wind-down retention window, in days. FOUNDER RULING Q88 (2026-09-07): a
 * suspended or deleted organisation retains its data for 60 days and may be
 * reactivated within that window.
 *
 * Used for COPY -- "you have 60 days" -- which the UI has to be able to say
 * about a workspace that is not yet suspended and therefore has no
 * `retention_expires_at` to read.
 *
 * WHAT IT IS NOT: a deadline after which reinstatement stops working.
 * public.reinstate_organisation() deliberately has no window check (see its
 * comment) -- past the deadline a workspace is wound down and out of the
 * directory, and the operator's undo still works, because a one-way door with
 * a clock on it is the failure mode this whole feature exists to avoid.
 */
export const ORGANISATION_RETENTION_DAYS = 60;

/**
 * The three states of public.organisations.lifecycle_state.
 *
 * `deleted` is a SOFT state -- CLAUDE.md § Superuser dashboard, "soft-delete
 * only... no immediate hard delete" -- and there is no hard-purge path
 * anywhere in this product. A `deleted` workspace differs from a `suspended`
 * one in exactly two observable ways: the word the customer's own banner uses,
 * and that it leaves the network directory at once rather than at the end of
 * its paid period (DECISIONS-QUEUE Q101).
 */
export type OrganisationLifecycleState = "active" | "suspended" | "deleted" | "owner_closed";

/** The two states in which a workspace is read-only and winding down. */
export const WOUND_DOWN_STATES: readonly OrganisationLifecycleState[] = [
  "suspended",
  "deleted",
  // Phase 8 Task 9c: the workspace's own Owner closed it
  // (public.close_my_workspace(); founder 2026-09-30, reversing Q104).
  "owner_closed",
];

export function isWoundDown(
  state: OrganisationLifecycleState,
): state is Exclude<OrganisationLifecycleState, "active"> {
  return state !== "active";
}

/**
 * The customer-facing word for a state.
 *
 * Deliberately NOT "deleted" for `deleted`: nothing has been deleted, and
 * telling a customer their workspace is deleted while every record in it is
 * still there and one operator click restores it would be the copy lying about
 * the mechanism. "Closed" is what the state actually is.
 */
export function lifecycleLabel(state: OrganisationLifecycleState): string {
  switch (state) {
    case "active":
      return "Active";
    case "suspended":
      return "Suspended";
    case "deleted":
      return "Closed";
    case "owner_closed":
      return "Closed by its Owner";
  }
}

/**
 * Days remaining until a retention deadline, floored at 0.
 *
 * Rendering "in 3 days" rather than a bare timestamp is the difference between
 * a banner a customer reads and a banner a customer skims. The timestamp is
 * shown too -- this is the urgency, not the fact.
 */
export function daysUntil(deadline: string | null, now: Date = new Date()): number | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
