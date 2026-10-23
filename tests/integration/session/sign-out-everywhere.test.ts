// Phase 10 Task 22: "sign out everywhere" revokes the user's OTHER sessions.
//
// Drives the real signOutEverywhereAction against the real local GoTrue. Only
// the Next request seams are mocked: the cookie-bound server client is swapped
// for browser A's signed-in client, and redirect() records its target.
// Browser B is a second, independent sign-in of the same user; the claim is
// that B's refresh token stops working.
//
// MUTANT (2026-10-23): scope "global" -> "local" in the action turns the
// revocation case red (B's refresh succeeds). Recorded in the Task 22 ledger.
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

import { signOutEverywhereAction } from "@/lib/auth/actions";

const PASSWORD = "Test-Passw0rd!-sign-out-everywhere";
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

async function signOutEverywhereFrom(c: SupabaseClient) {
  current.client = c;
  current.redirectedTo = null;
  await expect(signOutEverywhereAction({})).rejects.toThrow("NEXT_REDIRECT");
  expect(current.redirectedTo).toBe("/login");
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  email = `sign-out-everywhere-${randomUUID().slice(0, 8)}@test.local`;
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

describe("signOutEverywhereAction (Task 22)", () => {
  it("revokes the other browser's refresh token, and this browser's", async () => {
    const a = await browser();
    const b = await browser();
    const aToken = (await a.auth.getSession()).data.session!.refresh_token;

    // Positive control: before the action, B's refresh token works.
    const before = await b.auth.refreshSession();
    expect(before.error).toBeNull();

    await signOutEverywhereFrom(a);

    const after = await b.auth.refreshSession();
    expect(after.error?.code).toBe("refresh_token_not_found");
    expect(after.data.session).toBeNull();

    // A's own session is gone too, server-side (the client forgot it already).
    const { error: aRefresh } = await a.auth.refreshSession({ refresh_token: aToken });
    expect(aRefresh?.code).toBe("refresh_token_not_found");
  });

  it("a fresh sign-in afterwards works: the account is signed out, not locked", async () => {
    const c = await browser();
    const { error } = await c.auth.refreshSession();
    expect(error).toBeNull();
  });
});
