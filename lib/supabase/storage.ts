import "server-only";

// ===========================================================================
// SERVICE-ROLE STORAGE CLIENT. READ THIS BEFORE IMPORTING IT ANYWHERE.
// ===========================================================================
//
// The `documents` bucket is private and fenced: storage.objects carries a
// RESTRICTIVE deny-all policy for `authenticated` and `anon`
// (20260902030000), so the ordinary user-scoped server client
// (lib/supabase/server.ts) CANNOT read or write a `documents` object -- by
// design. The ONLY principal that can is `service_role`, which bypasses RLS.
// So server-mediated storage I/O (the upload here, the signed-URL issue in
// Task 5) runs through THIS client, on the server, after the caller has
// already been authorised by the Server Action.
//
// This is a separate factory from lib/supabase/admin.ts on purpose: that file
// documents itself as "used for EXACTLY ONE THING: the GoTrue Admin API" and
// forbids growing new usage, and keeping that invariant literally true is
// worth one more small file. The security envelope is identical to admin.ts's:
//
//   1. `import "server-only"` -- if a Client Component's import graph ever
//      reaches this file, the BUILD FAILS. Not a review convention.
//   2. The key is SUPABASE_SERVICE_ROLE_KEY, no NEXT_PUBLIC_ prefix, so
//      Next.js will not inline it into a client bundle (lib/supabase/env.ts).
//   3. This client is used for `.storage` ONLY -- never `.from(...)` table
//      access. `service_role` holds ZERO table privileges in this schema (the
//      RLS suites assert it), and privileged TABLE work belongs in a
//      SECURITY DEFINER function, not here. Storage is not a `public` table
//      and has no user-scoped equivalent for a fenced private bucket, which is
//      the one reason a service-role client is unavoidable at all.
//
// Constructed per call, no session, never writes auth cookies.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseSecretKey, supabaseUrl } from "./env";

export function createStorageClient() {
  return createSupabaseClient(supabaseUrl(), supabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
