import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoRoot as root, readSource as read } from "../../support/source";

// EVERY CREATE PAGE IS THE SAME CREATE PAGE.
//
// The third census in this family, after one-restore-queue and
// one-entity-list, and it guards the same habit for the same reason: nine
// `*/new/` routes were one page copied nine times, and nothing would have
// stopped a tenth.
//
// WHAT IT IS REALLY PROTECTING is the route gate. A create route must refuse a
// caller who cannot write, with the SAME sentence the disabled button on the
// list carries -- `getCrmWriteAccess()` produces both. A copy that forgot it
// would render a form, accept typing, and refuse on submit; a copy that
// hard-coded the string instead of reading `access` would drift from the
// button silently. Neither is visible to anything but a browser driven as a
// Read Only user, and there is no e2e test per entity.
//
// A SOURCE CENSUS, with the usual limit: it says the shared implementation is
// the one being called, not that it is correct.

const NEW_ROUTE = /[\\/]new[\\/]page\.tsx$/;

/** Create routes that legitimately do not use the factory. */
const EXEMPT: readonly string[] = [
  // Invoices Task 9: not a CRM record. Its gate is finance (view_finance to
  // see, finance write access + Pro to save, getFinanceReadAccess before
  // anything renders), not the CRM write gate newRecordPage applies, and its
  // form is a line editor with live totals, not one record's fields.
  "app/(app)/[orgSlug]/invoices/new/page.tsx",
];

function newRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root + dir)) {
    const rel = `${dir}/${entry}`;
    if (statSync(root + rel).isDirectory()) newRoutes(rel, out);
    else if (NEW_ROUTE.test(rel)) out.push(rel);
  }
  return out;
}

const ROUTES = newRoutes("app");
const FACTORY = "components/crm/new-record-page.tsx";

describe("every create page is the same create page", () => {
  it("finds them all, so this cannot pass vacuously", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(9);
    expect(ROUTES).toContain("app/(app)/[orgSlug]/contacts/new/page.tsx");
    expect(ROUTES).toContain("app/(app)/[orgSlug]/events/new/page.tsx");
  });

  it("each one calls the factory, or is a named exception", () => {
    const handRolled = ROUTES.filter(
      (rel) => !read(rel).includes("newRecordPage(") && !EXEMPT.includes(rel),
    );
    expect(
      handRolled,
      "a create route that does not call newRecordPage. That is the " +
        "copy-a-page habit returning -- and a copy is where the route gate " +
        "gets forgotten. If the route genuinely cannot use the factory, add " +
        "it to EXEMPT here WITH the reason.",
    ).toEqual([]);
  });

  it("no create route resolves write access for itself", () => {
    // The gate belongs to the factory. A route reading `getCrmWriteAccess`
    // again is either duplicating the decision or -- worse -- making a second,
    // different one on the same page.
    for (const rel of ROUTES) {
      if (EXEMPT.includes(rel)) continue;
      expect(
        read(rel).includes("getCrmWriteAccess"),
        `${rel} resolves write access itself; ${FACTORY} owns that`,
      ).toBe(false);
    }
  });

  it("the factory gates the route and reuses the button's own explanation", () => {
    // The two halves of "gated, not only the button that leads to it": the
    // form renders only behind `canWrite`, and the refusal is
    // `WriteBlockedNote` fed the SAME `access` object -- never a string this
    // page invented, which would drift from the disabled button's sentence.
    const src = read(FACTORY);
    expect(src).toContain("access.canWrite");
    expect(src).toContain("<WriteBlockedNote access={access}");
    expect(src).toContain("getCrmWriteAccess(org, config.permissionKey)");
  });

  it("the form slot is called only on the writable branch", () => {
    // `events/new` reads the venue picker inside it. If the slot were invoked
    // unconditionally -- or hoisted above the branch -- a Read Only user would
    // pay for a hundred venues and their rooms to render a page with no
    // <select> on it.
    const src = read(FACTORY);
    const branch = src.indexOf("access.canWrite ? (");
    const slot = src.indexOf("config.form({");
    expect(branch, "the canWrite branch exists").toBeGreaterThan(-1);
    expect(slot, "the form slot is called").toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(branch);
  });
});
