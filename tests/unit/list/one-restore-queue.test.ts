import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";

// ONE RESTORE QUEUE, AND A CENSUS THAT SAYS SO.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// The nine `*/deleted/` routes used to be one page copied nine times, and the
// contacts copy predicted its own future in its header: "one more route per
// entity, so Task 4b ships four more. It is a copy of this file with three
// identifiers changed." Four more duly shipped, at 60-77% identical lines.
//
// They now share components/list/deleted-records-page.tsx. The saving is real
// -- 1,842 route lines became 892 -- but the saving is not what this file
// guards. What it guards is the HABIT. Nothing stopped the tenth entity from
// being another copy, and nothing would have told a reviewer it had happened;
// the duplication was invisible precisely because every copy was individually
// correct.
//
// A SOURCE CENSUS, in the same spirit and with the same limits as
// tests/unit/list/one-cursor-only.test.ts: it says the shared implementation is
// the one being called, not that the shared implementation is correct. The
// behaviour lives in the e2e golden paths and the axe scans.
//
// ===========================================================================
// WHAT WOULD BREAK IT, WHICH IS THE POINT
// ===========================================================================
//   * a new `*/deleted/` route that hand-rolls the frame instead of calling
//     the factory -- the copy-a-page habit returning, asserted below.
//   * a route setting `scope: "deleted"` for itself. That option is the one
//     line that puts a list on the far side of the soft-delete boundary, and
//     lib/list/query.ts is emphatic that it is a SERVER-set option a request
//     must never reach. It belongs in one place that a reviewer can check.
//   * the documented exception quietly growing. `documents/deleted` is
//     deliberately not converted (its restore is an inline row control needing
//     an async permission read feeding the COLUMNS); if a second route joins
//     it, the exception list here has to be edited, which is the argument for
//     revisiting the factory rather than a thing to wave through.

const DELETED_ROUTE = /[\\/]deleted[\\/]page\.tsx$/;

/**
 * Deliberately written out rather than sharing the factory.
 *
 * A document has no detail page, so restore is an inline control in the row,
 * and that control needs `manage_documents` -- an async read feeding the
 * columns, not merely a note under the list. Supporting it would add an async
 * `columns`, a permission fetched for nine callers who never read it, and a
 * footer slot: three concepts on every page to serve one.
 */
const EXEMPT = ["app/(app)/[orgSlug]/documents/deleted/page.tsx"];

function deletedRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root + dir)) {
    const rel = `${dir}/${entry}`;
    if (statSync(root + rel).isDirectory()) deletedRoutes(rel, out);
    else if (DELETED_ROUTE.test(rel)) out.push(rel);
  }
  return out;
}

const ROUTES = deletedRoutes("app");
const FACTORY = "components/list/deleted-records-page.tsx";

describe("every restore queue is the same restore queue", () => {
  it("finds them all, so this cannot pass vacuously", () => {
    // THE DENOMINATOR. A census whose scan silently found nothing is a green
    // test that checks nothing -- the failure mode every file in this
    // directory is written to avoid.
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
    expect(ROUTES).toContain("app/(app)/[orgSlug]/contacts/deleted/page.tsx");
    expect(ROUTES).toContain("app/(app)/[orgSlug]/documents/deleted/page.tsx");
  });

  it("each one either calls the factory or is the one documented exception", () => {
    const handRolled = ROUTES.filter(
      (rel) => !read(rel).includes("deletedRecordsPage") && !EXEMPT.includes(rel),
    );
    expect(
      handRolled,
      "a restore queue that does not call deletedRecordsPage. This is the " +
        "copy-a-page habit the factory exists to end -- see " +
        "components/list/deleted-records-page.tsx. If the route genuinely " +
        "cannot use it, add it to EXEMPT here WITH the reason, the way " +
        "documents/deleted is.",
    ).toEqual([]);
  });

  it("the exception list has not grown without anyone noticing", () => {
    // Not a style rule. A second exception means two routes now need
    // something the factory does not give them, which is the point at which
    // the factory should grow that capability rather than the exception list.
    expect(EXEMPT).toHaveLength(1);
    for (const rel of EXEMPT) expect(ROUTES).toContain(rel);
  });

  it("`scope: \"deleted\"` is set in the factory and in the exception, nowhere else", () => {
    // lib/list/query.ts: `scope` is "an option the SERVER sets per route and
    // the request cannot reach". Keeping the number of places it is written
    // small is what makes that claim checkable by reading rather than by
    // trusting.
    const setters = ROUTES.filter((rel) => read(rel).includes('scope: "deleted"'));
    expect(setters).toEqual(EXEMPT);
    expect(read(FACTORY)).toContain('scope: "deleted"');
  });

  it("no converted route re-implements the frame the factory owns", () => {
    // The specific lines that were nine-times duplicated. A route importing
    // ListToolbar or building its own Suspense key is a page drifting back
    // out of the shared frame one element at a time, which is how it got to
    // nine copies in the first place.
    const owned = ["ListToolbar", "ListSkeleton", "fetchListPage", "isNarrowed"];
    for (const rel of ROUTES) {
      if (EXEMPT.includes(rel)) continue;
      const src = read(rel);
      for (const symbol of owned) {
        expect(
          src.includes(symbol),
          `${rel} references ${symbol}, which deleted-records-page.tsx owns`,
        ).toBe(false);
      }
    }
  });

  it("the factory keeps the Suspense key that makes paging not flash", () => {
    // It must remount on a QUERY change and not on a cursor change. Written
    // out nine times this was nine chances to get subtly wrong; written once
    // it is worth one assertion that it is still right.
    const src = read(FACTORY);
    expect(src).toContain("listParams.q");
    expect(src).toContain("listParams.filters");
    expect(src).toContain("listParams.pageSize");
    expect(src).not.toContain("listParams.after");
  });
});
