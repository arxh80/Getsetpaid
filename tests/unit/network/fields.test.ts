import { describe, expect, it } from "vitest";
import {
  ALWAYS_NETWORK_FIELDS,
  PUBLISHABLE_FIELDS,
  VISIBILITY_LEVELS,
  isNetworkEntityKind,
  isPublishableField,
  isVisibilityLevel,
  parseFieldVisibility,
  publishSummary,
  visibilityOf,
  type FieldVisibility,
} from "@/lib/network/fields";

// Task 2's own tests over Task 1's vocabulary module: the closed vocabulary
// (already asserted against the database by
// tests/integration/network/field-vocabulary-matches-db.test.ts, which this
// does not repeat) and `publishSummary()`, which Task 2 adds.

describe("the vocabulary is closed, and the two always-network fields have no level", () => {
  it("PUBLISHABLE_FIELDS has exactly seven entries", () => {
    expect(PUBLISHABLE_FIELDS.length).toBe(7);
  });

  it("ALWAYS_NETWORK_FIELDS has exactly two entries, and neither is publishable", () => {
    expect(ALWAYS_NETWORK_FIELDS.length).toBe(2);
    for (const field of ALWAYS_NETWORK_FIELDS) {
      expect(
        isPublishableField(field),
        `${field} is an ALWAYS_NETWORK_FIELD and must not be a settable visibility key`,
      ).toBe(false);
    }
  });

  it("the two sets are disjoint", () => {
    const publishable = new Set<string>(PUBLISHABLE_FIELDS);
    for (const field of ALWAYS_NETWORK_FIELDS) {
      expect(publishable.has(field)).toBe(false);
    }
  });

  it("VISIBILITY_LEVELS has exactly the three levels, least to most exposed", () => {
    expect(VISIBILITY_LEVELS).toEqual(["hidden", "connections", "network"]);
  });

  it("isVisibilityLevel and isPublishableField reject everything outside the vocabulary", () => {
    expect(isVisibilityLevel("netwrok")).toBe(false);
    expect(isVisibilityLevel(null)).toBe(false);
    expect(isPublishableField("display_name")).toBe(false);
    expect(isPublishableField("entity_kind")).toBe(false);
    expect(isPublishableField("phone")).toBe(false);
    expect(isPublishableField(null)).toBe(false);
  });

  it("isNetworkEntityKind rejects a contact -- deliberately absent (Q74)", () => {
    expect(isNetworkEntityKind("contact")).toBe(false);
    expect(isNetworkEntityKind("company")).toBe(true);
  });
});

describe("visibilityOf: an absent key reads as hidden, both directions", () => {
  it("an empty map is all-hidden", () => {
    for (const field of PUBLISHABLE_FIELDS) {
      expect(visibilityOf({}, field)).toBe("hidden");
    }
    expect(visibilityOf(null, "city")).toBe("hidden");
    expect(visibilityOf(undefined, "city")).toBe("hidden");
  });

  it("a stored level is read back exactly", () => {
    expect(visibilityOf({ city: "network" }, "city")).toBe("network");
    expect(visibilityOf({ city: "connections" }, "headline")).toBe("hidden");
  });
});

describe("parseFieldVisibility: defensive about shape as well as vocabulary", () => {
  it("drops an unknown key and an unknown level, keeps the rest", () => {
    const parsed = parseFieldVisibility({
      city: "network",
      phone: "network", // unknown key
      country: "netwrok", // unknown level (typo)
      bio: "connections",
    });
    expect(parsed).toEqual({ city: "network", bio: "connections" });
  });

  it("null, an array, and a non-object all parse to {}", () => {
    expect(parseFieldVisibility(null)).toEqual({});
    expect(parseFieldVisibility([1, 2, 3])).toEqual({});
    expect(parseFieldVisibility("network")).toEqual({});
    expect(parseFieldVisibility(42)).toEqual({});
  });
});

describe("publishSummary: the denominator is 9, not 7", () => {
  it("an all-hidden profile: 2 network (the always-shown pair), 0 connections, 7 hidden, total 9", () => {
    const empty: FieldVisibility = {};
    expect(publishSummary(empty)).toEqual({
      network: 2,
      connections: 0,
      hidden: 7,
      total: 9,
    });
  });

  it("all seven publishable fields at `network`: 9 network, 0 connections, 0 hidden", () => {
    const allNetwork: FieldVisibility = Object.fromEntries(
      PUBLISHABLE_FIELDS.map((f) => [f, "network"]),
    );
    expect(publishSummary(allNetwork)).toEqual({
      network: 9,
      connections: 0,
      hidden: 0,
      total: 9,
    });
  });

  it("all seven publishable fields at `connections`: 2 network, 7 connections, 0 hidden", () => {
    const allConnections: FieldVisibility = Object.fromEntries(
      PUBLISHABLE_FIELDS.map((f) => [f, "connections"]),
    );
    expect(publishSummary(allConnections)).toEqual({
      network: 2,
      connections: 7,
      hidden: 0,
      total: 9,
    });
  });

  it("the mixed fixture the brief's own example sentence describes: 3 of 9 network, 1 connections, 5 hidden", () => {
    // "3 of 9 fields are visible to the whole network; 1 more to accepted
    // connections; 5 are hidden." -- 3 network TOTAL includes the two
    // always-shown fields, so exactly ONE publishable field is at `network`.
    const fixture: FieldVisibility = {
      headline: "network",
      bio: "connections",
      city: "hidden",
      region: "hidden",
      country: "hidden",
      website_url: "hidden",
      contact_email: "hidden",
    };
    expect(publishSummary(fixture)).toEqual({
      network: 3,
      connections: 1,
      hidden: 5,
      total: 9,
    });
  });

  it("null/undefined visibility is the same as an empty map", () => {
    expect(publishSummary(null)).toEqual(publishSummary({}));
    expect(publishSummary(undefined)).toEqual(publishSummary({}));
  });

  it("total is ALWAYS 9, regardless of a partial map's size", () => {
    expect(publishSummary({ city: "network" }).total).toBe(9);
    expect(publishSummary({}).total).toBe(9);
  });
});
