"use server";

// Organisation lifecycle Server Actions: create an organisation, invite a
// member, accept an invitation.
//
// ===========================================================================
// THE INVITE FLOW'S CENTRAL CONSTRAINT, and how the privilege split works
// ===========================================================================
//
// organisation_memberships.user_id is NOT NULL and references auth.users. So
// you cannot create a membership for somebody who has never signed up -- there
// is no id to point at. That single fact shapes everything below:
//
//   Step 1  Get a real auth.users id for the invited address.
//           - Never signed up  -> supabase.auth.admin.inviteUserByEmail()
//                                 creates the row and sends Supabase's invite
//                                 email. Requires the SERVICE-ROLE client.
//           - Already has an account -> inviteUserByEmail returns
//                                 422 email_exists (verified empirically
//                                 against the local stack). Look the existing
//                                 user up by email through the Admin API
//                                 instead and reuse their id.
//
//   Step 2  Create the membership row -- as the INVITING ADMIN, through their
//           own session, under RLS. NOT with the service-role client.
//
// STEP 2 IS THE IMPORTANT ONE. It would be easier to insert the membership
// with the admin client we already have open from step 1. That would be a
// real privilege bug: the check that the caller may invite anyone into this
// organisation at all would then live only in this file, in an `if`. Doing
// the insert through the user's own client means
// organisation_memberships_insert_manage_members decides -- in the database,
// on every attempt, for every code path including ones written later by
// someone who has not read this comment. The service-role client's remit here
// is strictly "mint an auth identity"; it never touches a tenant table, and
// it holds no table grants that would let it (Task 4 design note (e)).
//
// WHY THE ADMIN API IS UNAVOIDABLE
//   Creating an auth.users row has no user-scoped equivalent -- there is no
//   RLS policy that could authorise it, because auth.users is not our table.
//   This is the one legitimate service-role use in this phase.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/supabase/env";
import { getCurrentOrg } from "@/lib/auth";
import { field, isValidEmail, type FormState } from "@/lib/forms";
// Plain data lives in its own module: a "use server" file may only EXPORT
// async functions, and exporting the roles array from here compiles fine then
// throws on module evaluation at runtime. See lib/org/roles.ts.
import { isInvitableRole } from "./roles";

// ---------------------------------------------------------------------------
// Create organisation
// ---------------------------------------------------------------------------
export async function createOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const name = field(formData, "name");
  const slug = slugify(field(formData, "slug") ?? name ?? "");

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Enter a name for your organisation.";
  if (!slug) {
    fieldErrors.slug = "Enter a web address for your workspace.";
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 63) {
    // Mirrors the check inside create_organisation() so the user gets a
    // useful message instead of a raised Postgres exception. The database
    // still enforces it -- this is a nicety, not the rule.
    fieldErrors.slug =
      "Use 2-63 lowercase letters, numbers and single hyphens.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const supabase = await createClient();

  // create_organisation() is SECURITY DEFINER and creates the organisation
  // AND the caller's owner membership AND the audit record atomically. It is
  // the only sanctioned path: public.organisations has no INSERT policy, and
  // a brand-new user holds no permission anywhere so could not insert their
  // own first membership either.
  const { data, error } = await supabase.rpc("create_organisation", {
    p_name: name,
    p_slug: slug,
  });

  if (error) {
    // 23505 = unique_violation on organisations.slug. Worth naming precisely:
    // slugs are public-ish workspace addresses, not secrets, and "that address
    // is taken" is the only message that lets the user actually proceed.
    if (error.code === "23505") {
      return { fieldErrors: { slug: "That workspace address is already taken." } };
    }
    return { error: "We couldn't create that organisation. Try again." };
  }
  if (!data) return { error: "We couldn't create that organisation. Try again." };

  redirect(`/${slug}`);
}

