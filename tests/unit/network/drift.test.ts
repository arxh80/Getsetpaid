import { describe, expect, it } from "vitest";
import { profileHasDrifted, type EntitySnapshot, type ProfileSnapshot } from "@/lib/network/drift";

// Q75's drift affordance, pure. The four detail pages call this over two
// objects they already loaded separately; this file drives the function
// itself against fixtures shaped like each of the four private kinds.

const NO_DRIFT: ProfileSnapshot = {
  displayName: "Acme Ltd",
  country: null,
  city: null,
  websiteUrl: null,
};

describe("the baseline: identical name, everything else hidden/unset -> no drift", () => {
  it("company/agency shape (name only)", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd" };
    expect(profileHasDrifted(entity, NO_DRIFT)).toBe(false);
  });
});

describe("display_name is compared UNCONDITIONALLY -- it can never be hidden", () => {
  it("a changed private name is drift, even with every other field null/unset", () => {
    const entity: EntitySnapshot = { name: "Acme Holdings Ltd" };
    expect(profileHasDrifted(entity, NO_DRIFT)).toBe(true);
  });
});

describe("a HIDDEN published field is never drift, whatever the private record says", () => {
  it("profile.city is null (hidden or unset) -- a changed private city is not drift", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", city: "Manchester" };
    expect(profileHasDrifted(entity, NO_DRIFT)).toBe(false);
  });

  it("same for country and website", () => {
    const entity: EntitySnapshot = {
      name: "Acme Ltd",
      country: "France",
      website: "https://example.com",
    };
    expect(profileHasDrifted(entity, NO_DRIFT)).toBe(false);
  });
});

describe("a column THIS KIND does not have is never compared -- undefined, not null", () => {
  it("a company snapshot has no `city` key at all; a stored city on the profile is not drift", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd" }; // city: undefined
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: null,
      city: "Manchester", // published, e.g. from before the company page ever had one
      websiteUrl: null,
    };
    expect(profileHasDrifted(entity, profile)).toBe(false);
  });
});

describe("a real change on a field BOTH sides carry, and the profile has PUBLISHED, is drift", () => {
  it("country changed", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", country: "Germany" };
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: "France",
      city: null,
      websiteUrl: null,
    };
    expect(profileHasDrifted(entity, profile)).toBe(true);
  });

  it("city changed", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", city: "Leeds" };
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: null,
      city: "Manchester",
      websiteUrl: null,
    };
    expect(profileHasDrifted(entity, profile)).toBe(true);
  });

  it("the private value went to null while the profile still publishes one -- real drift", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", country: null };
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: "France",
      city: null,
      websiteUrl: null,
    };
    expect(profileHasDrifted(entity, profile)).toBe(true);
  });
});

describe("website comparison tolerates scheme/slash noise -- it is not a bare string compare", () => {
  it("http vs https, with vs without a trailing slash: not drift", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", website: "example.com" };
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: null,
      city: null,
      websiteUrl: "https://example.com/",
    };
    expect(profileHasDrifted(entity, profile)).toBe(false);
  });

  it("a genuinely different host IS drift", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", website: "https://newsite.example" };
    const profile: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: null,
      city: null,
      websiteUrl: "https://oldsite.example",
    };
    expect(profileHasDrifted(entity, profile)).toBe(true);
  });

  it("an unparseable private value falls back to a raw string compare", () => {
    const entity: EntitySnapshot = { name: "Acme Ltd", website: "ask the office" };
    const same: ProfileSnapshot = {
      displayName: "Acme Ltd",
      country: null,
      city: null,
      websiteUrl: "ask the office",
    };
    const different: ProfileSnapshot = { ...same, websiteUrl: "https://example.com" };
    expect(profileHasDrifted(entity, same)).toBe(false);
    expect(profileHasDrifted(entity, different)).toBe(true);
  });
});
