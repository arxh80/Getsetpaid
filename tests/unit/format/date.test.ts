import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDate, formatDateOnly, formatDateTime } from "@/lib/format/date";

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

  for (const file of sources) {
    if (file === "lib/format/date.ts") continue;
    it(`${file} imports the formatters rather than defining them`, () => {
      const match = DEFINITION.exec(readFileSync(root + file, "utf8"));
      expect(
        match?.[0] ?? null,
        "a second copy of a date formatter is how one page starts showing UTC",
      ).toBeNull();
    });
  }
});
