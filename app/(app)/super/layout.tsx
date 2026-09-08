import Link from "next/link";

// Phase 7 Task 1: the superuser dashboard's own route-area shell.
//
// NOT ORG-SCOPED (CLAUDE.md § Superuser dashboard). This segment is a
// SIBLING of app/(app)/[orgSlug], not a child of it, so it renders none of
// that segment's chrome -- no workspace switcher, no org rail, both of which
// are inherently org-scoped (DESIGN.md, Task 1's brief: "no org sidebar...
// give the superuser area a minimal header of its own"). The site header
// above this (wordmark, sign-out) still comes from app/(app)/layout.tsx,
// which every signed-in route -- this one included -- renders inside.
//
// ===========================================================================
// NO GATE HERE. THIS IS DELIBERATE, NOT AN OMISSION -- READ BEFORE ADDING ONE
// ===========================================================================
// The refusal for a non-superuser (including an Org Owner) has to be the
// STREAMED not-found contract: HTTP 200, the identical
// app/(app)/not-found.tsx document, same as a tenant record that exists but
// belongs to someone else (DESIGN.md § Error pages; Task 1's brief: "same
// refusal parity as tenant routes"). That requires the notFound() call to
// run BELOW a route's own loading.tsx boundary -- and a layout.tsx's body
// runs ABOVE the Suspense boundary its OWN segment's sibling loading.tsx
// creates for `children` (loading.tsx wraps page.tsx and what is below it,
// not the layout.tsx beside it). app/(app)/[orgSlug]/layout.tsx is the
// precedent for the OTHER shape: its notFound() there IS a literal,
// non-streamed 404, for exactly this structural reason -- DESIGN.md names it
// as the one deliberate exception ("a workspace-level refusal... still
// carries a literal HTTP 404").
//
// So every page under this segment checks lib/admin/superuser.ts's
// isSuperuser() and notFound()s FOR ITSELF, each with its own loading.tsx
// sibling -- see app/(app)/super/page.tsx and
// app/(app)/super/audit-log/page.tsx, and every page a later Phase 7 task
// adds here. This layout therefore renders its header for ANY authenticated
// caller who navigates to /super/*, superuser or not: harmless, because it
// carries no tenant data and no platform data, only a static label and a
// link back out -- the actual refusal, and everything that would leak
// anything, lands one level down.
export default function SuperuserLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
        <p className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
          Superuser
        </p>
        <Link
          href="/"
          className="text-sm text-primary underline underline-offset-4 hover:text-ink"
        >
          Back to your workspace
        </Link>
      </div>
      {children}
    </div>
  );
}
