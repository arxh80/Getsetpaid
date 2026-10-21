// The impersonation contract's PURE half: two constants and one string
// function, with no `server-only` marker and no Supabase import.
//
// ===========================================================================
// WHY THIS IS A SEPARATE FILE FROM lib/admin/impersonation-session.ts
// ===========================================================================
// FOUND BY BUILDING, NOT BY REVIEW. These constants belonged in
// impersonation-session.ts on first write, and that file is `server-only` and
// imports lib/supabase/server. Three Client Components need the time-box to
// write "60 minutes" into their copy (the request form's explanation and the
// start/accept confirmations), and importing it from there pulled the whole
// server module -- cookies(), the Supabase server client -- into the client
// graph, which Next.js refuses with the `server-only` error at build time:
//
//     ./lib/supabase/server.ts  [Client Component SSR]
//     ./lib/admin/impersonation-session.ts  [Client Component SSR]
//     ./components/admin/impersonation-actions.tsx  [Client Component SSR]
//
// The fix is not to drop `server-only` from that file -- it exists to keep a
// server Supabase client out of a bundle -- and not to hardcode "60" in three
// components, which is the drift the constant exists to prevent. It is to put
// the parts that are genuinely shared, and genuinely inert, where both sides
// can reach them.
//
// NOTHING HERE IS A CONTROL. The database owns every value in this file:
// private.impersonation_time_box() is what start_impersonation_session()
// actually stamps onto expires_at, and
// private.impersonated_organisations() resolves the envelope by joining
// role_permissions rather than reading any string from here.
// tests/integration/rls/impersonation-matches-db.test.ts asserts the two
// agree, reading the expectation out of a real Postgres rather than restating
// it, because a number duplicated in two languages is a number that will
// disagree.

/**
 * The time-box, in minutes. DECISIONS-QUEUE Q95 (default taken 2026-09-08).
 *
 * Used only for COPY -- "this session lasts 60 minutes" -- which the UI has to
 * be able to say before any session exists and therefore before there is an
 * `expires_at` to read. Once a session is live, every rendered end-time comes
 * from the database's own `expires_at` column, never from this number plus a
 * clock.
 */
export const IMPERSONATION_TIME_BOX_MINUTES = 60;

/**
 * The role whose permission set an impersonating superuser is granted.
 * DECISIONS-QUEUE Q96 (read-only) / Q97 (at full record scope).
 *
 * A LABEL FOR A RULE THE DATABASE OWNS. private.impersonated_organisations()
 * joins public.role_permissions for this role_key rather than listing
 * permission keys, so the envelope is whatever the product means by "Read
 * Only" at the time it is evaluated -- and the binding test asserts this exact
 * key exists in public.roles and grants no write permission.
 */
export const IMPERSONATION_ROLE_ENVELOPE = "read_only";

/**
 * The route string the page-access audit records: path only, query string
 * discarded.
 *
 * lib/supabase/middleware.ts stamps `${pathname}${search}` onto the header
 * lib/auth/current-path.ts reads, and `search` is where a list page's `q=`
 * search term lives. A SEARCH TERM IS CONTENT -- a fragment of what the
 * tenant's records say, typed by whoever is looking -- and the brief is
 * explicit that the page-access audit carries "route only, no content".
 *
 * A path SEGMENT's record id is deliberately KEPT: knowing which record
 * support opened is the entire point of the trail, and an id is not content.
 */
export function auditableRoute(path: string): string {
  const [pathname] = path.split("?");
  return pathname ?? "/";
}
