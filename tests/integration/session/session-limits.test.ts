// Automated regression suite for the claim supabase/config.toml's
// [auth.sessions] comment makes: "timebox and inactivity_timeout invalidate
// the refresh token itself." Task 7 re-verified this against the running
// stack by hand before writing anything into middleware.ts or
// components/auth/idle-timeout.ts -- this file is that verification made
// permanent and automated, real local stack, no mocking, same philosophy as
// tests/integration/rls/rls.test.ts.
//
// WHY auth.sessions IS MUTATED THROUGH A DIRECT POSTGRES CONNECTION.
// `created_at`/`refreshed_at` on a session cannot be backdated through any
// client path (there is none, by design), and waiting 12h/30m of real time
// per assertion is not a viable test. The pg Pool + getLocalSupabaseStatus()
// pairing is the same one tests/integration/rls/support/fixtures.ts uses for
// exactly the same reason (granting platform_admins has no client path
// either).
//
// WHY THIS TALKS TO GoTrue's HTTP ENDPOINTS DIRECTLY (fetch), NOT THROUGH
// supabase-js's refreshSession()/getUser(): the auth-js client adds its own
// proactive-refresh and retry behaviour on top of the raw endpoints, which
// would obscure exactly what THIS test needs to see -- the raw HTTP status
// and error_code GoTrue's /auth/v1/token and /auth/v1/user return.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { getLocalSupabaseStatus } from "../rls/support/env";

const PASSWORD = "Test-Passw0rd!-session-limits";

describe("GoTrue session limits -- verifies supabase/config.toml [auth.sessions] and jwt_expiry", () => {
  const { apiUrl, anonKey, serviceRoleKey, dbUrl } = getLocalSupabaseStatus();
  const pool = new Pool({ connectionString: dbUrl });
  const adminAuth = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const runId = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  afterAll(async () => {
    for (const id of userIds) {
      await adminAuth.auth.admin.deleteUser(id).catch(() => {});
    }
    await pool.end();
  });

  interface FreshSession {
    userId: string;
    accessToken: string;
    refreshToken: string;
  }

  async function freshSession(label: string): Promise<FreshSession> {
    const email = `session-limits-${runId}-${label}@test.local`;
    const { data, error } = await adminAuth.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`Could not create ${email}: ${error?.message}`);
    }
    userIds.push(data.user.id);

    const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const body = await res.json();
    if (res.status !== 200) {
      throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body)}`);
    }
    return {
      userId: data.user.id,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
    };
  }

  async function refreshViaHttp(refreshToken: string) {
    const res = await fetch(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  it("REJECTS a refresh once the session is older than the 12h timebox", async () => {
    const session = await freshSession("timebox");
    await pool.query(
      `update auth.sessions set created_at = now() - interval '13 hours' where user_id = $1`,
      [session.userId],
    );

    const { status, body } = await refreshViaHttp(session.refreshToken);

    expect(status).toBe(400);
    expect(body.error_code).toBe("session_expired");
  });

  it("REJECTS a refresh more than 30 minutes after the session's LAST refresh (inactivity)", async () => {
    const session = await freshSession("inactivity");

    // The first refresh is exempt from the inactivity check (see the next
    // test) -- it exists here only to populate `refreshed_at`, which is what
    // the inactivity comparison actually reads.
    const first = await refreshViaHttp(session.refreshToken);
    expect(first.status).toBe(200);

    await pool.query(
      `update auth.sessions set refreshed_at = now() - interval '31 minutes' where user_id = $1`,
      [session.userId],
    );

    const { status, body } = await refreshViaHttp(first.body.refresh_token);

    expect(status).toBe(400);
    expect(body.error_code).toBe("session_expired");
    expect(body.msg).toMatch(/inactivity/i);
  });

  it("DOCUMENTS THE GAP: a session that has NEVER refreshed is exempt from the inactivity check, however long it has sat idle (bounded only by the 12h timebox)", async () => {
    const session = await freshSession("never-refreshed");
    await pool.query(
      `update auth.sessions set created_at = now() - interval '2 hours' where user_id = $1`,
      [session.userId],
    );

    const { status } = await refreshViaHttp(session.refreshToken);

    // Succeeds: refreshed_at was NULL, so GoTrue's inactivity comparison
    // never ran -- only the 12h timebox (comfortably not exceeded here)
    // applies to a session's first-ever refresh. This is why
    // components/auth/idle-timeout.tsx exists as genuine, independent
    // enforcement rather than pure UX: GoTrue alone would let a session like
    // this one survive up to ~2h (and up to just under 12h) of true
    // inactivity with nobody ever touching the app again.
    expect(status).toBe(200);
  });

  it("DOCUMENTS THE GAP: an already-issued access token keeps authenticating for its own remaining TTL even after its session is invalidated -- enforcement bites at REFRESH, not at every request", async () => {
    const session = await freshSession("live-token-after-invalidation");
    await pool.query(
      `update auth.sessions set created_at = now() - interval '13 hours' where user_id = $1`,
      [session.userId],
    );

    // The session is now unrefreshable...
    const refreshed = await refreshViaHttp(session.refreshToken);
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error_code).toBe("session_expired");

    // ...but the access token minted before invalidation is still a validly
    // signed, unexpired JWT, and GoTrue's /user endpoint verifies it locally
    // (signature + exp) rather than re-checking auth.sessions on every
    // request. This is exactly why supabase/config.toml's jwt_expiry was
    // lowered from 3600 to 900 as part of this task: it is the only lever
    // that bounds how long this gap can last.
    const res = await fetch(`${apiUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.status).toBe(200);
  });
});
