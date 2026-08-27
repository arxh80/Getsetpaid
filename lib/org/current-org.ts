import "server-only";

import { cookies } from "next/headers";

// "Last viewed workspace" cookie.
//
// CLAUDE.md § Tenancy model: "Never trust a client-supplied organisation ID."
// This cookie IS one -- client-supplied by construction, since the browser
// controls every cookie it sends back, and hand-editable by anyone with
// devtools. It is used for exactly one thing: letting app/page.tsx's hub
// redirect prefer the workspace a returning multi-org user last viewed over
// arbitrary query order. See lib/org/resolve.ts's resolveTargetMembership(),
// the ONLY function that ever reads a value out of this cookie -- it never
// queries anything with it, it only looks the value up inside a list
// (lib/auth's getActiveMemberships()) the caller's own RLS-filtered session
// already produced. A hand-edited cookie naming another tenant's real UUID, a
// revoked org, or pure garbage all take the identical path through that
// function: "not found among MY active memberships" -> ignored, fall back to
// the first one. Nothing reachable through this file can widen what the
// cookie's holder can see; at worst it reproduces the arbitrary-order
// behaviour this feature replaces.
export const CURRENT_ORG_COOKIE = "gsp_current_org";

// 180 days: long enough that "the workspace I was last in" survives a normal
// gap between sessions (this product's users work in bursts around events,
// not daily), short enough that a workspace someone hasn't touched in months
// eventually stops being "remembered" if they never come back to reselect it.
// Refreshed every time the org is (re)selected -- see writeCurrentOrgIdCookie's
// two call sites in lib/org/workspace-actions.ts -- so an actively used
// workspace never actually approaches this ceiling.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/**
 * Reads the raw cookie value, or null if it was never set.
 *
 * NEVER hand this straight to a query or an authorization decision -- always
 * through resolveTargetMembership() against the caller's own active
 * memberships first (see that file's header comment). Safe to call from any
 * Server Component: reading cookies is always allowed in the App Router;
 * see writeCurrentOrgIdCookie() below for why WRITING is more restricted.
 */
export async function readCurrentOrgIdCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(CURRENT_ORG_COOKIE)?.value ?? null;
}

/**
 * Sets the cookie. Callable only from a Server Action or Route Handler --
 * Next.js throws ("Cookies can only be modified in a Server Action or Route
 * Handler") if this runs during a plain Server Component render. Both call
 * sites are Server Actions in lib/org/actions.ts.
 *
 * Attribute choices, and why:
 *
 *   httpOnly: true  -- nothing in this app's client-side JavaScript ever
 *     needs to read this value; every consumer (app/page.tsx) runs on the
 *     server. Keeping it out of `document.cookie` removes one more thing an
 *     XSS payload could read, for zero functional cost -- there is no UI here
 *     that reflects "your current workspace" back from client state.
 *
 *   sameSite: "lax" -- the same policy this stack's own Supabase auth cookies
 *     use (see supabase/config.toml). This cookie carries no state-changing
 *     power (see the file header: worst case is a fallback to the same
 *     behaviour that existed before it), so CSRF is not the threat model for
 *     it at all -- "lax" is chosen simply so a top-level navigation landing on
 *     the app from an external link still sends it, matching the ordinary
 *     expectation for a "remember my preference" cookie, rather than the
 *     stricter "strict" a cookie that DID grant something would want.
 *
 *   secure: only in production -- the local Supabase CLI and `next dev` both
 *     serve over plain http://, so requiring `secure` unconditionally would
 *     silently stop the cookie from ever being set locally. Production is
 *     HTTPS-only (CLAUDE.md § Non-functional targets), so it is unconditional
 *     there.
 *
 *   path: "/" -- written from an org-scoped page (/{orgSlug}/...) but read
 *     from the hub at "/" (app/page.tsx). Scoping it to a narrower path would
 *     make the hub unable to see it at all.
 *
 *   maxAge: MAX_AGE_SECONDS -- see that constant's comment above.
 */
export async function writeCurrentOrgIdCookie(
  organisationId: string,
): Promise<void> {
  const store = await cookies();
  store.set(CURRENT_ORG_COOKIE, organisationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}
