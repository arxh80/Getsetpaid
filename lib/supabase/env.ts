// Environment plumbing for the Supabase clients.
//
// Every getter throws a NAMED error rather than handing `undefined` to
// createClient(), because the failure mode otherwise is a Supabase client that
// constructs fine and then 401s on every request with no indication that a
// variable is simply missing.
//
// THE PUBLIC/SECRET SPLIT IS THE POINT OF THIS FILE.
//   Next.js inlines any NEXT_PUBLIC_* variable into the client bundle at build
//   time. So the split below is not a naming convention, it is the boundary:
//
//     supabaseUrl()      NEXT_PUBLIC_ -- safe, and needed in the browser
//     supabasePublicKey()NEXT_PUBLIC_ -- safe: the anon/publishable key is
//                                        designed to be public, it is RLS that
//                                        protects the data behind it
//     supabaseSecretKey() NOT public  -- bypasses RLS entirely. Read only from
//                                        lib/supabase/admin.ts, which is
//                                        marked `server-only`.
//
//   SECURITY.md and CLAUDE.md § Non-negotiable rules both state it plainly:
//   "Service-role keys stay server-side. They bypass RLS. Never ship them to
//   the browser." Renaming the secret variable to NEXT_PUBLIC_* would publish
//   every tenant's data to anyone who opens devtools.

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local ` +
        "and fill it in from `supabase status` (local) or the project's API " +
        "settings (hosted).",
    );
  }
  return value;
}

/** Supabase project URL. Public by necessity -- the browser calls it. */
export function supabaseUrl(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

/**
 * The publishable (anon) key. Safe in the browser BY DESIGN: it carries no
 * privilege of its own, it only identifies the project. Row access is decided
 * by RLS against the session's JWT, not by this key.
 */
export function supabasePublicKey(): string {
  return required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * The service-role key. BYPASSES RLS COMPLETELY.
 *
 * Deliberately NOT prefixed NEXT_PUBLIC_, so Next cannot inline it into a
 * client bundle even if this module were imported from a Client Component --
 * `process.env.SUPABASE_SERVICE_ROLE_KEY` evaluates to undefined in the
 * browser, and the throw above turns that into a loud failure rather than a
 * silent unauthenticated client.
 *
 * Its ONLY caller is lib/supabase/admin.ts (marked `server-only`), and its
 * only sanctioned use in this phase is the GoTrue Admin API for invites --
 * never a table read or write. See that file's header.
 */
export function supabaseSecretKey(): string {
  return required(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Absolute origin used to build auth redirect URLs (OAuth callback, magic
 * link, invite link).
 *
 * Read from the environment rather than from the incoming request's Host
 * header: Host is attacker-controlled, and using it here would let a poisoned
 * Host redirect an auth code to another origin. Supabase also allow-lists
 * redirect targets server-side (config.toml `site_url` /
 * `additional_redirect_urls`), so this value must match one of those.
 */
export function siteUrl(): string {
  const raw = required("NEXT_PUBLIC_SITE_URL", process.env.NEXT_PUBLIC_SITE_URL);
  return raw.replace(/\/+$/, "");
}
