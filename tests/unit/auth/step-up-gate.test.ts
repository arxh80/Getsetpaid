// The "wiring test proving the gate actually blocks when freshness is stale
// and passes when fresh" the Task 7 brief asks for.
//
// This does NOT re-test amr age arithmetic -- that is already exhaustive in
// tests/unit/auth/step-up.test.ts (isStepUpSatisfied/readAuthFreshness).
// What it proves instead is that checkStepUp(), the function
// components/auth/step-up-gate.tsx actually calls, is correctly wired to
// those primitives: pass it claims explicitly (as a real caller with an
// injected value would) and it must return exactly what isStepUpSatisfied
// would over the same claims -- no extra branch, no inversion, no silently
// different default.
//
// Calling checkStepUp() with NO argument (the real request path, which reads
// cookies() via lib/supabase/server.ts) is deliberately NOT exercised here --
// cookies() throws outside a real Next.js request, which is exactly why
// checkStepUp() accepts claims as an optional override in the first place.
// That path has no logic of its own beyond "fetch claims, then delegate",
// which is the same reasoning tests/integration/rls's suite already applies
// to real request-bound plumbing versus pure decisions.
import { describe, expect, it } from "vitest";
import { checkStepUp, proofModeFor } from "@/lib/auth/step-up-gate";
import { STEP_UP_MAX_AGE_SECONDS } from "@/lib/auth/step-up";

function claims(method: string, agoSeconds: number) {
  return {
    sub: "00000000-0000-0000-0000-000000000001",
    amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - agoSeconds }],
  };
}

describe("checkStepUp — the gate's actual decision function", () => {
  it("PASSES (renders the gated content): a password sign-in from moments ago", async () => {
    await expect(checkStepUp(claims("password", 5))).resolves.toBe(true);
  });

  it("PASSES: an MFA factor presented moments ago", async () => {
    await expect(checkStepUp(claims("mfa/totp", 5))).resolves.toBe(true);
  });

  it("BLOCKS (renders the re-auth prompt): a password sign-in older than the step-up window", async () => {
    await expect(
      checkStepUp(claims("password", STEP_UP_MAX_AGE_SECONDS + 1)),
    ).resolves.toBe(false);
  });

  it("BLOCKS: an eleven-hour-old session, well inside its 12h timebox, by any method", async () => {
    for (const method of ["password", "otp", "mfa/totp"]) {
      await expect(checkStepUp(claims(method, 11 * 3600))).resolves.toBe(false);
    }
  });

  it("BLOCKS: a magic-link session, however fresh — link proof is not step-up", async () => {
    await expect(checkStepUp(claims("otp", 1))).resolves.toBe(false);
  });

  it("BLOCKS: claims with no usable amr at all (null, absent, empty)", async () => {
    // Note: NOT calling checkStepUp() with zero arguments anywhere in this
    // file -- that path reads cookies() via lib/supabase/server.ts, which
    // throws outside a real Next.js request. Every case here passes an
    // explicit claims value, including null, to stay on the pure branch.
    await expect(checkStepUp(null)).resolves.toBe(false);
    await expect(checkStepUp({ sub: "x" })).resolves.toBe(false);
    await expect(checkStepUp({ amr: [] })).resolves.toBe(false);
  });
});

// ===========================================================================
// FINAL FIX WAVE (review M-5): stepUpProofMode() failed OPEN on a transient
// listFactors() error while lib/auth/mfa-gate.ts failed CLOSED on the same
// class of error -- two files from the same task disagreeing about the same
// question. proofModeFor() is that decision, extracted so the direction is
// assertable without provoking a real GoTrue failure, exactly the pattern
// tests/unit/auth/mfa-gate.test.ts already uses for roleCheckRequiresMfa().
//
// WHY THE OPEN DIRECTION WAS WRONG, restated so nobody "simplifies" it back:
// a listFactors() error is indistinguishable from "no factor enrolled", so
// falling through to { mode: "password" } silently downgrades an MFA user's
// step-up to the weaker proof -- and a password proof mints an aal1 session,
// so it would ALSO drop the caller's assurance level while walking them past
// a gate whose entire purpose is to raise it.
// ===========================================================================
describe("proofModeFor — fail CLOSED on a listFactors() error", () => {
  it("returns 'unavailable' when the factor lookup errored, even though an email identity exists", () => {
    expect(
      proofModeFor({
        factorId: null,
        factorsError: { message: "connection reset" },
        hasEmailIdentity: true,
      }),
    ).toEqual({ mode: "unavailable" });
  });

  it("returns 'unavailable' on an error EVEN IF a factor id came back alongside it", () => {
    // The case that most looks like it should be waved through. It must not
    // be: a response carrying both an error and data is not one we understand,
    // and this decision grants a security capability.
    expect(
      proofModeFor({
        factorId: "factor-123",
        factorsError: { message: "partial failure" },
        hasEmailIdentity: true,
      }),
    ).toEqual({ mode: "unavailable" });
  });

  it("prefers MFA when a verified factor really is present and there was no error", () => {
    expect(
      proofModeFor({
        factorId: "factor-123",
        factorsError: null,
        hasEmailIdentity: true,
      }),
    ).toEqual({ mode: "mfa", factorId: "factor-123" });
  });

  it("falls back to password for a genuine no-factor email account (not an error)", () => {
    expect(
      proofModeFor({ factorId: null, factorsError: null, hasEmailIdentity: true }),
    ).toEqual({ mode: "password" });
  });

  it("returns 'unavailable' for a Google-SSO-only account with no factor — never a password field that can never succeed", () => {
    expect(
      proofModeFor({ factorId: null, factorsError: null, hasEmailIdentity: false }),
    ).toEqual({ mode: "unavailable" });
  });
});
