import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateOnly,
  formatDateTime,
  instantToLondonWallClock,
  londonWallClockToInstant,
} from "@/lib/format/date";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("formatDate -- an instant, rendered in UK local time", () => {
  it("renders en-GB day/short-month/year", () => {
    expect(formatDate("2026-03-03T12:00:00.000Z")).toBe("03 Mar 2026");
  });

  it("is Europe/London, not UTC and not the machine's zone", () => {
    // 23:30 UTC on 2 July is 00:30 on 3 July in London (BST). A UTC formatter
    // says the 2nd; the machine's own zone says whatever the machine is set
    // to. This is the assertion that catches a drifted copy.
    expect(formatDate("2026-07-02T23:30:00.000Z")).toBe("03 Jul 2026");
  });

  it("does not shift a winter instant, because London is UTC in January", () => {
    expect(formatDate("2026-01-02T23:30:00.000Z")).toBe("02 Jan 2026");
  });
});

describe("formatDateTime -- the same instant, with a time", () => {
  it("renders day, short month, year and a 24-hour time", () => {
    expect(formatDateTime("2026-03-03T09:05:00.000Z")).toBe("03 Mar 2026, 09:05");
  });

  it("shifts into BST, so the time shown is the time it happened here", () => {
    expect(formatDateTime("2026-07-02T23:30:00.000Z")).toBe("03 Jul 2026, 00:30");
  });
});

describe("formatDateOnly -- a `date` column, with NO timezone conversion", () => {
  // 20260827232510 convention (4): a representation that started on the 3rd
  // started on the 3rd everywhere. `new Date("2026-03-03")` parses as UTC
  // midnight and renders a day earlier west of Greenwich, which is exactly the
  // bug this function exists to avoid.
  it("returns the day that was stored", () => {
    expect(formatDateOnly("2026-03-03")).toBe("03 Mar 2026");
  });

  it("does not move a date that sits on a DST boundary", () => {
    // 29 March 2026 is the day BST begins. A Europe/London formatter fed UTC
    // midnight still says the 29th, but 1 January would not survive a zone
    // west of Greenwich -- both are asserted so neither direction drifts.
    expect(formatDateOnly("2026-03-29")).toBe("29 Mar 2026");
    expect(formatDateOnly("2026-01-01")).toBe("01 Jan 2026");
  });

  it("is a different answer from formatDate for the same calendar day", () => {
    // Not an academic difference: `formatDate("2026-03-03")` parses UTC
    // midnight and renders it in London, which happens to agree here -- but
    // the two take different INPUTS (an instant vs a `date` column) and
    // swapping them is a silent off-by-one-day. The names are the guard.
    expect(formatDateOnly("2026-03-03")).toBe(formatDate("2026-03-03T00:00:00.000Z"));
  });
});

// ===========================================================================
// I-10 / L947 -- THE CENSUS
// ===========================================================================
//
// There were twenty-five copies of these three functions across `app/` and
// `components/` when the final review counted them. The duplication was not
// the danger on its own: the timezone pinning is, and one drifted copy renders
// UTC on one page while every other page renders UK local, with nothing to
// catch it. This is what catches it.
describe("I-10: nothing outside lib/format/ defines a date formatter", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root + dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(path));
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
    }
    return out;
  }

  const DEFINITION = /function\s+(formatDate|formatDateTime|formatDateOnly)\s*\(/;
  const sources = [...walk("app"), ...walk("components"), ...walk("lib")];

  it("finds source files at all, so this cannot pass vacuously", () => {
    expect(sources.length).toBeGreaterThanOrEqual(60);
  });

  it("no second definition anywhere under app/, components/ or lib/", () => {
    // ONE ASSERTION LISTING THE OFFENDERS, not one test per file: there are
    // ~150 source files and a per-file `it` would be 150 near-identical rows in
    // every run for a property with a single failure mode. The message names
    // the file and the line, which is what a reader of a red run needs.
    const offenders = sources
      .filter((file) => file !== "lib/format/date.ts")
      .flatMap((file) => {
        const match = DEFINITION.exec(readFileSync(root + file, "utf8"));
        return match ? [`${file}: ${match[0]}`] : [];
      });
    expect(
      offenders,
      "a second copy of a date formatter is how one page starts showing UTC",
    ).toEqual([]);
  });
});

