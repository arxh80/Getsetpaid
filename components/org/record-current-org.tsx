"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { recordCurrentOrgAction } from "@/lib/org/workspace-actions";

/**
 * Fire-and-forget: tells the server "the user is now looking at this
 * workspace" so app/page.tsx's hub redirect can send them back to it next
 * time, without requiring they use the switcher explicitly -- see
 * lib/org/workspace-actions.ts's recordCurrentOrgAction for why this exists
 * as a separate action from the switcher's.
 *
 * A Server Component render cannot write a cookie (Next.js throws --
 * lib/org/current-org.ts), so this is the one Client Component in the whole
 * org-context feature: it is what turns "the URL says I'm viewing org X,
 * because getCurrentOrg() just verified that" into a durable preference, by
 * calling back into a Server Action. Renders nothing.
 *
 * organisationId is NOT trusted for authorization by anything downstream:
 * recordCurrentOrgAction re-checks it against the caller's OWN active
 * memberships before writing anything. Worst case if this were ever mounted
 * with a wrong id is a wasted round trip that writes nothing -- see that
 * action's comment. Mounted from app/(app)/layout.tsx, once per request, only
 * when the request resolved to a real current org.
 *
 * `usePathname()` IS IN THE DEPENDENCY ARRAY EVEN THOUGH ITS VALUE IS UNUSED.
 * Verified empirically against this stack (not assumed): a client-side
 * <Link> transition between two org-scoped routes that share this same
 * dynamic layout can re-render the layout with a genuinely new
 * `organisationId` prop -- visible in the switcher, which updates correctly
 * -- WITHOUT this component's effect re-running. `organisationId` alone as
 * the dependency was not a reliable signal for "a client-side navigation just
 * happened" on this version of Next.js's App Router; `usePathname()` reads
 * from the router's own navigation context, which does update on every
 * client-side transition, and forces the effect to re-evaluate alongside it.
 */
export function RecordCurrentOrg({ organisationId }: { organisationId: string }) {
  const pathname = usePathname();

  useEffect(() => {
    void recordCurrentOrgAction(organisationId);
  }, [organisationId, pathname]);

  return null;
}
