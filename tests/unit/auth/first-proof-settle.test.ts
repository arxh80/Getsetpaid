import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

// ===========================================================================
// settleFirstProof's ORDER OF OPERATIONS and its FAILURE PATH (Phase 10 Task
// 20, fix round 1). The journeys are tests/e2e/first-proof-password.spec.ts;
// what a browser cannot show is what happens when a dependency FAILS after
// verifyOtp has already confirmed the account, and that the other sessions
// are signed out (no route lets a squatter hold a session before the proof).
// The three server-side clients are replaced by recorders.
// ===========================================================================

const calls: string[] = [];
const rpc = vi.fn();
const adminUpdate = vi.fn();
const cookieStore = { get: vi.fn(), set: vi.fn() };

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { updateUserById: adminUpdate } } }),
}));

const { settleFirstProof, unknowablePassword, passwordMayStay, confirmedJustNow, bindSignUp, bindingMatches } =
  await import("@/lib/auth/first-proof");

function session() {
  return {
    auth: {
      updateUser: vi.fn(async (attrs: { password?: string }) => {
        calls.push(`updateUser(${attrs.password ? "password" : "?"})`);
        return { data: {}, error: null };
      }),
      signOut: vi.fn(async ({ scope }: { scope: string }) => {
        calls.push(`signOut(${scope})`);
        return { error: null };
      }),
      refreshSession: vi.fn(async () => {
        calls.push("refreshSession");
        return { data: {}, error: null };
      }),
    },
  };
}
type Session = ReturnType<typeof session>;
const asClient = (s: Session) => s as unknown as Parameters<typeof settleFirstProof>[0];

const now = new Date().toISOString();
const squattedAccount = {
  id: "7f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  email_confirmed_at: now,
  identities: [{ provider: "email" }],
  app_metadata: {},
} as unknown as User;

beforeEach(() => {
  calls.length = 0;
  rpc.mockReset();
  adminUpdate.mockReset();
  cookieStore.get.mockReset();
  cookieStore.set.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    calls.push(fn);
    return { data: fn === "address_is_proved" ? false : null, error: null };
  });
  adminUpdate.mockImplementation(async () => {
    calls.push("admin.updateUserById");
    return { data: {}, error: null };
  });
});

describe("the first proof, when nothing fails", () => {
  it("replaces the password, signs out the OTHER sessions, marks, refreshes, then records -- in that order", async () => {
    const s = session();
    await expect(settleFirstProof(asClient(s), squattedAccount, "signup")).resolves.toBe("must-choose-password");
    expect(calls).toEqual([
      "address_is_proved",
      "updateUser(password)",
      "signOut(others)",
      "admin.updateUserById",
      "refreshSession",
      "record_address_first_proof",
    ]);
  });
});

describe("FAIL CLOSED: a failure after verifyOtp confirmed the account", () => {
  it("an address_is_proved error still replaces the password and signs out EVERY session", async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: "service key missing" } }));
    const s = session();
    await expect(settleFirstProof(asClient(s), squattedAccount, "signup")).rejects.toThrow(/address_is_proved/);
    expect(s.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(s.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("a thrown RPC (network) does the same", async () => {
    rpc.mockImplementation(async () => {
      throw new Error("fetch failed");
    });
    const s = session();
    await expect(settleFirstProof(asClient(s), squattedAccount, "signup")).rejects.toThrow(/fetch failed/);
    expect(s.auth.updateUser).toHaveBeenCalledTimes(1);
    expect(s.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("GoTrue refusing the replacement password still ends in a global sign-out", async () => {
    const s = session();
    s.auth.updateUser.mockImplementation(async () => {
      calls.push("updateUser(password)");
      return { data: {}, error: { message: "weak password" } } as never;
    });
    await expect(settleFirstProof(asClient(s), squattedAccount, "signup")).rejects.toThrow(/password replacement/);
    expect(s.auth.signOut).toHaveBeenLastCalledWith({ scope: "global" });
  });

  it("but not when this browser holds the binding: its password was the owner's", async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: "down" } }));
    const { createHash } = await import("node:crypto");
    const bound = {
      ...squattedAccount,
      app_metadata: { signup_binding_sha256: createHash("sha256").update("nonce").digest("hex") },
    } as unknown as User;
    cookieStore.get.mockReturnValue({ value: `${bound.id}.nonce` });
    const s = session();
    await expect(settleFirstProof(asClient(s), bound, "signup")).rejects.toThrow();
    expect(s.auth.updateUser).not.toHaveBeenCalled();
    expect(s.auth.signOut).not.toHaveBeenCalled();
  });

  it("and not for an account confirmed long ago: an outage must not destroy a password", async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: "down" } }));
    const old = { ...squattedAccount, email_confirmed_at: "2026-01-01T00:00:00Z" } as unknown as User;
    const s = session();
    await expect(settleFirstProof(asClient(s), old, "magiclink")).rejects.toThrow();
    expect(s.auth.updateUser).not.toHaveBeenCalled();
  });
});

