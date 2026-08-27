"use server";

// Server Actions for the workspace switcher and its "last used" cookie.
//
// Kept SEPARATE from lib/org/actions.ts (organisation lifecycle: create,
// invite, accept) deliberately -- that file is a distinct concern (creating
// and populating organisations) from this one (which of the caller's EXISTING
// organisations they are currently looking at). Both actions below treat a
// client-supplied organisation id with identical suspicion, via the same
// resolveTargetMembership() lib/org/resolve.ts uses for the cookie itself --
// see that file for the shared reasoning. Neither action ever queries
// `organisations` or `organisation_memberships` directly with the id it was
// handed; both go through getActiveMemberships(), which is the caller's own
// RLS-filtered result set.

import { redirect } from "next/navigation";
import { getActiveMemberships } from "@/lib/auth";
import { field } from "@/lib/forms";
import { resolveTargetMembership } from "./resolve";
import { writeCurrentOrgIdCookie } from "./current-org";

/**
 * The workspace switcher's form action
 * (components/org/workspace-switcher.tsx).
 *
 * A plain <form action={...}> submission, not a client-side fetch -- it works
 * with JavaScript disabled, and switching workspace is a real navigation
 * (redirect to /{slug}) rather than a client-side route replace, matching
 * lib/auth/actions.ts's whole-file convention for anything that changes what
 * the user is looking at.
 *
 * The submitted `organisationId` naming an org the caller is not an active
 * member of (a stale option on a tab left open since being removed from a
 * workspace, or a hand-crafted request) resolves to the caller's first active
 * membership instead of erroring -- the closest analogue to what already
 * happens today if a stale link is followed to a workspace access has since
 * been lost to. No active membership at all is not expected to be reachable
 * here (the switcher only ever renders when there is more than one), but
 * failing to the hub rather than throwing keeps this consistent with every
 * other "shouldn't happen" branch in lib/auth.
 */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const candidateOrgId = field(formData, "organisationId");
  const active = await getActiveMemberships();
  const membership = resolveTargetMembership(candidateOrgId, active);

  if (!membership || !membership.organisation.slug) redirect("/");

  await writeCurrentOrgIdCookie(membership.organisationId);
  redirect(`/${membership.organisation.slug}`);
}

/**
 * Records "the caller is now looking at this workspace" without navigating --
 * called from components/org/record-current-org.tsx, a Client Component
 * mounted once per org-scoped page render.
 *
 * WHY THIS EXISTS SEPARATELY FROM switchWorkspaceAction: a Server Component
 * cannot write a cookie (see lib/org/current-org.ts's header comment).
 * Without this, only an explicit use of the switcher would ever update "last
 * used", and a user who reaches a second workspace by following an ordinary
 * link -- the "Your other workspaces" list on the org home page, or a
 * bookmarked URL -- would never have that visit remembered, so the hub could
 * keep sending them back to a workspace they have since moved on from.
 *
 * organisationId is RE-CHECKED against the caller's own active memberships
 * here, exactly as switchWorkspaceAction's form field is. This matters
 * because a Server Action is reachable directly (a POST to its own action
 * endpoint) by anyone, not only from the one Client Component that happens to
 * call it in this codebase's own UI -- an arbitrary caller can ask this
 * function to remember an arbitrary id. getActiveMemberships() is what stops
 * that id from ever being written unless it genuinely names one of the
 * caller's own active memberships; an id that fails that check is silently
 * ignored rather than written, since there is nothing sensible to fall back
 * to for a background "just record this" call the way there is for a
 * navigating switch.
 */
export async function recordCurrentOrgAction(
  organisationId: string,
): Promise<void> {
  const active = await getActiveMemberships();
  const membership = active.find((m) => m.organisationId === organisationId);
  if (!membership) return;
  await writeCurrentOrgIdCookie(membership.organisationId);
}
