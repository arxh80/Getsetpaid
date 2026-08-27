import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { signOutAction } from "@/lib/auth/actions";
import { mfaGateBlocks } from "@/lib/auth/mfa-gate";
import { MfaEnrollGate } from "@/components/auth/mfa-enroll-gate";
import { IdleTimeout } from "@/components/auth/idle-timeout";
import { Wordmark } from "@/components/wordmark";
import { Button } from "@/components/ui/button";
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
  // enrollment screen until they have one. Checked on EVERY signed-in page
  // (there is no "current org" yet to scope this more narrowly to -- see
  // lib/auth/mfa-gate.ts), so it replaces <main>'s content rather than
  // living on one route. The header (and sign-out) stays reachable either
  // way -- this is a gate, not a trap.
  const mfaBlocked = await mfaGateBlocks();

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      {/* Client-side inactivity enforcement (Task 7) -- renders nothing
          visible until the user has been idle long enough to warn. See
          components/auth/idle-timeout.tsx for why this is genuine
          enforcement (it calls supabase.auth.signOut()) and not only UX. */}
      <IdleTimeout />
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
                pre-connection. */}
            <form action={signOutAction}>
              <Button type="submit" variant="quiet">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:py-12">
        {mfaBlocked ? <MfaEnrollGate next="/" /> : children}
      </main>
    </div>
  );
}
