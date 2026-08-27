// Unit tests for lib/entitlements/policy.ts's resolveEntitlements() -- the
// pure decision function extracted specifically so the three-way
// "no row" / "row" / "error" split (plus the active-vs-not status branch and
// the unknown-plan_id branch) is testable without provoking a real
// PostgREST failure, the same motive as
// tests/unit/auth/mfa-gate.test.ts's roleCheckRequiresMfa() tests.
//
// THE PROPERTY BEING GUARDED: "no subscription row" and "the query errored"
// must never collapse into the same outcome. Both currently render the same
// Free-tier `entitlements` object (Free is the correct answer for the first
// and the safe default for the second), but `status` tells them apart, and
// every test below asserts on `status` explicitly rather than only on the
// entitlements shape -- asserting only the latter would let the two cases
// silently merge again without any test noticing.
import { describe, expect, it } from "vitest";
import { resolveEntitlements } from "@/lib/entitlements/policy";
import { TIER_MATRIX } from "@/lib/entitlements/tiers";

describe("resolveEntitlements -- no-subscription vs indeterminate are never the same outcome", () => {
  it('no row, no error -> status "no-subscription", Free entitlements (a brand-new org, not a failure)', () => {
    const result = resolveEntitlements({ data: null, error: null });
    expect(result.status).toBe("no-subscription");
    expect(result.tier).toBe("free");
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });

  it('a query error -> status "indeterminate", tier null, but STILL a safe (Free-shaped) entitlements object', () => {
    const result = resolveEntitlements({
      data: null,
      error: { message: "connection reset" },
    });
    expect(result.status).toBe("indeterminate");
    expect(result.tier).toBeNull();
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });

  it("an error takes precedence over data even if a row somehow came back alongside it", () => {
    const result = resolveEntitlements({
      data: { plan_id: "pro", status: "active" },
      error: { message: "timeout" },
    });
    expect(result.status).toBe("indeterminate");
    expect(result.tier).toBeNull();
  });
});

describe("resolveEntitlements -- an active subscription resolves to its plan's entitlements", () => {
  it.each(["free", "starter", "pro"] as const)(
    "status='active', plan_id='%s' -> resolved, matching TIER_MATRIX exactly",
    (planId) => {
      const result = resolveEntitlements({
        data: { plan_id: planId, status: "active" },
        error: null,
      });
      expect(result.status).toBe("resolved");
      expect(result.tier).toBe(planId);
      expect(result.entitlements).toEqual(TIER_MATRIX[planId]);
    },
  );
});

describe("resolveEntitlements -- only status='active' grants the paid plan (CLAUDE.md: downgrade limits, never deletes)", () => {
  it.each(["past_due", "cancelled"] as const)(
    "a %s pro subscription falls back to Free's entitlements, not Pro's",
    (status) => {
      const result = resolveEntitlements({
        data: { plan_id: "pro", status },
        error: null,
      });
      expect(result.status).toBe("resolved");
      expect(result.tier).toBe("free");
      expect(result.entitlements).toEqual(TIER_MATRIX.free);
    },
  );

  it("a past_due starter subscription also falls back to Free, not Starter", () => {
    const result = resolveEntitlements({
      data: { plan_id: "starter", status: "past_due" },
      error: null,
    });
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });
});

describe("resolveEntitlements -- unrecognised plan_id fails closed rather than trusting an unknown key", () => {
  it("an active row with a plan_id this mirror does not know about -> indeterminate, Free-shaped default", () => {
    const result = resolveEntitlements({
      data: { plan_id: "enterprise", status: "active" },
      error: null,
    });
    expect(result.status).toBe("indeterminate");
    expect(result.tier).toBeNull();
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });
});
