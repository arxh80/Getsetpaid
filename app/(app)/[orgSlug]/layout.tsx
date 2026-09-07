import { notFound } from "next/navigation";
import { getCurrentOrg, hasPermission } from "@/lib/auth";
import { CRM_AREAS, OPERATIONS_AREAS, NETWORK_ITEMS, ADMIN_ITEMS } from "@/lib/nav/areas";
import { Sidebar } from "@/components/nav/sidebar";
import type { SidebarNavGroup } from "@/components/nav/types";

// The persistent left rail's server half. Wraps EVERY route under
// /[orgSlug]/**, sitting between app/(app)/layout.tsx (the header, the
// workspace switcher, the MFA gate, the idle timeout) and each page.
//
// ===========================================================================
// WHY notFound() HERE TOO, WHEN EVERY PAGE ALREADY CHECKS getCurrentOrg()
// ===========================================================================
// Duplicated, not redundant. getCurrentOrg() is cache()-wrapped per request
// (lib/auth/index.ts), so calling it again here costs nothing extra -- one
// database round trip serves both this layout's check and whatever the child
// page does with the same slug (the same sharing app/(app)/layout.tsx's own
// header comment already relies on for the workspace switcher). Checking
// HERE means a slug that resolves to nothing, someone else's workspace, or an
// invitation not yet accepted 404s BEFORE the sidebar and its permission
// queries render at all -- the identical 404 as every page's own check
// (app/(app)/not-found.tsx), for the identical reason DESIGN.md's
// tenant-isolation rule gives: "exists, not yours" and "does not exist" must
// never be distinguishable from the outside.
//
// ===========================================================================
// WHY NO <main> HERE, EVEN THOUGH THE BRIEF SAYS "Sidebar + <main>{children}"
// ===========================================================================
// app/(app)/layout.tsx already opens `<main id="main">` around whatever this
// layout renders. A second `<main>` nested inside it is exactly the defect
// Phase 3's final review (I-8) found and fixed for app/not-found.tsx:
// `landmark-main-is-top-level`, `landmark-no-duplicate-main` and
// `landmark-unique` all fire on a page with two `main` landmarks, and
// tests/e2e/accessibility.spec.ts's WCAG tag set (with `best-practice` added
// for exactly this class of finding) would catch it on every single org
// route. So the flex row below is Sidebar + a plain `<div>` for the content
// slot -- still "Sidebar and content, side by side" as the brief asks, just
// without a second document landmark. The one `<main>` in the tree stays the
// parent layout's.
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

  // THREE INDEPENDENT PERMISSION READS, IN PARALLEL -- same
  // Promise.all-not-sequential-awaits shape app/(app)/[orgSlug]/page.tsx and
  // members/page.tsx both use (vercel-react-best-practices' async-parallel
  // pattern), and the same has_permission() RPC those pages call: this is a
  // RENDER decision, not the enforcement. Every route these gate is
  // independently protected by its own RLS policy regardless of what this
  // sidebar chooses to show.
  const [canViewNetwork, canManageMembers, canManageCustomFields] =
    await Promise.all([
      hasPermission(org.id, "view_network"),
      hasPermission(org.id, "manage_members"),
      hasPermission(org.id, "manage_custom_fields"),
    ]);

  const groups: SidebarNavGroup[] = [
    {
      id: "crm",
      heading: "CRM",
      items: CRM_AREAS.map((area) => toNavItem(org.slug, area)),
    },
    {
      id: "operations",
      heading: "Operations",
      items: OPERATIONS_AREAS.map((area) => toNavItem(org.slug, area)),
    },
    // NOT INCLUDED: a "Finance" group. The task brief's spec names one, but
    // there is no route to point it at -- Phase 5 shipped finance as a panel
    // ON THE EVENT DETAIL PAGE (components/crm/finance-panel.tsx), not a
    // standalone list (lib/crm/finance.ts: "a finance line has NO standalone
    // detail route, so the generic panel is..."). CLAUDE.md's own instruction
    // for a sidebar item is explicit: "do not invent sections that have no
    // route." A link that only ever lands on /events, mislabelled "Finance",
    // would duplicate the Events item under a false name instead of solving
    // anything -- so this group is omitted rather than faked, and the report
    // names it as a deviation from the brief for a design-system owner to
    // weigh in on (a dedicated /[orgSlug]/finance rollup page is the real fix,
    // and is not this build's to invent).
    ...(canViewNetwork
      ? [
          {
            id: "network",
            heading: "Network",
            items: NETWORK_ITEMS.map((area) => toNavItem(org.slug, area)),
          },
        ]
      : []),
    // ADMIN ITEMS ARE GATED INDIVIDUALLY, not as a group -- same rule
    // app/(app)/[orgSlug]/page.tsx's own header links use: `manage_members`
    // and `manage_custom_fields` are two different permissions Owner and
    // Admin both hold and nobody else does, so a Manager who can invite
    // people but not define custom fields sees "Members" alone, not a
    // half-disabled group. The group itself only appears once it has at
    // least one item -- an empty "Admin" heading with nothing under it would
    // be worse than not showing the group at all.
    ...(canManageMembers || canManageCustomFields
      ? [
          {
            id: "admin",
            heading: "Admin",
            items: [
              ...(canManageMembers
                ? [toNavItem(org.slug, ADMIN_ITEMS[0])]
                : []),
              ...(canManageCustomFields
                ? [toNavItem(org.slug, ADMIN_ITEMS[1])]
                : []),
            ],
          },
        ]
      : []),
  ];

  // NO `mx-auto`/`max-w-4xl`/`px-4 py-8` HERE. app/(app)/layout.tsx's <main>
  // already applies all of that to whatever this layout returns -- adding it
  // again would nest a second centred, padded column inside the first
  // (visible as doubled padding and a sidebar+content row squeezed into half
  // its own already-narrow box). The rail lives INSIDE that existing
  // max-w-4xl shell column rather than breaking out to the true viewport
  // edge; see components/nav/sidebar.tsx's own header comment for the
  // sticky/height consequence of that, and the build report for why a full
  // edge-to-edge rail was not attempted here (it would mean restructuring
  // app/(app)/layout.tsx's <main> for the two routes outside [orgSlug] that
  // also render through it -- /invites and /onboarding -- which this task
  // does not touch).
  return (
    <div className="flex flex-1 items-start gap-8">
      <Sidebar groups={groups} />
      {/* data-testid, not a class or id: this is a TEST SEAM, not a style
          hook. Sidebar nav items now share `<main>` with every page's own
          content (see the "WHY NO <main> HERE" comment above), and some of
          them render the exact same short label as a page's own breadcrumb
          link -- "Events" is both this page's sidebar item AND the event
          detail page's "back to the list" breadcrumb. A `page.locator("main")`
          assertion that used to find exactly one no longer does.
          tests/e2e/events.spec.ts's breadcrumb non-vacuity check is the one
          place that collision actually broke an assertion; it now scopes to
          this testid instead of `main` so it means "the page's own content",
          not "everything main happens to contain". */}
      <div data-testid="page-content" className="min-w-0 flex-1">
        {children}
      </div>
    </div>
  );
}

function toNavItem(
  orgSlug: string,
  area: { path: string; label: string; sub: string },
) {
  return {
    path: area.path,
    label: area.label,
    sub: area.sub,
    href: `/${orgSlug}/${area.path}`,
  };
}
