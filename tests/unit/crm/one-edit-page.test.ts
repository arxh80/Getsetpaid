import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";

// THE EDIT PAGES, AND THE THREE THAT DISAGREE.
//
// The fourth census in this family. Six of the nine `*/edit/` routes share
// components/crm/edit-record-page.tsx; three do not, and this file's real job
// is to keep that split HONEST rather than to police delegation.
//
// ===========================================================================
// THE EXEMPTIONS ARE THE POINT, NOT AN ESCAPE HATCH
// ===========================================================================
// tasks and meetings answer "you opened the edit URL of a deleted record" by
// REDIRECTING to the record page, where Restore lives. The six answer it by
// rendering an Alert that says so. notes goes further: it redirects on deleted
// OR not-the-author OR no-write, and has no blocked note at all.
//
// Three different product answers to one situation. Unifying them inside a
// refactor would have been a product change wearing a refactor's clothes, so
// the disagreement stays visible -- and this file pins it, so that neither
// half drifts unnoticed and so the next person to add an edit route has to
// choose deliberately rather than by copying whichever neighbour they opened.
//
// It also means an entry moving from EXEMPT to the factory is a decision
// somebody made, not something that happened.

const EDIT_ROUTE = /[\\/]edit[\\/]page\.tsx$/;
const FACTORY = "components/crm/edit-record-page.tsx";

/**
 * Edit routes that deliberately do NOT use the factory, with the behaviour
 * that makes each one different. Each is asserted to still HAVE that
 * behaviour, so an exemption cannot outlive its reason.
 */
const EXEMPT = [
  { path: "app/(app)/[orgSlug]/tasks/[taskId]/edit/page.tsx", because: "redirect(" },
  { path: "app/(app)/[orgSlug]/meetings/[meetingId]/edit/page.tsx", because: "redirect(" },
  { path: "app/(app)/[orgSlug]/notes/[noteId]/edit/page.tsx", because: "redirect(" },
] as const;

function editRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root + dir)) {
    const rel = `${dir}/${entry}`;
    if (statSync(root + rel).isDirectory()) editRoutes(rel, out);
    else if (EDIT_ROUTE.test(rel)) out.push(rel);
  }
  return out;
}

const ROUTES = editRoutes("app");
const EXEMPT_PATHS: readonly string[] = EXEMPT.map((e) => e.path);

describe("the edit pages share one frame, and the exceptions stay honest", () => {
  it("finds them all, so this cannot pass vacuously", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(9);
    for (const { path } of EXEMPT) expect(ROUTES).toContain(path);
  });

  it("every non-exempt edit route calls the factory", () => {
    const handRolled = ROUTES.filter(
      (rel) => !EXEMPT_PATHS.includes(rel) && !read(rel).includes("editRecordPage("),
    );
    expect(
      handRolled,
      "an edit route that neither calls editRecordPage nor is a named " +
        "exception. If it genuinely differs, add it to EXEMPT with the " +
        "behaviour that makes it differ -- do not copy a neighbour.",
    ).toEqual([]);
  });

  it("each exemption still has the behaviour it was exempted for", () => {
    // An exemption that stops being true is worse than no exemption: it reads
    // as a considered decision while actually being a page that could have
    // joined the factory and did not.
    for (const { path, because } of EXEMPT) {
      expect(
        read(path).includes(because),
        `${path} is exempt because it uses ${because}, and no longer does. ` +
          "Either it should now use the factory, or the exemption needs a " +
          "new reason.",
      ).toBe(true);
    }
  });

  it("no delegating route re-implements the triage the factory owns", () => {
    const owned = ["getCrmWriteAccess", "outcome === \"unavailable\"", "notFound()", "WriteBlockedNote"];
    for (const rel of ROUTES) {
      if (EXEMPT_PATHS.includes(rel)) continue;
      const src = read(rel);
      for (const symbol of owned) {
        expect(
          src.includes(symbol),
          `${rel} references ${symbol}, which ${FACTORY} owns`,
        ).toBe(false);
      }
    }
  });

  it("the factory keeps unavailable and missing apart", () => {
    // "There is no such agency" is a claim about the customer's data, and
    // making it because the database was unreachable reads as deletion. The
    // error Alert is for `unavailable`; only `missing` gets the 404.
    const src = read(FACTORY);
    const unavailable = src.indexOf('outcome === "unavailable"');
    const missing = src.indexOf('outcome === "missing"');
    expect(unavailable, "the unavailable branch exists").toBeGreaterThan(-1);
    expect(missing, "the missing branch exists").toBeGreaterThan(-1);
    expect(unavailable).toBeLessThan(missing);
    expect(src).toContain('<Alert tone="error">');
    expect(src).toContain("notFound()");
  });

  it("the factory refuses a deleted record before rendering a form", () => {
    // The update actions carry `deleted_at is null`, so a submit from a
    // deleted record's edit page matches no rows and is reported as refused.
    // The page says so before the user types.
    const src = read(FACTORY);
    const deleted = src.indexOf("config.deletedAt(record) !== null");
    const form = src.indexOf("config.form({");
    expect(deleted, "the deleted branch exists").toBeGreaterThan(-1);
    expect(form, "the form slot is called").toBeGreaterThan(-1);
    expect(deleted).toBeLessThan(form);
  });

  it("artists is the only they/them pronoun, and it is declared", () => {
    // The refusal sentence is derived from a noun and a pronoun because all
    // six pages carried one sentence differing only in those. Artists shipped
    // as they/them; flattening it to "it" would be a copy regression that no
    // other assertion here would catch.
    const artists = read("app/(app)/[orgSlug]/artists/[artistId]/edit/page.tsx");
    expect(artists).toContain('pronoun: "they"');
    const theyThem = ROUTES.filter(
      (rel) => !EXEMPT_PATHS.includes(rel) && read(rel).includes('pronoun: "they"'),
    );
    expect(theyThem).toEqual([
      "app/(app)/[orgSlug]/artists/[artistId]/edit/page.tsx",
    ]);
  });
});
