import { describe, expect, it } from "vitest";
import { readSource as read } from "../../support/source";

// THE RELATIONSHIP-LAYER LISTS ARE ONE LIST.
//
// The sibling of tests/unit/list/one-restore-queue.test.ts, for the live side
// of the soft-delete line, and it exists for the same reason: collapsing five
// copies into components/list/entity-list-page.tsx fixes the duplication that
// existed and does nothing about the sixth entity. The agencies copy said out
// loud that it was "app/(app)/[orgSlug]/companies/page.tsx with the spec, the
// nouns and the columns changed", and four pages arrived that way.
//
// A SOURCE CENSUS, with the limit those files all state: it says the shared
// implementation is the one being CALLED, not that it is correct. What the
// factory actually renders is covered by the golden paths, the axe scans and
// -- for the property that motivated the shared Suspense key -- the keyboard
// suite.

const LISTS = [
  "app/(app)/[orgSlug]/contacts/page.tsx",
  "app/(app)/[orgSlug]/companies/page.tsx",
  "app/(app)/[orgSlug]/artists/page.tsx",
  "app/(app)/[orgSlug]/agencies/page.tsx",
  "app/(app)/[orgSlug]/venues/page.tsx",
];
const FACTORY = "components/list/entity-list-page.tsx";

describe("the relationship-layer lists share one frame", () => {
  it("all five call the factory", () => {
    for (const rel of LISTS) {
      expect(read(rel), `${rel} must call entityListPage`).toContain(
        "entityListPage(",
      );
    }
  });

  it("none of them re-implements the frame the factory owns", () => {
    // A page importing the toolbar, the skeleton, the fetcher or the
    // write-access read is drifting back out of the shared frame one element
    // at a time -- which is how there came to be five copies.
    //
    // `NewRecordAction` is NOT in this list and must not be: the empty state's
    // button carries a different label and a different id from the heading's,
    // so each page legitimately renders its own.
    const owned = [
      "ListToolbar",
      "ListSkeleton",
      "fetchListPage",
      "getCrmWriteAccess",
      "parseListParams",
      "isRecordScopedRole",
    ];
    for (const rel of LISTS) {
      const src = read(rel);
      for (const symbol of owned) {
        expect(
          src.includes(symbol),
          `${rel} references ${symbol}, which ${FACTORY} owns`,
        ).toBe(false);
      }
    }
  });

  it("the owner filter reads the session, never the query string", () => {
    // It was byte-identical in all five callers before the factory existed,
    // which is why it moved wholesale rather than becoming a prop. The
    // property that matters is unchanged and worth one assertion now that
    // there is one place to make it: the id comes from `getCurrentUser()`.
    const src = read(FACTORY);
    expect(src).toContain("getCurrentUser()");
    expect(src).toContain('query.eq("owner_user_id", user.id)');
  });

  it("the factory keys its boundary on the toolbar's params, not the cursor", () => {
    // The measured reason the key is split this way: keying on the full URL
    // remounted the pager and dropped focus to <body> on every page click.
    // Five copies were five chances to get it wrong; one copy earns one guard.
    const src = read(FACTORY);
    expect(src).toContain("listParams.q");
    expect(src).toContain("listParams.filters");
    expect(src).toContain("listParams.pageSize");
    expect(src).not.toContain("listParams.after");
  });
});
