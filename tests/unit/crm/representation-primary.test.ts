import { describe, expect, it } from "vitest";
import {
  resolveClearPrimaryTargets,
  type ClearPrimaryRow,
} from "@/lib/crm/representation-primary";

// The regression test for fix round 1, I-1: `ClearPrimary` used to target
// `rows[0]?.artistId` on the agency side -- an arbitrary, order-dependent
// pick that was genuinely ambiguous whenever two different artists both held
// this agency as their current primary. This asserts the replacement returns
// a target PER current-primary row instead of reducing to one.

function row(overrides: Partial<ClearPrimaryRow>): ClearPrimaryRow {
  return {
    artistId: "artist-1",
    agencyId: "agency-1",
    otherName: "Some Artist",
    primaryState: null,
    isRemoved: false,
    ...overrides,
  };
}

describe("resolveClearPrimaryTargets", () => {
  it("the two-current-primaries case: returns BOTH artists, not rows[0]", () => {
    // An agency's roster: two different artists, each independently current
    // for this agency. The old code picked `rows[0]` and cleared whichever
    // one happened to sort first -- silently. This must name both.
    const rows: ClearPrimaryRow[] = [
      row({
        artistId: "artist-a",
        agencyId: "agency-shared",
        otherName: "Artist A",
        primaryState: "current",
      }),
      row({
        artistId: "artist-b",
        agencyId: "agency-shared",
        otherName: "Artist B",
        primaryState: "current",
      }),
    ];

    const targets = resolveClearPrimaryTargets(rows, false);

    expect(targets).toHaveLength(2);
    expect(targets).toEqual([
      { artistId: "artist-a", agencyId: "agency-shared", artistName: "Artist A" },
      { artistId: "artist-b", agencyId: "agency-shared", artistName: "Artist B" },
    ]);
    // The specific regression: a fix that still reduces to "the first row"
    // would pass a length-1 assertion but fail this one.
    const artistIds = targets.map((t) => t.artistId);
    expect(artistIds).toContain("artist-a");
    expect(artistIds).toContain("artist-b");
  });

  it("the artist side names nobody -- one artist, one unambiguous control", () => {
    const rows: ClearPrimaryRow[] = [
      row({ artistId: "artist-1", agencyId: "agency-1", primaryState: "current" }),
      row({ artistId: "artist-1", agencyId: "agency-2", primaryState: "scheduled-end" }),
    ];

    const targets = resolveClearPrimaryTargets(rows, true);

    expect(targets).toEqual([
      { artistId: "artist-1", agencyId: "agency-1", artistName: null },
    ]);
  });

  it("returns nothing when no row is current", () => {
    const rows: ClearPrimaryRow[] = [
      row({ primaryState: "scheduled-end" }),
      row({ primaryState: "past" }),
      row({ primaryState: null }),
    ];
    expect(resolveClearPrimaryTargets(rows, false)).toEqual([]);
  });

  it("a soft-deleted row does not earn a control even if it is still flagged current", () => {
    const rows: ClearPrimaryRow[] = [
      row({ primaryState: "current", isRemoved: true }),
    ];
    expect(resolveClearPrimaryTargets(rows, false)).toEqual([]);
  });

  it("the Q3a case: the artist name may be null, and the target still carries the id", () => {
    const rows: ClearPrimaryRow[] = [
      row({
        artistId: "artist-hidden",
        agencyId: "agency-1",
        otherName: null,
        primaryState: "current",
      }),
    ];
    expect(resolveClearPrimaryTargets(rows, false)).toEqual([
      { artistId: "artist-hidden", agencyId: "agency-1", artistName: null },
    ]);
  });
});
