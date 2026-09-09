// Unit tests for lib/entitlements/policy.ts's resolveEntitlements() -- the
// pure decision function extracted specifically so the three-way
// "no row" / "row" / "error" split (plus the status branch, the past_due
// grace window and the unknown-plan_id branch) is testable without provoking
// a real PostgREST failure, the same motive as
// tests/unit/auth/mfa-gate.test.ts's roleCheckRequiresMfa() tests.
//
// THE PROPERTY BEING GUARDED: "no subscription row" and "the query errored"
// must never collapse into the same outcome. Both currently render the same
// Free-tier `entitlements` object (Free is the correct answer for the first
// and the safe default for the second), but `status` tells them apart, and
// every test below asserts on `status` explicitly rather than only on the
// entitlements shape -- asserting only the latter would let the two cases
// silently merge again without any test noticing.
//
// TIME IS INJECTED, NEVER READ FROM THE CLOCK. resolveEntitlements() takes
// `now` so the grace-window tests below are deterministic. A test that let
// the real clock run would pass today and fail three days from now, which is
// the exact bug class this feature is made of.
import { describe, expect, it, vi } from "vitest";
import {
  PAST_DUE_GRACE_DAYS,
  isWithinPastDueGrace,
  resolveEntitlements,
} from "@/lib/entitlements/policy";
import { TIER_MATRIX } from "@/lib/entitlements/tiers";

/** A fixed "now" and a period end exactly on it, so every offset below is
 * unambiguous relative to the moment the subscription lapsed. */
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const PERIOD_END = "2026-08-28T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Builds a query result; current_period_end defaults to the fixed instant. */
function row(
  plan_id: string,
  status: string,
  current_period_end: string = PERIOD_END,
) {
  return { data: { plan_id, status, current_period_end }, error: null };
}

describe("resolveEntitlements -- no-subscription vs indeterminate are never the same outcome", () => {
  it('no row, no error -> status "no-subscription", Free entitlements (a brand-new org, not a failure)', () => {
    const result = resolveEntitlements({ data: null, error: null }, NOW);
    expect(result.status).toBe("no-subscription");
    expect(result.tier).toBe("free");
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });

  it('a query error -> status "indeterminate", tier null, but STILL a safe (Free-shaped) entitlements object', () => {
    const result = resolveEntitlements(
      { data: null, error: { message: "connection reset" } },
      NOW,
    );
    expect(result.status).toBe("indeterminate");
    expect(result.tier).toBeNull();
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });

  it("an error takes precedence over data even if a row somehow came back alongside it", () => {
    const result = resolveEntitlements(
      { data: { plan_id: "pro", status: "active", current_period_end: PERIOD_END },
        error: { message: "timeout" } },
      NOW,
    );
    expect(result.status).toBe("indeterminate");
    expect(result.tier).toBeNull();
  });
});

describe("resolveEntitlements -- an active subscription resolves to its plan's entitlements", () => {
  it.each(["free", "starter", "pro"] as const)(
    "status='active', plan_id='%s' -> resolved, matching TIER_MATRIX exactly",
    (planId) => {
      const result = resolveEntitlements(row(planId, "active"), NOW);
      expect(result.status).toBe("resolved");
      expect(result.tier).toBe(planId);
      expect(result.entitlements).toEqual(TIER_MATRIX[planId]);
    },
  );

  it("an active subscription is unaffected by current_period_end, however old", () => {
    // Grace only exists for past_due. An 'active' row whose period end is in
    // the past is a renewal that succeeded, not a lapse.
    const result = resolveEntitlements(
      row("pro", "active", "2020-01-01T00:00:00.000Z"),
      NOW,
    );
    expect(result.tier).toBe("pro");
  });
});

describe("resolveEntitlements -- past_due keeps the paid tier for a 3-day grace window", () => {
  it("the grace window is 3 days, as decided", () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(3);
  });

  it.each([
    ["the moment the period ends", 0],
    ["one day in", 1],
    ["a minute before the window closes", 3 - 1 / 1440],
  ])("past_due pro still gets Pro %s", (_label, daysAfter) => {
    const result = resolveEntitlements(
      row("pro", "past_due"),
      NOW + daysAfter * DAY_MS,
    );
    expect(result.status).toBe("resolved");
    expect(result.tier).toBe("pro");
    expect(result.entitlements).toEqual(TIER_MATRIX.pro);
  });

  it.each([
    ["exactly at the 3-day boundary", 3],
    ["a minute past it", 3 + 1 / 1440],
    ["a month later", 30],
  ])("past_due pro falls back to Free %s", (_label, daysAfter) => {
    const result = resolveEntitlements(
      row("pro", "past_due"),
      NOW + daysAfter * DAY_MS,
    );
    expect(result.status).toBe("resolved");
    expect(result.tier).toBe("free");
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
  });

  it("the boundary is exclusive: at exactly +3 days the grace is over, not still running", () => {
    // Pinned deliberately. An off-by-one here is invisible in production --
    // it just means someone keeps or loses features for one extra instant --
    // so only a test states which side of the boundary is intended.
    expect(isWithinPastDueGrace(PERIOD_END, NOW + 3 * DAY_MS - 1)).toBe(true);
    expect(isWithinPastDueGrace(PERIOD_END, NOW + 3 * DAY_MS)).toBe(false);
  });

  it("grace applies to Starter too, not just Pro", () => {
    const result = resolveEntitlements(row("starter", "past_due"), NOW + DAY_MS);
    expect(result.tier).toBe("starter");
    expect(result.entitlements).toEqual(TIER_MATRIX.starter);
  });
});

