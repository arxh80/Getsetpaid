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
//           - Has an account that signed ITSELF up and never confirmed its
//                                 email -> REFUSED, before any invitation
//                                 email exists (G11, account pre-hijacking;
//                                 see resolveOrInviteAuthUser()).
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
import { adminAuthFetch, createAdminClient } from "@/lib/supabase/admin";
import { siteUrl } from "@/lib/supabase/env";
import { getCurrentOrg } from "@/lib/auth";
// The MFA requirement, asserted server-side rather than merely rendered.
// CLAUDE.md § Session security requires MFA for Owner/Admin/Finance; before
// the final fix wave that requirement existed ONLY as a content swap in
// app/(app)/layout.tsx, so a stolen Owner password could POST straight at
// these action endpoints and never meet it. See assertMfaSatisfied()'s own
// header for which actions are gated and, just as importantly, which are
// deliberately not. This is the readable-error layer; the enforcement is
// supabase/migrations/20260827210000_mfa_aal_permission_gate.sql.
import { assertMfaSatisfied } from "@/lib/auth/mfa-gate";
import { field, isValidEmail, type FormState } from "@/lib/forms";
// Plain data lives in its own module: a "use server" file may only EXPORT
// async functions, and exporting the roles array from here compiles fine then
// throws on module evaluation at runtime. See lib/org/roles.ts.
import { isInvitableRole } from "./roles";
import { RESERVED_SLUG_HINT, RESERVED_SLUG_MESSAGE, isReservedWorkspaceSlug } from "./reserved-slugs";

