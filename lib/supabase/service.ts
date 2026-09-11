import "server-only";

// ===========================================================================
// SERVICE-ROLE TABLE CLIENT -- THE NOTIFICATION SENDER'S, AND NOBODY ELSE'S.
// READ THIS BEFORE IMPORTING IT ANYWHERE.
// ===========================================================================
//
// lib/supabase/admin.ts is "the GoTrue Admin API and nothing else" and
// lib/supabase/storage.ts is "`.storage` and never `.from(...)`". Both
// headers say a privileged TABLE need belongs in a SECURITY DEFINER function,
// and for a caller WITH a session that is still true. This file exists for
// the one caller that has no session at all: the email sender.
//
// Phase 7 Task 5's fix round (20260909070000, review finding I3) settled how
// the incident-alert email seam is reached: `service_role` was granted
// `select` on `incident_alerts` and `update` on `notified_at` ALONE, because
// a sender is a server-side job with no user, so no RLS policy can name it
// and no session-scoped RPC can authorise it. 20260911000000 gives
// `public.feedback` the identical, column-narrow grant. So this client's
// reach is bounded BY THE GRANTS, not by convention: it can read the two
// notification tables and stamp one column on each, and a `.from()` against
// any other table in this schema fails at the privilege check, because
// `service_role` still holds nothing else (the RLS suites assert it).
//
// THE SAME FOUR PROPERTIES admin.ts and storage.ts keep:
//   1. `import "server-only"` -- a Client Component reaching this file is a
//      BUILD failure, not a review note.
//   2. The key is SUPABASE_SERVICE_ROLE_KEY, never NEXT_PUBLIC_.
//   3. Constructed per call, no session, never writes auth cookies.
//   4. ONE IMPORTER: lib/email/*. tests/unit/email/service-client-census.test.ts
//      is the source-only census that keeps it that way -- a second importer
//      fails the suite, so growing this into a general-purpose RLS bypass is
//      a visible decision rather than a drift.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseSecretKey, supabaseUrl } from "./env";

export function createServiceClient() {
  return createSupabaseClient(supabaseUrl(), supabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
