import { describe, expect, it } from "vitest";

// Field validation for the CRM forms.
//
// The two that are worth testing are the two the brief asks about, and both
// are tested for what they ACCEPT rather than only for what they refuse --
// because the defect a CRM validator actually ships is rejecting real data.
// § 4 of the Task 4 brief names it: "an over-strict email regex on a CRM that
// stores `booking@` aliases and international numbers is its own kind of
// defect."

const {
  checkEmail,
  checkPhone,
  checkName,
  checkShortText,
  checkLongText,
  checkCapacity,
  checkDate,
  parseTags,
  parseGenres,
  formatTags,
  MAX_CAPACITY,
  MAX_LONG_TEXT,
} = await import("@/lib/crm/validate");

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

// ===========================================================================
// TASK 4b
// ===========================================================================

describe("genres: the same rule as tags, and the MESSAGE has to differ", () => {
  // `artists.genres` and `contacts.tags` are the same column twice, so they
  // share an implementation -- but `FieldProblem.field` is the INPUT NAME the
  // message renders beside, and an artist form told "Use 25 tags or fewer"
  // beside an input called `genres` renders it beside nothing at all. That is
  // a WCAG 3.3.1 failure wearing a validation message's clothes, and it is the
  // only thing the shared implementation could get wrong.
  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(parseGenres("Techno, techno, House").genres).toEqual([
      "Techno",
      "House",
    ]);
  });

  it("caps the count, and the problem is keyed to the GENRES input", () => {
    const problem = parseGenres(
      Array.from({ length: 26 }, (_, i) => `g${i}`).join(","),
    ).problem;
    expect(problem?.field).toBe("genres");
    expect(problem?.message).toContain("genres");
    expect(problem?.message).not.toContain("tags");
  });

  it("caps the length, and that message names a genre too", () => {
    const problem = parseGenres("a".repeat(41)).problem;
    expect(problem?.field).toBe("genres");
    expect(problem?.message).toContain("genre");
  });

  it("round-trips through formatTags, which the edit form uses for both", () => {
    const { genres } = parseGenres("techno, house, uk garage");
    expect(parseGenres(formatTags(genres)).genres).toEqual(genres);
  });

  it("treats absent as no genres", () => {
    expect(parseGenres(null)).toEqual({ genres: [], problem: null });
  });

  it("did not change what parseTags says", () => {
    // The shared implementation is only safe if the older caller's messages are
    // untouched. This is the assertion that goes red if the noun leaks.
    const problem = parseTags("a".repeat(41)).problem;
    expect(problem?.field).toBe("tags");
    expect(problem?.message).toContain("tag");
  });
});

describe("capacity: BLANK MEANS UNKNOWN, and never zero", () => {
  // 20260827232510 makes `venues.capacity` nullable and says why: "capacity is
  // frequently unknown when a venue is first entered, and 0 would be a lie
  // that then renders as a real number in the UI". Every obvious
  // implementation gets this wrong -- `Number("")` is 0, and
  // `parseInt("1,200")` is 1.
  it("an empty field is NULL, not 0", () => {
    // `field()` in lib/forms.ts has already turned "" and "   " into null by
    // the time this is called, so null IS the empty case.
    expect(checkCapacity(null)).toEqual({ capacity: null, problem: null });
  });

  it("accepts a whole number", () => {
    expect(checkCapacity("800")).toEqual({ capacity: 800, problem: null });
    expect(checkCapacity("0")).toEqual({ capacity: 0, problem: null });
  });

  it("refuses a thousands separator rather than reading it as 1", () => {
    // `parseInt("1,200")` is 1. Silently storing a 200-capacity venue as 1 is
    // the failure this rejects.
    expect(checkCapacity("1,200").problem?.field).toBe("capacity");
    expect(checkCapacity("1,200").capacity).toBeNull();
  });

  it("refuses a decimal, because the column is `integer`", () => {
    expect(checkCapacity("800.5").problem).not.toBeNull();
  });

  it("refuses a negative, with a sentence rather than a raised 23514", () => {
    expect(checkCapacity("-40").problem?.message).toContain("negative");
  });

  it("refuses something larger than any venue on earth", () => {
    // The cap is 1,000,000 and not `integer`'s 2,147,483,647: the largest
    // stadium on earth holds about 150,000, and a typo has to hit a limit
    // somewhere below the one that raises 22003 from Postgres.
    expect(checkCapacity(String(MAX_CAPACITY)).problem).toBeNull();
    expect(checkCapacity(String(MAX_CAPACITY + 1)).problem?.field).toBe("capacity");
  });

  it("refuses words", () => {
    expect(checkCapacity("about eight hundred").problem).not.toBeNull();
    expect(checkCapacity("800 standing").problem).not.toBeNull();
  });
});

