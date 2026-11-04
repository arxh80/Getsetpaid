import { beforeEach, describe, expect, it, vi } from "vitest";

// inviteMemberAction's existing-account branch. Anyone can sign up as an
// address they don't own, so an unconfirmed account must never receive the
// membership: otherwise pre-registering victim@x lets an attacker accept an
// invite meant for the victim. Auth and the database are stubbed.
//
// DENOMINATOR: the confirmed case proves the INSERT is reached with the
// matched id, so "not inserted" below means the guard refused.

const SLUG = "neon-nights";
const EMAIL = "victim@example.test";

const stubs = vi.hoisted(() => ({
  confirmedAt: null as string | null,
  insert: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("@/lib/auth/mfa-gate", () => ({ assertMfaSatisfied: async () => null }));
vi.mock("@/lib/auth", () => ({
  getCurrentOrg: async (slug: string) => (slug === SLUG ? { id: "org-1", slug: SLUG } : null),
}));
vi.mock("@/lib/supabase/env", () => ({ siteUrl: () => "http://localhost:3000" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: true }),
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) },
    from: () => ({
      insert: async (row: unknown) => {
        stubs.insert(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: async () => ({
          data: { user: null },
          error: { code: "email_exists", status: 422 },
        }),
      },
    },
  }),
  adminAuthFetch: async () =>
    new Response(
      JSON.stringify({
        users: [{ id: "existing-1", email: EMAIL, email_confirmed_at: stubs.confirmedAt }],
      }),
    ),
}));

import { inviteMemberAction } from "@/lib/org/actions";

function form() {
  const fd = new FormData();
  fd.set("orgSlug", SLUG);
  fd.set("email", EMAIL);
  fd.set("role", "manager");
  return fd;
}

beforeEach(() => {
  stubs.insert.mockClear();
});

describe("inviting an address that already has an account", () => {
  it("attaches the membership to a confirmed account", async () => {
    stubs.confirmedAt = "2026-11-01T00:00:00Z";
    const result = await inviteMemberAction({}, form());
    expect(stubs.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "existing-1" }));
    // Nothing is mailed to an existing account, so the message must not say so.
    expect(result).toEqual({ message: expect.stringContaining("no email was sent") });
  });

  it("refuses an unconfirmed account and creates no membership", async () => {
    stubs.confirmedAt = null;
    const result = await inviteMemberAction({}, form());
    expect(stubs.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ error: expect.stringContaining("unfinished GetSetPaid sign-up") });
  });
});
