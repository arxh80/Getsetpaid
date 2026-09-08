import "server-only";

// Session and organisation resolution for the server.
//
// Everything here reads through the USER'S OWN Supabase client, so every
// result is already filtered by RLS. That is deliberate and load-bearing:
// getCurrentOrg() below does not decide whether you may see an organisation,
// it merely asks the database, which answers according to
// organisations_select_member / is_active_member. If the policy is wrong, this
// file does not paper over it -- and if this file is wrong, the policy still
// holds. Neither layer is trusted to cover for the other.
//
// CLAUDE.md § Tenancy model: "RLS derives the current user from the
// authenticated session and checks membership in the database. Never trust a
// client-supplied organisation ID." getCurrentOrg() takes an org SLUG from the
// URL, which is client-supplied by definition -- and resolves it with a query
// that returns nothing at all unless the caller is an active member. A slug
// belonging to another tenant is indistinguishable from a slug that does not
// exist, which is exactly what DESIGN.md § Error pages requires.

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  IMPERSONATION_ROLE_ENVELOPE,
  resolveImpersonationForOrg,
} from "@/lib/admin/impersonation-session";

export interface CurrentUser {
  id: string;
  email: string | null;
  fullName: string | null;
}

export type MembershipStatus = "invited" | "active" | "revoked";

export interface Membership {
  id: string;
  organisationId: string;
  role: string;
  status: MembershipStatus;
  invitedAt: string;
  joinedAt: string | null;
  organisation: { id: string; name: string; slug: string };
}

export interface CurrentOrg {
  id: string;
  name: string;
  slug: string;
  /** The caller's own role in this organisation. Never another user's. */
  role: string;
  /**
   * The organisation is soft-deleted, i.e. SUSPENDED BY THE PLATFORM.
   *
   * DECISIONS-QUEUE Q6 (founder, 2026-08-28) makes suspension READ-ONLY, not a
   * lockout: members keep `view_crm` and lose every write, which
   * 20260828210000 enforces. Consumers must render the workspace and disable
   * its write controls -- see lib/crm/write-access.ts, which turns this into
   * an answer with an explanation attached, and components/org/suspended-banner.tsx.
   *
   * It is NOT the enforcement. `private.crm_write_organisations()` carries its
   * own `o.deleted_at is null`, and `public.permissions.survives_suspension`
   * gates the read side. This flag exists so the customer is told, not so the
   * rule holds.
   */
  isSuspended: boolean;
  /**
   * This workspace is being viewed through a live BREAK-GLASS IMPERSONATION
   * SESSION, not through a membership (Phase 7 Task 2).
   *
   * `role` above is then `IMPERSONATION_ROLE_ENVELOPE` ('read_only'), which is
   * the honest description of what the caller holds -- but note that it is a
   * LABEL here, not the enforcement: the enforcement is
   * private.impersonated_organisations(), wired into public.has_permission(),
   * private.permitted_organisations() and private.full_scope_organisations()
   * by 20260908020000. Setting this field on its own would grant nothing, and
   * clearing it would take nothing away.
   *
   * Consumers must render the banner (app/(app)/layout.tsx does, for every
   * org-scoped route at once, the same way it renders SuspendedBanner) so
   * support access is never mistaken for normal use.
   */
  isImpersonated: boolean;
  /** ISO instant the impersonation window closes, or null when not impersonated. */
  impersonationExpiresAt: string | null;
}

/**
 * The signed-in user, or null.
 *
 * getClaims() verifies the JWT signature rather than trusting the cookie's
 * contents (which is all getSession() does). Wrapped in React's `cache` so a
 * page that asks several times in one render pays for one round trip -- the
 * cache is per-request, so it cannot leak one user's identity into another
 * request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;

  // The display name comes from public.profiles, not from the JWT's
  // user_metadata. user_metadata is client-writable -- fine for a name, but
  // reading it here would normalise the habit of trusting it, and the very
  // next field someone adds will be one that matters.
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", claims.sub)
    .maybeSingle();

  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    fullName: profile?.full_name ?? null,
  };
});

/**
 * Every membership the caller holds, at any status, newest invite first.
 *
 * THE `.eq("user_id", ...)` IS LOAD-BEARING. There are two SELECT policies on
 * organisation_memberships, not one: "select own rows" returns the caller's
 * rows at any status, and organisation_memberships_select_same_organisation
 * additionally returns EVERY row in an organisation the caller is an active
 * member of. Their union is what an unfiltered query gets back -- so the
 * moment a workspace has a second person, this returns their rows too.
 *
 * Symptoms, seen in a real browser during fix round 1 and the reason this
 * filter exists: the invitations page offered an active member somebody ELSE's
 * pending invite, complete with an Accept button (accept_invite() refuses it
 * in the database, so it was a broken affordance rather than a privilege hole),
 * and getActiveMemberships() listed the same workspace once per member --
 * "Your workspaces: Northern Lights Touring, Northern Lights Touring."
 *
 * This is the SAME defect getCurrentOrg() below was fixed for in Task 6, in
 * the same file, for the same reason. Filtering by status is not a substitute
 * for filtering by user; both policies are correct and it is this query that
 * has to say which rows it actually wants.
 *
 * The join to organisations goes through the SAME query so it is subject to
 * organisations_select_member -- which means an invited-but-not-active
 * membership comes back with a NULL organisation, because the invitee is not
 * an active member and genuinely cannot read that row yet. Those are surfaced
 * as pending invites without the org's details rather than dropped, so the
 * user can still accept.
 */
