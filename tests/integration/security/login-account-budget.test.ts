// Phase 10 Task 8 (G4, High): the per-account password budget the app spends
// BEFORE GoTrue, for production without the password-verification hook (F8).
//
// Drives the real signInAction against the real local GoTrue and the real
// public.meter_password_sign_in (20261108002000), mocking only the Next seams
// (as sign-out-everywhere.test.ts does). GoTrue's token requests are counted
// at the client's fetch, so "refused BEFORE GoTrue was called" is measured,
// not inferred from the message (which is the same either way, on purpose).
//
// Locally the hook is ALSO on, and would refuse a sixth wrong password by
// itself. That is why the assertion is on GoTrue's request count: with the
// app-side check removed the sixth attempt still fails, but it reaches
// GoTrue. MUTANT (Task 8): signInAction without mayTryPassword() -> red.
// MUTANT (Task 8 review): count on failure after GoTrue instead of on the
// attempt before it -> the simultaneous burst below reaches GoTrue 8 times, red.
//
// Does NOT drive GoTrue's per-IP limit (30 per 5 minutes) anywhere near its
// boundary: this file sends at most seventeen password grants.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getLocalSupabaseStatus } from "../rls/support/env";

const current = vi.hoisted(() => ({
  client: null as unknown,
  redirectedTo: null as string | null,
  tokenRequests: 0,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => current.client }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    current.redirectedTo = to;
    throw new Error("NEXT_REDIRECT");
  },
}));

import { signInAction } from "@/lib/auth/actions";

const PASSWORD = "Test-Passw0rd!-login-budget";
const WRONG = "Wrong-Passw0rd!-login-budget";
const BAD_SIGN_IN = "That email and password don't match. Check both and try again.";
const WINDOW_SECONDS = 900;

const { apiUrl, anonKey, serviceRoleKey, dbUrl } = getLocalSupabaseStatus();
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const pool = new Pool({ connectionString: dbUrl });
const run = randomUUID().slice(0, 8);
const users: { id: string; email: string }[] = [];
const ghost = `login-budget-ghost-${run}@test.local`;
const ghostSubject = createHash("sha256").update(ghost).digest("hex").slice(0, 32)
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

/** A fresh browser-like client whose GoTrue password grants are counted. */
function countingClient(): SupabaseClient {
  return createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("/auth/v1/token")) {
          current.tokenRequests += 1;
        }
        return fetch(input, init);
      },
    },
  });
}

async function signIn(email: string, password: string) {
  current.client = countingClient();
  current.redirectedTo = null;
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  try {
    return await signInAction({}, form);
  } catch (e) {
    if ((e as Error).message !== "NEXT_REDIRECT") throw e;
    return { redirectedTo: current.redirectedTo };
  }
}

async function makeUser(label: string) {
  const email = `login-budget-${label}-${run}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  users.push({ id: data.user.id, email });
  return { id: data.user.id, email };
}

async function counter(subject: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select coalesce(sum(request_count), 0)::int as n from public.rate_limit_counters
      where category = 'login_email' and subject_id = $1`,
    [subject],
  );
  return rows[0].n;
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = apiUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
  // Fixed 15-minute windows are epoch-aligned: never start a burst that could
  // straddle a boundary and split across two counters.
  const remaining = WINDOW_SECONDS - ((Date.now() / 1000) % WINDOW_SECONDS);
  if (remaining < 90) await new Promise((r) => setTimeout(r, Math.ceil(remaining * 1000) + 500));
}, 120_000);

afterAll(async () => {
  const subjects = [...users.map((u) => u.id), ghostSubject];
  await pool.query(`delete from public.rate_limit_counters where subject_id = any($1::uuid[])`, [subjects]);
  await pool.query(`delete from public.incident_alerts where details->>'subject_id' = any($1::text[])`, [subjects]);
  for (const u of users) await admin.auth.admin.deleteUser(u.id).catch(() => {});
  await pool.end();
});

