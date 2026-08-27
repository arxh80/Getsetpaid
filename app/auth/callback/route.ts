import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/auth/redirects";

// ===========================================================================
// The single landing point for every Supabase auth redirect.
//
// It has to handle TWO DIFFERENT MECHANISMS, because Supabase does not use one
// for everything. This was verified against the running local stack rather
// than assumed -- see the report for the transcript.
//
//   ?code=<pkce code>            Google OAuth, and any PKCE email flow.
//                                Exchanged for a session server-side. The code
//                                verifier lives in a cookie the browser client
//                                set when it started the flow.
//
//   ?token_hash=<hash>&type=...  Invites and magic links, via verifyOtp().
//
// WHY BOTH, AND WHY THE EMAIL TEMPLATES WERE CHANGED:
//   supabase-js documents that "PKCE is not supported when using
//   inviteUserByEmail ... the browser initiating the invite is often different
//   from the browser accepting the invite". Confirmed empirically: GoTrue's
//   default invite email points at /auth/v1/verify, which 303s to
//     <redirect_to>#access_token=...&refresh_token=...
//   -- an IMPLICIT-flow URL FRAGMENT. A fragment is never sent to the server,
//   so a route handler cannot see it at all; picking it up would mean shipping
//   the tokens into client-side JavaScript and posting them back.
//
//   So supabase/templates/invite.html and magic-link.html link here with
//   `token_hash` instead, and verifyOtp() completes the exchange server-side.
//   The tokens never touch the browser's URL, its history, or a Referer
//   header. Do not revert those templates to {{ .ConfirmationURL }} without
//   also building the client-side fragment handler they would then require.
//
// EVERY FAILURE LANDS ON /login WITH A GENERIC REASON. The specific GoTrue
// error is not surfaced: "this link expired" versus "this link was already
// used" versus "no such token" tells an attacker holding a stolen link which
// of those it is. One message, one destination.
// ===========================================================================

/** Types verifyOtp accepts here. An unrecognised `type` is refused, not coerced. */
const EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  "invite",
  "magiclink",
  "signup",
  "recovery",
  "email_change",
  "email",
]);

/**
 * Redirect with a RELATIVE `Location`, resolved by the browser against the URL
 * it actually requested.
 *
 * WHY NOT `NextResponse.redirect(new URL(path, request.url))` -- the obvious
 * version, and the one every tutorial shows:
 *
 *   In a Route Handler, both `request.url` and `request.nextUrl` are built from
 *   the SERVER's hostname, not from the request's Host header. Under
 *   `next start` they come back as `http://localhost:3000/...` even when the
 *   browser asked for `http://127.0.0.1:3000/...`, and even when the server is
 *   explicitly bound with `-H 127.0.0.1`. localhost and 127.0.0.1 are different
 *   ORIGINS to a browser, so every auth cookie this route just set is dropped
 *   on the redirect, and the user lands on /login having just "successfully"
 *   signed in.
 *
 *   Caught end-to-end, not by reasoning: the invite link verified correctly,
 *   verifyOtp returned a session, and the invitee still ended up at the login
 *   page. The same class of bug hits any deployment where the public hostname
 *   differs from what the Node server thinks it is -- i.e. anything behind a
 *   proxy, a load balancer or a custom domain.
 *
 * A relative Location sidesteps the question entirely: RFC 7231 has the client
 * resolve it against the request URI, so it lands on whatever origin the user
 * was already on. It is also strictly safer -- a relative Location CANNOT point
 * off-site, which reinforces the open-redirect protection in safeNextPath()
 * rather than depending on it alone.
 *
 * 303 See Other, not 307: this is "the operation is done, go look over there",
 * and it is unambiguously a GET for the client.
 *
 * Cookies set by the Supabase client through next/headers are attached to
 * whatever response this handler returns, so building the response by hand
 * does not lose the session.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: path },
  });
}

function failure(reason: string): NextResponse {
  return redirectTo(`/login?error=${encodeURIComponent(reason)}`);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The provider or GoTrue itself rejected the attempt (user hit "cancel" on
  // Google's consent screen, provider misconfigured, and so on).
  if (params.get("error")) {
    return failure("link_failed");
  }

  // `next` is attacker-controllable -- it is a query parameter on a link that
  // arrives by email. safeNextPath keeps same-origin paths only; without it
  // this route is an open redirect that launders the trust of a completed
  // sign-in. See lib/auth/redirects.ts.
  const next = safeNextPath(params.get("next"));

  const supabase = await createClient();

  const code = params.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failure("link_failed");
    return redirectTo(next);
  }

  const tokenHash = params.get("token_hash");
  const rawType = params.get("type");
  if (tokenHash && rawType) {
    // Validate against the allowlist rather than casting the string through.
    if (!EMAIL_OTP_TYPES.has(rawType as EmailOtpType)) {
      return failure("link_failed");
    }
    const type = rawType as EmailOtpType;

    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return failure("link_failed");

    // A recovery link means "let me set a new password", which is the account
    // -setup screen's job, not the destination the link happened to carry.
    if (type === "recovery") {
      return redirectTo("/invites?welcome=1");
    }
    // An invite lands on the invite screen in "welcome" mode, which offers to
    // set a password -- an invited user has none yet (see
    // completeAccountSetupAction) and would otherwise be locked out when this
    // session expires.
    if (type === "invite") {
      if (next === "/") return redirectTo("/invites?welcome=1");
      // The base is a throwaway -- only pathname+search are kept, so the
      // Location stays relative. `next` has already been through safeNextPath.
      const withWelcome = new URL(next, "https://gsp.invalid");
      withWelcome.searchParams.set("welcome", "1");
      return redirectTo(`${withWelcome.pathname}${withWelcome.search}`);
    }

    return redirectTo(next);
  }

  // Neither mechanism present: somebody navigated here directly, or a link was
  // truncated in an email client.
  return failure("link_failed");
}
