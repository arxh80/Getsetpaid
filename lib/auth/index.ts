// Session/org resolution helpers used throughout the app.
// Filled in by a later Foundation-phase task once lib/supabase/server.ts and
// the organisation_memberships table exist (see CLAUDE.md § Tenancy model).
// Placeholder signatures only — real implementations resolve the session
// user and their active organisation from the authenticated request.

export async function getCurrentUser(): Promise<null> {
  return null;
}

export async function getCurrentOrg(): Promise<null> {
  return null;
}
