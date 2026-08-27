// Session refresh for Next.js middleware.
//
// WHY THIS EXISTS AT ALL
//   A Server Component cannot write cookies. So when an access token expires
//   mid-render, the server client refreshes it, tries to persist the new one,
//   and silently cannot -- the user is then logged out at an interval that
//   looks random. Middleware runs before rendering, on a response that IS
//   writable, so it is the one place a refresh can actually be saved.
//   @supabase/ssr calls this out explicitly: "If cookies cannot be set from
//   pages or components, middleware *must* handle session updates."
//
// THE RESPONSE-OBJECT RULE (the classic way to get this subtly wrong)
//   The NextResponse created here is the object Supabase writes refreshed
//   cookies onto. If you build a *different* response later and return that,
//   the refreshed cookies are dropped and the session dies. So: either return
//   this exact object, or copy its cookies onto whatever replaces it. The
//   redirect path below does the copy.
//
// AUTHENTICATION HERE IS UX, NOT ENFORCEMENT
//   The redirects below decide which SCREEN someone sees. They decide nothing
//   about which DATA they can reach -- that is RLS, in the database, on every
//   query. Middleware runs on an edge-ish runtime, is easy to misconfigure via
//   the matcher, and can be bypassed by anything that talks to Supabase
//   directly. Treat a middleware check as a nicety; never as the control.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabasePublicKey, supabaseUrl } from "./env";

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ["/login", "/signup", "/magic-link", "/auth"];

/** Signed-in users have no business on these -- bounce them to the hub. */
const SIGNED_OUT_ONLY_PATHS = ["/login", "/signup", "/magic-link"];

function isUnder(pathname: string, roots: string[]): boolean {
  return roots.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

/**
 * Fix round 1 (Task 7), Minor: the signed-in layout (app/(app)/layout.tsx)
 * needs the current path to send a user BACK to it once an interstitial gate
 * (MFA enrollment/challenge, future step-up) is satisfied -- without this,
 * every gate redirected to "/" regardless of what page the user actually
 * wanted. A Server Component/layout has no built-in way to read the request
 * path (that's a Client Component-only hook, usePathname()), so middleware
 * -- the one place that DOES see the raw request -- stamps it onto a request
 * header the layout reads back via next/headers's headers().
 */
const PATHNAME_HEADER = "x-pathname";

export async function updateSession(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    PATHNAME_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(supabaseUrl(), supabasePublicKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
        // Supabase hands us Cache-Control/Expires/Pragma alongside any
        // Set-Cookie. They matter: a CDN that caches a response carrying auth
        // cookies serves one user's session to the next visitor.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // MUST run before any response is generated, and must be getClaims() (or
  // getUser()) rather than getSession(): getSession() returns whatever the
  // cookie says without revalidating it, so it is not a basis for any decision
  // on the server. getClaims() verifies the JWT signature and triggers the
  // refresh whose cookies setAll() above persists.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims);

  const { pathname } = request.nextUrl;

  if (!isSignedIn && !isUnder(pathname, PUBLIC_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve the destination so sign-in can return them to it. Only the
    // path+query is carried, never a full URL -- see safeNextPath() in
    // lib/auth/redirects.ts for why an absolute URL here is an open redirect.
    if (pathname !== "/") {
      url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    }
    return copyCookies(response, NextResponse.redirect(url));
  }

  if (isSignedIn && isUnder(pathname, SIGNED_OUT_ONLY_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return copyCookies(response, NextResponse.redirect(url));
  }

  return response;
}

/**
 * Moves any cookies Supabase wrote during the refresh onto a replacement
 * response. Without this, redirecting throws away a freshly refreshed session
 * and the user bounces between /login and the app.
 */
function copyCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}