export const getMemberships = cache(async (): Promise<Membership[]> => {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisation_memberships")
    .select(
      "id, organisation_id, role, status, invited_at, joined_at, organisations ( id, name, slug )",
    )
    .eq("user_id", user.id)
    .order("invited_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row) => {
    const org = row.organisations as unknown as
      | { id: string; name: string; slug: string }
      | null;
    return {
      id: row.id as string,
      organisationId: row.organisation_id as string,
      role: row.role as string,
      status: row.status as MembershipStatus,
      invitedAt: row.invited_at as string,
      joinedAt: (row.joined_at as string | null) ?? null,
      organisation: org ?? {
        id: row.organisation_id as string,
        name: "",
        slug: "",
      },
    };
  });
});

/** Active memberships only -- the organisations the user can actually work in. */
export async function getActiveMemberships(): Promise<Membership[]> {
  return (await getMemberships()).filter((m) => m.status === "active");
}

/** Pending invitations the user has not accepted or had revoked. */
export async function getPendingInvites(): Promise<Membership[]> {
  return (await getMemberships()).filter((m) => m.status === "invited");
}

/**
 * Resolve an org slug from the URL to the caller's organisation, or null.
 *
 * NULL COVERS THREE CASES AND DOES NOT DISTINGUISH THEM: the slug does not
 * exist, the slug belongs to another tenant, or the caller's membership there
 * is only 'invited'/'revoked'. Callers must render the same 404 for all three
 * (DESIGN.md § Error pages, tenant-isolation rule) -- telling them apart is an
 * enumeration oracle for other tenants' slugs.
 */
