// lib/admin/impersonation-list.ts's two rendering decisions, at their
// boundaries.
//
// ===========================================================================
// WHY THESE TWO FUNCTIONS ARE WORTH A TEST WHEN THEY ARE NOT THE ENFORCEMENT
// ===========================================================================
// `isLive` and `displayStatus` decide what the UI SAYS, never what the
// database ALLOWS -- private.impersonated_organisations()'s own
// `status = 'active' and expires_at > now()` is the enforcement, evaluated
// per permission check, and supabase/tests/rls_phase7_impersonation.sql § IE
// proves it. So a bug here cannot leak a row.
//
// It can, however, LIE, and only in one direction that matters: an 'active'
// row whose clock has run out still reads 'active' in the status column
// (20260908020000 makes the column bookkeeping and the clock enforcement), so
// a naive chip would say "Active" over a session that grants nothing, and
// offer an "Open workspace" link that 404s. Telling a support engineer they
// have access they do not have is the one direction a status label must never
// be wrong in, and the boundary where it happens -- expiresAt exactly equal to
// now -- is exactly the case a hand-check tends to get backwards.
import { describe, expect, it } from "vitest";
import { displayStatus, isLive } from "@/lib/admin/impersonation-list";

const NOW = new Date("2026-09-08T12:00:00.000Z");

function row(status: string, expiresAt: string | null) {
  return { status, expiresAt } as Parameters<typeof isLive>[0];
}

describe("isLive", () => {
  it("is true for an active session whose clock is still running", () => {
    expect(isLive(row("active", "2026-09-08T12:30:00.000Z"), NOW)).toBe(true);
  });

  it("is false one millisecond after expiry", () => {
    expect(isLive(row("active", "2026-09-08T11:59:59.999Z"), NOW)).toBe(false);
  });

  // THE BOUNDARY. The database's predicate is `expires_at > now()`, strictly
  // greater -- so a session whose expires_at is exactly now is already dead
  // there. `>=` here would be the UI claiming one last live moment the
  // database has already refused.
  it("is false at EXACTLY expires_at, matching the database's strict `>` ", () => {
    expect(isLive(row("active", NOW.toISOString()), NOW)).toBe(false);
  });

  it("is false for every non-active status, however far in the future the clock", () => {
    for (const status of ["requested", "accepted", "declined", "ended", "expired"]) {
      expect(
        isLive(row(status, "2099-01-01T00:00:00.000Z"), NOW),
        `${status} must not read as live`,
      ).toBe(false);
    }
  });

  // Unreachable through the CHECK constraint (an 'active' row must carry
  // expires_at), which is precisely why it is asserted: this function is also
  // called on rows that arrive from a query, and "no clock" must not be read
  // as "no limit".
  it("is false for an active row with a null clock -- absent bound is not unlimited", () => {
    expect(isLive(row("active", null), NOW)).toBe(false);
  });
});

describe("displayStatus", () => {
  it("shows an expired-but-still-'active' row as Expired, not Active", () => {
    expect(displayStatus(row("active", "2026-09-08T11:00:00.000Z"), NOW)).toBe(
      "expired",
    );
  });

  it("shows a genuinely live session as active", () => {
    expect(displayStatus(row("active", "2026-09-08T12:30:00.000Z"), NOW)).toBe(
      "active",
    );
  });

  it("passes every other status through untouched", () => {
    for (const status of ["requested", "accepted", "declined", "ended", "expired"]) {
      expect(displayStatus(row(status, null), NOW)).toBe(status);
    }
  });
});