// ---------------------------------------------------------------------------
// Create organisation
// ---------------------------------------------------------------------------
export async function createOrganisationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // FIRST, before any validation or any write. A caller with no privileged
  // membership anywhere -- the ordinary brand-new signup creating their first
  // workspace -- passes straight through, because the gate does not apply to
  // them at all. A caller who is already an Owner or Admin somewhere is
  // refused until they present their factor.
  const refusal = await assertMfaSatisfied();
  if (refusal) return refusal;

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
  } else if (isReservedWorkspaceSlug(slug)) {
    // Also a nicety: the database refuses it (hint reserved_slug, below).
    fieldErrors.slug = RESERVED_SLUG_MESSAGE;
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
    // The database's own refusal of a slug that is one of the app's routes
    // (20260923005000) -- reached only if the list above has drifted, which
    // tests/unit/org/reserved-slugs.test.ts exists to prevent.
    if (error.code === "22023" && error.hint === RESERVED_SLUG_HINT) {
      return { fieldErrors: { slug: RESERVED_SLUG_MESSAGE } };
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
  // FIRST, and the reason this guard is worth having at all even though the
  // database now refuses the INSERT independently: step 1 below creates an
  // auth.users row for the invitee through the Admin API and sends them an
  // email. Without this, an aal1 attacker POSTing here could not complete the
  // invite -- the RLS policy stops that -- but could still spray account
  // creations and invitation emails at arbitrary addresses from the product's
  // own domain. The database gate protects the tenant; this one stops the
  // action before it does side-effectful work outside the database.
  const refusal = await assertMfaSatisfied();
  if (refusal) return refusal;

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
  /** True when inviteUserByEmail answered 200 (and sent the email). */
  created: boolean;
}

/**
 * Shown to the inviter when the address belongs to an account that signed
 * itself up and has not confirmed its email.
 *
 * NEUTRAL ON PURPOSE: IT TELLS NOBODY TO CONFIRM ANYTHING (Task 4 fix round
 * 1). The first wording ("Ask them to confirm it, then invite again") sent
 * the inviter to have the address's owner confirm an account a squatter may
 * have created -- and confirming it is exactly what makes the squatter's
 * password work (GoTrue keeps the first password; the RESIDUAL test in
 * tests/e2e/invite-pre-hijack.spec.ts). Measured on the local stack before
 * choosing this wording, on a squatter's unconfirmed account:
 *   - the sign-in page's only "forgotten it?" route, the emailed sign-in
 *     link, makes GoTrue send a sign-up confirmation instead; following it
 *     confirms the account and the squatter's password still signs in;
 *   - GoTrue's recovery flow does confirm the account, and the squatter's
 *     password fails once a new one is set -- but this app has no "Forgot
 *     password" page to send anyone to, and the password form it shows after
 *     a recovery link is optional.
 * So there is no safe path to point the owner at until Phase 10 Task 20
 * (Q245) makes an address's first proof also choose a new password. Until
 * then the message states the fact and offers the one thing that is safe:
 * a different address.
 */
const UNCONFIRMED_SIGN_UP_REFUSAL =
  "We can't invite that address yet: it has an unfinished GetSetPaid sign-up. Check the address with the person you're inviting, or invite them at a different address.";

const INVITE_FAILED = "We couldn't send that invitation. Try again.";

/**
 * Returns an auth.users id for `email`, creating the account if it does not
 * exist yet -- or refuses, when binding the invitation would hand a tenant
 * membership to somebody who never proved they hold that inbox.
 *
 * OBSERVED BEHAVIOUR of supabase.auth.admin.inviteUserByEmail(), verified
 * against the local stack rather than assumed:
 *   - address with no account       -> 200, returns the newly created user
 *                                      with invited_at set; sends the invite
 *                                      email.
 *   - address with a CONFIRMED
 *     account                       -> 422 { code: "email_exists" }, no user
 *                                      returned.
 *   - address invited but never
 *     accepted                      -> 200 again, SAME user id, invited_at
 *                                      refreshed, email re-sent. So re-inviting
 *                                      a pending user is naturally idempotent.
 *   - address that SIGNED ITSELF UP
 *     and never confirmed           -> ALSO 200, SAME user id, and an invite
 *                                      email sent (measured with confirmations
 *                                      on, Phase 10 Task 4: the squatter's
 *                                      account came back with invited_at now
 *                                      set). Only a confirmed account gets the
 *                                      422.
 *
 * THE LAST CASE IS G11 PATH 2, AND WHY THE CHECK RUNS BEFORE THE CALL.
 * A squatter signs up as bookings@victim.example with a password of their
 * own and never confirms (they cannot: the inbox is not theirs). Before this
 * check, a workspace inviting that address bound the squatter's id through
 * the 200 above. The real owner then followed the invitation link, which is
 * what CONFIRMS an account in GoTrue -- with the squatter's password still on
 * it -- and the squatter signed in and held the membership. Reproduced end to
 * end in tests/e2e/invite-pre-hijack.spec.ts.
 *
 * So the address is looked up FIRST, and an unconfirmed self-service sign-up
 * is refused before inviteUserByEmail runs. Refusing after the call would be
 * too late: the invitation email would already be in the victim's inbox, and
 * following it confirms the squatter's account whether or not a membership
 * row was written.
 *
 * WHAT TELLS A SQUATTER FROM A PENDING INVITEE. Both are existing,
 * unconfirmed accounts, and inviteUserByEmail treats them identically. The
 * difference is how the account came to exist: a pending invitee was created
 * by an invitation (invited_at is set before this call, and the account has
 * no password anybody chose), a squatter by a sign-up (invited_at is null).
 * Refusing every unconfirmed account would break one person being invited by
 * two workspaces before accepting either, which the e2e spec keeps working.
 * invited_at is reliable here because nothing but this function invites, and
 * it never invites an unconfirmed sign-up -- so an account carrying a
 * password somebody chose never acquires an invited_at through this product.
 *
 * RESIDUALS, stated rather than left for a reviewer (SECURITY.md § 10):
 *   - A squatter signing up in the milliseconds between the lookup and the
 *     inviteUserByEmail call would still be bound. They would have to know
 *     when the invitation is sent.
 *   - Confirming the squatter's sign-up (by following its confirmation
 *     email, by signing up again and confirming, or by asking for an emailed
 *     sign-in link) makes the account usable with the squatter's password:
 *     GoTrue keeps the FIRST password on an unconfirmed re-sign-up. After
 *     that the account is confirmed and binds like any other. Open until
 *     Phase 10 Task 20 (Q245); UNCONFIRMED_SIGN_UP_REFUSAL is worded so as
 *     not to steer anyone into it.
 *
 * THE OTHER ORDERING IS SAFE (measured, and pinned by the e2e spec): when the
 * invitation comes FIRST, the account it creates has no password, and a
 * squatter signing up over it afterwards stores none either -- GoTrue does
 * not update an existing unconfirmed user on sign-up. The squatter's
 * sign-up does re-send a confirmation, which voids the invitation link, so
 * the invitee may need the newer email or a fresh invitation; that is a
 * nuisance, not a takeover.
 */
async function resolveOrInviteAuthUser(
  email: string,
  orgSlug: string,
): Promise<ResolvedIdentity | { error: string }> {
  const admin = createAdminClient();

  // ---- G11: never bind an unconfirmed self-service sign-up ---------------
  // Fails CLOSED: if the lookup itself fails we cannot tell a squatter from a
  // stranger, and proceeding would bind the squatter through the 200 above.
  const lookup = await findAuthUserByEmail(email);
  if (lookup === LOOKUP_FAILED) return { error: INVITE_FAILED };
  if (lookup && isUnconfirmedSignUp(lookup)) {
    return { error: UNCONFIRMED_SIGN_UP_REFUSAL };
  }

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
    // The lookup above normally already holds this account. Look again only
    // if it found nothing (the account appeared since).
    const existing = lookup ?? (await findAuthUserByEmail(email));
    if (!existing || existing === LOOKUP_FAILED) {
      // inviteUserByEmail said the address is taken but we cannot find it.
      // Refuse rather than guess -- inventing an id here would attach the
      // membership to the wrong person.
      return { error: INVITE_FAILED };
    }
    // GoTrue answers 422 only for a confirmed account, so this is belt and
    // braces: the binding rule is "proven inbox", whichever branch got here.
    if (existing.emailConfirmedAt === null) {
      return { error: UNCONFIRMED_SIGN_UP_REFUSAL };
    }
    return { userId: existing.id, created: false };
  }

  if (error?.status === 429) {
    return { error: "Too many invitations sent. Wait a minute and try again." };
  }

  return { error: INVITE_FAILED };
}

