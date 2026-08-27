// Integration coverage for the data/RPC layer lib/auth/mfa-gate.ts and
// lib/auth/mfa-actions.ts are built on -- real local Supabase stack, real
// auth.users, no mocking, same philosophy as tests/integration/rls/rls.test.ts.
//
// WHY THIS DOES NOT CALL requiresMfaEnrollment()/evaluateMfaGate() DIRECTLY.
// Those functions go through lib/supabase/server.ts's createClient(), which
// calls Next's cookies() -- only callable inside a real Next.js request
// (Server Component/Action/Route Handler), not from a Vitest process. This
// suite instead proves the THREE FACTS those functions compose, using a plain
// @supabase/supabase-js client signed in as each persona over real HTTP --
// the exact queries and RPC calls the gate performs, minus the
// Next-specific cookie plumbing that has no logic of its own to test:
//
//   1. An org role in MFA_REQUIRED_ROLES ('owner'/'admin'/'finance') is
//      visible in the caller's own organisation_memberships rows, and a
//      non-privileged role is not.
//   2. public.is_platform_admin() -- the wrapper added in
//      20260827180000_public_is_platform_admin.sql specifically because the
//      private-schema original is not reachable at all (see that migration's
//      header) -- returns true only for a platform_admins-allowlisted user.
//   3. The real TOTP enroll -> verify lifecycle: unverified factors are
//      invisible to listFactors().data.totp (only .all), a wrong code is
//      rejected, and a correct one verifies and then appears in .totp.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";
// The RFC 6238 generator this suite uses to produce a code the LIVE GoTrue
// verifier accepts. Moved to tests/support/totp.ts in the final fix wave when
// the RLS fixtures needed the same thing to raise privileged personas to
// aal2; the algorithm and its reasoning are unchanged, only its address.
import { totpCode } from "@/tests/support/totp";

const PASSWORD = "Test-Passw0rd!-mfa-lifecycle";

