// Integration coverage for the data/RPC layer lib/auth/mfa-gate.ts and
// lib/auth/mfa-actions.ts are built on -- real local Supabase stack, real
// auth.users, no mocking, same philosophy as tests/integration/rls/rls.test.ts.
//
// WHY THIS DOES NOT CALL requiresMfaEnrollment()/mfaGateBlocks() DIRECTLY.
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
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";

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

  describe("TOTP enroll -> verify lifecycle (hasVerifiedTotpFactor()'s dependency)", () => {
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

    it("a CORRECT TOTP code verifies the factor, which then appears in .totp -- proving hasVerifiedTotpFactor() would flip to true", async () => {
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
});

// ---------------------------------------------------------------------------
// RFC 4226 (HOTP) / RFC 6238 (TOTP), the standard algorithm every
// authenticator app implements -- reimplemented here (SHA-1, 30s step,
// 6 digits, GoTrue's defaults) purely so this test can generate a code that
// actually matches the secret enroll() just returned, without a new runtime
// dependency for one test file.
// ---------------------------------------------------------------------------
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secretBase32: string, at: number = Date.now()): string {
  const stepSeconds = 30;
  const digits = 6;
  const counter = Math.floor(at / 1000 / stepSeconds);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const key = base32Decode(secretBase32);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binCode % 10 ** digits).toString().padStart(digits, "0");
}
