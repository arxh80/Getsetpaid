import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { GoogleButton } from "@/components/auth/google-button";
import { Alert } from "@/components/ui/alert";
import { safeNextPath } from "@/lib/auth/redirects";

export const metadata: Metadata = { title: "Sign in · GetSetPaid" };

/**
 * Reasons /auth/callback and the OAuth action can bounce someone here.
 *
 * An ALLOWLIST, mapped to fixed copy. `error` is a query parameter, so
 * rendering it directly would be reflected XSS at worst and attacker-authored
 * copy on our sign-in page at best ("Your account was suspended, call this
 * number"). An unknown value falls through to the generic message.
 */
const ERRORS: Record<string, string> = {
  link_failed:
    "That link didn't work. It may have expired or already been used. Request a new one below.",
  google_unavailable:
    "Google sign-in isn't available right now. Use your email and password instead.",
};

/**
 * Same allowlist idea as ERRORS, but for a routine, expected event rather
 * than a failure -- CLAUDE.md § Session security's 30-minute inactivity
 * timeout (components/auth/idle-timeout.tsx) firing is not an error, and
 * a red "Error." banner over ordinary security behaviour reads as something
 * having gone wrong when nothing did.
 */
const NOTICES: Record<string, string> = {
  idle_timeout: "You were signed out after 30 minutes of inactivity.",
  // choosePasswordAction (Phase 10 Task 20): saved, but the session could not refresh.
  password_saved: "Your new password is saved. Sign in with it to continue.",
};

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : null;
  const next = safeNextPath(rawNext);
  const rawError = typeof params.error === "string" ? params.error : null;
  const noticeMessage = rawError ? NOTICES[rawError] : undefined;
  const errorMessage =
    rawError && !noticeMessage
      ? (ERRORS[rawError] ?? "Something went wrong. Try again.")
      : null;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Sign in
        </h1>
        <p className="text-lg text-ink-muted">
          Pick up where your workspace left off.
        </p>
      </div>

      {noticeMessage ? <Alert tone="info">{noticeMessage}</Alert> : null}
      {errorMessage ? <Alert tone="error">{errorMessage}</Alert> : null}

      <LoginForm next={next} />

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-rule" />
        <span className="text-xs uppercase tracking-[0.04em] text-ink-muted">
          or
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <GoogleButton next={next} />

      <p className="border-t border-rule pt-5 text-base text-ink-muted">
        Don’t have an account?{" "}
        <Link
          href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`}
          className="text-primary underline underline-offset-4 hover:text-ink"
        >
          Create one
        </Link>
        .
      </p>
    </div>
  );
}
