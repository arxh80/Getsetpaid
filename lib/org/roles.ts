// Roles offered by the invite form.
//
// WHY THIS IS ITS OWN FILE and not a const in lib/org/actions.ts: a
// "use server" module may only export async functions. Exporting this array
// from there compiles cleanly and then throws at runtime, on module
// evaluation, with `A "use server" file can only export async functions, found
// object` -- which surfaces as a 500 on the page that imports it, not as a
// build failure. Keep plain data out of action files.
//
// Mirrors public.roles minus 'owner': transferring ownership is a distinct,
// higher-stakes action and does not belong in an invite dropdown.
//
// This is a UI convenience. Removing it entirely would change nothing about
// what is actually permitted -- organisation_memberships.role is FK-constrained
// to public.roles, and the whole INSERT is refused unless the caller holds
// 'manage_members'.
export const INVITABLE_ROLES = [
  { key: "admin", label: "Admin" },
  { key: "manager", label: "Manager" },
  { key: "booker", label: "Booker" },
  { key: "venue_manager", label: "Venue Manager" },
  { key: "finance", label: "Finance" },
  { key: "marketing", label: "Marketing" },
  { key: "standard_user", label: "Standard User" },
  { key: "read_only", label: "Read Only" },
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number]["key"];

/**
 * Allowlist check, not a filter: an unexpected value is rejected outright
 * rather than coerced, so a tampered <select> cannot smuggle an arbitrary
 * string toward the foreign key.
 */
const KEYS = new Set<string>(INVITABLE_ROLES.map((r) => r.key));

export function isInvitableRole(value: string | null): value is InvitableRole {
  return value !== null && KEYS.has(value);
}
