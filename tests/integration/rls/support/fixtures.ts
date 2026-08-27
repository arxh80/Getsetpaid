// Fixture lifecycle for the RLS/permission-engine integration suite.
//
// Mirrors the pattern supabase/tests/rls_foundation.sql + run-rls-tests.sh
// established for Task 4, adapted to the real client path:
//   - Auth users are created through the GoTrue Admin API (service-role key),
//     exactly like run-rls-tests.sh's `curl .../auth/v1/admin/users` calls.
//   - Organisations are created through the REAL create_organisation() RPC,
//     signed in as the owning user -- exercising the actual client path, not
//     a shortcut.
//   - Invites are created through a REAL INSERT against
//     organisation_memberships, signed in as an org admin/owner who holds
//     'manage_members' -- again the actual client path.
//   - Activating an invite to 'active' goes through the REAL
//     public.accept_invite() RPC (Task 6), called by each invitee's own
//     signed-in client. It used to be a raw superuser UPDATE because no
//     client path existed; that path now exists, so the fixture uses it.
//   - Granting platform_admins is a DBA-only action by design (no client
//     path exists at all, and the suite asserts that) -- done the same way.
//
// Everything the tests actually ASSERT on goes through @supabase/supabase-js
// clients signed in as the relevant persona, talking HTTP to the local
// PostgREST instance -- the same path the real application will use.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "./env";
import { totpCode } from "@/tests/support/totp";

const PASSWORD = "Test-Passw0rd!-rls-js";

export type RoleKey =
  | "owner"
  | "admin"
  | "manager"
  | "booker"
  | "venue_manager"
  | "finance"
  | "marketing"
  | "standard_user"
  | "read_only";

/** All 9 seeded org roles (public.roles), per the Task 4 reference-data
 * migration. 'platform_superuser' is deliberately NOT in this list -- it was
 * removed from the roles catalogue during Task 4's review and replaced by
 * the platform_admins allowlist (see 20260826202023_reference_data.sql). */
export const ALL_ROLES: RoleKey[] = [
  "owner",
  "admin",
  "manager",
  "booker",
  "venue_manager",
  "finance",
  "marketing",
  "standard_user",
  "read_only",
];

export interface Persona {
  key: string;
  email: string;
  userId: string;
  role: RoleKey | null;
  /** Signed-in client for this persona -- the real HTTP path. */
  client: SupabaseClient;
}

export interface RlsFixtures {
  runId: string;
  apiUrl: string;
  anonKey: string;
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  /** Every non-owner role in org A, ACTIVE, keyed by role. */
  activeByRole: Record<Exclude<RoleKey, "owner">, Persona>;
  ownerA: Persona;
  ownerB: Persona;
  /** role='admin' in org A, INSERTed as an invite and deliberately NEVER
   * activated -- the subject of the membership-status-gating tests. */
  invitedAdminA: Persona;
  superuser: Persona;
  /** Fresh client with no session at all (anon key, signed out). */
  anonClient: SupabaseClient;
  /** service-role client. Used for the Admin Auth API (user create/delete)
   * throughout fixture setup/teardown, and exactly ONCE against a PostgREST
   * table endpoint -- rls.test.ts's "service_role has NO table privileges on
   * profiles" assertion -- to prove the Task 4 design decision that
   * service_role holds zero table grants (design note (e): "a leaked service
   * key is not, by itself, a read of every tenant's data"). Every other use
   * in this file is Admin API only. */
  adminAuth: SupabaseClient;
  /** All created auth.users ids + organisation ids, for teardown. */
  _allUserIds: string[];
  _allOrgIds: string[];
  _pool: Pool;
}

