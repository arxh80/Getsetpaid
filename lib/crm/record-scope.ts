// Which organisation roles see only the records assigned to them.
//
// This is a MIRROR of `private.full_scope_organisations()`
// (20260828120500_crm_policy_helpers.sql), whose body is:
//
//     where m.user_id = (select auth.uid())
//       and m.status = 'active'
//       and m.role not in ('standard_user', 'read_only')
//
// The database is authoritative and this file changes nothing about what a
// query returns -- record scope is enforced by the SELECT policies and would
// hold identically if this file did not exist. What it is for is COPY: a
// Standard User's contacts list is not short because the organisation is
// empty, it is short because they are seeing their own records, and a list
// that says "No contacts yet" to them is telling them something false about
// their employer's data. Only the role tells the page which of those two
// sentences is true.
//
// TWO REPRESENTATIONS OF ONE RULE IS THE DRIFT RISK THIS CODEBASE ALREADY HAS
// A HABIT ABOUT. `subscription_plans` vs `TIER_MATRIX`,
// `private.role_requires_mfa` vs `MFA_REQUIRED_ROLES`, `has_permission` vs
// `permitted_organisations`, `past_due_grace_days()` vs `PAST_DUE_GRACE_DAYS`
// -- each is bound by a test that drives BOTH sides rather than comparing
// strings. This one is bound the same way, by
// tests/integration/list/record-scope-matches-db.test.ts, which builds a real
// membership at every role in public.roles and asks the deployed function.
//
// The failure it exists to catch is a quiet one: a role added later that the
// policy treats as record-scoped, while this list still calls it full-scope,
// so the new role gets an empty page and copy insisting the organisation has
// no contacts.

export const RECORD_SCOPED_ROLES = ["standard_user", "read_only"] as const;

export type RecordScopedRole = (typeof RECORD_SCOPED_ROLES)[number];

export function isRecordScopedRole(role: string): boolean {
  return (RECORD_SCOPED_ROLES as readonly string[]).includes(role);
}
