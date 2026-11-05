// GoTrue's security notification emails, measured end to end against the
// local stack: the change is made the way an attacker holding a stolen access
// token would make it -- straight to GoTrue with the anon key, never through
// the app -- and the account holder's inbox (Mailpit) must receive the notice.
//
// Phase 10 Task 2, finding F3. Step-up is an application control; a password
// change (PUT /auth/v1/user) or an MFA factor enrolment/removal
// (/auth/v1/factors) made directly against GoTrue skips it, and the pinned
// toolchain offers no configurable GoTrue-side gate (SECURITY.md § 4, the F3
// residual). What is left is to make such a change VISIBLE: these three
// notifications ([auth.email.notification.*] in supabase/config.toml, and the
// same three switches on the hosted project, SECURITY.md § 15).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";
import { totpCode } from "@/tests/support/totp";

const PASSWORD = "Test-Passw0rd!-notify-1";

const SUBJECTS = {
  password: "Your GetSetPaid password was changed",
  enrolled: "A sign-in factor was added to your GetSetPaid account",
  unenrolled: "A sign-in factor was removed from your GetSetPaid account",
} as const;

describe("security notifications reach the account holder (F3)", () => {
  const { apiUrl, anonKey, serviceRoleKey, mailUrl } = getLocalSupabaseStatus();
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userIds: string[] = [];

  afterAll(async () => {
    for (const id of userIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  async function signedIn(): Promise<{ email: string; client: SupabaseClient }> {
    const email = `notify-${randomUUID().slice(0, 8)}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    userIds.push(data.user.id);
    const client = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError) throw new Error(`signIn: ${signInError.message}`);
    return { email, client };
  }

  /** Subjects of every message to `address`, polled until `subject` arrives or 10 s pass. */
  async function waitForSubject(address: string, subject: string): Promise<string[]> {
    if (!mailUrl) throw new Error("`supabase status` reported no local mail catcher (MAILPIT_URL).");
    let subjects: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await fetch(
        `${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
      );
      const body = (await res.json()) as { messages?: { Subject: string }[] };
      subjects = (body.messages ?? []).map((m) => m.Subject);
      if (subjects.includes(subject)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return subjects;
  }

  it("a password changed straight through GoTrue emails the holder", async () => {
    const { email, client } = await signedIn();
    const { error } = await client.auth.updateUser({ password: "Test-Passw0rd!-notify-2" });
    expect(error).toBeNull();
    expect(await waitForSubject(email, SUBJECTS.password)).toContain(SUBJECTS.password);
  });

  it("an MFA factor enrolled, then removed, straight through GoTrue emails the holder each time", async () => {
    const { email, client } = await signedIn();
    const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "attacker" });
    if (enrolled.error || !enrolled.data) throw new Error(`enroll: ${enrolled.error?.message}`);
    const verified = await client.auth.mfa.challengeAndVerify({
      factorId: enrolled.data.id,
      code: totpCode(enrolled.data.totp.secret),
    });
    expect(verified.error).toBeNull();
    expect(await waitForSubject(email, SUBJECTS.enrolled)).toContain(SUBJECTS.enrolled);

    const removed = await client.auth.mfa.unenroll({ factorId: enrolled.data.id });
    expect(removed.error).toBeNull();
    expect(await waitForSubject(email, SUBJECTS.unenrolled)).toContain(SUBJECTS.unenrolled);
  });
});
