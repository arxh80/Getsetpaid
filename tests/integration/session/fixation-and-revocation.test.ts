// Phase 10 Task 7 (G16): the ordinary sign-out revokes this browser's refresh
// token server-side, not just its cookie.
//
// Drives the real signOutAction against the real local GoTrue, mocking only
// the Next seams (as sign-out-everywhere.test.ts does). signOutAction uses
// scope "local", which GoTrue's /logout?scope=local implements by deleting the
// CURRENT session and its refresh tokens; this test proves that rather than
// assuming it. The fixation half (a planted cookie is replaced at sign-in)
// needs a browser and lives in tests/e2e/session-fixation.spec.ts.
//
// MUTANT (2026-10-24): signOutAction skips the GoTrue call (cookie-only
// sign-out) -> the revocation case red. Recorded in the Task 7 ledger.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";

const current = vi.hoisted(() => ({ client: null as unknown, redirectedTo: null as string | null }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    current.redirectedTo = to;
    throw new Error("NEXT_REDIRECT");
  },
}));

import { signOutAction } from "@/lib/auth/actions";

const PASSWORD = "Test-Passw0rd!-sign-out-revocation";
const { apiUrl, anonKey, serviceRoleKey } = getLocalSupabaseStatus();
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let userId: string;
let email: string;

async function browser(): Promise<SupabaseClient> {
  const c = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  return c;
}

/** A refresh with this exact token, from a client that holds no session. */
async function refreshWith(refreshToken: string) {
  const c = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return c.auth.refreshSession({ refresh_token: refreshToken });
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  email = `sign-out-revocation-${randomUUID().slice(0, 8)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
});

describe("signOutAction revokes the signed-out refresh token (G16)", () => {
  it("a refresh with the captured token is refused after sign-out", async () => {
    const a = await browser();
    const b = await browser();
    const aToken = (await a.auth.getSession()).data.session!.refresh_token;
    const bToken = (await b.auth.getSession()).data.session!.refresh_token;

    current.client = a;
    current.redirectedTo = null;
    await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(current.redirectedTo).toBe("/login");

    const { data, error } = await refreshWith(aToken);
    expect(error?.status).toBe(400);
    expect(error?.code).toBe("refresh_token_not_found");
    expect(data.session).toBeNull();

    // POSITIVE CONTROL: a token captured the same way from the session that
    // was NOT signed out still refreshes, so the refusal above is about the
    // sign-out, not a malformed capture or a dead account. Scope "local"
    // leaves other devices signed in, by design.
    const other = await refreshWith(bToken);
    expect(other.error).toBeNull();
    expect(other.data.session?.user.id).toBe(userId);
  });
});