/** The fields of a GoTrue admin user record this file reads. */
interface AuthUserRecord {
  id: string;
  emailConfirmedAt: string | null;
  invitedAt: string | null;
}

/** An account that signed ITSELF up and has never proved its address. */
function isUnconfirmedSignUp(user: AuthUserRecord): boolean {
  return user.emailConfirmedAt === null && user.invitedAt === null;
}

/** The Admin API could not be asked. Distinct from "no such account". */
const LOOKUP_FAILED = "lookup_failed";

/** The slice of a GoTrue admin user row this file reads, as the API sends it. */
interface AdminUserRow {
  id?: string;
  email?: string;
  email_confirmed_at?: string | null;
  invited_at?: string | null;
}

/** Users per page when scanning the Admin API's filtered result set. */
const LOOKUP_PAGE_SIZE = 100;
/**
 * Hard ceiling on pages walked. With `filter` set to a full email address the
 * server-side result set is one row in every realistic case (see below), so
 * this is a runaway guard, not a working limit.
 */
const LOOKUP_MAX_PAGES = 10;

/**
 * Finds an existing auth user by email address.
 *
 * Returns its id, email_confirmed_at and invited_at (the last two are G11's
 * binding rule, above); null when no account matches exactly; LOOKUP_FAILED
 * when the Admin API could not be asked. A failure is NOT "no account": the
 * invite step reads it as a reason to stop, since "no account" would let it
 * proceed to inviteUserByEmail and bind whatever is there.
 *
 * TWO THINGS ARE GOING ON HERE, and they are easy to confuse.
 *
 * 1. THE QUERY IS FILTERED SERVER-SIDE. `?filter=` is sent to GoTrue's admin
 *    list endpoint, so the database does the matching. The previous version of
 *    this function called `admin.listUsers({ page: 1, perPage: 200 })` with NO
 *    filter and searched the result in JS -- so past 200 auth users
 *    project-wide, inviting somebody who already had an account silently
 *    failed to find them and the invite errored out generically. It also
 *    scanned the whole user table on every such invite. Review finding 2.
 *
 *    The filter has to be passed by hand: @supabase/auth-js 2.112.4 types
 *    listUsers() as taking `PageParams = { page?, perPage? }` only, and its
 *    implementation sends exactly those two. adminAuthFetch() in
 *    lib/supabase/admin.ts is the escape hatch, hard-scoped to /auth/v1.
 *
 * 2. THE FILTER IS NOT TRUSTED. GoTrue's `filter` is a SUBSTRING match --
 *    verified against the running stack, where `?filter=probe-` returned two
 *    distinct users -- so `?filter=a@b.com` also matches
 *    `xa@b.com.attacker.test`. Every returned row is therefore re-checked for
 *    an exact, case-insensitive match. Handing back a near-miss id would
 *    attach the membership to the wrong account, in a flow whose entire job is
 *    granting somebody access to a tenant.
 *
 * Pagination metadata is honoured rather than ignored: the walk follows the
 * `link: ...; rel="next"` header until the match is found or the pages run
 * out. With `filter` set to a complete address a second page is vanishingly
 * unlikely -- it would need other addresses CONTAINING this whole address as a
 * substring -- but "unlikely" was the previous version's failure mode too.
 */
