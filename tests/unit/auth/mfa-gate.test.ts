// Unit tests for lib/auth/mfa-gate.ts's fail-closed decision logic (fix
// round 1, Important 3). These are the pure functions extracted specifically
// so this direction is testable without provoking a real PostgREST/RPC
// failure -- roleCheckRequiresMfa() and platformAdminCheckRequiresMfa() take
// the exact {data, error} shape their real callers get back and decide
// nothing else.
//
// THE FINDING BEING GUARDED AGAINST: the original version of this file
// returned `false` (MFA not required) on an error from either check --
// reasoned as consistent with lib/auth/index.ts's hasPermission(), which
// also treats "could not determine" as "no". That analogy inverts here:
// hasPermission()'s "no" DENIES a capability; this gate's "no" GRANTS entry
// past the only MFA control that exists. Every "on error" case below asserts
// the CLOSED direction (required: true), and every "genuinely empty, not an
// error" case asserts it does NOT trip the same wire -- a brand-new signup
// with zero real memberships must still read as "not required", not as
// "error, therefore required".
import { describe, expect, it } from "vitest";
import {
  platformAdminCheckRequiresMfa,
  roleCheckRequiresMfa,
} from "@/lib/auth/mfa-gate";

describe("roleCheckRequiresMfa — fail CLOSED on error, fail OPEN on genuine emptiness", () => {
  it("REQUIRES MFA when the query errored, regardless of what data (if any) came back", () => {
    expect(
      roleCheckRequiresMfa({ data: null, error: { message: "connection reset" } }),
    ).toBe(true);
    expect(
      roleCheckRequiresMfa({ data: [], error: { message: "timeout" } }),
    ).toBe(true);
  });

  it("does NOT require MFA for a genuinely empty result (a brand-new signup, not an error)", () => {
    expect(roleCheckRequiresMfa({ data: [], error: null })).toBe(false);
    expect(roleCheckRequiresMfa({ data: null, error: null })).toBe(false);
  });

  it("requires MFA when a privileged role is present", () => {
    for (const role of ["owner", "admin", "finance"]) {
      expect(
        roleCheckRequiresMfa({ data: [{ role }], error: null }),
      ).toBe(true);
    }
  });

  it("does not require MFA for a non-privileged role, with no error", () => {
    for (const role of ["manager", "booker", "venue_manager", "marketing", "standard_user", "read_only"]) {
      expect(
        roleCheckRequiresMfa({ data: [{ role }], error: null }),
      ).toBe(false);
    }
  });

  it("requires MFA if ANY of several memberships is privileged, even if others aren't", () => {
    expect(
      roleCheckRequiresMfa({
        data: [{ role: "standard_user" }, { role: "finance" }],
        error: null,
      }),
    ).toBe(true);
  });
});

describe("platformAdminCheckRequiresMfa — fail CLOSED on error, fail OPEN on a real `false`", () => {
  it("REQUIRES MFA when the RPC errored, regardless of what data (if any) came back", () => {
    expect(
      platformAdminCheckRequiresMfa({ data: null, error: { message: "PGRST000" } }),
    ).toBe(true);
    expect(
      platformAdminCheckRequiresMfa({ data: false, error: { message: "PGRST000" } }),
    ).toBe(true);
  });

  it("does NOT require MFA for a real, error-free `false` (an ordinary authenticated user)", () => {
    expect(platformAdminCheckRequiresMfa({ data: false, error: null })).toBe(false);
    expect(platformAdminCheckRequiresMfa({ data: null, error: null })).toBe(false);
  });

  it("requires MFA for a real, error-free `true` (the platform superuser)", () => {
    expect(platformAdminCheckRequiresMfa({ data: true, error: null })).toBe(true);
  });
});
