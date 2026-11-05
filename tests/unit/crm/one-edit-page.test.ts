import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";

// THE EDIT PAGES, AND THE ONE ANSWER THEY NOW AGREE ON.
//
// The fourth census in this family. Six of the nine `*/edit/` routes share
// components/crm/edit-record-page.tsx; three do not, and this file's real job
// is to keep that split HONEST rather than to police delegation.
//
// ===========================================================================
// THIS FILE USED TO PIN A DISAGREEMENT. IT NOW PINS AN AGREEMENT.
// ===========================================================================
// Nine routes used to give three answers to "you opened the edit URL of a
// deleted record": the six explained it in place, tasks and meetings
// redirected to the record page where Restore lives, and notes redirected on
// deleted OR not-the-author OR no-write without distinguishing them. Which
// answer a user met depended only on which entity they had opened.
//
// An earlier pass deliberately did NOT unify them -- picking one is a product
// decision, and making it inside a refactor would have been a product change
// wearing a refactor's clothes. So the split was pinned instead, exactly so
// the decision would have to be taken rather than drift. It was taken, in
// favour of explaining in place, and the reasoning lives in
// components/crm/deleted-record-notice.tsx.
//
// So the assertions changed shape. EXEMPT below is now about STRUCTURE (these
// three own their own frame) and no longer about BEHAVIOUR, and the behaviour
// is asserted of all nine at once. The remaining exception is notes' redirect
// on authorship, which is a fact about the caller rather than a state of the
// record; it is documented in EXEMPT and nowhere else.

const EDIT_ROUTE = /[\\/]edit[\\/]page\.tsx$/;
const FACTORY = "components/crm/edit-record-page.tsx";

/**
 * Edit routes that do not use the factory.
 *
 * ALL THREE ARE HERE FOR STRUCTURE, NOT FOR BEHAVIOUR, AND THAT DISTINCTION IS
 * NEW. They used to differ in what they DID: tasks and meetings redirected a
 * deleted record to its own page, notes redirected it along with two other
 * conditions, and the six answered in place. Nine routes, three answers, and
 * which one a user met depended only on which entity they were editing.
 *
 * They all explain in place now — `components/crm/deleted-record-notice.tsx` is
 * the single implementation, and the assertion below drives every route against
 * it. What keeps these three out of the factory is only their frame: a
 * single-level breadcrumb and a fixed "Edit task" heading rather than the
 * factory's "Tasks › title" and "Edit {title}". That is a smaller difference
 * than the one that used to be here, and it is cosmetic rather than a
 * disagreement about what the product does.
 */
const EXEMPT = [
  { path: "app/(app)/[orgSlug]/tasks/[taskId]/edit/page.tsx", because: "DeletedRecordNotice" },
  { path: "app/(app)/[orgSlug]/meetings/[meetingId]/edit/page.tsx", because: "DeletedRecordNotice" },
  // notes ALSO redirects, and that part is deliberate: a note is author-only
  // writable (Q54), and "you are not the author" / "you cannot write here" are
  // facts about the CALLER that the note's own page states with context this
  // page does not have. Deleted is a state of the RECORD, and it is explained
  // here like everywhere else.
  { path: "app/(app)/[orgSlug]/notes/[noteId]/edit/page.tsx", because: "DeletedRecordNotice" },
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

  it("every edit route explains a deleted record in place — none redirects", () => {
    // THE ASSERTION THAT REPLACED AN EXEMPTION. It used to check that each
    // exempt route still HAD the redirect that excused it. The redirects are
    // gone, so it now checks the opposite and checks it of all nine: every
    // route reaches the one shared notice, and none answers `deletedAt` with a
    // `redirect`.
    for (const rel of ROUTES) {
      const src = read(rel);
      const usesFactory = src.includes("editRecordPage(");
      // RENDERED, not merely imported, and matched with a boundary. A bare
      // `includes("DeletedRecordNotice")` was satisfied by the import line of
      // a route that had stopped rendering it -- caught by mutation, not by
      // review.
      const usesNotice = /<DeletedRecordNotice[\s/>]/.test(src);
      expect(
        usesFactory || usesNotice,
        `${rel} neither delegates to the factory nor renders ` +
          "DeletedRecordNotice, so it has some third answer for a deleted " +
          "record. Nine routes with three answers is what this file exists " +
          "to have ended.",
      ).toBe(true);

      // The specific regression: a `redirect` in the deleted BRANCH. notes
      // still redirects for AUTHORSHIP, which is a different condition, so a
      // blanket ban on `redirect(` would be wrong here. Reading a window after
      // the `deletedAt` test rather than matching a one-line `if (…) redirect(`
      // is deliberate: the braced form is what a copied neighbour would most
      // likely produce, and a regex pinned to the brace-less spelling would
      // wave it through.
      //
      // Only the three that own their frame are read this way. The six hand
      // `deletedAt` to the factory as a config slot and never write the
      // comparison themselves, so the branch this looks for lives in
      // edit-record-page.tsx -- which "the factory refuses a deleted record
      // before rendering a form" below already pins.
      if (usesFactory) continue;
      const test = src.indexOf("deletedAt !== null");
      expect(test, `${rel} has no deletedAt branch at all`).toBeGreaterThan(-1);
      expect(
        src.slice(test, test + 400).includes("redirect("),
        `${rel} redirects on deletedAt. Deleted is explained in place now ` +
          "-- see components/crm/deleted-record-notice.tsx.",
      ).toBe(false);
    }
  });

  it("the shared notice is the only place that sentence is written", () => {
    const owners = ROUTES.filter((rel) =>
      read(rel).includes("has been deleted, so"),
    );
    expect(
      owners,
      "a route writes the deleted sentence itself instead of rendering " +
        "DeletedRecordNotice",
    ).toEqual([]);
    expect(read("components/crm/deleted-record-notice.tsx")).toContain(
      "has been deleted, so",
    );
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
