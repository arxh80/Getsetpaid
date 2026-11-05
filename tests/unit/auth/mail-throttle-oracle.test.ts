import { beforeEach, describe, expect, it, vi } from "vitest";

// G3 (Phase 10 Task 8). [auth.email] max_frequency = "20m" makes GoTrue answer
// 429 over_email_send_rate_limit to a second emailed link or confirmation for
// the SAME account inside 20 minutes. Only an address with an account can get
// that answer, so showing it would tell a stranger which addresses are
// customers. magicLinkAction and signUpAction must answer it exactly as they
// answer success; the per-IP limit (over_request_rate_limit) says nothing
// about the address and is still shown.

const current = vi.hoisted(() => ({
  error: null as null | { status: number; code: string; message: string },
  redirectedTo: null as string | null,
  cookiesSet: [] as string[],
}));

// The sign-up binding cookie (lib/auth/first-proof.ts) is set on every
// sign-up outcome; recorded by name so the branches can be compared.
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (name: string) => current.cookiesSet.push(name), get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    current.redirectedTo = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async () => ({ data: {}, error: current.error }),
      signUp: async () => ({ data: { user: null }, error: current.error }),
      getClaims: async () => ({ data: null }),
    },
  }),
}));

import { magicLinkAction, signUpAction } from "@/lib/auth/actions";

const THROTTLED = { status: 429, code: "over_email_send_rate_limit", message: "For security purposes, you can only request this after 1200 seconds." };
const PER_IP = { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function run(action: () => Promise<unknown>): Promise<{ redirectedTo: string | null; result: unknown }> {
  current.redirectedTo = null;
  try {
    return { redirectedTo: null, result: await action() };
  } catch (e) {
    if ((e as Error).message !== "NEXT_REDIRECT") throw e;
    return { redirectedTo: current.redirectedTo, result: undefined };
  }
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  current.error = null;
  current.cookiesSet = [];
});

describe("magicLinkAction", () => {
  const ask = () => magicLinkAction({}, form({ email: "someone@example.test" }));

  it("POSITIVE CONTROL: a sent link lands on the sent page", async () => {
    expect((await run(ask)).redirectedTo).toBe("/magic-link/sent?email=someone%40example.test");
  });

  it("the per-account throttle lands on the same page, not on an error", async () => {
    current.error = THROTTLED;
    expect((await run(ask)).redirectedTo).toBe("/magic-link/sent?email=someone%40example.test");
  });

  it("the per-IP limit is still shown", async () => {
    current.error = PER_IP;
    const { redirectedTo, result } = await run(ask);
    expect(redirectedTo).toBeNull();
    expect(result).toEqual({ error: "Too many requests. Wait a minute and try again." });
  });
});

describe("signUpAction", () => {
  const ask = () =>
    signUpAction({}, form({ email: "someone@example.test", password: "Long-enough-passw0rd", fullName: "S" }));

  it("the per-account throttle lands on check-email, as an existing account does", async () => {
    current.error = THROTTLED;
    expect((await run(ask)).redirectedTo).toBe("/signup/check-email?email=someone%40example.test");
  });

  it("and sets the same cookie a successful sign-up sets (Task 18 finding 2: no Set-Cookie oracle)", async () => {
    current.error = THROTTLED;
    await run(ask);
    const refused = current.cookiesSet;
    current.cookiesSet = [];
    current.error = null;
    expect((await run(ask)).redirectedTo).toBe("/signup/check-email?email=someone%40example.test");
    expect(refused).toEqual(["gsp_signup_binding"]);
    expect(current.cookiesSet).toEqual(refused);
  });

  it("the per-IP limit is still shown", async () => {
    current.error = PER_IP;
    const { redirectedTo, result } = await run(ask);
    expect(redirectedTo).toBeNull();
    expect(result).toEqual({ error: "Too many attempts. Wait a minute and try again." });
  });
});
