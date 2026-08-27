// Unit tests for lib/org/current-org.ts's read/write plumbing -- the
// mechanism "last used workspace" persistence actually runs on.
//
// next/headers's cookies() throws outside a real Next.js request (same
// constraint tests/unit/auth/step-up-gate.test.ts documents for its own
// cookie-touching path), so there is no way to exercise the real HTTP
// Set-Cookie/Cookie round trip from a plain Vitest run. What CAN be verified
// here, with `next/headers` swapped for an in-memory stand-in that implements
// the same get/set shape, is the thing this module is actually responsible
// for: that a written value reads back unchanged (the "persistence" property
// itself, request-shaped concerns aside) and that every attribute this file's
// header comment justifies is the one actually sent. The full browser-visible
// behaviour (cookie survives a real page navigation, forged edits, expiry) was
// additionally exercised by hand against the local dev server -- see
// task-8-report.md.
import { afterEach, describe, expect, it, vi } from "vitest";

interface StoredCookie {
  value: string;
  options: Record<string, unknown>;
}

// vi.hoisted: vi.mock's factory below is hoisted above this file's imports,
// so a plain `const store = new Map()` declared after it would still be in
// its temporal dead zone when the factory first runs. vi.hoisted runs its
// initialiser at the same hoisted point, so `store` is safe to close over.
const store = vi.hoisted(() => new Map<string, StoredCookie>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const entry = store.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set(name: string, value: string, options: Record<string, unknown>) {
      store.set(name, { value, options });
    },
  }),
}));

import {
  CURRENT_ORG_COOKIE,
  readCurrentOrgIdCookie,
  writeCurrentOrgIdCookie,
} from "@/lib/org/current-org";

afterEach(() => {
  store.clear();
});

describe("readCurrentOrgIdCookie / writeCurrentOrgIdCookie", () => {
  it("reads null before anything has ever been written", async () => {
    await expect(readCurrentOrgIdCookie()).resolves.toBeNull();
  });

  it("PERSISTENCE: a written value reads back unchanged", async () => {
    await writeCurrentOrgIdCookie("11111111-1111-1111-1111-111111111111");
    await expect(readCurrentOrgIdCookie()).resolves.toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("re-selecting a different workspace REPLACES the remembered value, not appends", async () => {
    await writeCurrentOrgIdCookie("11111111-1111-1111-1111-111111111111");
    await writeCurrentOrgIdCookie("22222222-2222-2222-2222-222222222222");
    await expect(readCurrentOrgIdCookie()).resolves.toBe(
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("sets the documented attributes: httpOnly, sameSite=lax, path=/, and a 180-day maxAge", async () => {
    await writeCurrentOrgIdCookie("11111111-1111-1111-1111-111111111111");
    const entry = store.get(CURRENT_ORG_COOKIE);
    expect(entry?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 180,
    });
  });

  it("only requires `secure` in production -- local dev (plain http://) must still be able to set it", async () => {
    await writeCurrentOrgIdCookie("11111111-1111-1111-1111-111111111111");
    const entry = store.get(CURRENT_ORG_COOKIE);
    expect(entry?.options.secure).toBe(process.env.NODE_ENV === "production");
  });
});
