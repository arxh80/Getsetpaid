import "server-only";

// Server-side Supabase client, backed by the request's auth cookies.
//
// This is the client that every Server Component, Server Action and Route
// Handler uses. It carries the SIGNED-IN USER's identity, which means every
// query it makes is subject to RLS exactly as the database intends -- an
// organisation the user is not an active member of does not exist as far as
// this client is concerned. That is the property the whole tenancy model
// rests on, so prefer this client for absolutely everything and reach for
// lib/supabase/admin.ts only where a Supabase Admin API call genuinely has no
// user-scoped equivalent.
//
// NEVER CACHE OR SHARE THE RETURNED CLIENT ACROSS REQUESTS. It closes over one
// request's cookie jar; a module-level singleton would hand user A's session
// to user B. @supabase/ssr says the same thing in createServerClient's own
// docs ("always create a new client for each server render").
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { authCookieOptions, supabasePublicKey, supabaseUrl } from "./env";

let warnedNoServerMark = false;

// THE SERVER-ONLY REQUEST MARK (Phase 10 Task 5, G2/G14). Sent on every
// request from this client and no other; the database (api_hooks.pre_request)
// hashes it against private.server_request_digest. Without it the network
// directory views are refused and an impersonation session reads nothing, so
// a missing value fails closed -- and says so once, by name.
function serverMarkHeaders(): Record<string, string> | undefined {
  const mark = process.env.GETSETPAID_SERVER_REQUEST_SECRET;
  if (mark) return { "x-getsetpaid-server": mark };
  if (!warnedNoServerMark) {
    warnedNoServerMark = true;
    console.error(
      "GETSETPAID_SERVER_REQUEST_SECRET is not set: the network directory and " +
        "impersonation will be refused (SECURITY.md § 15).",
    );
  }
  return undefined;
}

export async function createClient() {
  // Async since Next 15 -- cookies() returns a Promise.
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabasePublicKey(), {
    global: { headers: serverMarkHeaders() },
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Server Components are not allowed to write cookies, and Next throws
        // when they try. That is EXPECTED here and safe to swallow, but only
        // because middleware.ts runs createClient() + getClaims() on every
        // matched request and refreshes the session there, where the response
        // is still writable. If that middleware is ever removed, this catch
        // turns token refresh into a silent no-op and users get logged out at
        // seemingly random intervals -- the exact failure @supabase/ssr warns
        // about. Server Actions and Route Handlers CAN write cookies, so the
        // sign-in / sign-out paths land their cookies through here for real.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Read-only cookie store (a Server Component render). See above.
        }
      },
    },
  });
}