// ===========================================================================
// PHASE 3 TASK 4 -- THE FORM DIRECTION
// ===========================================================================
//
// THE MUTATION THESE EXIST FOR, stated plainly because it is the whole reason
// the file grew: replace `londonWallClockToInstant`'s body with
//
//     return new Date(value).toISOString();
//
// and on a machine set to Europe/London the July and January cases still pass.
// They are the two a reviewer would have written, and they are the two that
// prove nothing. What that mutant CANNOT do is the two transition days, where
// the offset is not a function of the date alone -- and on a CI box running
// UTC (which is every CI box) it fails all four.
//
// Every assertion below is an absolute UTC instant computed from
// `Intl.DateTimeFormat`'s own transition data, so this file's result does not
// depend on `TZ` where it runs. That is the point: so is the implementation's.
//
// The four dates are the brief's: a BST date, a GMT date, and both 2026
// transitions -- 29 March (01:00 UTC, clocks forward, 01:00-02:00 local does
// not exist) and 25 October (01:00 UTC, clocks back, 01:00-02:00 local happens
// twice).

describe("londonWallClockToInstant -- a datetime-local value is Europe/London", () => {
  it("a BST evening is stored an hour earlier in UTC", () => {
    // 1 July 2026 is BST (UTC+1). 20:00 in London is 19:00Z.
    expect(londonWallClockToInstant("2026-07-01T20:00")).toBe(
      "2026-07-01T19:00:00.000Z",
    );
  });

  it("a GMT evening is stored unchanged, because London is UTC in January", () => {
    expect(londonWallClockToInstant("2026-01-15T20:00")).toBe(
      "2026-01-15T20:00:00.000Z",
    );
  });

  it("accepts the seconds a datetime-local input may include", () => {
    expect(londonWallClockToInstant("2026-07-01T20:00:30")).toBe(
      "2026-07-01T19:00:30.000Z",
    );
  });

  describe("29 March 2026 -- the clocks go forward at 01:00Z", () => {
    it("before the transition the offset is still zero", () => {
      expect(londonWallClockToInstant("2026-03-29T00:30")).toBe(
        "2026-03-29T00:30:00.000Z",
      );
    });

    it("after the transition the offset is one hour", () => {
      // 12:00 BST is 11:00Z. A naive `new Date()` on a UTC box says 12:00Z.
      expect(londonWallClockToInstant("2026-03-29T12:00")).toBe(
        "2026-03-29T11:00:00.000Z",
      );
    });

    it("01:30, WHICH NEVER HAPPENS, is shifted forward past the gap", () => {
      // Documented in the function: `Temporal`'s "compatible" disambiguation.
      // Returning null here would put "That doesn't look like a date and time"
      // under a string that looks perfectly ordinary.
      const instant = londonWallClockToInstant("2026-03-29T01:30");
      expect(instant).toBe("2026-03-29T01:30:00.000Z");
      // And it reads back as the hour it really became.
      expect(instantToLondonWallClock(instant as string)).toBe(
        "2026-03-29T02:30",
      );
    });
  });

  describe("25 October 2026 -- the clocks go back at 01:00Z", () => {
    it("before the transition the offset is still one hour", () => {
      // 00:30 BST on the 25th is 23:30Z on the 24th -- the day moves too.
      expect(londonWallClockToInstant("2026-10-25T00:30")).toBe(
        "2026-10-24T23:30:00.000Z",
      );
    });

    it("after the transition the offset is zero", () => {
      expect(londonWallClockToInstant("2026-10-25T02:30")).toBe(
        "2026-10-25T02:30:00.000Z",
      );
    });

    it("01:30, WHICH HAPPENS TWICE, resolves to the FIRST occurrence", () => {
      // 00:30Z is 01:30 BST; 01:30Z is 01:30 GMT an hour later. Both are
      // "01:30 on 25 October" in London and the input cannot tell them apart.
      // The earlier one wins, and the assertion is written with both instants
      // named so the choice is visible rather than implied.
      const first = "2026-10-25T00:30:00.000Z";
      const second = "2026-10-25T01:30:00.000Z";
      expect(instantToLondonWallClock(first)).toBe("2026-10-25T01:30");
      expect(instantToLondonWallClock(second)).toBe("2026-10-25T01:30");
      expect(londonWallClockToInstant("2026-10-25T01:30")).toBe(first);
      expect(londonWallClockToInstant("2026-10-25T01:30")).not.toBe(second);
    });
  });

  describe("what it refuses", () => {
    it("returns null for anything that is not a datetime-local value", () => {
      for (const value of [
        "",
        "   ",
        "tomorrow",
        "2026-07-01",
        "2026-07-01 20:00",
        "01/07/2026 20:00",
        "2026-07-01T20:00Z",
        "2026-07-01T20:00+01:00",
      ]) {
        expect(londonWallClockToInstant(value), value).toBeNull();
      }
    });

    it("returns null for a string that matches the shape but is not a day", () => {
      // 2026-02-30 matches the pattern. `Date.UTC` would roll it to 2 March
      // and store an event on a day the user did not choose.
      expect(londonWallClockToInstant("2026-02-30T20:00")).toBeNull();
      expect(londonWallClockToInstant("2026-13-01T20:00")).toBeNull();
      expect(londonWallClockToInstant("2026-07-32T20:00")).toBeNull();
      expect(londonWallClockToInstant("2026-07-01T24:00")).toBeNull();
      expect(londonWallClockToInstant("2026-07-01T20:60")).toBeNull();
    });

    it("returns null for a year outside living memory (the 0202-for-2020 typo)", () => {
      expect(londonWallClockToInstant("0202-07-01T20:00")).toBeNull();
      expect(londonWallClockToInstant("9999-07-01T20:00")).toBeNull();
      // ...and the bounds themselves are inside.
      expect(londonWallClockToInstant("1900-07-01T20:00")).not.toBeNull();
      expect(londonWallClockToInstant("2200-07-01T20:00")).not.toBeNull();
    });
  });
});

