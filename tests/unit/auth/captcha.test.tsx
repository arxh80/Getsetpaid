import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Turnstile on the auth forms: every captcha-protected GoTrue call carries the
// token the widget posts, a refused check says so (before the address is looked
// up, so it is no account oracle), and the widget exists only with a site key.

const current = vi.hoisted(() => ({
  calls: [] as { method: string; args: Record<string, unknown> }[],
  error: null as null | { status: number; code: string; message: string },
  redirectedTo: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: () => {}, get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    current.redirectedTo = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/auth/login-budget", () => ({
  mayTryPassword: async () => true,
  recordPasswordOutcome: async () => {},
}));
vi.mock("@/lib/auth/index", () => ({
  getCurrentUser: async () => ({ id: "u1", email: "someone@example.test" }),
}));
vi.mock("@/lib/supabase/server", () => {
  const call = (method: string) => async (args: Record<string, unknown>) => {
    current.calls.push({ method, args });
    return { data: { user: null }, error: current.error };
  };
  return {
    createClient: async () => ({
      auth: {
        signUp: call("signUp"),
        signInWithPassword: call("signInWithPassword"),
        signInWithOtp: call("signInWithOtp"),
        getClaims: async () => ({ data: null }),
      },
    }),
  };
});

import { magicLinkAction, signInAction, signUpAction } from "@/lib/auth/actions";
import { reauthenticateAction } from "@/lib/auth/step-up-actions";
import { CAPTCHA_FAILED, CAPTCHA_FIELD } from "@/lib/auth/captcha";
import { Turnstile } from "@/components/auth/turnstile";

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const REFUSED = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed" };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function run(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action();
  } catch (e) {
    if ((e as Error).message !== "NEXT_REDIRECT") throw e;
    return undefined;
  }
}

const EMAIL = "someone@example.test";
const TYPED = "Long-enough-passw0rd";
const ACTIONS = [
  ["signUpAction", "signUp", () => signUpAction({}, form({ email: EMAIL, password: TYPED, [CAPTCHA_FIELD]: TOKEN }))],
  ["signInAction", "signInWithPassword", () => signInAction({}, form({ email: EMAIL, password: TYPED, [CAPTCHA_FIELD]: TOKEN }))],
  ["magicLinkAction", "signInWithOtp", () => magicLinkAction({}, form({ email: EMAIL, [CAPTCHA_FIELD]: TOKEN }))],
  ["reauthenticateAction (password)", "signInWithPassword", () => reauthenticateAction({}, form({ password: TYPED, [CAPTCHA_FIELD]: TOKEN }))],
] as const;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  current.calls = [];
  current.error = null;
  current.redirectedTo = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("the auth actions pass the Turnstile token to GoTrue", () => {
  it.each(ACTIONS)("%s sends options.captchaToken to %s", async (_name, method, act) => {
    await run(act);
    expect(current.calls.map((c) => c.method)).toEqual([method]);
    expect((current.calls[0].args.options as { captchaToken?: string }).captchaToken).toBe(TOKEN);
  });

  it("with no widget on the page (captcha off), the token is simply absent", async () => {
    await run(() => signInAction({}, form({ email: EMAIL, password: TYPED })));
    expect((current.calls[0].args.options as { captchaToken?: string }).captchaToken).toBeUndefined();
  });

  it.each(ACTIONS)("%s shows the security-check message when GoTrue refuses the token", async (_name, _m, act) => {
    current.error = REFUSED;
    expect(await run(act)).toEqual({ error: CAPTCHA_FAILED });
    expect(current.redirectedTo, "a refused check must not land on a success page").toBeNull();
  });
});

describe("the Turnstile widget", () => {
  it("renders nothing without NEXT_PUBLIC_TURNSTILE_SITE_KEY (local, CI, e2e)", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    expect(renderToStaticMarkup(<Turnstile />)).toBe("");
  });

  it("renders its container with a site key", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    expect(renderToStaticMarkup(<Turnstile />)).toContain("min-h-[65px]");
  });
});
