"use server";

// Authentication Server Actions.
//
// All of these run on the server, which is why the pages that use them are
// plain <form action={...}> submissions rather than client-side fetches: the
// password never enters client-side JavaScript, the form works with JS
// disabled, and the auth cookies are written by the same request that
// establishes the session.
//
// ON ACCOUNT ENUMERATION -- the rule this file follows throughout:
//   Sign-in, magic link and (as far as the UI is concerned) sign-up all return
//   the same message whether or not the address has an account. An auth form
//   that says "no account with that email" for one address and "wrong
//   password" for another is a membership oracle: it confirms which of a list
//   of harvested addresses are customers here, which is both a privacy leak
//   about our customers and a targeting list for credential stuffing.
//   Supabase itself is careful about this; we must not undo it in the UI.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/supabase/env";
import { safeNextPath } from "./redirects";
import { mayChangePassword, readAuthFreshness } from "./step-up";
import { bindSignUp, clearMustChoosePassword, isNewSignUp } from "./first-proof";
import { MUST_CHOOSE_PASSWORD_KEY } from "@/lib/supabase/middleware";
import {
  field,
  isValidEmail,
  passwordProblem,
  type FormState,
} from "@/lib/forms";

/** Where Supabase sends the user back to after an emailed link or OAuth. */
function callbackUrl(next: string): string {
  const url = new URL("/auth/callback", siteUrl());
  if (next !== "/") url.searchParams.set("next", next);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Sign up (email + password)
// ---------------------------------------------------------------------------
export async function signUpAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = field(formData, "email");
  const password = field(formData, "password");
  const fullName = field(formData, "fullName");
  const next = safeNextPath(field(formData, "next"));

  const fieldErrors: Record<string, string> = {};
  if (!email) {
    fieldErrors.email = "Enter your email address.";
  } else if (!isValidEmail(email)) {
    fieldErrors.email = "That doesn't look like an email address.";
  }
  if (!password) {
    fieldErrors.password = "Choose a password.";
  } else {
    const problem = passwordProblem(password);
    if (problem) fieldErrors.password = problem;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const supabase = await createClient();
  const { data: signedUp, error } = await supabase.auth.signUp({
    email: email!,
    password: password!,
    options: {
      // Lands in auth.users.raw_user_meta_data, which the Task 6 trigger
      // copies into public.profiles. CLIENT-WRITABLE -- display name only,
      // never anything an authorisation decision reads.
      data: fullName ? { full_name: fullName } : undefined,
      emailRedirectTo: callbackUrl(next),
    },
  });

  if (error) {
    // Supabase distinguishes "already registered" from other failures. We do
    // not pass that distinction on -- see the enumeration note above. A user
    // who really does have an account gets the same "check your email" screen.
    // over_email_send_rate_limit too: GoTrue answers it to a re-sign-up of
    // an unconfirmed account mailed inside [auth.email] max_frequency (20
    // minutes, G3), which a new address never gets -- the same oracle.
    if (
      error.status === 422 ||
      error.code === "user_already_exists" ||
      error.code === "over_email_send_rate_limit"
    ) {
      redirect(`/signup/check-email?email=${encodeURIComponent(email!)}`);
    }
    return { error: authErrorMessage(error.message) };
  }

  // Phase 10 Task 20 (Q245): tie a NEW account to this browser, so confirming
  // here keeps the password just typed. A sign-up that returned an EXISTING,
  // unconfirmed account gets no binding: GoTrue kept the FIRST registrant's
  // password on it, so whoever proves the inbox must choose a new one
  // (lib/auth/first-proof.ts).
  if (signedUp.user && isNewSignUp(signedUp.user)) await bindSignUp(signedUp.user.id);

  // With email confirmations disabled (the local default), signUp returns a
  // live session and the user is already signed in. With them enabled there is
  // no session yet and they must click the emailed link. Handle both rather
  // than assuming the local configuration.
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) redirect(next);

  redirect(`/signup/check-email?email=${encodeURIComponent(email!)}`);
}

// ---------------------------------------------------------------------------
// Sign in (email + password)
// ---------------------------------------------------------------------------
export async function signInAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = field(formData, "email");
  const password = field(formData, "password");
  const next = safeNextPath(field(formData, "next"));

  if (!email || !password) {
    return {
      fieldErrors: {
        ...(email ? {} : { email: "Enter your email address." }),
        ...(password ? {} : { password: "Enter your password." }),
      },
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // ONE message for wrong-password and no-such-account alike. Do not
    // "improve" this by reading error.code and being more specific.
    return {
      error: "That email and password don't match. Check both and try again.",
    };
  }

  redirect(next);
}

