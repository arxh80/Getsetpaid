import { beforeEach, describe, expect, it, vi } from "vitest";

// closeMyWorkspaceAction (Phase 8 Task 9c job 3b) -- what it refuses BEFORE
// public.close_my_workspace() is called, what it sends when it does, and how
// it words the RPC's refusals. The database is stubbed: the RPC's own guards
// are proved by supabase/tests/rls_phase8_workspace_closure.sql, and the
// action's refusal against a real database by
// tests/integration/security/close-workspace-action.test.ts.
//
// DENOMINATOR: the "happy" test proves the stubbed RPC IS reached with the
// right arguments, so every "not called" below means the guard refused rather
// than that the call was never wired.

const SLUG = "neon-nights";
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";

type Org = {
  id: string;
  name: string;
  slug: string;
  role: string;
  isSuspended: boolean;
  isImpersonated: boolean;
};

const stubs = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  org: null as Org | null,
  stepUp: true,
  aal2: true,
  rpc: vi.fn(),
  result: { error: null } as { error: { code: string; hint?: string; message: string } | null },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => stubs.user,
  getCurrentOrg: async (slug: string) => (stubs.org && stubs.org.slug === slug ? stubs.org : null),
}));
vi.mock("@/lib/auth/step-up-gate", () => ({
  checkStepUp: async () => stubs.stepUp,
  sessionIsAal2: async () => stubs.aal2,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      stubs.rpc(name, args);
      return { data: null, ...stubs.result };
    },
  }),
}));

import { closeMyWorkspaceAction } from "@/lib/org/closure-actions";
import {
  CLOSED_MESSAGE,
  CLOSE_MESSAGES,
  checkCloseForm,
  closeRefusalFor,
} from "@/lib/org/closure-contract";
import {
  OWNER_CLOSED_READ_ONLY_EXPLANATION,
  SUSPENDED_READ_ONLY_EXPLANATION,
  readOnlyExplanation,
} from "@/lib/admin/lifecycle-contract";
import { EMPTY_FORM_STATE } from "@/lib/forms";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const GOOD = { orgSlug: SLUG, confirmSlug: SLUG, reason: "  We are winding the business down.  " };

beforeEach(() => {
  stubs.rpc.mockReset();
  stubs.result = { error: null };
  stubs.user = { id: "u1" };
  stubs.stepUp = true;
  stubs.aal2 = true;
  stubs.org = {
    id: ORG_ID,
    name: "Neon Nights",
    slug: SLUG,
    role: "owner",
    isSuspended: false,
    isImpersonated: false,
  };
});

