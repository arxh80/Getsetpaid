import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getActiveMemberships,
  getCurrentOrg,
  getCurrentUser,
} from "@/lib/auth";
import { buildSidebarGroups } from "@/lib/nav/sidebar-groups";
import { Sidebar } from "@/components/nav/sidebar";
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
import { SuspendedBanner } from "@/components/org/suspended-banner";
import { Wordmark } from "@/components/wordmark";
import { SkipLink } from "@/components/ui/skip-link";
import { PaletteTrigger } from "@/components/palette/palette-trigger";
import { FeedbackDialog } from "@/components/feedback/feedback-dialog";

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

  // THE SIDEBAR IS BUILT HERE, NOT IN app/(app)/[orgSlug]/layout.tsx, AND THE
  // REASON IS THE SKIP LINK (review finding 1). `<SkipLink>` targets `#main`;
  // if the rail rendered inside `<main>` (as the first cut did), "skip to
  // content" would land a keyboard user at the top of up to 17 repeated nav
  // links -- the exact WCAG 2.4.1 failure the link exists to prevent, and one
  // axe cannot see. The HTML spec agrees: `main` "must not include content
  // that is repeated across a set of documents, such as site navigation
  // links". So the rail is a SIBLING of <main>, which only this layout can
  // arrange -- and `currentOrg` is already resolved here for the workspace
  // switcher, via the same RLS-gated lookup, so no second resolution is
  // needed. Null (a non-org route like /invites or /onboarding, or a slug the
  // caller cannot see) simply means no rail.
  //
  // NOT RENDERED WHILE THE MFA GATE HOLDS: the gate replaces the page content
  // wholesale, and a rail of workspace links beside a "set up your
  // authenticator" card would be navigation to pages that all re-gate
  // identically. Skipping it also skips the three permission RPCs below.
  //
  // THREE INDEPENDENT PERMISSION READS, IN PARALLEL -- same
  // Promise.all-not-sequential-awaits shape app/(app)/[orgSlug]/page.tsx and
  // members/page.tsx both use, and the same has_permission() RPC those pages
  // call (now cache()-wrapped, so the org-home page's identical three reads
  // cost nothing extra): this is a RENDER decision, not the enforcement.
  // Every route these gate is independently protected by its own RLS policy
  // regardless of what this sidebar chooses to show.
  const sidebarGroups =
    currentOrg && mfaGate.kind === "pass"
      ? await buildSidebarGroups(currentOrg.id, currentOrg.slug)
      : null;

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
            {/* The command palette's TRIGGER only (keyboard-a11y pass) — a
                dumb event dispatcher, because THIS module graph must reach no
                CRM query (the MFA-lockout guard,
                tests/unit/list/app-shell-has-no-crm-query.test.ts). The
                palette itself, whose search action reaches the CRM list
                specs, mounts below the gate in app/(app)/[orgSlug]/layout.tsx
                and listens for the trigger's event. Same render condition as
                the rail, so trigger and palette exist together or not at
                all. */}
            {sidebarGroups ? <PaletteTrigger /> : null}
            {/* Phase 7 Task 6: in-app feedback, "reachable from anywhere in
                the app" -- every signed-in screen, org-scoped or not, /super
                included. Gated on the MFA gate passing, like the rail: a
                user still enrolling is not "in the app" yet. Its server
                action reaches `feedback` and no CRM table
                (tests/unit/list/app-shell-has-no-crm-query.test.ts walks
                this import).

                RENDERED UNDER IMPERSONATION TOO, since founder ruling Q121
                reversed Task 6 fix round 1's M4. That round hid this control
                whenever the render knew the request was impersonated, because
                a support-access session holds no membership and the row would
                have been refused at the trigger. The submission is now
                ACCEPTED with no workspace on it and labelled "Sent during
                support access" -- so there is nothing to hide, and the gating
                that could never be reliable anyway (this layout does not
                re-render on a client-side navigation into the workspace, the
                impersonation banner's own lesson below) is gone rather than
                left as a control that appears and disappears. The workspace
                is dropped in submitFeedbackAction and the LABEL is stamped by
                the database (20260916002000), which is the only place it can
                be enforced for a direct PostgREST write. */}
            {mfaGate.kind === "pass" ? <FeedbackDialog /> : null}
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

      {/* Task 4 / DECISIONS-QUEUE Q6. Immediately under the header and above
          every route's content, because it is a fact about the whole workspace
          rather than about one screen -- and because getCurrentOrg() is
          resolved HERE for the switcher, so no route has to remember to render
          it. A CRM page that forgot would be a page whose disabled buttons had
          no explanation.

          It sits OUTSIDE <main>, before the content and after the skip link's
          target, so "skip to content" still lands on the content and the
          banner is still read before it in DOM order. */}
      {currentOrg?.isSuspended ? (
        <SuspendedBanner
          orgName={currentOrg.name}
          lifecycle={currentOrg.lifecycle}
        />
      ) : null}

      {/* THE IMPERSONATION BANNER IS NOT HERE, AND THAT IS FIX ROUND 1,
          IMPORTANT 1 — MEASURED, NOT REASONED.

          It was here, beside SuspendedBanner, on the argument that both are
          facts about the whole workspace and `currentOrg` is already
          resolved at this level. The argument is fine and the LOCATION was
          wrong, for the same reason lib/admin/impersonation-session.ts gives
          for keeping the page audit out of a layout: THIS LAYOUT DOES NOT
          RE-RENDER ON A CLIENT-SIDE NAVIGATION. `(app)` is a shared ancestor
          of both /super/impersonation and /[orgSlug], so clicking the
          operator's own "Open workspace" link — the primary way into a
          session — reused this segment, and the FIRST impersonated page a
          human ever saw was the one page with no banner.

          Measured by clicking the real control in
          tests/e2e/impersonation.spec.ts: the URL assertion passed and the
          banner assertion failed. Every other navigation in that file is
          page.goto(), a full document load, which re-renders every layout —
          which is exactly why the suite could not see it before.

          It now renders from app/(app)/[orgSlug]/layout.tsx, the segment
          boundary every impersonated route crosses: entering the segment
          renders it fresh, navigating within the segment keeps it mounted.
          SuspendedBanner stays here because its own audience is different —
          it is about a workspace a MEMBER is in, reached from the switcher
          and from routes outside the segment. */}

      {/* Rail and content are SIBLINGS in one full-width row -- the rail at
          the true viewport edge (the standard CRM shell this build wanted;
          the first cut kept it inside <main>'s centred max-w-4xl column only
          because restructuring this layout was out of that task's scope, and
          this review brought the restructure anyway). <main> keeps its own
          centred column INSIDE the row, so /invites and /onboarding -- where
          there is no rail -- render exactly as before. On desktop widths the
          rail's hover-expansion now spends the viewport's slack margins
          before it touches the content column's width. */}
      <div className="flex w-full flex-1 items-start">
        {sidebarGroups ? <Sidebar groups={sidebarGroups} /> : null}
        {/* tabIndex={-1}: a programmatic focus target, reachable by script
            and by the skip link but never by Tab. The skip link's fragment
            navigation moves the sequential-focus start without it in modern
            browsers, but a script (idle-timeout's "Stay signed in", which
            unmounts the element holding focus) needs a real .focus() target
            — and -1 makes the skip link's landing a genuine focus move
            everywhere rather than a scroll in some browser/AT pairings. */}
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 py-8 sm:py-12"
        >
          {mfaGate.kind === "enroll" ? (
            <MfaEnrollGate next={next} />
          ) : mfaGate.kind === "challenge" ? (
            <MfaChallengeGate next={next} />
          ) : (
            children
          )}
        </main>
        {/* THE RAIL'S COUNTERWEIGHT (re-review N2). <main>'s `mx-auto`
            centres it in the LEFTOVER flex space, so without this the rail's
            64px footprint pushed the whole content column 32px right of the
            header's own max-w-4xl column at rest -- header and page visibly
            out of register on every org route. A trailing spacer with the
            rail's exact collapsed width (w-16 = RAIL_WIDTH_COLLAPSED = 64px,
            same `hidden`/`md` breakpoint) makes the leftover space
            symmetric again, so the two columns line up. It mirrors the
            COLLAPSED width only, deliberately: hover-expansion still
            translates the centred column -- that residual motion is
            acknowledged in DESIGN.md § Motion's width-tween waiver, not
            engineered away here. aria-hidden is belt-and-braces on an empty
            div. */}
        {sidebarGroups ? (
          <div aria-hidden className="hidden w-16 shrink-0 md:block" />
        ) : null}
      </div>

      {/* Phase 8 Task 1: the legal pages, reachable from inside the app
          (PRD §12). One link to the index rather than all fifteen -- the
          signed-in shell is a working surface, and /legal lists them. It
          renders on the MFA gate screens too, deliberately: a user being
          asked to enrol a factor is exactly who may want the privacy notice
          first, and /legal needs no session and reaches no CRM table. */}
      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 text-sm text-ink-muted">
          <Link
            href="/legal"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Legal and privacy
          </Link>
          {/* Phase 8 Task 2: the account-level privacy control (marketing
              consent). In the footer beside the legal index rather than in
              the header, which is a working surface with a tested tab order;
              the page itself is signed-in and MFA-gated like every route
              under this layout. */}
          <Link
            href="/account/privacy"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Your privacy choices
          </Link>
          {/* Phase 8 Task 3: the data-subject-request form and tracker. Beside
              the consent page for the same reason -- both are account-level
              rights, neither belongs to a workspace, and the footer is where
              somebody looks for them. */}
          <Link
            href="/account/data-requests"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Your data requests
          </Link>
          {/* Phase 8 Task 5: account erasure. In the footer with the other
              three account-level rights rather than hidden behind a settings
              screen -- a statutory right that is hard to find is a right the
              product is making harder to exercise, and the page itself
              explains what happens before anything can be pressed. */}
          <Link
            href="/account/erase"
            prefetch={false}
            className="underline underline-offset-4 hover:text-ink"
          >
            Delete your account
          </Link>
        </div>
      </footer>
    </div>
  );
}