// ---------------------------------------------------------------------------
// Magic link
// ---------------------------------------------------------------------------
export async function magicLinkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = field(formData, "email");
  const next = safeNextPath(field(formData, "next"));

  if (!email || !isValidEmail(email)) {
    return { fieldErrors: { email: "Enter a valid email address." } };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // This is a SIGN-IN link, not a back-door signup. Without this, anyone
      // could create an account for any address by requesting a link for it,
      // bypassing the signup form entirely.
      shouldCreateUser: false,
      emailRedirectTo: callbackUrl(next),
    },
  });

  // Deliberately not surfacing `error` as a distinguishable outcome. The
  // dominant error here is "Signups not allowed for otp" -- i.e. no account
  // exists -- and showing it turns this form into an account-existence checker
  // for any address an attacker cares to type. Rate limiting is what bounds
  // abuse, not a distinguishable error message.
  //
  // The same holds for GoTrue's per-account mail throttle ([auth.email]
  // max_frequency, 20 minutes since G3): over_email_send_rate_limit comes back
  // only for an address that HAS an account and was mailed recently, so it
  // gets the "sent" page like everything else. The project-wide email cap
  // shares that code and is treated the same way. Only the per-IP request
  // limit, which says nothing about the address, is shown.
  if (error && error.status === 429 && error.code !== "over_email_send_rate_limit") {
    return { error: "Too many requests. Wait a minute and try again." };
  }

  redirect(`/magic-link/sent?email=${encodeURIComponent(email)}`);
}

// ---------------------------------------------------------------------------
// Google SSO
// ---------------------------------------------------------------------------
//
// NOT END-TO-END VERIFIABLE IN THIS TASK. The OAuth client id and secret are a
// founder action that has not happened yet, so there is no Google project to
// authenticate against. What is wired here is the whole of OUR side:
//
//   - The provider is configured in supabase/config.toml as
//     [auth.external.google], reading client_id / secret from the
//     GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET environment
//     variables through config.toml's `env(...)` substitution. Those are read
//     by the SUPABASE AUTH SERVER, not by this application -- which is why no
//     code in this repo reads them, and why neither is NEXT_PUBLIC_.
//   - The redirect target is our own /auth/callback, which already handles the
//     `?code=` exchange this flow produces.
//
// When the credentials exist, filling in those two variables and restarting
// the Supabase stack is the entire remaining step; no code change is expected.
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const raw = formData.get("next");
  const next = safeNextPath(typeof raw === "string" ? raw : null);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl(next),
      queryParams: {
        // Force the account chooser, so a user with several Google accounts is
        // not silently signed in as whichever one their browser happens to
        // hold -- a real hazard on a B2B product where work and personal
        // accounts sit in the same browser.
        prompt: "select_account",
      },
    },
  });

  if (error || !data?.url) {
    redirect("/login?error=google_unavailable");
  }

  // signInWithOAuth on the server does NOT navigate; it returns the provider
  // URL for us to redirect to. That is why the button is a form submission and
  // not an <a href>: the URL is minted per request and carries PKCE state.
  redirect(data.url);
}

// ---------------------------------------------------------------------------
// Finish account setup (invitees)
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: a user created by admin.inviteUserByEmail() has NO PASSWORD.
// They are signed in right now only because they just clicked a single-use
// emailed link. Without a way to set one they are locked out the moment the
// session expires -- and CLAUDE.md § Session security caps that at 12 hours.
// So the invite landing page offers this, and the flow is not actually
// complete without it.
//
// ON STEP-UP RE-AUTH -- REWRITTEN IN FIX ROUND 1, read this before touching
// the password branch.
//
// CLAUDE.md § Session security requires step-up re-authentication before
// "changing security settings (MFA, password, email)". The original version of
// this action checked only that getUser() returned a user, and relied on the
// UI's ?welcome=1 flag to mean "this is a first-time setup". That flag is a
// query parameter: it grants nothing, anyone can type it, and the server never
// looked at it anyway. The effect was that ANY authenticated session -- one
// eleven hours into its 12-hour lifetime, or a stolen cookie -- could set a new
// password with no proof of the old one. Review finding 1.
//
// What replaces it is a check on HOW, and HOW RECENTLY, this session actually
// authenticated -- read from the JWT's `amr` claim, which survives token
// refresh and therefore measures the authentication event rather than the
// token's age. Two proofs are accepted and nothing else is:
//
//   STEP-UP     a credential method (password/MFA) within five minutes.
//   LINK PROOF  a single-use emailed token (otp) within thirty minutes --
//               the invitee's path, and the only proof they can have.
//
// A valid session that authenticated hours ago now fails BOTH, which is the
// finding closed. lib/auth/step-up.ts holds the windows and the reasoning.
//
// WHY NOT "does this account already have a password?", which would let a
// first-time set skip the gate entirely and force step-up on every genuine
// change: BECAUSE THAT FACT IS NOT OBSERVABLE. Probed exhaustively --
// user.identities is identical for an invitee and a password user, the Admin
// API exposes no password field, and auth.users.encrypted_password stops being
// empty the moment the invitee CONFIRMS, which is strictly before they can
// reach this form. Full measurements are in lib/auth/step-up.ts, along with
// the residual that leaves and the state of the notification email intended to
// cover it.
//
// This action still must not become the account-settings "change password"
// screen. That screen is a later task and owes the user a real re-entry of
// their current password / MFA, not merely a recent one; what is here is the
// floor, not the design.
export async function completeAccountSetupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = field(formData, "password");
  const fullName = field(formData, "fullName");

  if (!password && !fullName) {
    return { error: "Enter a name or a password to save." };
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session has expired. Sign in again." };

  if (password) {
    const problem = passwordProblem(password);
    if (problem) return { fieldErrors: { password: problem } };

    const gate = await passwordChangeGate(supabase);
    if (gate) return gate;

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      return { fieldErrors: { password: authErrorMessage(error.message) } };
    }
  }

  if (fullName) {
    // Written to public.profiles, not to user_metadata: profiles is the
    // display-name system of record, and profiles_update_own scopes the write
    // to the caller's own row in the database.
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: fullName.slice(0, 200) })
      .eq("id", user.id);
    if (error) return { error: "We couldn't save your name. Try again." };
  }

  return { message: "Saved." };
}

