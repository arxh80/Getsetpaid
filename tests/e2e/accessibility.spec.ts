import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE AUTOMATED ACCESSIBILITY PASS THE PLAN ASKED FOR.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
// Task 8 brief § 3, quoting `CLAUDE.md` § Testing gates: "accessibility
// (automated plus keyboard/screen-reader spot checks)". The first Task 8 round
// ran `python scripts/contrast.py`, a keyboard walk and some DOM measurements,
// and marked the automated row "Partial" -- but `contrast.py` audits the
// DESIGN.md TOKEN CONTRACT. It never loads a page, so it cannot see a missing
// form label, an orphaned `aria-*`, a control below the target size, or the
// nested `<main>` that round found by hand. Its review called that out
// (Important #4) and it is closed here: axe-core over the pages the golden-path
// and tenant-breakout specs already visit, in the same run.
//
// ===========================================================================
// WHAT IT DOES NOT DO
// ===========================================================================
// Automated scanning finds a MINORITY of WCAG failures -- the
// machine-checkable ones. It cannot tell you that a heading is wrong, that
// focus order is illogical, or how a screen reader announces the timeline. The
// screen-reader spot check is STILL outstanding (Task 8 report F-4 and § 7
// item 2). This does not close it and must not be read as closing it.
//
// ===========================================================================
// THE TAG SET, AND WHY `best-practice` IS IN IT
// ===========================================================================
// The five WCAG tags are the mandated set. `best-practice` is added, and the
// reason is measured rather than assumed: with the five WCAG tags alone this
// suite reported ZERO violations on every page INCLUDING the in-app 404 --
// the page whose two nested `<main>` landmarks the first Task 8 round found by
// hand and filed as F-4. axe classifies every `landmark-*` rule as
// best-practice, not as a WCAG success criterion, so a WCAG-tagged run cannot
// see a real defect this project already knows about. Adding the tag turned
// that page red with three rules (enumerated below) and left every other page
// green, so the tag costs nothing and buys the one finding that mattered.
const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

interface Deferred {
  rule: string;
  why: string;
}

/**
 * Scan one page.
 *
 * `deferred` is an ENUMERATED, PER-PAGE exclusion list, never a blanket skip
 * and never global: a rule disabled for the 404 page stays armed on every
 * other page. Each entry names a violation this scan actually found and that
 * Task 8 deliberately did not fix, with a pointer into FOLLOW-UPS.md.
 */
async function scan(page: Page, label: string, deferred: Deferred[] = []) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .disableRules(deferred.map((d) => d.rule))
    .analyze();

  // NON-VACUITY CONTROL. An AxeBuilder pointed at a page that never rendered,
  // or a tag set that matches no rule, returns zero violations and looks
  // identical to a clean page. `passes` is the denominator: a scan that
  // evaluated nothing is exactly the failure this task exists to catch.
  expect(
    results.passes.length,
    `${label}: axe evaluated no rules at all, so "0 violations" means nothing`,
  ).toBeGreaterThan(0);

  // VERBATIM, because the exit document quotes it. Rule id, impact, help URL
  // and every failing selector -- an assertion that only says "3 violations"
  // is one nobody can act on.
  for (const v of results.violations) {
    console.log(
      `AXE ${label} :: ${v.id} [${v.impact}] ${v.help}\n` +
        `     ${v.helpUrl}\n` +
        v.nodes
          .map(
            (n) =>
              `     - ${n.target.join(" ")}\n       ${n.failureSummary?.replace(/\n/g, "\n       ")}`,
          )
          .join("\n"),
    );
  }
  expect(
    results.violations.map((v) => `${label}: ${v.id} (${v.nodes.length} nodes)`),
  ).toEqual([]);
}

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

test("the signed-out login page has no automated accessibility violations", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await scan(page, "/login");
});

test("the golden-path pages have no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  // The same surfaces golden-path.spec.ts walks: a list, a create form, a
  // detail page with the activity timeline on it, and one create form per
  // remaining entity, because they are separate components rather than one
  // shared form.
  const pages: [string, string][] = [
    ["contacts list", `/${world.orgSlug}/contacts`],
    ["new contact", `/${world.orgSlug}/contacts/new`],
    [
      "contact detail + timeline",
      `/${world.orgSlug}/contacts/${world.managerOwnedContactId}`,
    ],
    ["companies list", `/${world.orgSlug}/companies`],
    ["new company", `/${world.orgSlug}/companies/new`],
    ["new artist", `/${world.orgSlug}/artists/new`],
    ["new venue", `/${world.orgSlug}/venues/new`],
  ];

  for (const [label, url] of pages) {
    await page.goto(url);
    await expect(page.locator("main").first()).toBeVisible();
    await scan(page, label);
  }
});

// THE THREE RULES THE 404 PAGE BREAKS, all one defect: `app/(app)/layout.tsx`
// opens `<main id="main">` and `app/not-found.tsx` opens its own `<main>`
// inside it. Enumerated rather than skipped wholesale, and disabled ONLY on
// this page -- they stay armed on every other surface above, which is what
// stops the pattern spreading.
const NESTED_MAIN: Deferred[] = [
  {
    rule: "landmark-main-is-top-level",
    why: "FOLLOW-UPS: Opened by Task 8 -- nested <main> on the in-app 404 (F-4). Fix is a (app)/not-found.tsx variant; Phase 3.",
  },
  {
    rule: "landmark-no-duplicate-main",
    why: "FOLLOW-UPS: Opened by Task 8 -- the same defect seen from the outer landmark.",
  },
  {
    rule: "landmark-unique",
    why: "FOLLOW-UPS: Opened by Task 8 -- consequence of the same nested <main>: two landmarks with role=main and no distinguishing label.",
  },
];

test("the in-app 404 -- where every refusal lands -- has only the known nested-main violations", async ({
  page,
}) => {
  // NOT AN AFTERTHOUGHT. This is the page a tenant-breakout refusal, a
  // record-scope refusal and a soft-deleted record all render
  // (tenant-breakout.spec.ts), so it is the most-reached error surface in the
  // product.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts/${world.otherOrgContactId}`);
  await expect(page.locator("body")).toContainText("Page not found");

  // CONTROL, so the exclusion list cannot quietly outlive the defect: with the
  // three rules armed this page IS red, and if a Phase 3 fix makes it green
  // this assertion fails and the exclusions get deleted rather than lingering.
  const unfiltered = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze();
  expect(unfiltered.violations.map((v) => v.id).sort()).toEqual(
    NESTED_MAIN.map((d) => d.rule).sort(),
  );

  await scan(page, "in-app 404", NESTED_MAIN);
});
