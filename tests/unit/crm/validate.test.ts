import { describe, expect, it } from "vitest";

// Field validation for the CRM forms.
//
// The two that are worth testing are the two the brief asks about, and both
// are tested for what they ACCEPT rather than only for what they refuse --
// because the defect a CRM validator actually ships is rejecting real data.
// § 4 of the Task 4 brief names it: "an over-strict email regex on a CRM that
// stores `booking@` aliases and international numbers is its own kind of
// defect."

const { checkEmail, checkPhone, checkName, checkShortText, parseTags, formatTags } =
  await import("@/lib/crm/validate");

describe("email: permissive on purpose", () => {
  const real = [
    "booking@nightshift.co.uk",
    "info+ra@agency.com",
    "o'brien@example.ie", // an apostrophe in a local part is legal
    "a@b.io",
    "first.last@sub.domain.london", // a long new TLD
    "UPPER@Example.COM",
  ];
  for (const value of real) {
    it(`accepts ${value}`, () => {
      expect(checkEmail(value)).toBeNull();
    });
  }

  const wrong = [
    ["no at sign", "nightshift.co.uk"],
    ["no dot in the domain", "booking@localhost"],
    ["embedded space", "book ing@example.com"],
    ["nothing before the at", "@example.com"],
    ["nothing after the dot", "a@b."],
  ] as const;
  for (const [label, value] of wrong) {
    it(`refuses ${label}`, () => {
      expect(checkEmail(value)?.field).toBe("email");
    });
  }

  it("refuses an address over the RFC 5321 path limit", () => {
    expect(checkEmail(`${"a".repeat(250)}@example.com`)?.field).toBe("email");
  });

  it("treats absent as fine -- the column is nullable and unvalidated", () => {
    expect(checkEmail(null)).toBeNull();
  });
});

describe("phone: length and character set, no format", () => {
  const real = [
    "+44 7700 900123",
    "07700 900123",
    "+1 (212) 555-0147",
    "+49 30 901820",
    "020 7946 0958 x12",
    "020.7946.0958",
  ];
  for (const value of real) {
    it(`accepts ${value}`, () => {
      expect(checkPhone(value)).toBeNull();
    });
  }

  it("refuses a pasted sentence", () => {
    expect(checkPhone("call the office and ask for Jo")?.field).toBe("phone");
  });

  it("refuses an injected URL", () => {
    expect(checkPhone("javascript:alert(1)")?.field).toBe("phone");
  });

  it("refuses something too short to be a number", () => {
    expect(checkPhone("999")?.field).toBe("phone");
  });

  it("refuses something too long to be one", () => {
    expect(checkPhone("0".repeat(41))?.field).toBe("phone");
  });

  it("treats absent as fine", () => {
    expect(checkPhone(null)).toBeNull();
  });
});

describe("name", () => {
  it("is required, matching the column's own btrim(name) <> '' check", () => {
    // `field()` normalises a blank input to null before this is called, so
    // null IS the empty case and there is no second branch to keep in step.
    expect(checkName(null)?.message).toBe("Enter a name.");
  });
  it("is capped", () => {
    expect(checkName("a".repeat(201))?.field).toBe("name");
    expect(checkName("a".repeat(200))).toBeNull();
  });
});

describe("short text", () => {
  it("names the field and the label it was given", () => {
    const problem = checkShortText("title", "a".repeat(201), "Role");
    expect(problem?.field).toBe("title");
    expect(problem?.message).toContain("Role");
  });
  it("accepts absent and ordinary values", () => {
    expect(checkShortText("title", null, "Role")).toBeNull();
    expect(checkShortText("title", "Booking agent", "Role")).toBeNull();
  });
});

describe("tags", () => {
  it("splits, trims and drops blanks", () => {
    expect(parseTags(" techno ,, warehouse , ").tags).toEqual([
      "techno",
      "warehouse",
    ]);
  });

  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    // The column is free text by design (20260827232510), so "Techno" and
    // "techno" are the same label typed twice, not two labels.
    expect(parseTags("Techno, techno, TECHNO").tags).toEqual(["Techno"]);
  });

  it("caps the count and the length", () => {
    expect(parseTags(Array.from({ length: 26 }, (_, i) => `t${i}`).join(",")).problem)
      .not.toBeNull();
    expect(parseTags("a".repeat(41)).problem?.field).toBe("tags");
  });

  it("round-trips through formatTags", () => {
    const { tags } = parseTags("techno, warehouse, uk");
    expect(parseTags(formatTags(tags)).tags).toEqual(tags);
  });

  it("treats absent as no tags", () => {
    expect(parseTags(null)).toEqual({ tags: [], problem: null });
    expect(formatTags(null)).toBe("");
    expect(formatTags(undefined)).toBe("");
  });
});