describe("instantToLondonWallClock -- filling the edit form back in", () => {
  it("renders a BST instant as the local wall clock", () => {
    expect(instantToLondonWallClock("2026-07-01T19:00:00.000Z")).toBe(
      "2026-07-01T20:00",
    );
  });

  it("renders a GMT instant unchanged", () => {
    expect(instantToLondonWallClock("2026-01-15T20:00:00.000Z")).toBe(
      "2026-01-15T20:00",
    );
  });

  it("crosses midnight in the right direction", () => {
    // 23:30Z on 2 July is 00:30 on the 3rd here -- the same case formatDate's
    // own test pins, in the other direction.
    expect(instantToLondonWallClock("2026-07-02T23:30:00.000Z")).toBe(
      "2026-07-03T00:30",
    );
  });

  it("round-trips every unambiguous wall clock", () => {
    for (const wall of [
      "2026-01-15T20:00",
      "2026-07-01T20:00",
      "2026-03-29T00:30",
      "2026-03-29T12:00",
      "2026-10-25T00:30",
      "2026-10-25T02:30",
      "2026-12-31T23:59",
    ]) {
      const instant = londonWallClockToInstant(wall);
      expect(instant, wall).not.toBeNull();
      expect(instantToLondonWallClock(instant as string), wall).toBe(wall);
    }
  });

  it("returns an empty string rather than null for an unreadable value", () => {
    // A `defaultValue` of null makes an uncontrolled input controlled, which
    // React warns about; "" is the honest empty input.
    expect(instantToLondonWallClock("not an instant")).toBe("");
    expect(instantToLondonWallClock("")).toBe("");
  });
});