// ---------------------------------------------------------------------------
// Invite a member
// ---------------------------------------------------------------------------
export async function inviteMemberAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const orgSlug = field(formData, "orgSlug");
  const email = field(formData, "email")?.toLowerCase() ?? null;
  const role = field(formData, "role");

  if (!orgSlug) return { error: "Missing organisation." };

  const fieldErrors: Record<string, string> = {};
  if (!email) {
    fieldErrors.email = "Enter an email address.";
  } else if (!isValidEmail(email)) {
    fieldErrors.email = "That doesn't look like an email address.";
  }
  if (!isInvitableRole(role)) {
    fieldErrors.role = "Choose a role.";
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  // Resolve the slug to an organisation THROUGH RLS. A slug the caller is not
  // an active member of resolves to null and is indistinguishable from one
  // that does not exist -- so this never confirms another tenant's slug.
  // It also gives us the organisation UUID from the database rather than from
  // the form, which is the "never trust a client-supplied organisation ID"
  // rule in CLAUDE.md § Tenancy model.
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { error: "That workspace isn't available." };

  const supabase = await createClient();

  // Pre-flight permission check, so a user without 'manage_members' gets a
  // clear message instead of an opaque RLS rejection -- and so we do not
  // create an auth.users row for someone who was never going to be allowed to
  // invite. NOT the enforcement: the INSERT below is independently gated by
  // organisation_memberships_insert_manage_members, which is what actually
  // decides. CLAUDE.md: "hiding UI is not enforcement".
  const { data: mayInvite } = await supabase.rpc("has_permission", {
    p_org_id: org.id,
    p_permission: "manage_members",
  });
  if (mayInvite !== true) {
    return { error: "You don't have permission to invite people to this workspace." };
  }

  // ---- Step 1: get a real auth.users id for this address -----------------
  const identity = await resolveOrInviteAuthUser(email!, orgSlug);
  if ("error" in identity) return { error: identity.error };

  // ---- Step 2: create the membership row AS THE ADMIN, under RLS ---------
  // status and joined_at are pinned by the INSERT policy (status must be
  // 'invited', joined_at must be null) -- sent explicitly here so the intent
  // is legible, but the policy is what guarantees it. invited_by is set to the
  // caller; the policy refuses any other value.
  const {
    data: { user: actor },
  } = await supabase.auth.getUser();

  const { error: insertError } = await supabase
    .from("organisation_memberships")
    .insert({
      organisation_id: org.id,
      user_id: identity.userId,
      role,
      status: "invited",
      invited_by: actor?.id ?? null,
    });

  if (insertError) {
    // 23505 = the (organisation_id, user_id) unique constraint: this person
    // already has a membership row here, at some status.
    if (insertError.code === "23505") {
      return {
        fieldErrors: {
          email: "That person is already a member of, or invited to, this workspace.",
        },
      };
    }
    // 42501 = the RLS policy refused it. Reachable if the caller's permission
    // changed between the check above and this insert -- which is exactly the
    // race the database-side check exists to lose safely.
    if (insertError.code === "42501") {
      return { error: "You don't have permission to invite people to this workspace." };
    }
    return { error: "We couldn't send that invitation. Try again." };
  }

  revalidatePath(`/${orgSlug}/members`);
  return {
    message: identity.created
      ? `Invitation sent to ${email}. They'll get an email with a link to join.`
      : `${email} already has a GetSetPaid account. We've sent them an invitation to this workspace.`,
  };
}

interface ResolvedIdentity {
  userId: string;
  /** True when this call created the auth.users row (and sent the email). */
  created: boolean;
}

/**
 * Returns an auth.users id for `email`, creating the account if it does not
 * exist yet.
 *
 * OBSERVED BEHAVIOUR of supabase.auth.admin.inviteUserByEmail(), verified
 * against the local stack rather than assumed:
 *   - address with no account       -> 200, returns the newly created user
 *                                      with invited_at set; sends the invite
 *                                      email.
 *   - address with a full account   -> 422 { code: "email_exists" }, no user
 *                                      returned.
 *   - address invited but never
 *     accepted                      -> 200 again, SAME user id, invited_at
 *                                      refreshed, email re-sent. So re-inviting
 *                                      a pending user is naturally idempotent.
 *
 * The 422 is what the fallback below handles.
 */