describe("signInAction's per-account budget (G4 fallback)", () => {
  it("POSITIVE CONTROL: a correct password on the first try signs in, through GoTrue, and leaves no count", async () => {
    const u = await makeUser("ok");
    current.tokenRequests = 0;
    expect(await signIn(u.email, PASSWORD)).toEqual({ redirectedTo: "/" });
    expect(current.tokenRequests).toBe(1);
    expect(await counter(u.id)).toBe(0);
  });

  it("five wrong passwords reach GoTrue; the sixth attempt, and then the right password, do not", async () => {
    const u = await makeUser("locked");
    current.tokenRequests = 0;
    for (let i = 1; i <= 5; i++) {
      expect(await signIn(u.email, WRONG)).toEqual({ error: BAD_SIGN_IN });
      expect(current.tokenRequests, `attempt ${i} did not reach GoTrue`).toBe(i);
    }
    expect(await counter(u.id), "the budget is keyed on the account's id").toBe(5);

    expect(await signIn(u.email, WRONG)).toEqual({ error: BAD_SIGN_IN });
    expect(current.tokenRequests, "the sixth attempt was sent to GoTrue").toBe(5);
    // A lockout that lifts for the right password is no lockout.
    expect(await signIn(u.email, PASSWORD)).toEqual({ error: BAD_SIGN_IN });
    expect(current.tokenRequests).toBe(5);

    // The crossing filed ONE login alert naming the account, which is what
    // the account holder's notice (Q114) joins on.
    const { rows } = await pool.query<{ category: string }>(
      `select details->>'category' as category from public.incident_alerts
        where alert_type = 'repeated_login_failures' and details->>'subject_id' = $1`,
      [u.id],
    );
    expect(rows).toEqual([{ category: "login_email" }]);
  });

  it("a different case and padding of the address is the same budget", async () => {
    const u = users.find((x) => x.email.includes("-locked-"))!;
    current.tokenRequests = 0;
    expect(await signIn(`  ${u.email.toUpperCase()} `, PASSWORD)).toEqual({ error: BAD_SIGN_IN });
    expect(current.tokenRequests).toBe(0);
  });

  it("an address with no account is refused the same way, so a refusal says nothing about existence", async () => {
    current.tokenRequests = 0;
    for (let i = 1; i <= 5; i++) expect(await signIn(ghost, WRONG)).toEqual({ error: BAD_SIGN_IN });
    expect(current.tokenRequests).toBe(5);
    expect(await signIn(ghost, WRONG)).toEqual({ error: BAD_SIGN_IN });
    expect(current.tokenRequests).toBe(5);
    expect(await counter(ghostSubject), "keyed on the SHA-256 of the normalised address").toBe(6);
  });

  it("a burst of eight simultaneous guesses: only five reach GoTrue", async () => {
    const u = await makeUser("burst");
    current.tokenRequests = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => signIn(u.email, WRONG)));
    expect(results.every((r) => "error" in r && r.error === BAD_SIGN_IN)).toBe(true);
    expect(current.tokenRequests, "the budget is checked before any failure lands").toBe(5);
    expect(await counter(u.id)).toBe(8);
  });

  it("a browser cannot spend or clear anybody's budget over PostgREST, signed in or not", async () => {
    const u = await makeUser("direct");
    // POSITIVE CONTROL: the app's server (service role) can.
    const server = await admin.rpc("meter_password_sign_in", { p_email: u.email, p_outcome: "attempt" });
    expect(server.error, server.error?.message).toBeNull();
    expect(await counter(u.id)).toBe(1);

    const anon = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const bare = await anon.rpc("meter_password_sign_in", { p_email: u.email, p_outcome: "attempt" });
    expect(bare.error?.code).toBe("42501");

    const session = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: signInError } = await session.auth.signInWithPassword({ email: users[0].email, password: PASSWORD });
    expect(signInError).toBeNull();
    for (const outcome of ["attempt", "succeeded"]) {
      const { error } = await session.rpc("meter_password_sign_in", { p_email: u.email, p_outcome: outcome });
      expect(error?.code, `a session could call ${outcome}`).toBe("42501");
    }
    expect(await counter(u.id), "a refused call changed the count").toBe(1);
  });
});
