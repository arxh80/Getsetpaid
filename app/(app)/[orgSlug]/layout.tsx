import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { buildSidebarGroups } from "@/lib/nav/sidebar-groups";
import { CommandPalette } from "@/components/palette/command-palette";

// The org segment's guard, and deliberately nothing else. The sidebar this
// layout used to render moved UP to app/(app)/layout.tsx (review finding 1):
// this layout renders INSIDE that one's `<main id="main">`, so a rail here
// put primary navigation inside `main` -- which the HTML spec forbids for
// repeated site navigation, and which broke the skip link (WCAG 2.4.1,
// Bypass Blocks): "skip to content" targeted `#main` and landed keyboard
// users at the top of up to 17 nav links instead of past them. The parent
// layout already resolves `currentOrg` for the workspace switcher, so it
// renders the rail as a SIBLING of `<main>` instead.
//
// ===========================================================================
// WHY notFound() HERE TOO, WHEN EVERY PAGE ALREADY CHECKS getCurrentOrg()
// ===========================================================================
// Duplicated, not redundant. getCurrentOrg() is cache()-wrapped per request
// (lib/auth/index.ts), so calling it again here costs nothing extra -- one
// database round trip serves this layout's check, the parent layout's
// switcher, and whatever the child page does with the same slug. Checking
// HERE means a slug that resolves to nothing, someone else's workspace, or an
// invitation not yet accepted 404s at the segment boundary -- the identical
// 404 as every page's own check (app/(app)/not-found.tsx), for the identical
// reason DESIGN.md's tenant-isolation rule gives: "exists, not yours" and
// "does not exist" must never be distinguishable from the outside.
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  // THE COMMAND PALETTE MOUNTS HERE, NOT IN THE SHELL (keyboard-a11y pass).
  // Its search action's module graph reaches the CRM list specs, and the
  // shell's graph must not — tests/unit/list/app-shell-has-no-crm-query
  // .test.ts guards the MFA-enrolment lockout a CRM read in the shell would
  // cause. This layout renders only below a passed gate and a resolved org,
  // which is also exactly where the palette's sections and record search
  // mean anything. The header's visible trigger stays in the shell as a
  // dumb event dispatcher (components/palette/palette-trigger.tsx); this
  // component listens for its event and for Ctrl/Cmd-K. buildSidebarGroups
  // runs on cache()-wrapped permission RPCs the shell already paid for, so
  // the second call costs no extra round trips.
  const groups = await buildSidebarGroups(org.id, org.slug);

  return (
    <>
      <CommandPalette orgSlug={org.slug} groups={groups} />
      {children}
    </>
  );
}
