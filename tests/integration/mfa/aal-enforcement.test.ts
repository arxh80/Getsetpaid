// The MFA requirement, enforced by the DATABASE, exercised over real HTTP.
//
// ===========================================================================
// WHAT THIS SUITE IS FOR
// ===========================================================================
// Before the final fix wave, CLAUDE.md § Session security's "MFA is required
// for: Platform Superuser, Organisation Owner, Admin, Finance" lived in
// exactly one place: evaluateMfaGate(), called once, from
// app/(app)/layout.tsx, where it swaps what <main> renders. No Server Action
// called it and no RLS policy looked at the JWT's `aal` claim. So a stolen
// Owner password bought an aal1 session that could POST straight at
// /rest/v1/organisation_memberships with the public anon key -- which ships in
// every browser bundle by design -- and mint itself an admin foothold. That
// request never touches the Next.js app, so no application-layer guard is on
// its path.
//
// 20260827210000_mfa_aal_permission_gate.sql closes it in the permission
// engine. This suite is that fix, asserted the way the attack would actually
// be made: @supabase/supabase-js against the live local stack, signed in with
// a real password grant, no mocking anywhere.
//
// It is a NEW FILE rather than additions to tests/integration/rls/rls.test.ts
// on purpose -- that suite has been frozen since Task 5 and is left
// byte-identical, so a reviewer can diff it and see nothing.
//
// ===========================================================================
// THE TWO HALVES MATTER EQUALLY
// ===========================================================================
// A gate that refuses everything passes every "must be denied" test in here
// and ships a product nobody can use. The lockout half is asserted just as
// hard as the enforcement half: an Owner who has not enrolled yet MUST still
// be able to read enough to render the app and reach the enrolment screen,
// because there is no other way for them to ever get a factor. This phase
// already shipped one lockout bug of exactly that shape (Task 7's
// idle-timeout) and it was invisible to build, lint and tsc.
//
// ===========================================================================
// WHY THIS IS ONE SESSION WALKING aal1 -> aal2, AND NOT TWO SESSIONS COMPARED
// ===========================================================================
// The first draft held two live sessions for the same owner -- one left at
// aal1, one taken to aal2 -- so every pair of assertions could differ in
// nothing but assurance level. That does not work, and the reason is worth
// recording: VERIFIED against this stack, verifying a user's FIRST TOTP factor
// REVOKES that user's other sessions. The aal1 client started returning
// "invalid claim: missing sub" and 42501 on reads it had made successfully
// moments earlier. Good behaviour by GoTrue, fatal to that fixture design.
//
// So the suite is ordered as a journey instead, which is also what a real
// Owner actually does: sign in, be refused, enrol, be allowed. The describes
// below run in declaration order (vitest default, and vitest.config.ts sets
// fileParallelism:false), and the ESCAPE ROUTE block is where the session
// crosses over. Nothing before it may assume aal2 and nothing after it may
// assume aal1.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { totpCode } from "@/tests/support/totp";

const PASSWORD = "Test-Passw0rd!-aal";

