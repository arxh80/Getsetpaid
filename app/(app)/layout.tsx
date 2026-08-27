import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveMemberships, getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { currentPath } from "@/lib/auth/current-path";
import { signOutAction } from "@/lib/auth/actions";
import { evaluateMfaGate } from "@/lib/auth/mfa-gate";
import { firstPathSegment } from "@/lib/org/path";
import { MfaEnrollGate } from "@/components/auth/mfa-enroll-gate";
import { MfaChallengeGate } from "@/components/auth/mfa-challenge-gate";
import { IdleTimeout } from "@/components/auth/idle-timeout";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { RecordCurrentOrg } from "@/components/org/record-current-org";
import { WorkspaceSwitcher } from "@/components/org/workspace-switcher";
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

  // Task 8: which workspace, if any, does THIS request concern -- derived
  // from the URL's first path segment through the SAME RLS-gated lookup
  // every org-scoped page already uses, not by pattern-matching path names
  // against a list of "reserved" top-level routes (invites, onboarding, ...).
  // That list would be one more place for reserved-vs-org-slug drift to hide;
  // this way there is nothing to keep in sync. A non-org route (this layout
  // also wraps /invites and /onboarding) and an org slug the caller cannot
  // see both resolve to null here, identically -- see getCurrentOrg()'s own
  // "null covers three cases" comment in lib/auth/index.ts.
  //
  // getCurrentOrg() is cache()-wrapped per request, so calling it here with
  // the same slug string a page further down the tree also calls it with
  // (e.g. app/(app)/[orgSlug]/page.tsx) costs one database round trip total,
  // not two.
  //
  // WHY THIS LIVES HERE AND NOT IN AN [orgSlug]/layout.tsx: the switcher
  // belongs in THIS header (the task brief is explicit), and a child route's
  // layout renders INSIDE this one's <main>, with no way to reach back up
  // into an already-rendered <header>. A parent layout also does not receive
  // a child segment's dynamic params -- [orgSlug] is below this layout in the
  // tree -- which is exactly the gap lib/auth/current-path.ts's header-based
  // currentPath() already exists to work around for the MFA gate above; this
  // reuses the same mechanism for the same reason.
  const candidateSlug = firstPathSegment(next);
  const [currentOrg, activeMemberships] = await Promise.all([
    candidateSlug ? getCurrentOrg(candidateSlug) : Promise.resolve(null),
    getActiveMemberships(),
  ]);

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
      {/* Task 8: durably remembers "last viewed workspace" across requests,
          even when this org was reached by an ordinary link rather than the
          switcher below -- see components/org/record-current-org.tsx. Only
          mounted when the request actually resolved to a real current org. */}
      {currentOrg ? <RecordCurrentOrg organisationId={currentOrg.id} /> : null}
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4">
          <Link href="/" className="no-underline">
            <Wordmark />
          </Link>

          <div className="ml-auto flex items-center gap-4">
            {/* Task 8: only rendered on an org-scoped page (currentOrg !==
                null). A single-org user never sees the switcher at all -- a
                control with exactly one destination is not a control, it is
                a label pretending to be one -- so they get their workspace
                name as plain, non-interactive text instead. See
                components/org/workspace-switcher.tsx for the widget choice
                behind the multi-org case. */}
            {currentOrg ? (
              activeMemberships.length > 1 ? (
                <WorkspaceSwitcher current={currentOrg} memberships={activeMemberships} />
              ) : (
                <span className="hidden truncate text-sm text-ink-muted sm:inline">
                  {currentOrg.name}
                </span>
              )
            ) : null}
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