// ===========================================================================
// THE MUTATION GUARD, AND WHY THE BLOCK ABOVE IS NOT ONE ON ITS OWN
// ===========================================================================
//
// The brief predicted that a naive `return new Date(value).toISOString()`
// "passes the July and January cases on a UK machine and fails the
// transitions". MEASURED, AND IT IS NOT TRUE. On this machine
// (`Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/London"`) V8
// resolves both transition days exactly as `londonWallClockToInstant` does --
// the ambiguous 01:30 to the FIRST occurrence, the non-existent 01:30 shifted
// FORWARD -- so the naive mutant passes all eight of the assertions above,
// including the four the brief nominated as the guard:
//
//     2026-03-29T01:30 -> 2026-03-29T01:30:00.000Z   (agrees)
//     2026-10-25T01:30 -> 2026-10-25T00:30:00.000Z   (agrees)
//
// That is not a coincidence and it is not luck: `new Date(wallClock)` on a box
// whose zone IS Europe/London is asking the same tz database the same
// question. The bug the function exists to prevent is not "the maths is hard",
// it is "the zone is whatever the machine says" -- so a test run only in the
// machine's own zone cannot see it, on any date.
//
// So the table is re-run with `process.env.TZ` moved out from under it. Node
// re-reads TZ for local-time `Date` behaviour after start (verified: the same
// literal yields 19:00Z under Europe/London, 20:00Z under UTC and 00:00Z the
// next day under America/New_York), while `Intl.DateTimeFormat` with an
// EXPLICIT `timeZone` is untouched -- which is the whole design. Under UTC the
// naive mutant fails every row here, including July and January.
//
// TZ is restored in afterAll, and vitest.config.ts sets `fileParallelism:
// false`, so no other suite observes the change.

const ZONE_CASES: readonly (readonly [string, string])[] = [
  ["2026-07-01T20:00", "2026-07-01T19:00:00.000Z"],
  ["2026-01-15T20:00", "2026-01-15T20:00:00.000Z"],
  ["2026-03-29T00:30", "2026-03-29T00:30:00.000Z"],
  ["2026-03-29T01:30", "2026-03-29T01:30:00.000Z"],
  ["2026-03-29T12:00", "2026-03-29T11:00:00.000Z"],
  ["2026-10-25T00:30", "2026-10-24T23:30:00.000Z"],
  ["2026-10-25T01:30", "2026-10-25T00:30:00.000Z"],
  ["2026-10-25T02:30", "2026-10-25T02:30:00.000Z"],
];

describe("the answer does not depend on the server's own timezone", () => {
  const originalTZ = process.env.TZ;
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  for (const zone of ["UTC", "America/New_York", "Australia/Sydney"]) {
    describe(`with TZ=${zone}`, () => {
      beforeAll(() => {
        process.env.TZ = zone;
      });

      it("finds the zone really moved, so this cannot pass vacuously", () => {
        // Without this, a Node that ignored a runtime TZ change would make
        // every assertion below a second copy of the ambient-zone run.
        expect(new Date("2026-07-01T20:00").toISOString()).not.toBe(
          "2026-07-01T19:00:00.000Z",
        );
      });

      for (const [wall, instant] of ZONE_CASES) {
        it(`${wall} is still ${instant}`, () => {
          expect(londonWallClockToInstant(wall)).toBe(instant);
        });
      }

      it("and the inverse still renders London, not the server's clock", () => {
        expect(instantToLondonWallClock("2026-07-01T19:00:00.000Z")).toBe(
          "2026-07-01T20:00",
        );
        expect(instantToLondonWallClock("2026-01-15T20:00:00.000Z")).toBe(
          "2026-01-15T20:00",
        );
      });
    });
  }
});
