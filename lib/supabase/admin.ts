import "server-only";

// ===========================================================================
// SERVICE-ROLE CLIENT. READ THIS BEFORE IMPORTING IT ANYWHERE.
// ===========================================================================
//
// This client authenticates as `service_role`, which BYPASSES ROW LEVEL
// SECURITY. It is the one credential in the system that can ignore the tenant
// boundary, and CLAUDE.md § Non-negotiable rules lists keeping it off the
// client as an acceptance criterion, not a hardening task:
//
//     "Service-role keys stay server-side. They bypass RLS. Never ship them
//      to the browser."
//
// FOUR THINGS KEEP THAT TRUE, and all four have to stay:
//
//   1. `import "server-only"` at the top of this file. If any module in a
//      Client Component's import graph reaches this file, the BUILD FAILS.
//      That is a compile-time guarantee, not a code-review convention.
//   2. The key is read from SUPABASE_SERVICE_ROLE_KEY, with no NEXT_PUBLIC_
//      prefix, so Next.js will not inline it into a client bundle even by
//      accident (see lib/supabase/env.ts).
//   3. `service_role` holds ZERO table privileges in this schema. Task 4's
//      migration revoked them all deliberately (design note (e): "a leaked
//      service key is not, by itself, a read of every tenant's data") and the
//      RLS suites assert it -- H16/H17/H18 in the SQL suite, plus J4 for
//      accept_invite. So even here, a table read would fail.
//   4. Consequently this client is used for EXACTLY ONE THING: the GoTrue
//      Admin API (`.auth.admin.*`), which is not a table and is not covered
//      by RLS at all. Nothing in this file may grow a `.from(...)` call. If a
//      future feature needs privileged table access, that is a SECURITY
//      DEFINER function in a migration -- reviewed, search_path-pinned,
//      auth.uid()-anchored -- not a service-role table write.
//
// WHY THE ADMIN API IS NEEDED AT ALL (the invite flow's real constraint):
//   organisation_memberships.user_id is NOT NULL and references auth.users.
//   So a membership row cannot exist for somebody who has never signed up --
//   there is no id to point at. Creating that auth.users row is an Admin API
//   operation and has no user-scoped equivalent. What this client does NOT do
//   is create the membership: that INSERT is made by the inviting admin's own
//   session, through RLS, gated by has_permission(org, 'manage_members'). The
//   privilege check stays in the database. See lib/org/invites.ts.
//
// Session persistence is off: this client is constructed per call, has no
// user, and must never write auth cookies.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseSecretKey, supabaseUrl } from "./env";

export function createAdminClient() {
  return createSupabaseClient(supabaseUrl(), supabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
