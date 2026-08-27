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
 * The "select own rows" policy on organisation_memberships makes this safe to
 * ask unfiltered: it returns the caller's rows and nobody else's. Pending
 * invites are included on purpose -- the invite landing page needs them, and
 * an 'invited' row is the caller's own business.
 *
 * The join to organisations goes through the SAME query so it is subject to
 * organisations_select_member -- which means an invited-but-not-active
 * membership comes back with a NULL organisation, because the invitee is not
 * an active member and genuinely cannot read that row yet. Those are surfaced
 * as pending invites without the org's details rather than dropped, so the
 * user can still accept.
 */
export const getMemberships = cache(async (): Promise<Membership[]> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organisation_memberships")
    .select(
      "id, organisation_id, role, status, invited_at, joined_at, organisations ( id, name, slug )",
    )
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
    const { data: org, error } = await supabase
      .from("organisations")
      .select("id, name, slug")
      .eq("slug", slug)
      .is("deleted_at", null)
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

    if (!membership) return null;

    return {
      id: org.id as string,
      name: org.name as string,
      slug: org.slug as string,
      role: membership.role as string,
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
 */
export async function hasPermission(
  organisationId: string,
  permission: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_permission", {
    p_org_id: organisationId,
    p_permission: permission,
  });
  if (error) return false;
  return data === true;
}
