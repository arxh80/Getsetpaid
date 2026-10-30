// Phase 10 Task 8 (G3, High): SECURITY.md § 5 promises password recovery at
// most 3 per hour per account. GoTrue has no per-account hook on recovery, so
// the enforcement point is its own per-user mail timer, [auth.email]
// max_frequency = "20m" (pinned by tests/unit/security/auth-config.test.ts).
// This measures that the running GoTrue obeys it, and what else the same
// timer throttles: the emailed sign-in link, the lockout's escape hatch.
//
// Calls GoTrue straight with the anon key, as an attacker would: the app has
// no recovery page. Sends two mails in all, against the project-wide
// email_sent budget.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";

const { apiUrl, anonKey, serviceRoleKey } = getLocalSupabaseStatus();
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stranger = createClient(apiUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const ids: string[] = [];

async function makeUser(label: string): Promise<string> {
  const email = `recovery-frequency-${label}-${randomUUID().slice(0, 8)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "Test-Passw0rd!-recovery-frequency",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  ids.push(data.user.id);
  return email;
}

let email: string;

beforeAll(async () => {
  email = await makeUser("a");
});

afterAll(async () => {
  for (const id of ids) await admin.auth.admin.deleteUser(id).catch(() => {});
});

describe("[auth.email] max_frequency bounds recovery per account (G3)", () => {
  it("the first recovery request is sent (positive control); a second inside the window is 429 over_email_send_rate_limit", async () => {
    const first = await stranger.auth.resetPasswordForEmail(email);
    expect(first.error, first.error?.message).toBeNull();

    const second = await stranger.auth.resetPasswordForEmail(email);
    expect(second.error?.status).toBe(429);
    expect(second.error?.code).toBe("over_email_send_rate_limit");
  });

  it("the same timer refuses an emailed sign-in link for that account (the G3 trade-off, Q260)", async () => {
    const link = await stranger.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    expect(link.error?.status).toBe(429);
    expect(link.error?.code).toBe("over_email_send_rate_limit");
  });

  it("another account is not affected: the timer is per account, not per caller", async () => {
    const other = await makeUser("b");
    const { error } = await stranger.auth.resetPasswordForEmail(other);
    expect(error, error?.message).toBeNull();
  });
});
