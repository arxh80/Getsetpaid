import { beforeEach, describe, expect, it, vi } from "vitest";

// STEP-UP ON THE TWO ACTIONS THAT CHANGE WHAT THE PUBLIC READS
// (Phase 8 Task 1, fix round 1, review finding M6).
//
// lib/legal/admin-actions.ts re-checks step-up on publishing and on recording
// counsel's review. That check is the only place session freshness can be
// enforced -- `amr` lives in the JWT, which the database cannot see -- and
// before this file nothing imported the module: the e2e golden walk runs
// seconds after a TOTP challenge, so its credential is always fresh, and
// flipping both `stepUp: true` flags to false left every suite green.
//
// WHAT IS REAL HERE: the four Server Actions, checkStepUp()
// (lib/auth/step-up-gate.ts) and the amr arithmetic under it
// (lib/auth/step-up.ts). WHAT IS STUBBED: the session's claims (the input
// under test), the RPC (so "no RPC was called" is observable), and the
// identity checks that precede step-up. A stale credential is one presented
// more than STEP_UP_MAX_AGE_SECONDS ago -- the "session left open, cookie
// taken later" case the window exists to refuse -- which an e2e run cannot
// produce without waiting five minutes.
//
// Mutation-tested: setting `stepUp: false` on publishLegalDocumentAction or
// recordCounselReviewAction turns the matching STALE case below red.

const stubs = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  rpc: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "00000000-0000-4000-8000-000000000001", email: "op@example.test" }),
}));
vi.mock("@/lib/admin/superuser", () => ({ isSuperuser: async () => true }));
vi.mock("@/lib/crm/write", () => ({ FAILED_MESSAGE: "Something went wrong." }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: stubs.claims ? { claims: stubs.claims } : null, error: null }) },
    rpc: async (name: string, args: unknown) => {
      stubs.rpc(name, args);
      return { data: "00000000-0000-4000-8000-0000000000dd", error: null };
    },
  }),
}));

import {
  createLegalDraftAction,
  publishLegalDocumentAction,
  recordCounselReviewAction,
  saveLegalDraftAction,
} from "@/lib/legal/admin-actions";
import { STEP_UP_MAX_AGE_SECONDS } from "@/lib/auth/step-up";
import { EMPTY_FORM_STATE } from "@/lib/forms";

const DOC = "00000000-0000-4000-8000-0000000000dd";

function claimsAged(method: string, agoSeconds: number): Record<string, unknown> {
  return {
    sub: "00000000-0000-4000-8000-000000000001",
    aal: "aal2",
    amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - agoSeconds }],
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const publishForm = () => form({ slug: "terms", documentId: DOC, confirm: "yes" });
const reviewForm = () => form({ slug: "terms", documentId: DOC, confirm: "yes", reviewer: "Counsel LLP" });

beforeEach(() => {
  stubs.rpc.mockReset();
  stubs.claims = null;
});

describe("publishing a legal document requires a fresh credential", () => {
  it("STALE: a TOTP presented just outside the window is refused, and nothing is published", async () => {
    stubs.claims = claimsAged("totp", STEP_UP_MAX_AGE_SECONDS + 1);
    const result = await publishLegalDocumentAction(EMPTY_FORM_STATE, publishForm());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(result.message).toBeUndefined();
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("STALE: an eleven-hour-old password sign-in is refused", async () => {
    stubs.claims = claimsAged("password", 11 * 3600);
    const result = await publishLegalDocumentAction(EMPTY_FORM_STATE, publishForm());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("NO PROOF: claims with no amr are refused", async () => {
    stubs.claims = { sub: "x", aal: "aal2" };
    const result = await publishLegalDocumentAction(EMPTY_FORM_STATE, publishForm());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: the same request with a TOTP from seconds ago publishes", async () => {
    stubs.claims = claimsAged("totp", 5);
    const result = await publishLegalDocumentAction(EMPTY_FORM_STATE, publishForm());
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/^Published\./);
    expect(stubs.rpc).toHaveBeenCalledWith("publish_legal_document", { p_document_id: DOC });
  });
});

describe("recording counsel's review requires a fresh credential", () => {
  it("STALE: a TOTP presented just outside the window is refused, and nothing is recorded", async () => {
    stubs.claims = claimsAged("totp", STEP_UP_MAX_AGE_SECONDS + 1);
    const result = await recordCounselReviewAction(EMPTY_FORM_STATE, reviewForm());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("STALE: a magic-link session, however recent, is not step-up", async () => {
    stubs.claims = claimsAged("otp", 5);
    const result = await recordCounselReviewAction(EMPTY_FORM_STATE, reviewForm());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: the same request with a fresh credential records the review", async () => {
    stubs.claims = claimsAged("totp", 5);
    const result = await recordCounselReviewAction(EMPTY_FORM_STATE, reviewForm());
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/^Counsel’s review recorded\./);
    expect(stubs.rpc).toHaveBeenCalledWith("record_legal_document_counsel_review", {
      p_document_id: DOC,
      p_reviewer: "Counsel LLP",
    });
  });
});

describe("drafting is deliberately NOT step-up gated (a draft is private until publish)", () => {
  it("creates and saves a draft on a stale credential", async () => {
    stubs.claims = claimsAged("totp", 11 * 3600);
    const created = await createLegalDraftAction(EMPTY_FORM_STATE, form({ slug: "terms" }));
    expect(created.error).toBeUndefined();
    const saved = await saveLegalDraftAction(
      EMPTY_FORM_STATE,
      form({ slug: "terms", documentId: DOC, title: "Terms of Service", body: "## Terms\n\nText.", effectiveDate: "2026-09-22" }),
    );
    expect(saved.error).toBeUndefined();
    expect(stubs.rpc.mock.calls.map((c) => c[0])).toEqual([
      "create_legal_document_draft",
      "update_legal_document_draft",
    ]);
  });
});
