// Task 4b fix round 1, I-1: which of a representation panel's rows earn a
// "clear primary" control, and what to call each one.
//
// A plain module, not "use server" and not a Client Component -- deliberately,
// so this is drivable from a node vitest the way the rest of tests/unit is
// (vitest.config.ts: "pure functions only"). components/crm/representation-panel.tsx
// imports it; nothing here imports React, Next or Supabase.
//
// ===========================================================================
// THE DEFECT: ONE SHARED CONTROL, PICKING `rows[0]`
// ===========================================================================
// A representation panel lists rows from ONE anchor's point of view -- an
// artist's agencies, or an agency's artists. On the ARTIST side every row
// shares that one artist_id, and
// `artist_representations_one_current_primary_per_artist` is a partial UNIQUE
// index ON artist_id -- so AT MOST ONE row on that page can ever be "current"
// at once. A single "clear primary" control there is unambiguous by
// construction.
//
// On the AGENCY side that guarantee says nothing at all: an agency's roster is
// many DIFFERENT artists, and an agency can ordinarily be the current primary
// for more than one of them at the same time. The reviewed version picked
// `rows[0]?.artistId` for the one shared control in that case -- an
// ARBITRARY, order-dependent row that happened to work only because
// `sortRepresentations` (lib/crm/queries.ts) sorts a current primary first,
// a coupling stated nowhere. With two artists both current on the same agency
// it picked one of them silently, with no way for the user to tell which.
//
// ===========================================================================
// THE FIX: NOTHING IS PICKED
// ===========================================================================
// `resolveClearPrimaryTargets` returns one target PER row that is currently
// primary, rather than reducing the list to one arbitrary id first. "One
// target" (the artist page) and "several targets" (an agency's roster) are
// the same code path, and each target carries the artist's own id and name --
// no `rows[0]`, no `.find()` whose result then goes unused.
export interface ClearPrimaryRow {
  artistId: string;
  agencyId: string;
  /**
   * The artist's display name, from the anchor's point of view -- null under
   * the accepted Q3a identifier disclosure (the caller may read the
   * representation but not the artist record it names).
   */
  otherName: string | null;
  primaryState: "current" | "scheduled-end" | "past" | null;
  isRemoved: boolean;
}

export interface ClearPrimaryTarget {
  artistId: string;
  agencyId: string;
  /**
   * Null on the ARTIST side, where the page has exactly one artist and a
   * generic label is unambiguous. The artist's name on the AGENCY side, where
   * it is not.
   */
  artistName: string | null;
}

export function resolveClearPrimaryTargets(
  rows: readonly ClearPrimaryRow[],
  onArtist: boolean,
): ClearPrimaryTarget[] {
  return rows
    .filter((row) => !row.isRemoved && row.primaryState === "current")
    .map((row) => ({
      artistId: row.artistId,
      agencyId: row.agencyId,
      artistName: onArtist ? null : row.otherName,
    }));
}
