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

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const rawNext = typeof params.next === "string" ? params.next : null;
  const next = safeNextPath(rawNext);
  const rawError = typeof params.error === "string" ? params.error : null;
  const errorMessage = rawError
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
        Don&apos;t have an account?{" "}
        <Link
          href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`}
          className="text-primary underline underline-offset-4"
        >
          Create one
        </Link>
        .
      </p>
    </div>
  );
}