describe("MFA-gate data layer (lib/auth/mfa-gate.ts's real dependencies)", () => {
  const { apiUrl, anonKey, serviceRoleKey, dbUrl } = getLocalSupabaseStatus();
  const pool = new Pool({ connectionString: dbUrl });
  const adminAuth = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const runId = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const orgIds: string[] = [];

  afterAll(async () => {
    try {
      // audit_events.actor_user_id has NO ON DELETE cascade/set-null by
      // design (Task 4/5's fixtures.ts documents why: it must survive an
      // actor account being removed), so deleting these test auth.users rows
      // would otherwise be blocked by that FK -- create_organisation() writes
      // an audit row for the owner persona. Same cleanup shape as
      // tests/integration/rls/support/fixtures.ts's destroyFixtures().
      await pool.query(
        `delete from public.audit_events
          where organisation_id = any($1::uuid[])
             or actor_user_id  = any($2::uuid[])`,
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

  async function personaClient(email: string): Promise<{ userId: string; client: SupabaseClient }> {
    const { data, error } = await adminAuth.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`Could not create ${email}: ${error?.message}`);
    }
    userIds.push(data.user.id);

    const client = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: PASSWORD,
    });
    if (signInError) {
      throw new Error(`Could not sign in ${email}: ${signInError.message}`);
    }
    return { userId: data.user.id, client };
  }

  it("an org OWNER's own membership row carries the 'owner' role -- the exact query requiresMfaEnrollment() reads", async () => {
    const { userId, client } = await personaClient(`mfa-owner-${runId}@test.local`);

    const { data: orgId, error: orgErr } = await client.rpc("create_organisation", {
      p_name: `MFA Gate Org ${runId}`,
      p_slug: `mfa-gate-org-${runId}`,
    });
    if (orgErr) throw new Error(`create_organisation failed: ${orgErr.message}`);
    orgIds.push(orgId as string);

    const { data: memberships, error } = await client
      .from("organisation_memberships")
      .select("role, status")
      .eq("user_id", userId);

    expect(error).toBeNull();
    expect(memberships).toEqual([{ role: "owner", status: "active" }]);
  });

  it("a STANDARD USER with no memberships sees none -- requiresMfaEnrollment()'s role check is false for them", async () => {
    const { userId, client } = await personaClient(`mfa-nobody-${runId}@test.local`);

    const { data: memberships, error } = await client
      .from("organisation_memberships")
      .select("role")
      .eq("user_id", userId);

    expect(error).toBeNull();
    expect(memberships).toEqual([]);
  });

  it("is_platform_admin() is false for an ordinary authenticated user", async () => {
    const { client } = await personaClient(`mfa-ordinary-${runId}@test.local`);
    const { data, error } = await client.rpc("is_platform_admin");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("is_platform_admin() is true ONLY once the user is on the platform_admins allowlist (DBA-only, no client path -- same as has_platform_permission)", async () => {
    const { userId, client } = await personaClient(`mfa-superuser-${runId}@test.local`);

    const before = await client.rpc("is_platform_admin");
    expect(before.data).toBe(false);

    await pool.query(`insert into public.platform_admins (user_id) values ($1)`, [
      userId,
    ]);

    const after = await client.rpc("is_platform_admin");
    expect(after.error).toBeNull();
    expect(after.data).toBe(true);
  });

  describe("TOTP enroll -> verify lifecycle (verifiedTotpFactorId()'s dependency)", () => {
    it("an unverified factor is invisible to listFactors().data.totp but present in .all", async () => {
      const { client } = await personaClient(`mfa-enroll-${runId}@test.local`);

      const before = await client.auth.mfa.listFactors();
      expect(before.data?.totp).toEqual([]);

      const enrolled = await client.auth.mfa.enroll({
        factorType: "totp",
        issuer: "GetSetPaid",
      });
      expect(enrolled.error).toBeNull();
      expect(enrolled.data?.totp.secret).toBeTruthy();

      const after = await client.auth.mfa.listFactors();
      expect(after.data?.totp).toEqual([]);
      expect(
        after.data?.all.some(
          (f) => f.id === enrolled.data!.id && f.status === "unverified",
        ),
      ).toBe(true);
    });

    it("a WRONG code is rejected and the factor stays unverified", async () => {
      const { client } = await personaClient(`mfa-wrongcode-${runId}@test.local`);
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error || !enrolled.data) throw new Error("enroll failed");

      const { error } = await client.auth.mfa.challengeAndVerify({
        factorId: enrolled.data.id,
        code: "000000",
      });
      expect(error).not.toBeNull();

      const after = await client.auth.mfa.listFactors();
      expect(after.data?.totp).toEqual([]);
    });

    it("a CORRECT TOTP code verifies the factor, which then appears in .totp -- proving verifiedTotpFactorId() would flip to non-null", async () => {
      const { client } = await personaClient(`mfa-correctcode-${runId}@test.local`);
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error || !enrolled.data) throw new Error("enroll failed");

      const code = totpCode(enrolled.data.totp.secret);
      const { data, error } = await client.auth.mfa.challengeAndVerify({
        factorId: enrolled.data.id,
        code,
      });
      expect(error).toBeNull();
      expect(data?.access_token).toBeTruthy();

      const after = await client.auth.mfa.listFactors();
      expect(after.data?.totp.some((f) => f.id === enrolled.data!.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Fix round 1, Important 2: evaluateMfaGate()'s "challenge" outcome.
  //
  // Supabase does not force an MFA challenge at sign-in on its own -- a
  // password sign-in for a user who enrolled TOTP weeks ago still comes back
  // aal1. evaluateMfaGate() detects this via getAuthenticatorAssuranceLevel()
  // and this suite proves the exact signal it reads, end to end: enroll and
  // verify a factor (aal2, this session), sign in FRESH on a brand new
  // client (a real second sign-in, the way a returning user's browser
  // would), and confirm THAT session reports aal1/aal2 -- currentLevel below
  // nextLevel, meaning "a verified factor exists, this session hasn't
  // presented it" -- which is precisely the state evaluateMfaGate() maps to
  // `{ kind: "challenge" }` rather than `{ kind: "enroll" }` or
  // `{ kind: "pass" }`.
  // -------------------------------------------------------------------------
  describe("getAuthenticatorAssuranceLevel() -- the signal evaluateMfaGate()'s challenge outcome reads", () => {
    it("a session with NO verified factor reports aal1/aal1 (nextLevel === currentLevel, i.e. no upgrade possible -> 'enroll')", async () => {
      const { client } = await personaClient(`mfa-aal-none-${runId}@test.local`);
      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(error).toBeNull();
      expect(data?.currentLevel).toBe("aal1");
      expect(data?.nextLevel).toBe("aal1");
    });

    it("the SAME session that just verified a factor reports aal2/aal2 ('pass')", async () => {
      const { client } = await personaClient(`mfa-aal-same-session-${runId}@test.local`);
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error || !enrolled.data) throw new Error("enroll failed");
      const code = totpCode(enrolled.data.totp.secret);
      const verify = await client.auth.mfa.challengeAndVerify({
        factorId: enrolled.data.id,
        code,
      });
      expect(verify.error).toBeNull();

      const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(error).toBeNull();
      expect(data?.currentLevel).toBe("aal2");
      expect(data?.nextLevel).toBe("aal2");
    });

    it("a FRESH sign-in after enrollment reports aal1/aal2 -- the exact 'challenge, not enroll or pass' state evaluateMfaGate() must detect", async () => {
      const email = `mfa-aal-fresh-signin-${runId}@test.local`;
      const { client: firstSession } = await personaClient(email);
      const enrolled = await firstSession.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error || !enrolled.data) throw new Error("enroll failed");
      const code = totpCode(enrolled.data.totp.secret);
      const verify = await firstSession.auth.mfa.challengeAndVerify({
        factorId: enrolled.data.id,
        code,
      });
      expect(verify.error).toBeNull();

      // A brand new client, signing in fresh -- the same shape of session a
      // returning user's browser establishes days later. Deliberately NOT
      // the same `client` object: reusing it would keep the aal2 amr entry
      // from the verify above, which is exactly the scenario a real
      // password-only sign-in does NOT reproduce.
      const returning = createClient(apiUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInError } = await returning.auth.signInWithPassword({
        email,
        password: PASSWORD,
      });
      expect(signInError).toBeNull();

      const { data, error } = await returning.auth.mfa.getAuthenticatorAssuranceLevel();
      expect(error).toBeNull();
      expect(data?.currentLevel).toBe("aal1");
      expect(data?.nextLevel).toBe("aal2");

      // And the factor IS still listed as verified on this fresh session --
      // mfaChallengeAction resolves factorId this same way, server-side,
      // rather than trusting a client-supplied id.
      const factors = await returning.auth.mfa.listFactors();
      expect(factors.data?.totp[0]?.id).toBe(enrolled.data!.id);
    });

    it("REGRESSION EVIDENCE for lib/auth/step-up-actions.ts (Important 4): challengeAndVerify() upgrades the SAME session rather than minting a new one", async () => {
      const { userId, client } = await personaClient(`mfa-session-stability-${runId}@test.local`);
      const enrolled = await client.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error || !enrolled.data) throw new Error("enroll failed");

      const { data: sessionBefore } = await client.auth.getSession();
      const sessionIdBefore = decodeSessionId(sessionBefore!.session!.access_token);

      const code = totpCode(enrolled.data.totp.secret);
      const verify = await client.auth.mfa.challengeAndVerify({
        factorId: enrolled.data.id,
        code,
      });
      expect(verify.error).toBeNull();

      const sessionIdAfter = decodeSessionId(verify.data!.access_token);
      expect(sessionIdAfter).toBe(sessionIdBefore);

      const row = await pool.query(
        `select aal, user_id from auth.sessions where id = $1`,
        [sessionIdAfter],
      );
      expect(row.rows[0].aal).toBe("aal2");
      // The row's own user_id confirms this is genuinely this persona's
      // session, not a coincidental id collision.
      expect(row.rows[0].user_id).toBe(userId);
    });
  });
});

/**
 * Decodes an access token's `session_id` claim without verifying the
 * signature -- fine here, since these are tokens THIS test just received
 * directly from the local GoTrue instance over HTTPS/loopback, not
 * untrusted input. Used only to prove challengeAndVerify() upgrades the
 * EXISTING session rather than minting a new one (fix round 1, Important 4's
 * evidence).
 */
function decodeSessionId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  const claims = JSON.parse(json) as { session_id: string };
  return claims.session_id;
}