async function createPersonaUser(
  adminAuth: SupabaseClient,
  email: string,
): Promise<string> {
  const { data, error } = await adminAuth.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Could not create auth user ${email}: ${error?.message}`);
  }
  return data.user.id;
}

async function signInClient(
  apiUrl: string,
  anonKey: string,
  email: string,
): Promise<SupabaseClient> {
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) {
    throw new Error(`Could not sign in as ${email}: ${error.message}`);
  }
  return client;
}

/**
 * Org roles CLAUDE.md § Session security requires MFA for. Mirrors
 * private.role_requires_mfa() in
 * supabase/migrations/20260827210000_mfa_aal_permission_gate.sql and
 * MFA_REQUIRED_ROLES in lib/auth/mfa-gate.ts.
 */
const MFA_REQUIRED_ROLES = new Set<RoleKey>(["owner", "admin", "finance"]);

/**
 * Takes a signed-in client from aal1 to aal2 by genuinely enrolling a TOTP
 * factor and completing a challenge against the live GoTrue verifier.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENING OF THIS SUITE
 * ===========================================================================
 * 20260827210000_mfa_aal_permission_gate.sql makes has_permission() return
 * false for an owner/admin/finance membership whose SESSION has not presented
 * a factor. signInWithPassword() returns aal1 -- verified in the suite's own
 * MFA lifecycle tests -- so before this helper, ownerA's fixture invites (and
 * the superuser's subscription writes) were being made by a session that, per
 * CLAUDE.md § Session security, should never have been able to make them. The
 * fixture was passing because the requirement was not enforced anywhere.
 *
 * The fix is to make the FIXTURE realistic, not to relax the policy: a real
 * Owner of a real organisation is required to hold a factor, so the persona
 * standing in for one holds a factor too. Every assertion in rls.test.ts
 * therefore still asserts exactly what it always did, against a persona whose
 * privileges are now legitimately established rather than accidentally
 * available.
 *
 * Applied ONLY to personas whose role requires MFA (plus the superuser).
 * manager, booker, venue_manager, marketing, standard_user, read_only and the
 * never-activated invited admin all stay at aal1 -- MFA is optional for those
 * roles at MVP, and running them at aal1 is what keeps the suite honest about
 * the gate being role-scoped rather than a blanket "aal2 to do anything",
 * which would lock out most of the product.
 *
 * challengeAndVerify() upgrades the EXISTING session in place -- same
 * session_id, same auth.sessions.created_at, only `aal` moves. That is
 * measured, not assumed; see the regression-evidence test in
 * tests/integration/mfa/mfa-lifecycle.test.ts. So this does not mint a second
 * session or restart any clock the rest of the fixture depends on.
 */
async function elevateToAal2(client: SupabaseClient, label: string): Promise<void> {
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
  if (enrolled.error || !enrolled.data) {
    throw new Error(`Fixture: could not enrol TOTP for ${label}: ${enrolled.error?.message}`);
  }

  const { error } = await client.auth.mfa.challengeAndVerify({
    factorId: enrolled.data.id,
    code: totpCode(enrolled.data.totp.secret),
  });
  if (error) {
    throw new Error(`Fixture: TOTP challenge failed for ${label}: ${error.message}`);
  }

  // Assert the elevation actually happened rather than trusting a silent
  // success. If this ever regresses, the failure has to name itself here --
  // otherwise it surfaces as a baffling RLS denial fifty lines later.
  const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    throw new Error(
      `Fixture: ${label} is still ${aal?.currentLevel ?? "unknown"} after a successful TOTP challenge`,
    );
  }
}

export async function createFixtures(): Promise<RlsFixtures> {
  const env = getLocalSupabaseStatus();
  const runId = randomUUID().slice(0, 8);

  const adminAuth = createClient(env.apiUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pool = new Pool({ connectionString: env.dbUrl });

  const nonOwnerRoles = ALL_ROLES.filter((r) => r !== "owner") as Exclude<
    RoleKey,
    "owner"
  >[];

  // ---- 1. Create every auth user up front -------------------------------
  const emailFor = (key: string) => `rlsjs-${runId}-${key}@test.local`;

  const ownerAEmail = emailFor("owner-a");
  const ownerBEmail = emailFor("owner-b");
  const superuserEmail = emailFor("superuser");
  const invitedAdminEmail = emailFor("invited-admin-a");
  const roleEmails = new Map(nonOwnerRoles.map((r) => [r, emailFor(r)]));

  const allEmails = [
    ownerAEmail,
    ownerBEmail,
    superuserEmail,
    invitedAdminEmail,
    ...roleEmails.values(),
  ];
  const idByEmail = new Map<string, string>();
  for (const email of allEmails) {
    idByEmail.set(email, await createPersonaUser(adminAuth, email));
  }

  const allUserIds = [...idByEmail.values()];

  // ---- 1b. Name the personas' public.profiles rows.
  // These rows already EXIST: as of Task 6 an AFTER INSERT trigger on
  // auth.users (private.handle_new_user) provisions one for every user, which
  // is what the permission-engine migration meant by "profile rows are
  // provisioned alongside the auth.users row (Task 6)". createUser() above
  // sends no user_metadata, so each arrives with a NULL full_name.
  //
  // This is therefore an UPSERT that gives them readable names for the
  // profile-visibility assertions, not the INSERT that creates them -- a
  // plain INSERT would now hit the primary key. profiles still has no
  // client-facing INSERT/UPDATE-anyone-else policy, so naming another user's
  // profile is still only possible as the Postgres superuser.
  await pool.query(
    `insert into public.profiles (id, full_name)
     select * from unnest($1::uuid[], $2::text[])
     on conflict (id) do update set full_name = excluded.full_name`,
    [allUserIds, allEmails],
  );

  // ---- 2. Sign in as each persona (real HTTP auth, real session) --------
  const clientByEmail = new Map<string, SupabaseClient>();
  for (const email of allEmails) {
    clientByEmail.set(email, await signInClient(env.apiUrl, env.anonKey, email));
  }

  const makePersona = (
    key: string,
    email: string,
    role: RoleKey | null,
  ): Persona => ({
    key,
    email,
    userId: idByEmail.get(email)!,
    role,
    client: clientByEmail.get(email)!,
  });

  const ownerA = makePersona("ownerA", ownerAEmail, "owner");
  const ownerB = makePersona("ownerB", ownerBEmail, "owner");
  const superuser = makePersona("superuser", superuserEmail, null);
  const invitedAdminA = makePersona("invitedAdminA", invitedAdminEmail, "admin");

  // ---- 2b. Raise the MFA-required personas to aal2, BEFORE any of them does
  // anything privileged. Owners (steps 3-4), the superuser (steps 6-7) and the
  // active admin/finance personas the assertions use all need it; everyone
  // else stays at aal1 on purpose. See elevateToAal2()'s header.
  await elevateToAal2(ownerA.client, "ownerA");
  await elevateToAal2(ownerB.client, "ownerB");
  await elevateToAal2(superuser.client, "superuser");
  for (const role of nonOwnerRoles) {
    if (!MFA_REQUIRED_ROLES.has(role)) continue;
    await elevateToAal2(clientByEmail.get(roleEmails.get(role)!)!, `active ${role}`);
  }
  // invitedAdminA is deliberately NOT elevated. Their role is 'admin', but
  // their membership is 'invited' and never activated, so has_permission()
  // refuses them on status long before it looks at assurance level. Leaving
  // them at aal1 keeps the status-gating assertions testing status, not aal.

  // ---- 3. Create organisations through the REAL create_organisation() RPC
  const orgASlug = `rls-js-a-${runId}`;
  const orgBSlug = `rls-js-b-${runId}`;

  const { data: orgAId, error: orgAErr } = await ownerA.client.rpc(
    "create_organisation",
    { p_name: `RLS JS Test Org A ${runId}`, p_slug: orgASlug },
  );
  if (orgAErr || !orgAId) {
    throw new Error(`create_organisation (org A) failed: ${orgAErr?.message}`);
  }
  const { data: orgBId, error: orgBErr } = await ownerB.client.rpc(
    "create_organisation",
    { p_name: `RLS JS Test Org B ${runId}`, p_slug: orgBSlug },
  );
  if (orgBErr || !orgBId) {
    throw new Error(`create_organisation (org B) failed: ${orgBErr?.message}`);
  }

  const allOrgIds = [orgAId as string, orgBId as string];

  // ---- 4. Invite every non-owner role + the invited-only admin into org A,
  // through a REAL INSERT as ownerA (who holds 'manage_members'). This is
  // the actual client INSERT policy under test, not a shortcut.
  const inviteRows = [
    ...nonOwnerRoles.map((role) => ({
      organisation_id: orgAId as string,
      user_id: idByEmail.get(roleEmails.get(role)!)!,
      role,
      status: "invited" as const,
    })),
    {
      organisation_id: orgAId as string,
      user_id: invitedAdminA.userId,
      role: "admin" as const,
      status: "invited" as const,
    },
  ];
  const { error: inviteErr } = await ownerA.client
    .from("organisation_memberships")
    .insert(inviteRows);
  if (inviteErr) {
    throw new Error(`Fixture invites into org A failed: ${inviteErr.message}`);
  }

  // ---- 5. Activate every invite EXCEPT invitedAdminA, through the REAL
  // public.accept_invite() RPC (Task 6), each call made by the invitee's own
  // signed-in client. This used to be a raw superuser UPDATE standing in for
  // a flow that did not exist; now that it does, the fixture goes through the
  // sanctioned path like every other step here.
  //
  // invitedAdminA is left 'invited' on purpose: it is the subject of the
  // status-gating tests.
  for (const role of nonOwnerRoles) {
    const persona = clientByEmail.get(roleEmails.get(role)!)!;
    const { data: rows, error: findErr } = await persona
      .from("organisation_memberships")
      .select("id")
      .eq("organisation_id", orgAId as string);
    if (findErr || !rows?.length) {
      throw new Error(
        `Fixture: ${role} could not see their own pending membership: ${findErr?.message}`,
      );
    }
    const { error: acceptErr } = await persona.rpc("accept_invite", {
      p_membership_id: rows[0].id as string,
    });
    if (acceptErr) {
      throw new Error(`Fixture accept_invite failed for ${role}: ${acceptErr.message}`);
    }
  }

  // ---- 6. Grant platform_admins to the superuser persona. No client path
  // exists for this at all (public.platform_admins has zero policies and no
  // client GRANT) -- it is DBA/migration-only by design, so this is the only
  // possible way to arrange the fixture, and the tests assert the absence of
  // any other way.
  await pool.query(`insert into public.platform_admins (user_id) values ($1)`, [
    superuser.userId,
  ]);

  // ---- 7. Give both orgs a subscription, through the REAL client path as
  // the now-superuser persona (has_platform_permission gates this write).
  // This exercises organisation_subscriptions_insert_platform_billing for
  // real, rather than seeding it out of band.
  const subsPayload = (orgId: string, plan: string) => ({
    organisation_id: orgId,
    plan_id: plan,
    billing_cycle: "monthly",
    seat_count: 1,
    status: "active",
    current_period_end: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
  const { error: subAErr } = await superuser.client
    .from("organisation_subscriptions")
    .insert(subsPayload(orgAId as string, "pro"));
  if (subAErr) {
    throw new Error(`Fixture subscription insert (org A) failed: ${subAErr.message}`);
  }
  const { error: subBErr } = await superuser.client
    .from("organisation_subscriptions")
    .insert(subsPayload(orgBId as string, "starter"));
  if (subBErr) {
    throw new Error(`Fixture subscription insert (org B) failed: ${subBErr.message}`);
  }

  const activeByRole = Object.fromEntries(
    nonOwnerRoles.map((role) => [
      role,
      makePersona(role, roleEmails.get(role)!, role),
    ]),
  ) as Record<Exclude<RoleKey, "owner">, Persona>;

  const anonClient = createClient(env.apiUrl, env.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    runId,
    apiUrl: env.apiUrl,
    anonKey: env.anonKey,
    orgA: { id: orgAId as string, slug: orgASlug },
    orgB: { id: orgBId as string, slug: orgBSlug },
    activeByRole,
    ownerA,
    ownerB,
    invitedAdminA,
    superuser,
    anonClient,
    adminAuth,
    _allUserIds: allUserIds,
    _allOrgIds: allOrgIds,
    _pool: pool,
  };
}

export async function destroyFixtures(fx: RlsFixtures): Promise<void> {
  try {
    // audit_events.actor_user_id has NO ON DELETE cascade/set-null by design
    // (it must survive an actor account being removed) -- so a hard delete
    // of these test auth.users rows will be blocked by that FK unless the
    // audit rows they authored (and any rows scoped to our test orgs) are
    // removed first. This is the same shape of statement Task 6's real
    // account-erasure flow will eventually need; here it is pure teardown.
    await fx._pool.query(
      `delete from public.audit_events
        where organisation_id = any($1::uuid[])
           or actor_user_id  = any($2::uuid[])`,
      [fx._allOrgIds, fx._allUserIds],
    );

    // Cascades organisation_memberships + organisation_subscriptions.
    await fx._pool.query(`delete from public.organisations where id = any($1::uuid[])`, [
      fx._allOrgIds,
    ]);
  } finally {
    // Cascades profiles + platform_admins (both ON DELETE CASCADE to
    // auth.users). Use the Admin API rather than a raw DELETE so auth's own
    // bookkeeping (sessions, identities, refresh tokens) is cleaned up the
    // supported way.
    for (const userId of fx._allUserIds) {
      await fx.adminAuth.auth.admin.deleteUser(userId).catch(() => {
        // Best-effort: a partially-failed run should not hide the original
        // test failure behind a teardown error for an already-gone user.
      });
    }
    await fx._pool.end();
  }
}