export const getCurrentOrg = cache(
  async (slug: string): Promise<CurrentOrg | null> => {
    if (!slug) return null;

    const user = await getCurrentUser();
    if (!user) return null;
    const userId = user.id;

    const supabase = await createClient();

    // organisations_select_member gates this: an org the caller is not an
    // ACTIVE member of returns zero rows, so the .eq() on slug is a lookup
    // within what the caller may already see, not an access decision.
    //
    // THE `.is("deleted_at", null)` FILTER THAT USED TO BE HERE IS GONE, AND
    // THE THREE THINGS THAT REPLACED IT SHIPPED IN THE SAME CHANGE.
    //
    // DECISIONS-QUEUE Q6 (founder, 2026-08-28) made suspension READ-ONLY
    // rather than a lockout, and Task 3a implemented it in the database
    // (20260828210000): a suspended organisation's members keep `view_crm` and
    // lose every write, proven by rls_phase2_crm.sql § P. The filter returned
    // null for such a slug, so every route under it rendered the
    // tenant-isolation 404 while the switcher still listed the workspace --
    // the exact outcome Q6 reversed, and the reason Q6 was recorded as
    // "database half done, UI half owed".
    //
    // Task 3a deliberately did NOT fix it by deleting the line, and the review
    // measured why. The failure mode of deleting it alone is not "every write
    // 403s with no explanation". An INSERT is a loud 403; an UPDATE is refused
    // by the USING clause, matches no rows, and PostgREST answers 204 NO
    // CONTENT -- byte-identical IN THE STATUS LINE to a PATCH that changed
    // fifteen rows:
    //
    //     LIVE:      manager PATCHes contacts   204   (15 rows changed)
    //     SUSPENDED: manager PATCHes contacts   204   ( 0 rows changed)
    //
    // A normal-looking workspace, a form that submits, and a 2xx, with the
    // edit discarded. Not a UX problem: false confirmation that data was
    // saved. So the 404 stayed until the three things below existed, which is
    // what makes deleting the filter safe NOW and would not have then:
    //
    //   1. `isSuspended` on the returned object, from the `deleted_at` this
    //      query now selects. Read by lib/crm/write-access.ts.
    //   2. A persistent banner and disabled write controls
    //      (components/org/suspended-banner.tsx, and every form on a CRM
    //      route). Hiding UI is not enforcement -- the database is the
    //      enforcement -- this is about not lying to the user.
    //   3. lib/crm/write.ts, which asks for the ROW COUNT on every mutating
    //      request and treats zero as a refusal. THAT is the item the old
    //      comment here existed for, and it is the one that still matters when
    //      the UI is bypassed: PostgREST is reachable from the browser with
    //      the anon key regardless of what any button renders.
    //
    // Reading a suspended organisation's row needs no policy change:
    // organisations_select_member is `private.is_active_member(id)` with no
    // deleted_at term (verified in pg_policies), which is why the read half of
    // Q6 works at all.
    const { data: org, error } = await supabase
      .from("organisations")
      .select("id, name, slug, deleted_at")
      .eq("slug", slug)
      .maybeSingle();

    if (error || !org) return null;

    // Read the caller's OWN role. Their own row is always visible to them, so
    // this needs no elevated access -- but it does need the user_id filter.
    //
    // WITHOUT `.eq("user_id", ...)` THIS BREAKS AS SOON AS AN ORG HAS TWO
    // MEMBERS. organisation_memberships_select_same_organisation deliberately
    // lets an active member see EVERY membership row in that organisation, so
    // filtering only on (organisation_id, status='active') matches one row in
    // a one-person workspace and N rows in a real one. maybeSingle() then
    // fails with PGRST116, this function returns null, and the whole workspace
    // renders a 404 to a legitimate member.
    //
    // Caught end-to-end: the owner's workspace worked perfectly right up until
    // the first invitee accepted, at which point both of them were locked out.
    // A one-member fixture would never have surfaced it.
    const { data: membership } = await supabase
      .from("organisation_memberships")
      .select("role")
      .eq("organisation_id", org.id)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    // ===========================================================================
    // THE IMPERSONATION BRANCH (Phase 7 Task 2)
    // ===========================================================================
    // Reached ONLY when the membership lookup above came back empty, so an
    // ordinary member -- every user of the product except the platform
    // superuser mid-session -- pays nothing for it. A superuser who is NOT
    // mid-session falls straight through to the same `return null` as before,
    // and gets the identical tenant-isolation 404 as any stranger: there is no
    // "superuser can see everything" path here, which is CLAUDE.md
    // § Superuser dashboard's "no direct tenant-data access outside
    // impersonation" expressed in the resolver every org route goes through.
    //
    // resolveImpersonationForOrg() also WRITES the page-access audit row and
    // fails closed if that write is refused -- see its header for why the
    // audit lives at this choke point and not in a layout.
    if (!membership) {
      const impersonation = await resolveImpersonationForOrg(org.id as string);
      if (!impersonation) return null;
      return {
        id: org.id as string,
        name: org.name as string,
        slug: org.slug as string,
        // A LABEL, NOT THE GRANT. See CurrentOrg.isImpersonated.
        role: IMPERSONATION_ROLE_ENVELOPE,
        isSuspended: (org.deleted_at as string | null) !== null,
        isImpersonated: true,
        impersonationExpiresAt: impersonation.expiresAt,
      };
    }

    return {
      id: org.id as string,
      name: org.name as string,
      slug: org.slug as string,
      role: membership.role as string,
      isSuspended: (org.deleted_at as string | null) !== null,
      isImpersonated: false,
      impersonationExpiresAt: null,
    };
  },
);

/**
 * Ask the database whether the caller holds a permission in an organisation.
 *
 * This is public.has_permission() -- the same function the RLS policies
 * themselves call -- so the UI cannot drift out of step with what the database
 * will actually allow. It is used to decide what to RENDER. It is not the
 * enforcement: CLAUDE.md § Permissions is explicit that "entitlements are
 * enforced server-side -- hiding UI is not enforcement". Every gated action
 * here is independently refused by an RLS policy if it is attempted anyway.
 *
 * cache()-WRAPPED, LIKE EVERY OTHER READ IN THIS FILE. The sidebar layout
 * (app/(app)/layout.tsx) and the org-home page both ask for the identical
 * three keys (view_network / manage_members / manage_custom_fields) in the
 * same request; without the wrapper that was six has_permission() RPCs per
 * org-home render, three of them exact duplicates. cache() keys on the
 * argument pair, so distinct permissions still query independently.
 */
export const hasPermission = cache(
  async (organisationId: string, permission: string): Promise<boolean> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("has_permission", {
      p_org_id: organisationId,
      p_permission: permission,
    });
    if (error) return false;
    return data === true;
  },
);