describe("resolveEntitlements -- cancelled gets no grace at all", () => {
  it.each([
    ["the instant it is cancelled", 0],
    ["one day later", 1],
  ])("a cancelled pro subscription is Free %s", (_label, daysAfter) => {
    // The asymmetry with past_due is the point: cancelling is a choice the
    // customer made, so it is honoured at once. past_due happened TO them.
    const result = resolveEntitlements(
      row("pro", "cancelled"),
      NOW + daysAfter * DAY_MS,
    );
    expect(result.status).toBe("resolved");
    expect(result.tier).toBe("free");
  });

  it("an unrecognised status gets no grace either -- only past_due does", () => {
    const result = resolveEntitlements(row("pro", "paused"), NOW);
    expect(result.tier).toBe("free");
  });
});

describe("isWithinPastDueGrace -- an unreadable date fails closed", () => {
  it("an unparseable current_period_end ends the grace rather than extending it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // "Could not determine" must not be the branch that keeps paid features
      // switched on -- the same fail-closed asymmetry the MFA gate draws.
      expect(isWithinPastDueGrace("not a date", NOW)).toBe(false);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });

  it("a past_due row with an unreadable date resolves to Free, not to its paid plan", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = resolveEntitlements(row("pro", "past_due", "garbage"), NOW);
      expect(result.tier).toBe("free");
    } finally {
      error.mockRestore();
    }
  });
});

describe("resolveEntitlements -- unrecognised plan_id fails closed rather than trusting an unknown key", () => {
  it("an active row with a plan_id this mirror does not know about -> indeterminate, Free-shaped default", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = resolveEntitlements(row("enterprise", "active"), NOW);
      expect(result.status).toBe("indeterminate");
      expect(result.tier).toBeNull();
      expect(result.entitlements).toEqual(TIER_MATRIX.free);
    } finally {
      error.mockRestore();
    }
  });

  it("an unknown plan_id inside the grace window also fails closed, not into the unknown tier", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = resolveEntitlements(
        row("enterprise", "past_due"),
        NOW + DAY_MS,
      );
      expect(result.status).toBe("indeterminate");
      expect(result.tier).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});

// PHASE 7 TASK 4 -- billing overrides. private.active_billing_override()'s
// exact predicate (not revoked, started, not yet expired) is the SQL side's
// job and is proven against the deployed database in
// tests/integration/entitlements/billing-override-matches-db.test.ts; these
// tests are about what resolveEntitlements() DOES once it is handed an
// object it already trusts is "currently active".
describe("resolveEntitlements -- an active billing override wins outright", () => {
  it("an override naming Pro applies even though the subscription is Starter and active", () => {
    const result = resolveEntitlements(row("starter", "active"), NOW, {
      tier: "pro",
      seats: null,
    });
    expect(result.status).toBe("resolved");
    expect(result.tier).toBe("pro");
    expect(result.entitlements).toEqual(TIER_MATRIX.pro);
    expect(result.override).toBe(true);
  });

  it("an override BYPASSES the subscription's own status entirely -- cancelled included", () => {
    const result = resolveEntitlements(row("starter", "cancelled"), NOW, {
      tier: "pro",
      seats: null,
    });
    expect(result.tier).toBe("pro");
    expect(result.override).toBe(true);
  });

  it("an override wins even over a query ERROR -- it does not need the subscription row at all", () => {
    const result = resolveEntitlements(
      { data: null, error: { message: "connection reset" } },
      NOW,
      { tier: "starter", seats: null },
    );
    expect(result.status).toBe("resolved");
    expect(result.tier).toBe("starter");
    expect(result.override).toBe(true);
  });

  it("an override may LOWER the effective tier, exactly like a downgrade", () => {
    const result = resolveEntitlements(row("pro", "active"), NOW, {
      tier: "free",
      seats: null,
    });
    expect(result.tier).toBe("free");
    expect(result.entitlements).toEqual(TIER_MATRIX.free);
    expect(result.override).toBe(true);
  });

  it("a SEATS-ONLY override (tier null) does not change tier resolution", () => {
    const result = resolveEntitlements(row("starter", "active"), NOW, {
      tier: null,
      seats: 25,
    });
    expect(result.tier).toBe("starter");
    expect(result.entitlements).toEqual(TIER_MATRIX.starter);
    // override:false is deliberate here -- see resolveEntitlements()'s own
    // comment: this field means "the TIER came from an override", and a
    // seats-only override never changes it.
    expect(result.override).toBe(false);
  });

  it("no override object at all (null) behaves exactly as before Task 4", () => {
    const withNull = resolveEntitlements(row("pro", "active"), NOW, null);
    const withoutArg = resolveEntitlements(row("pro", "active"), NOW);
    expect(withNull).toEqual(withoutArg);
    expect(withNull.override).toBe(false);
  });

  it("every non-override branch reports override:false explicitly", () => {
    expect(resolveEntitlements({ data: null, error: null }, NOW).override).toBe(false);
    expect(
      resolveEntitlements({ data: null, error: { message: "x" } }, NOW).override,
    ).toBe(false);
    expect(resolveEntitlements(row("pro", "cancelled"), NOW).override).toBe(false);
  });
});
