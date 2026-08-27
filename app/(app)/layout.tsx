import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { currentPath } from "@/lib/auth/current-path";
import { signOutAction } from "@/lib/auth/actions";
import { evaluateMfaGate } from "@/lib/auth/mfa-gate";
import { MfaEnrollGate } from "@/components/auth/mfa-enroll-gate";
import { MfaChallengeGate } from "@/components/auth/mfa-challenge-gate";
import { IdleTimeout } from "@/components/auth/idle-timeout";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Wordmark } from "@/components/wordmark";
import { SkipLink } from "@/components/ui/skip-link";

// Shell for every signed-in screen.
//
// The redirect here is a SECOND check, not the only one. Middleware already
// bounces signed-out requests, but middleware is easy to mis-scope with a
// matcher and runs outside the render, so the layout re-establishes the
// session for itself. Neither is the authorisation control -- that is RLS, on
// every query, in the database.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Task 7: block Owner/Admin/Finance/Platform-Superuser behind a TOTP
  // gate -- ENROLL if they have no verified factor yet, CHALLENGE if they
  // have one but this session hasn't presented it (fix round 1, Important
  // 2: enrollment alone doesn't force a challenge on later sign-ins).
  // Checked on EVERY signed-in page (there is no "current org" yet to scope
  // this more narrowly to -- see lib/auth/mfa-gate.ts), so it replaces
  // <main>'s content rather than living on one route. The header (and
  // sign-out) stays reachable either way -- this is a gate, not a trap.
  const mfaGate = await evaluateMfaGate();

  // Fix round 1, Minor: where to send the user back to once a gate is
  // satisfied. lib/supabase/middleware.ts stamps the real request path onto
  // a header for exactly this; previously this was hardcoded to "/",
  // meaning MFA enrollment/challenge always dropped a user on the hub
  // instead of the page they were actually trying to reach.
  const next = await currentPath();

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      {/* Client-side inactivity enforcement (Task 7) -- renders nothing
          visible until the user has been idle long enough to warn. See
          components/auth/idle-timeout.tsx for why this is genuine
          enforcement (it calls supabase.auth.signOut()) and not only UX.
          Keyed by userId (fix round 1, Critical 1) so a second person
          signing in on the same browser never inherits a stale timestamp. */}
      <IdleTimeout userId={user.id} />
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4">
          <Link href="/" className="no-underline">
            <Wordmark />
          </Link>

          <div className="ml-auto flex items-center gap-4">
            {/* translate="no": an email address is an identifier, and a
                browser's page translator will happily "translate" the domain
                into something that is no longer the user's address. */}
            <span
              translate="no"
              className="hidden truncate text-sm text-ink-muted sm:inline"
            >
              {user.fullName ?? user.email}
            </span>
            {/* A form, not a link: signing out is a state change and must not
                be reachable by a prefetch, a crawler or a browser's link
                pre-connection. SignOutButton (not a raw <form>) is what
                clears the idle-timeout localStorage key on the way out --
                see components/auth/sign-out-button.tsx. */}
            <SignOutButton userId={user.id} action={signOutAction} />
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:py-12">
        {mfaGate.kind === "enroll" ? (
          <MfaEnrollGate next={next} />
        ) : mfaGate.kind === "challenge" ? (
          <MfaChallengeGate next={next} />
        ) : (
          children
        )}
      </main>
    </div>
  );
}