describe("MFA enforcement in the permission engine (aal2 required for privileged roles)", () => {
  const { apiUrl, anonKey, serviceRoleKey, dbUrl } = getLocalSupabaseStatus();
  const pool = new Pool({ connectionString: dbUrl });
  const adminAuth = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const runId = randomUUID().slice(0, 8);

  const userIds: string[] = [];
  const orgIds: string[] = [];

  /** The owner's session. Starts at aal1; the ESCAPE ROUTE block elevates it. */
  let owner: SupabaseClient;
  let ownerId: string;
  /** The platform superuser, at aal1 throughout -- never enrols. */
  let superAal1: SupabaseClient;
  let orgId: string;
  let orgName: string;
  let outsiderId: string;

  async function makeUser(key: string): Promise<{ id: string; email: string }> {
    const email = `aal-${runId}-${key}@test.local`;
    const { data, error } = await adminAuth.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
    userIds.push(data.user.id);
    return { id: data.user.id, email };
  }

  async function signIn(email: string): Promise<SupabaseClient> {
    const client = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`signIn ${email}: ${error.message}`);
    return client;
  }

  beforeAll(async () => {
    const ownerUser = await makeUser("owner");
    const outsider = await makeUser("outsider");
    const superuser = await makeUser("superuser");
    ownerId = ownerUser.id;
    outsiderId = outsider.id;

    owner = await signIn(ownerUser.email);
    superAal1 = await signIn(superuser.email);

    // create_organisation() is SECURITY DEFINER and does not consult
    // has_permission(), so a brand-new user at aal1 can still create their
    // first workspace. Deliberate, asserted below, and the reason this fixture
    // can be built at all.
    orgName = `AAL Org ${runId}`;
    const { data: org, error } = await owner.rpc("create_organisation", {
      p_name: orgName,
      p_slug: `aal-org-${runId}`,
    });
    if (error || !org) throw new Error(`create_organisation: ${error?.message}`);
    orgId = org as string;
    orgIds.push(orgId);

    await pool.query(`insert into public.platform_admins (user_id) values ($1)`, [
      superuser.id,
    ]);
  });

  afterAll(async () => {
    try {
      await pool.query(
        `delete from public.audit_events
          where organisation_id = any($1::uuid[]) or actor_user_id = any($2::uuid[])`,
        [orgIds, userIds],
      );
      await pool.query(`delete from public.organisations where id = any($1::uuid[])`, [
        orgIds,
      ]);
    } finally {
      for (const id of userIds) {
        await adminAuth.auth.admin.deleteUser(id).catch(() => {});
      }
      await pool.end();
    }
  });

  // =========================================================================
  describe("1. the starting state really is what this suite claims it is", () => {
    // Without these, everything below could be passing for the wrong reason --
    // e.g. against a session that was already aal2, where the later positive
    // controls would hold trivially and the denials would have to fail.
    it("a plain password sign-in yields aal1 — no MFA challenge is forced at sign-in", async () => {
      const { data } = await owner.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(data?.currentLevel).toBe("aal1");
    });

    it("this caller genuinely IS an active owner of the organisation", async () => {
      // So every denial below is about assurance level and nothing else --
      // not a missing membership, not the wrong status, not the wrong org.
      const { data } = await owner
        .from("organisation_memberships")
        .select("role, status")
        .eq("organisation_id", orgId);
      expect(data).toEqual([{ role: "owner", status: "active" }]);
    });
  });

  // =========================================================================
  describe("2. ENFORCEMENT: an aal1 owner holds no privileged permission", () => {
    it("has_permission('manage_members') is FALSE despite a real owner membership", async () => {
      const { data, error } = await owner.rpc("has_permission", {
        p_org_id: orgId,
        p_permission: "manage_members",
      });
      expect(error).toBeNull();
      expect(data).toBe(false);
    });

    it("has_permission('manage_organisation') is FALSE too", async () => {
      const { data } = await owner.rpc("has_permission", {
        p_org_id: orgId,
        p_permission: "manage_organisation",
      });
      expect(data).toBe(false);
    });

    it("THE EXPLOIT: an aal1 owner cannot invite an admin (42501)", async () => {
      // The exact request an attacker holding a stolen password would make,
      // made the way they would make it: supabase-js, anon key, real session
      // token, straight at PostgREST. Its positive control is in block 4 --
      // the identical statement from the identical human succeeds once the
      // factor has been presented.
      const { error } = await owner.from("organisation_memberships").insert({
        organisation_id: orgId,
        user_id: outsiderId,
        role: "admin",
        status: "invited",
      });
      expect(error?.code).toBe("42501");
    });

    it("an aal1 owner cannot rename or soft-delete the organisation", async () => {
      // 0 rows, not 42501: the UPDATE policy fails in USING, so the row is
      // filtered out before the write is attempted. A different mechanism from
      // the INSERT above and asserted as such -- getting these two the wrong
      // way round is the classic way an RLS suite passes green while the
      // policy is wrong.
      const { data, error } = await owner
        .from("organisations")
        .update({ name: "Pwned", deleted_at: new Date().toISOString() })
        .eq("id", orgId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("OUTCOME: the organisation really is untouched, not merely un-updated", async () => {
      // Statement-level rejection is not the same claim as "the world is
      // unchanged" -- the same discipline rls_foundation.sql's C22-C25 apply.
      const { data } = await owner
        .from("organisations")
        .select("name, deleted_at")
        .eq("id", orgId)
        .single();
      expect(data?.name).toBe(orgName);
      expect(data?.deleted_at).toBeNull();
    });
  });

  // =========================================================================
  describe("3. LOCKOUT GUARD: the un-enrolled owner can still reach enrolment", () => {
    // If any of these ever fails, the aal requirement has been widened onto a
    // read path and EVERY privileged user is permanently locked out with no
    // way back in -- they cannot enrol, because they cannot load the app far
    // enough to be offered the enrolment screen.
    it("reads their own membership rows (the workspace switcher and the hub)", async () => {
      const { data, error } = await owner
        .from("organisation_memberships")
        .select("id, role, status");
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });

    it("reads their own profile row", async () => {
      const { data, error } = await owner.from("profiles").select("id").eq("id", ownerId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });

    it("reads their own organisation", async () => {
      const { data, error } = await owner
        .from("organisations")
        .select("id, slug")
        .eq("id", orgId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });

    it("reads the roles catalogue the enrolment and members screens render from", async () => {
      const { data, error } = await owner.from("roles").select("key");
      expect(error).toBeNull();
      expect(data?.length).toBe(9);
    });

    it("can still create a NEW organisation at aal1 (create_organisation is DEFINER)", async () => {
      // The chicken-and-egg that would otherwise make signup impossible: a
      // brand-new user holds no membership anywhere, so nothing has told them
      // to enrol yet, and the org they are about to create is the very thing
      // that makes them an Owner.
      const { data, error } = await owner.rpc("create_organisation", {
        p_name: `AAL Second ${runId}`,
        p_slug: `aal-second-${runId}`,
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
      orgIds.push(data as string);
    });
  });

  // =========================================================================
  describe("4. ESCAPE ROUTE: enrolling turns the gate into a door", () => {
    // Everything after this point runs at aal2. This block is the crossover.
    it("the aal1 session can enrol a factor and complete a challenge", async () => {
      const enrolled = await owner.auth.mfa.enroll({ factorType: "totp" });
      expect(enrolled.error).toBeNull();

      // A real RFC 6238 code against the live GoTrue verifier -- not a mock.
      // A suite that stubbed this would prove nothing about the control.
      const verified = await owner.auth.mfa.challengeAndVerify({
        factorId: enrolled.data!.id,
        code: totpCode(enrolled.data!.totp.secret),
      });
      expect(verified.error).toBeNull();

      const { data: aal } = await owner.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(aal?.currentLevel).toBe("aal2");
    });

    it("POSITIVE CONTROL: the permission refused in block 2 is now granted", async () => {
      const { data } = await owner.rpc("has_permission", {
        p_org_id: orgId,
        p_permission: "manage_members",
      });
      expect(data).toBe(true);
    });

    it("POSITIVE CONTROL: the exact INSERT refused in block 2 now succeeds", async () => {
      // This is what makes block 2's 42501 meaningful: same user, same role,
      // same membership row, same statement. Only `aal` changed.
      const { error } = await owner.from("organisation_memberships").insert({
        organisation_id: orgId,
        user_id: outsiderId,
        role: "admin",
        status: "invited",
      });
      expect(error).toBeNull();
    });

    it("POSITIVE CONTROL: the organisation UPDATE refused in block 2 now reaches the row", async () => {
      const { data, error } = await owner
        .from("organisations")
        .update({ name: `${orgName} renamed` })
        .eq("id", orgId)
        .select();
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });
  });

  // =========================================================================
  describe("5. the platform superuser: identity is not aal-gated, permission is", () => {
    // The inversion trap. lib/auth/mfa-gate.ts asks is_platform_admin() to
    // decide whether the MFA requirement APPLIES, and necessarily asks it from
    // an aal1 session -- a superuser who has not presented a factor is exactly
    // the caller the gate exists to stop. Had is_platform_admin() inherited
    // the aal2 requirement it would answer "not a superuser", the gate would
    // conclude MFA does not apply, and the superuser would be waved through
    // WITHOUT MFA: the check inverted into the hole it was added to close.
    it("is_platform_admin() is TRUE at aal1 — the MFA gate depends on this", async () => {
      const { data, error } = await superAal1.rpc("is_platform_admin");
      expect(error).toBeNull();
      expect(data).toBe(true);
    });

    it("...but the aal1 superuser reads 0 audit_events", async () => {
      const { data, error } = await superAal1.from("audit_events").select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("...and cannot write an entitlement row", async () => {
      const { error } = await superAal1.from("organisation_subscriptions").insert({
        organisation_id: orgId,
        plan_id: "pro",
        billing_cycle: "monthly",
        seat_count: 1,
        status: "active",
        current_period_end: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(error?.code).toBe("42501");
    });
  });
});