describe("the pieces", () => {
  it("the replacement password has every character class, every time", () => {
    for (let i = 0; i < 200; i++) {
      const p = unknowablePassword();
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
      expect(p.length).toBeGreaterThanOrEqual(64);
    }
  });

  it("absent or empty identities prove nothing: the password may not stay", () => {
    expect(passwordMayStay({ ...squattedAccount, identities: undefined }, undefined)).toBe(false);
    expect(passwordMayStay({ ...squattedAccount, identities: [] }, undefined)).toBe(false);
    expect(
      passwordMayStay({ ...squattedAccount, identities: [{ provider: "google" }] as User["identities"] }, undefined),
    ).toBe(true);
    expect(passwordMayStay(squattedAccount, undefined)).toBe(false);
  });

  it("confirmedJustNow: fresh or absent is just now; an old stamp is not", () => {
    const t = Date.parse("2026-10-19T12:00:00Z");
    expect(confirmedJustNow({ email_confirmed_at: "2026-10-19T11:59:50Z" }, t)).toBe(true);
    expect(confirmedJustNow({ email_confirmed_at: undefined }, t)).toBe(true);
    expect(confirmedJustNow({ email_confirmed_at: "2026-10-19T11:00:00Z" }, t)).toBe(false);
  });
});

// Phase 10 Task 18, review finding 2: a binding is written only for a NEW
// account, so the cookie's presence must not depend on it -- otherwise its
// Set-Cookie header says which addresses already have an account.
describe("the sign-up binding cookie is no account oracle", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const set = () => cookieStore.set.mock.calls.at(-1) as [string, string, Record<string, unknown>];
  const shape = (value: string) => /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(value);

  beforeEach(() => {
    cookieStore.set.mockReset();
    adminUpdate.mockReset();
  });

  it("a new account: bound to it, and the stored hash matches the cookie (positive control)", async () => {
    adminUpdate.mockResolvedValue({ data: {}, error: null });
    await bindSignUp(USER);
    const [name, value] = set();
    expect(name).toBe("gsp_signup_binding");
    expect(value.startsWith(`${USER}.`)).toBe(true);
    const stored = (adminUpdate.mock.calls[0][1] as { app_metadata: Record<string, string> }).app_metadata;
    expect(bindingMatches(value, USER, Object.values(stored)[0])).toBe(true);
  });

  it("an existing address and a failed binding set the same cookie, which matches nobody", async () => {
    adminUpdate.mockResolvedValue({ data: {}, error: { message: "User not found" } });
    await bindSignUp(USER);
    const failed = set();
    await bindSignUp(null);
    const existing = set();
    adminUpdate.mockResolvedValue({ data: {}, error: null });
    await bindSignUp(USER);
    const bound = set();

    for (const [name, value, options] of [failed, existing]) {
      expect(name).toBe(bound[0]);
      expect(options).toEqual(bound[2]);
      expect(shape(value)).toBe(true);
      expect(value.startsWith(`${USER}.`)).toBe(false);
    }
    expect(shape(bound[1])).toBe(true);
  });
});