async function findAuthUserByEmail(
  email: string,
): Promise<AuthUserRecord | null | typeof LOOKUP_FAILED> {
  const target = email.toLowerCase();

  for (let page = 1; page <= LOOKUP_MAX_PAGES; page++) {
    const response = await adminAuthFetch("/admin/users", {
      filter: target,
      page: String(page),
      per_page: String(LOOKUP_PAGE_SIZE),
    });
    if (!response.ok) return LOOKUP_FAILED;

    const body: unknown = await response.json();
    const users =
      typeof body === "object" && body !== null && "users" in body
        ? (body as { users?: AdminUserRow[] }).users
        : undefined;
    if (!Array.isArray(users)) return LOOKUP_FAILED;
    if (users.length === 0) return null;

    const match = users.find((u) => u.email?.toLowerCase() === target);
    if (match?.id) {
      return {
        id: match.id,
        emailConfirmedAt: match.email_confirmed_at ?? null,
        invitedAt: match.invited_at ?? null,
      };
    }

    // GoTrue emits `link: <...>; rel="next"` only while another page exists.
    // No rel="next" means this was the last page and there is no exact match.
    if (!/rel="next"/.test(response.headers.get("link") ?? "")) return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Accept an invitation
// ---------------------------------------------------------------------------
export async function acceptInviteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Accepting an invitation turns an 'invited' row into an 'active' one, and
  // 'active' is what every read policy in the schema keys off -- so this is a
  // privileged tenant write even though the caller is only acting on their own
  // row. NOT a chicken-and-egg for the invitee: accept_invite() is SECURITY
  // DEFINER and does not consult has_permission, so an ordinary invitee (no
  // privileged membership anywhere yet) passes the gate untouched. It only
  // bites someone who is ALREADY an Owner/Admin elsewhere and has not
  // presented their factor -- who is already looking at the enrolment screen.
  const refusal = await assertMfaSatisfied();
  if (refusal) return refusal;

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
    // G11 (20261102010000): the account has not proved its email address.
    // Told apart from the 42501 below by its hint, and about the caller only.
    if (error.code === "42501" && error.hint === "invite_email_unconfirmed") {
      return { error: "Confirm your email address before accepting this invitation." };
    }
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
