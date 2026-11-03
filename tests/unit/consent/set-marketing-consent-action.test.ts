import { beforeEach, describe, expect, it, vi } from "vitest";

// setMarketingConsentAction -- what it sends to record_consent() and how it
// words each refusal. The database is stubbed (the ledger's own behaviour is
// proved by supabase/tests/rls_phase8_consents.sql and
// tests/integration/legal/consents.test.ts); what is under test is that the
// action never supplies a user, sends the rendered version only with a grant,
// and gives a withdrawal nothing that could make it fail.

const stubs = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-000000000001", email: "p@example.test" } as { id: string; email: string } | null,
  rpc: vi.fn(),
  result: { error: null } as { error: { code: string; hint?: string; message: string } | null },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => stubs.user }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      stubs.rpc(name, args);
      return { data: null, ...stubs.result };
    },
  }),
}));

import { setMarketingConsentAction } from "@/lib/consent/actions";
import { EMPTY_FORM_STATE } from "@/lib/forms";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  stubs.rpc.mockReset();
  stubs.result = { error: null };
  stubs.user = { id: "00000000-0000-4000-8000-000000000001", email: "p@example.test" };
});

describe("setMarketingConsentAction", () => {
  it("a grant sends the rendered version and the statement id, and no user", async () => {
    const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "grant", policyVersion: "2" }));
    expect(stubs.rpc).toHaveBeenCalledWith("record_consent", {
      p_purpose: "marketing_email",
      p_action: "granted",
      p_policy_version: 2,
      p_statement: "marketing-email-1",
    });
    expect(JSON.stringify(stubs.rpc.mock.calls[0][1])).not.toMatch(/user/i);
    expect(out.message).toMatch(/agreed/);
  });

  it("a withdrawal sends no version, even if one is posted", async () => {
    const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "withdraw", policyVersion: "999" }));
    expect(stubs.rpc).toHaveBeenCalledWith("record_consent", {
      p_purpose: "marketing_email",
      p_action: "withdrawn",
      p_policy_version: null,
      p_statement: "marketing-email-1",
    });
    expect(out.message).toMatch(/withdrawn/);
  });

  it("a grant with no usable version is refused before the database", async () => {
    for (const policyVersion of ["", "0", "-1", "2.5", "abc", "1e3"]) {
      const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "grant", policyVersion }));
      expect(out.error, policyVersion).toMatch(/has changed/);
    }
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("an unknown choice records nothing", async () => {
    const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "granted" }));
    expect(out.error).toBeTruthy();
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("no session records nothing", async () => {
    stubs.user = null;
    const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "withdraw" }));
    expect(out.error).toMatch(/session/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("words each database refusal", async () => {
    const cases: [{ code: string; hint?: string }, RegExp, "error" | "message"][] = [
      [{ code: "22023", hint: "stale_policy_version" }, /has changed/, "error"],
      [{ code: "22023", hint: "already_granted" }, /already agreed/, "message"],
      [{ code: "22023", hint: "not_granted" }, /nothing to withdraw/, "message"],
      [{ code: "PT429", hint: "1800" }, /Try again in 30 minutes/, "error"],
      [{ code: "42501" }, /could not be saved/, "error"],
    ];
    for (const [error, pattern, field] of cases) {
      stubs.result = { error: { ...error, message: "x" } };
      const out = await setMarketingConsentAction(EMPTY_FORM_STATE, form({ choice: "grant", policyVersion: "2" }));
      expect(out[field], JSON.stringify(error)).toMatch(pattern);
    }
  });
});