/**
 * Decides whether this session may set a password right now.
 *
 * Returns null to allow, or the FormState to hand straight back to the form.
 * Every failure path returns a REFUSAL -- there is no branch that falls
 * through to "allow" on an unexpected condition. That is the whole point: the
 * bug this replaces was a gate that permitted by default.
 *
 * Not exported (a "use server" module may only export async functions, and
 * this is not an action). Deliberately not reachable from anywhere else
 * either: the account-settings change-password screen must build its own real
 * step-up, not import this one.
 */
async function passwordChangeGate(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<FormState | null> {
  // getClaims() validates the JWT with the auth server before returning the
  // payload, so `amr` here is checked, not merely parsed off a cookie. An
  // error, or claims with no usable amr, both land on ageSeconds === null --
  // which every gate in step-up.ts refuses. Fail closed, by construction.
  const { data: claimsData } = await supabase.auth.getClaims();
  const freshness = readAuthFreshness(claimsData?.claims);

  if (mayChangePassword(freshness)) return null;

  // ONE message for every refusal. The alternatives ("your link expired" vs
  // "sign in with your password first") would differ by whether the account
  // has a password and how it last authenticated -- account metadata, handed
  // to whoever holds the session. Same discipline as the enumeration note at
  // the top of this file. The message names both recovery paths, so it is
  // actionable whichever case the user is actually in.
  return {
    fieldErrors: {
      password:
        "For your security, sign in again before setting a password — with your password, or a fresh emailed link.",
    },
  };
}

// ---------------------------------------------------------------------------
// Choose a password after the first proof (Phase 10 Task 20, Q245)
// ---------------------------------------------------------------------------
//
// Reachable only by an account carrying the must-choose mark, which
// lib/auth/first-proof.ts sets when it replaced the password at the first
// proof of the address. No step-up: the session is seconds old and was minted
// by that proof, and the password it replaces is one nobody knows. Without the
// mark this action changes nothing -- it must not become a password-change
// path that skips the step-up completeAccountSetupAction enforces.
export async function choosePasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = field(formData, "password");
  const next = safeNextPath(field(formData, "next"));

  if (!password) return { fieldErrors: { password: "Choose a password." } };
  const problem = passwordProblem(password);
  if (problem) return { fieldErrors: { password: problem } };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session has expired. Sign in again." };
  if (user.app_metadata?.[MUST_CHOOSE_PASSWORD_KEY] !== true) redirect(next);

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { fieldErrors: { password: authErrorMessage(error.message) } };

  if (!(await clearMustChoosePassword(user.id))) {
    // The mark stays, so a retry works; GoTrue refuses the same password twice.
    return { error: "We couldn't finish saving that. Try again with a different password." };
  }
  // The proxy reads the mark from the JWT; this session's still carries it.
  // If the refresh fails, the stale JWT would bounce them back here for good:
  // sign out and let them sign in with the password they just chose.
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    await supabase.auth.signOut({ scope: "local" });
    redirect("/login?error=password_saved");
  }
  redirect(next);
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------
export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  // 'local' clears this browser's session only. Signing every device out is a
  // deliberate, separate security action (signOutEverywhereAction), not what a
  // user expects from a header menu.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

// Phase 10 Task 22: "sign out everywhere", for a lost or stolen device.
// 'global' revokes every refresh token this user holds, this browser's
// included. An access token already issued keeps working until it expires
// (jwt_expiry, SECURITY.md § 4). No step-up: signing out cannot harm the
// account. A failure is reported, never redirected, so nobody is told every
// device is signed out when none is.
export async function signOutEverywhereAction(): Promise<FormState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) {
    return { error: "We couldn't sign you out everywhere. Try again in a moment." };
  }
  redirect("/login");
}

/**
 * Maps a Supabase auth message to something a person can act on.
 *
 * Never returns the raw message: those are written for developers, sometimes
 * name internal states, and occasionally reveal whether an address exists.
 * DESIGN.md § Error pages sets the tone -- plain, no blame, no apology beyond
 * "something went wrong", and always with a recovery path.
 */
function authErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (lower.includes("password")) {
    return "That password was rejected. Try a longer one.";
  }
  return "We couldn't complete that. Try again, or use a magic link instead.";
}
