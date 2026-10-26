import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 10 Task 2 F6: the Supabase auth cookies (access + refresh token) were
// set without `Secure`, because @supabase/ssr 0.12.5's DEFAULT_COOKIE_OPTIONS
// carries no `secure` key and none of our three clients passed cookieOptions.
// Each client must hand the library `secure: true` in production (and false
// under `next dev`, which serves plain http).
//
// The library is mocked only to capture what each client passes it; that the
// library merges cookieOptions over its defaults for every cookie it sets is
// its own code (dist/main/cookies.js, `...options?.cookieOptions`).

const captured: { secure?: boolean }[] = [];
const capture = (_url: string, _key: string, options?: { cookieOptions?: { secure?: boolean } }) => {
  captured.push(options?.cookieOptions ?? {});
  return { auth: { getClaims: async () => ({ data: null }) } };
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: capture,
  createBrowserClient: capture,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

async function cookieOptionsOfEveryClient(): Promise<{ secure?: boolean }[]> {
  captured.length = 0;
  vi.resetModules();
  const { createClient: server } = await import("@/lib/supabase/server");
  const { createClient: browser } = await import("@/lib/supabase/client");
  const { updateSession } = await import("@/lib/supabase/middleware");
  const { NextRequest } = await import("next/server");
  await server();
  browser();
  await updateSession(new NextRequest("http://localhost:3000/login"));
  return [...captured];
}

describe("auth cookies carry Secure in production (F6)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  });
  afterEach(() => vi.unstubAllEnvs());

  // The first test pays for importing next/server and the proxy module.
  it("server, browser and proxy clients all pass secure: true in production", { timeout: 30_000 }, async () => {
    vi.stubEnv("NODE_ENV", "production");
    const options = await cookieOptionsOfEveryClient();
    expect(options).toHaveLength(3);
    for (const o of options) expect(o.secure).toBe(true);
  });

  it("and secure: false in development, where the stack is plain http", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const options = await cookieOptionsOfEveryClient();
    expect(options).toHaveLength(3);
    for (const o of options) expect(o.secure).toBe(false);
  });
});