describe("closeMyWorkspaceAction", () => {
  it("POSITIVE CONTROL: an aal2 Owner with the exact slug and a reason reaches the RPC, reason trimmed", async () => {
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
    expect(stubs.rpc).toHaveBeenCalledTimes(1);
    expect(stubs.rpc).toHaveBeenCalledWith("close_my_workspace", {
      p_organisation_id: ORG_ID,
      p_confirmation: SLUG,
      p_reason: "We are winding the business down.",
    });
    expect(out.message).toBe(CLOSED_MESSAGE);
  });

  it("the organisation id comes from the caller's own membership, never the form", async () => {
    await closeMyWorkspaceAction(
      EMPTY_FORM_STATE,
      form({ ...GOOD, organisationId: "00000000-0000-4000-8000-0000000000bb" }),
    );
    expect(stubs.rpc.mock.calls[0][1]).toMatchObject({ p_organisation_id: ORG_ID });
  });

  it.each(["manager", "admin", "finance", "read_only", "standard_user"])(
    "a %s is refused and the RPC is never called",
    async (role) => {
      stubs.org = { ...stubs.org!, role };
      const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
      expect(out.error).toBe(CLOSE_MESSAGES.notOwner);
      expect(stubs.rpc).not.toHaveBeenCalled();
    },
  );

  it("an impersonating superuser is refused even if the role read 'owner'", async () => {
    stubs.org = { ...stubs.org!, isImpersonated: true };
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
    expect(out.error).toBe(CLOSE_MESSAGES.notOwner);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("a slug that is not the caller's workspace gets the same sentence as a non-Owner", async () => {
    const out = await closeMyWorkspaceAction(
      EMPTY_FORM_STATE,
      form({ ...GOOD, orgSlug: "someone-else", confirmSlug: "someone-else" }),
    );
    expect(out.error).toBe(CLOSE_MESSAGES.notOwner);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("no session, no slug, an over-long slug: refused, nothing called", async () => {
    stubs.user = null;
    expect((await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD))).error).toBeTruthy();
    stubs.user = { id: "u1" };
    expect((await closeMyWorkspaceAction(EMPTY_FORM_STATE, form({ ...GOOD, orgSlug: "" }))).error).toBeTruthy();
    expect(
      (await closeMyWorkspaceAction(EMPTY_FORM_STATE, form({ ...GOOD, orgSlug: "x".repeat(201) }))).error,
    ).toBeTruthy();
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("an already read-only workspace is refused", async () => {
    stubs.org = { ...stubs.org!, isSuspended: true };
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
    expect(out.error).toBe(CLOSE_MESSAGES.notActive);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("a stale credential is refused with the step-up sentence", async () => {
    stubs.stepUp = false;
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
    expect(out.error).toBe(CLOSE_MESSAGES.stepUp);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("an aal1 session is refused with the two-step sentence", async () => {
    stubs.aal2 = false;
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
    expect(out.error).toBe(CLOSE_MESSAGES.aal2);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("a wrong, padded or differently-cased slug is a field error and nothing is called", async () => {
    for (const confirmSlug of ["", "neon-night", ` ${SLUG}`, `${SLUG} `, "Neon-Nights"]) {
      const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form({ ...GOOD, confirmSlug }));
      expect(out.fieldErrors?.confirmSlug, JSON.stringify(confirmSlug)).toBe(CLOSE_MESSAGES.confirmMismatch);
    }
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("a blank or over-long reason is a field error; exactly 500 after trimming is accepted", async () => {
    for (const reason of ["", "   ", "x".repeat(501)]) {
      const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form({ ...GOOD, reason }));
      expect(out.fieldErrors?.reason).toBeTruthy();
    }
    expect(stubs.rpc).not.toHaveBeenCalled();
    const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form({ ...GOOD, reason: ` ${"x".repeat(500)} ` }));
    expect(out.message).toBe(CLOSED_MESSAGE);
    expect(stubs.rpc).toHaveBeenCalledTimes(1);
  });

  it("words each RPC refusal by its hint", async () => {
    const cases: [{ code: string; hint?: string }, "error" | "confirmSlug" | "reason", string][] = [
      [{ code: "42501", hint: "close_needs_step_up" }, "error", CLOSE_MESSAGES.aal2],
      [{ code: "42501", hint: "close_needs_an_owner" }, "error", CLOSE_MESSAGES.notOwner],
      [{ code: "22023", hint: "workspace_not_active" }, "error", CLOSE_MESSAGES.notActive],
      [{ code: "22023", hint: "close_confirmation_mismatch" }, "confirmSlug", CLOSE_MESSAGES.confirmMismatch],
      [{ code: "22023", hint: "close_reason_required" }, "reason", CLOSE_MESSAGES.reasonRequired],
      [{ code: "22023", hint: "close_reason_too_long" }, "reason", CLOSE_MESSAGES.reasonTooLong],
      [{ code: "42501" }, "error", CLOSE_MESSAGES.notOwner],
      [{ code: "XX000" }, "error", CLOSE_MESSAGES.failed],
    ];
    for (const [error, where, sentence] of cases) {
      stubs.result = { error: { ...error, message: "raw database text" } };
      const out = await closeMyWorkspaceAction(EMPTY_FORM_STATE, form(GOOD));
      const got = where === "error" ? out.error : out.fieldErrors?.[where];
      expect(got, JSON.stringify(error)).toBe(sentence);
      expect(JSON.stringify(out)).not.toContain("raw database text");
      expect(out.message).toBeUndefined();
    }
  });
});

describe("checkCloseForm / closeRefusalFor", () => {
  it("reports both field errors at once", () => {
    const out = checkCloseForm(form({ confirmSlug: "nope", reason: "" }), SLUG);
    expect(out).toEqual({
      ok: false,
      fieldErrors: { confirmSlug: CLOSE_MESSAGES.confirmMismatch, reason: CLOSE_MESSAGES.reasonRequired },
    });
  });

  it("a concurrent lifecycle change reads as not-active (20261028000000, N1)", () => {
    expect(closeRefusalFor({ code: "40001", hint: "lifecycle_changed_concurrently" })).toEqual({ error: CLOSE_MESSAGES.notActive });
  });

  it("an unknown hint never echoes the database", () => {
    expect(closeRefusalFor({ code: "P0001", hint: "something_new" })).toEqual({ error: CLOSE_MESSAGES.failed });
  });
});

describe("readOnlyExplanation", () => {
  it("names the Owner's closure only for owner_closed; everything else is the suspension sentence", () => {
    expect(readOnlyExplanation({ state: "owner_closed" })).toBe(OWNER_CLOSED_READ_ONLY_EXPLANATION);
    for (const state of ["suspended", "deleted", "active"] as const) {
      expect(readOnlyExplanation({ state })).toBe(SUSPENDED_READ_ONLY_EXPLANATION);
    }
    expect(readOnlyExplanation(null)).toBe(SUSPENDED_READ_ONLY_EXPLANATION);
    expect(OWNER_CLOSED_READ_ONLY_EXPLANATION).not.toMatch(/suspended|reinstated/i);
  });
});
