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
// that page red with three rules -- `landmark-main-is-top-level`,
// `landmark-no-duplicate-main`, `landmark-unique` -- and left every other page
// green, so the tag costs nothing and buys the one finding that mattered.
//
// THOSE THREE ARE NOW FIXED (final review I-8: `app/(app)/not-found.tsx`
// renders the 404's markup in a `<div>` instead of a second `<main>`), so the
// per-page exclusion list they justified is gone and every page in this file
// is asserted at zero violations. The tag STAYS: it is what found them, and it
// is the only reason a landmark regression in Phase 3 would be visible at all.
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
  // ===========================================================================
  // THE ONE TEST IN THIS SUITE WITH NO TIME HEADROOM, AND IT IS DECLARED
  // ===========================================================================
  // Seven pages, an axe scan each, against a DEV server -- so every page in the
  // list below pays a first-hit Turbopack compile the first time this suite
  // touches it. Measured at Phase 3 Task 7 on a fully warm server (every route
  // already compiled): 49.6s against the config's 60s budget. Cold, inside a
  // full `pnpm test:e2e` run, it exceeds it and fails with
  // "Test timeout of 60000ms exceeded" -- an EMPTY failure with no violation
  // attached, which reads exactly like an accessibility regression and is not
  // one. It failed that way twice in Task 7's gate runs and passed every time
  // it was run on its own.
  //
  // `test.slow()` triples the budget for this test alone rather than raising
  // `timeout` in playwright.config.ts, because every other test in the suite
  // finishes in seconds and a global raise would hide a real hang in one of
  // them. WHAT IT DOES NOT DO IS MAKE THE SUITE FASTER: the cost is real, it
  // grows with every page added to the list below, and the durable fix is to
  // split this into one test per page so a slow page is named rather than
  // averaged. Filed in FOLLOW-UPS.md.
  test.slow();

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

test("the in-app 404 -- where every refusal lands -- is clean, exclusions and all", async ({
  page,
}) => {
  // NOT AN AFTERTHOUGHT. This is the page a tenant-breakout refusal, a
  // record-scope refusal and a soft-deleted record all render
  // (tenant-breakout.spec.ts), so it is the most-reached error surface in the
  // product.
  //
  // THIS TEST USED TO CARRY AN EXCLUSION LIST. `app/(app)/layout.tsx` opens
  // `<main id="main">` and `app/not-found.tsx` opened its own `<main>` inside
  // it, which axe reported as `landmark-main-is-top-level`,
  // `landmark-no-duplicate-main` and `landmark-unique`. The three rules were
  // disabled for this page and this page only, with a red control asserting
  // that they still fired -- so the exclusions could not outlive the defect.
  //
  // Final review I-8 fixed it with `app/(app)/not-found.tsx`, which renders the
  // same markup in a `<div>`. The control went red, as it was designed to, and
  // the exclusions are deleted. What is left is the assertion the control was
  // protecting: ZERO violations, with no list to be excluded by.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts/${world.otherOrgContactId}`);
  await expect(page.locator("body")).toContainText("Page not found");

  // Explicitly, not only through `scan`: the whole point of I-8 is that this
  // page has exactly ONE `main` landmark, and it is the shell's.
  await expect(page.locator("main")).toHaveCount(1);

  await scan(page, "in-app 404");
});