async function resolveOrInviteAuthUser(
  email: string,
  orgSlug: string,
): Promise<ResolvedIdentity | { error: string }> {
  const admin = createAdminClient();

  // The invitee is sent to our own callback, which verifies the emailed token
  // server-side and then lands them on the invite screen for this workspace.
  const redirectTo = new URL("/auth/callback", siteUrl());
  redirectTo.searchParams.set("next", `/invites?org=${orgSlug}`);

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: redirectTo.toString(),
  });

  if (!error && data?.user) {
    return { userId: data.user.id, created: true };
  }

  if (error && (error.code === "email_exists" || error.status === 422)) {
    const existing = await findAuthUserByEmail(email);
    if (!existing) {
      // inviteUserByEmail said the address is taken but we cannot find it.
      // Refuse rather than guess -- inventing an id here would attach the
      // membership to the wrong person.
      return { error: "We couldn't send that invitation. Try again." };
    }
    return { userId: existing, created: false };
  }

  if (error?.status === 429) {
    return { error: "Too many invitations sent. Wait a minute and try again." };
  }

  return { error: "We couldn't send that invitation. Try again." };
}

/**
 * Finds an existing auth user by email address.
 *
 * GoTrue's admin list endpoint accepts `filter`, which is a SUBSTRING match on
 * the email -- so `?filter=a@b.com` also matches `xa@b.com.attacker.test`.
 * That is why every returned row is re-checked for an exact,
 * case-insensitive match here. Trusting the filter would let a near-miss
 * address hand back a different user's id, and the invitation would then
 * attach a membership to the wrong account.
 */
async function findAuthUserByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  const target = email.toLowerCase();

  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error || !data?.users) return null;

  const match = data.users.find((u) => u.email?.toLowerCase() === target);
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------
// Accept an invitation
// ---------------------------------------------------------------------------
export async function acceptInviteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const membershipId = field(formData, "membershipId");
  if (!membershipId) return { error: "Missing invitation." };

  const supabase = await createClient();

  // accept_invite() is SECURITY DEFINER and is the ONLY path from 'invited' to
  // 'active' -- the client-facing UPDATE policy refuses that transition for
  // everyone, the invitee included, which is what stops an admin minting an
  // active membership for someone who never consented.
  //
  // The membership id here is client-supplied and deliberately NOT trusted:
  // the function re-checks user_id = auth.uid() inside its own lookup, so an
  // id belonging to someone else fails there, in the database. Nothing in this
  // file establishes who owns the row.
  const { error } = await supabase.rpc("accept_invite", {
    p_membership_id: membershipId,
  });

  if (error) {
    // 42501 is raised for BOTH "no such invitation" and "that invitation is
    // not yours" -- the function does not distinguish them, and neither do we.
    // See the migration's design note (c).
    if (error.code === "42501") {
      return { error: "That invitation is no longer available." };
    }
    if (error.code === "22023") {
      return { error: "That invitation has already been used." };
    }
    return { error: "We couldn't accept that invitation. Try again." };
  }

  // Re-read the slug AFTER accepting: before acceptance the invitee is not an
  // active member, so organisations_select_member hid the row and we could not
  // have known the slug to redirect to.
  const { data: membership } = await supabase
    .from("organisation_memberships")
    .select("organisations ( slug )")
    .eq("id", membershipId)
    .maybeSingle();

  const org = membership?.organisations as unknown as { slug: string } | null;

  revalidatePath("/invites");
  if (org?.slug) redirect(`/${org.slug}`);
  redirect("/");
}

/**
 * Turns a workspace name into a URL-safe slug candidate.
 *
 * Only a suggestion -- create_organisation() validates the real thing with
 * `^[a-z0-9]+(-[a-z0-9]+)*$`, 2-63 chars, and raises if it does not match.
 * Non-ASCII is stripped rather than transliterated: a silent, lossy
 * transliteration of a name in another script produces a slug the owner does
 * not recognise. If nothing survives, the field is left for them to fill in.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
