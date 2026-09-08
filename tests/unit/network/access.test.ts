// The M4 closure: `getNetworkPublishAccess` alone cannot tell "a marketing
// user" from "a marketing user who is about to be refused by the database
// anyway" -- that needs the per-kind key `getNetworkPublishAccessForEntity`
// adds. This file is the CI-visible proof (tests/unit, not tests/integration
// -- it runs in the `vitest run tests/unit` job CI actually executes).
//
// tests/integration/network/publish-editor-flow.test.ts's "M4, at the
// database" describe block drives the SAME shape against the real database
// (a real marketing membership, a real artist row, a raw INSERT into
// network_profiles) for the mirror-test discipline this codebase applies
// everywhere else a rule exists in two languages: this file's mocked
// prediction and that block's measured result must agree, and if a future
// migration changes who marketing is or what entity_is_manageable dispatches
// to, one of the two goes red.
//
// PURE MOCKING, no database and no local stack required -- `hasPermission` is
// the one seam both `getNetworkPublishAccess` and
// `getNetworkPublishAccessForEntity` call through, so it is the one thing
// this file needs to control.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return { ...actual, hasPermission: vi.fn() };
});
vi.mock("@/lib/entitlements/policy", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/entitlements/policy")>();
  return {
    ...actual,
    // The no-subscription escape ("not yet billed => not yet gated"): every
    // organisation qualifies today (lib/network/access.ts's header). Fixed
    // for every test in this file, via the SAME resolveEntitlements() the
    // real code path calls, so only `hasPermission` varies.
    getOrganisationEntitlements: vi
      .fn()
      .mockResolvedValue(actual.resolveEntitlements({ data: null, error: null })),
  };
});

const { hasPermission } = await import("@/lib/auth");
const {
  getNetworkPublishAccess,
  getNetworkPublishAccessForEntity,
  manageableNetworkEntityKinds,
} = await import("@/lib/network/access");

const org = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "M4 probe",
  role: "marketing" as const,
  slug: "m4-probe",
  isSuspended: false,
  // Phase 7 Task 2 added these two to CurrentOrg. Always false/null in
  // these fixtures: nothing here exercises impersonation, and a fixture
  // that quietly claimed to would be asserting about the wrong feature.
  isImpersonated: false,
  impersonationExpiresAt: null,
};

afterEach(() => {
  vi.mocked(hasPermission).mockReset();
});

/** The exact shape 20260828120000 grants `marketing`: view_crm and
 *  manage_contacts, and manage_network_profile from 20260904002000 --
 *  nothing else, and specifically NOT manage_artists or manage_venues. */
function mockMarketing() {
  vi.mocked(hasPermission).mockImplementation(async (_orgId, key) => {
    return key === "manage_network_profile" || key === "manage_contacts";
  });
}

describe("M4: getNetworkPublishAccessForEntity closes the per-kind gap getNetworkPublishAccess cannot see", () => {
  it("getNetworkPublishAccess alone says yes for a marketing user -- the defect's premise", async () => {
    mockMarketing();
    const result = await getNetworkPublishAccess(org);
    expect(result.canWrite, "manage_network_profile is held").toBe(true);
  });

  it("...but getNetworkPublishAccessForEntity refuses an ARTIST, with reason 'permission'", async () => {
    mockMarketing();
    const result = await getNetworkPublishAccessForEntity(org, "artist");
    expect(result.canWrite, "marketing holds no manage_artists").toBe(false);
    if (!result.canWrite) {
      expect(result.reason).toBe("permission");
      expect(result.explanation).toMatch(/artists/);
    }
  });

  it("...and a VENUE, for the same reason", async () => {
    mockMarketing();
    const result = await getNetworkPublishAccessForEntity(org, "venue");
    expect(result.canWrite).toBe(false);
  });

  it("...but PERMITS a COMPANY -- marketing holds manage_contacts, the positive control", async () => {
    mockMarketing();
    const result = await getNetworkPublishAccessForEntity(org, "company");
    expect(result.canWrite, "marketing holds manage_contacts").toBe(true);
  });

  it("...and an AGENCY, which dispatches to manage_contacts too", async () => {
    mockMarketing();
    const result = await getNetworkPublishAccessForEntity(org, "agency");
    expect(result.canWrite).toBe(true);
  });

  it("the general refusal (no manage_network_profile at all) wins before the per-kind question is even asked", async () => {
    vi.mocked(hasPermission).mockResolvedValue(false);
    const result = await getNetworkPublishAccessForEntity(org, "company");
    expect(result.canWrite).toBe(false);
    if (!result.canWrite) {
      // The GENERAL sentence, not the per-kind one -- a caller who holds
      // neither key should be told the more fundamental refusal.
      expect(result.reason).toBe("permission");
      expect(result.explanation).not.toMatch(/companies/);
    }
    // Only the one key was ever asked: getNetworkPublishAccess's own refusal
    // short-circuits before the per-kind hasPermission call.
    expect(vi.mocked(hasPermission)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hasPermission)).toHaveBeenCalledWith(
      org.id,
      "manage_network_profile",
    );
  });

  it("manageableNetworkEntityKinds offers exactly {company, agency} for marketing -- never artist or venue", async () => {
    mockMarketing();
    const kinds = await manageableNetworkEntityKinds(org);
    expect([...kinds].sort()).toEqual(["agency", "company"]);
  });

  it("manageableNetworkEntityKinds is empty when the general gate refuses everything", async () => {
    vi.mocked(hasPermission).mockResolvedValue(false);
    const kinds = await manageableNetworkEntityKinds(org);
    expect(kinds.size).toBe(0);
  });

  it("an owner/admin/manager (every key held) gets all four kinds", async () => {
    vi.mocked(hasPermission).mockResolvedValue(true);
    const kinds = await manageableNetworkEntityKinds(org);
    expect([...kinds].sort()).toEqual(["agency", "artist", "company", "venue"]);
  });
});