describe("dates: a calendar check, not just a shape check", () => {
  it("accepts a real date and returns THE STRING, not a Date", () => {
    // The value travels to PostgREST as the string the <input type="date">
    // produced. `new Date("2026-03-03")` is UTC midnight, and formatting that
    // in a zone behind Greenwich renders 2 March -- so nothing here parses it.
    const result = checkDate("startedAt", "2026-03-03", "Start date");
    expect(result).toEqual({ value: "2026-03-03", problem: null });
    expect(typeof result.value).toBe("string");
  });

  it("accepts a leap day in a leap year", () => {
    expect(checkDate("endedAt", "2028-02-29", "End date").problem).toBeNull();
  });

  it("REFUSES a date that matches the pattern and does not exist", () => {
    // The case a regex alone lets through. Postgres answers 22008 for this,
    // which reaches the user as a fault rather than as a field error.
    expect(checkDate("endedAt", "2026-02-30", "End date").problem).not.toBeNull();
    expect(checkDate("endedAt", "2027-02-29", "End date").problem).not.toBeNull();
    expect(checkDate("endedAt", "2026-13-01", "End date").problem).not.toBeNull();
  });

  it("refuses the wrong shape", () => {
    expect(checkDate("startedAt", "03/03/2026", "Start date").problem).not.toBeNull();
    expect(checkDate("startedAt", "2026-3-3", "Start date").problem).not.toBeNull();
  });

  it("refuses a year that is a typo rather than a fact", () => {
    expect(checkDate("startedAt", "0202-01-01", "Start date").problem).not.toBeNull();
    expect(checkDate("startedAt", "2201-01-01", "Start date").problem).not.toBeNull();
  });

  it("ACCEPTS A FUTURE DATE -- the § 3(b) decision, as an assertion", () => {
    // Task 4b accepted the future-dated `ended_at` gap rather than forbidding
    // it: a representation that ends on a known date is an ordinary fact
    // people record when they sign it. If a later round decides to reject it,
    // this is the test that says the decision changed.
    expect(checkDate("endedAt", "2099-01-01", "End date")).toEqual({
      value: "2099-01-01",
      problem: null,
    });
  });

  it("absent is absent, not an error", () => {
    expect(checkDate("endedAt", null, "End date")).toEqual({
      value: null,
      problem: null,
    });
  });

  it("names the field it was given, so the message lands beside the input", () => {
    expect(checkDate("endedAt", "nonsense", "End date").problem?.field).toBe("endedAt");
    expect(checkDate("endedAt", "nonsense", "End date").problem?.message).toContain(
      "End date",
    );
  });
});

describe("long text: a paragraph is allowed, a novel is not", () => {
  it("accepts what MAX_SHORT_TEXT would refuse", () => {
    // The whole reason this exists: `artists.notes` and
    // `venues.technical_info` are meant to hold a paragraph, and 200
    // characters would refuse the thing they are for.
    expect(checkLongText("notes", "a".repeat(1000), "Notes")).toBeNull();
    expect(checkShortText("title", "a".repeat(1000), "Role")).not.toBeNull();
  });

  it("caps at MAX_LONG_TEXT", () => {
    expect(checkLongText("notes", "a".repeat(MAX_LONG_TEXT), "Notes")).toBeNull();
    expect(
      checkLongText("notes", "a".repeat(MAX_LONG_TEXT + 1), "Notes")?.field,
    ).toBe("notes");
  });

  it("does NOT strip anything -- it is a length cap, not a sanitiser", () => {
    // Both columns are rendered as TEXT (React escapes them), never as HTML.
    // Stripping here would silently rewrite what a user typed about their own
    // venue, and would be the wrong layer for it anyway.
    const hostile = "<script>alert(1)</script> load-in via the back";
    expect(checkLongText("technicalInfo", hostile, "Technical information")).toBeNull();
  });

  it("absent is absent", () => {
    expect(checkLongText("notes", null, "Notes")).toBeNull();
  });
});
