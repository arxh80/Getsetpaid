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
// reach is bounded BY THE GRANTS, not by convention: a `.from()` against any
// other table in this schema fails at the privilege check, because
// `service_role` still holds nothing else (the RLS suites assert it).
//
// WHAT IT REACHES, AS OF TASK 6c (fix round 1, M4 -- this paragraph was stale
// within one task of being written, which is why it now enumerates):
//
//   * `public.incident_alerts` -- select, and update on TWO columns:
//     `notified_at` (the operator's digest carried this row) and
//     `account_notified_at` (the account holder has been told, founder ruling
//     Q114). They are separate seams on purpose: different recipients,
//     independent failure.
//   * `public.feedback` -- select, and update on `notified_at` alone.
//   * ONE RPC: `public.pending_lockout_notifications(int)`, called from
//     lib/email/lockout-notification.ts to resolve the addresses of accounts
//     with an unnotified lockout alert.
//
// AN RPC IS BOUNDED BY ITS OWN GRANT, NOT BY THE TABLE GRANTS ABOVE IT, and
// that distinction is the whole reason this paragraph exists: a SECURITY
// DEFINER function runs as its OWNER, so anything this client can execute can
// reach past every grant listed here. `pending_lockout_notifications` is
// therefore built to be safe to hold rather than merely convenient: it is
// `security definer`, owned by `postgres`, revoked from public/anon/
// authenticated and granted to `service_role` ALONE, and it takes NO user
// argument -- it cannot be asked for a chosen person's address, only for the
// accounts that currently have an unnotified lockout alert. A future RPC added
// to this list gets the same three questions: who owns it, who may execute it,
// and what can the caller ask it FOR.
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
