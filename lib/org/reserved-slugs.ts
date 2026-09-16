// Workspace addresses that belong to the product itself.
//
// A workspace lives at /<slug>, beside the app's static top-level routes, and
// Next.js resolves a static segment first -- so a workspace called `legal`
// could be created and never opened (every /legal/* path is the legal pages),
// and one called `account` would lose /account/privacy (Phase 8 Task 2 review,
// M7; DECISIONS-QUEUE Q151).
//
// THE DATABASE ENFORCES THIS, not this file: private.reserved_workspace_slugs()
// and the trigger private.organisations_slug_not_reserved()
// (20260923005000) refuse a reserved slug on every insert and every slug
// change. This copy exists only so the create form can say so in words before
// the round trip. tests/unit/org/reserved-slugs.test.ts asserts that this
// list, the database's list and the static top-level segments app/ defines
// are the same set -- so adding a top-level route without reserving it is a
// red test.

export const RESERVED_WORKSPACE_SLUGS: readonly string[] = [
  "account",
  "api",
  "auth",
  "invites",
  "legal",
  "login",
  "magic-link",
  "onboarding",
  "signup",
  "super",
];

export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED_WORKSPACE_SLUGS.includes(slug.trim().toLowerCase());
}

/** The database's hint for the refusal (private.organisations_slug_not_reserved). */
export const RESERVED_SLUG_HINT = "reserved_slug";

export const RESERVED_SLUG_MESSAGE =
  "That address is used by a page of GetSetPaid. Choose a different one.";
