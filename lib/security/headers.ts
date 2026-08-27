// Response security headers, in one place, for both the places that set them.
//
// ===========================================================================
// THE FINDING THIS CLOSES
// ===========================================================================
// next.config.ts shipped as the seven-line scaffold default for the whole
// Foundation phase, with no headers() block and nothing in proxy.ts setting
// one either. So the application served NO Content-Security-Policy, no
// frame-ancestors, no HSTS, no Referrer-Policy and no X-Content-Type-Options.
// CLAUDE.md § Non-negotiable rules lists a strong CSP as an acceptance
// criterion, not a hardening task ("Treat all user content as untrusted ...
// ship a strong CSP"), and the most immediately exploitable gap was that
// /login, /magic-link and the MFA challenge screen were all frameable -- a
// clickjacking overlay over the MFA challenge attacks precisely the control
// this phase built.
//
// It fell between Task 1 (scaffolded the config and left it empty) and Task 10
// (which audited SOURCE for token compliance, not RESPONSE HEADERS), so no
// per-task brief owned it and no per-task review could have caught it.
//
// ===========================================================================
// WHY THE HEADERS ARE SET IN TWO PLACES, WHICH IS NOT AN ACCIDENT
// ===========================================================================
//   next.config.ts headers()   the STATIC headers. Applied by Next to every
//                              response, including the ones proxy.ts's matcher
//                              deliberately excludes (/_next/static, images,
//                              favicon). X-Content-Type-Options in particular
//                              is most valuable on exactly those asset
//                              responses.
//
//   proxy.ts (middleware)      the CSP, because it carries a PER-REQUEST
//                              NONCE and therefore cannot be a static config
//                              value. This is Next's documented mechanism:
//                              middleware puts the policy on the REQUEST
//                              headers, Next parses the nonce back out of it
//                              and stamps it onto the framework's own inline
//                              bootstrap scripts.
//
// Both call into this module, so there is one definition of each header and no
// opportunity for the two to drift.
//
// ===========================================================================
// WHAT THE POLICY DELIBERATELY ALLOWS, AND WHY -- read before widening it
// ===========================================================================
// A CSP that permits everything is worse than none, because it looks like a
// control in an audit. Every allowance here is named:
//
//   script-src 'strict-dynamic'
//     Required, not cosmetic. Next's bootstrap script (which does carry the
//     nonce) loads the route's chunks programmatically; without
//     'strict-dynamic' each of those would need its own nonce, which Next does
//     not emit. 'strict-dynamic' says "scripts loaded BY an already-trusted
//     script are trusted", which is the accurate description of what Next
//     does. Note that it makes CSP3 browsers IGNORE the 'self' beside it --
//     'self' is retained purely as the CSP2 fallback.
//
//   style-src 'unsafe-inline'
//     THE ONE BROAD ALLOWANCE IN THIS POLICY, and it is stated plainly rather
//     than buried. React/Next emit inline style attributes and <style>
//     elements during SSR that carry no nonce, and next/font/google injects a
//     <style> block for the self-hosted font faces. Measured, not assumed:
//     with style-src 'self' the production build reports CSP violations on
//     every route. There is no nonce path available for these today.
//     What it does NOT weaken: script execution is unaffected, and the app
//     ships zero dangerouslySetInnerHTML (grepped, still true), so the XSS
//     sink that would exploit inline styles is not present. Revisit if Next
//     gains style nonce propagation.
//
//   form-action includes the Supabase origin and accounts.google.com
//     The Google sign-in button is a <form action={signInWithGoogleAction}>,
//     because the provider URL is minted per request and carries PKCE state
//     (see lib/auth/actions.ts). Chrome enforces form-action against the whole
//     REDIRECT CHAIN of a form submission, and that chain is
//     our origin -> {SUPABASE_URL}/auth/v1/authorize -> accounts.google.com.
//     With 'self' alone the no-JS path of Google SSO is silently blocked.
//     Two named origins, not a wildcard.
//
//   connect-src includes the Supabase origin
//     The browser Supabase client talks to it directly on every session
//     refresh. wss: for the same origin is included because @supabase/ssr
//     opens a Realtime socket if any code ever subscribes; nothing does yet,
//     but the origin is the same one already trusted for HTTP.
//
//   'unsafe-eval', in DEVELOPMENT ONLY
//     React Fast Refresh needs it. It is gated on NODE_ENV and never present
//     in a production build -- verified by reading the actual response headers
//     from `pnpm build && pnpm start`, which is the only way this kind of
//     claim should be made.
//
// And what it refuses: object-src 'none' (no Flash/applet vectors),
// frame-ancestors 'none' (the clickjacking fix), frame-src 'none' (the app
// embeds nothing), base-uri 'self' (a <base> injection cannot re-point every
// relative URL at an attacker's host), default-src 'self' as the catch-all.

/** Origin of the Supabase project, for connect-src/form-action. */
function supabaseOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * True when this deployment is actually served over HTTPS, read from the
 * configured site URL rather than from the request (Host and X-Forwarded-Proto
 * are both attacker-influenced -- the same reasoning siteUrl() in
 * lib/supabase/env.ts already applies).
 *
 * Gates HSTS and upgrade-insecure-requests. Both are meaningless over plain
 * HTTP, and upgrade-insecure-requests actively BREAKS local verification: it
 * would rewrite the local stack's http://127.0.0.1:54321 to https and every
 * Supabase call would fail. Omitting them locally is deliberate, so that
 * `pnpm build && pnpm start` exercises the same app a browser will.
 */
function isHttpsDeployment(): boolean {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The headers that do not vary per request. Set from next.config.ts so they
 * reach every response, including static assets outside proxy.ts's matcher.
 */
export function staticSecurityHeaders(): { key: string; value: string }[] {
  const headers = [
    // Belt and braces with the CSP's frame-ancestors: X-Frame-Options is what
    // an older browser (or a scanner) actually honours, frame-ancestors is
    // what a current one does. They agree.
    { key: "X-Frame-Options", value: "DENY" },
    // Stops a browser MIME-sniffing an uploaded/served file into something
    // executable. Most valuable on exactly the /_next/static responses the
    // proxy matcher excludes, which is half of why these live here.
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Send the full URL only to ourselves. Cross-origin gets the origin alone,
    // so an org slug, a membership id or a ?next= path never leaks in a
    // Referer to a third party.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Nothing in the product uses any of these, so none is granted. A future
    // feature that needs one adds it here deliberately.
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    // Isolates this origin's browsing-context group from cross-origin popups,
    // which is what makes an OAuth popup unable to reach back into the page.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];

  if (isHttpsDeployment()) {
    // Two years, subdomains included, preload-eligible. Only sent on an HTTPS
    // deployment -- see isHttpsDeployment() for why not locally.
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }

  return headers;
}

/**
 * Builds the CSP for one request, around one nonce.
 *
 * Newline-separated directives are legal CSP and are what Next's own example
 * emits; they are collapsed to single spaces before the header is set so the
 * value is a single line on the wire.
 */
export function contentSecurityPolicy(nonce: string): string {
  const supabase = supabaseOrigin();
  const supabaseWs = supabase ? supabase.replace(/^http/, "ws") : null;
  const isDev = process.env.NODE_ENV !== "production";

  const connect = ["'self'", supabase, supabaseWs].filter(Boolean).join(" ");
  const form = ["'self'", supabase, "https://accounts.google.com"]
    .filter(Boolean)
    .join(" ");

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // See the header note: the single broad allowance, and why.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    `form-action ${form}`,
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];

  if (isHttpsDeployment()) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
