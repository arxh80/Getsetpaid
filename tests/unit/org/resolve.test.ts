// Unit tests for lib/org/resolve.ts's resolveTargetMembership() -- the ONE
// function that ever reads a value out of the "last viewed workspace" cookie
// (lib/org/current-org.ts) or the switcher's submitted form field
// (lib/org/actions.ts). Both callers hand it a candidate id that is, by
// construction, exactly as untrusted as a cookie is: this file is the proof
// that treating them identically is safe.
//
// THE PROPERTY THIS FILE EXISTS TO PROVE: a candidate id that does not name
// one of the caller's OWN active memberships -- because it is a forged/
// hand-edited value naming another tenant's real org, a revoked membership,
// or pure garbage -- changes NOTHING about which membership is returned. It
// always degrades to the exact same fallback as no candidate at all. That is
// what makes the cookie structurally not an authorization mechanism: this
// function never queries anything with the candidate, it only looks itself up
// inside a list (`active`) the caller's own RLS-filtered session already
// produced.
import { describe, expect, it } from "vitest";
import { resolveTargetMembership } from "@/lib/org/resolve";
import type { Membership } from "@/lib/auth";

function membership(overrides: Partial<Membership> & { organisationId: string }): Membership {
  return {
    id: `membership-${overrides.organisationId}`,
    role: "standard_user",
    status: "active",
    invitedAt: "2026-01-01T00:00:00Z",
    joinedAt: "2026-01-01T00:00:00Z",
    organisation: {
      id: overrides.organisationId,
      name: `Org ${overrides.organisationId}`,
      slug: `org-${overrides.organisationId}`,
    },
    ...overrides,
  };
}

const orgA = membership({ organisationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
const orgB = membership({ organisationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
const FOREIGN_TENANT_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

describe("resolveTargetMembership -- cookie/form value is never authorization", () => {
  it("returns the matching membership when the candidate names a real active membership", () => {
    expect(resolveTargetMembership(orgB.organisationId, [orgA, orgB])).toBe(orgB);
  });

  it("PROVES THE PROPERTY: a candidate naming another tenant's real-shaped UUID changes nothing -- falls back to the first of the caller's OWN active memberships, exactly as if no cookie existed at all", () => {
    const withForeignCandidate = resolveTargetMembership(FOREIGN_TENANT_UUID, [orgA, orgB]);
    const withNoCandidate = resolveTargetMembership(null, [orgA, orgB]);
    expect(withForeignCandidate).toBe(orgA);
    expect(withForeignCandidate).toEqual(withNoCandidate);
  });

  it("degrades gracefully for a stale/revoked-since candidate no longer in `active`", () => {
    // orgB was active when the cookie was written; the caller has since lost
    // that membership (revoked, or the org was deleted) so it is simply
    // absent from `active` on this request.
    expect(resolveTargetMembership(orgB.organisationId, [orgA])).toBe(orgA);
  });

  it("degrades gracefully for a candidate that is not even a real UUID shape", () => {
    expect(resolveTargetMembership("not-a-uuid; DROP TABLE organisations;", [orgA, orgB])).toBe(
      orgA,
    );
    expect(resolveTargetMembership("", [orgA, orgB])).toBe(orgA);
  });

  it("returns null rather than throwing when the caller has no active memberships at all", () => {
    expect(resolveTargetMembership(orgA.organisationId, [])).toBeNull();
    expect(resolveTargetMembership(null, [])).toBeNull();
  });

  it("never returns a membership that isn't in `active`, even when it matches by coincidence of shape", () => {
    const result = resolveTargetMembership(FOREIGN_TENANT_UUID, [orgA, orgB]);
    expect([orgA, orgB]).toContain(result);
  });
});
