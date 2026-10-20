"use client";

// Browser Supabase client.
//
// Used only where the browser genuinely has to talk to Supabase directly:
// starting the Google OAuth redirect (which needs to navigate the top-level
// window and, for PKCE, to write a code-verifier cookie the callback route
// then reads). Everything else in this app -- sign-in, sign-up, magic link,
// org creation, invites, acceptance -- goes through Server Actions against
// lib/supabase/server.ts, so credentials never touch client-side JavaScript.
//
// createBrowserClient() is memoised internally by @supabase/ssr, so calling
// this per component is fine and does not produce competing auth listeners.
//
// It reads and writes the SAME cookies the server client uses, which is the
// entire reason for using @supabase/ssr rather than plain supabase-js: a
// session established in the browser is visible to Server Components on the
// next request, and a refresh performed in middleware is visible here.
import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions, supabasePublicKey, supabaseUrl } from "./env";

export function createClient() {
  return createBrowserClient(supabaseUrl(), supabasePublicKey(), {
    cookieOptions: authCookieOptions(),
  });
}
