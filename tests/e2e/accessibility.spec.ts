import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  FINANCE_LINES,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";

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

// ===========================================================================
// ONE TEST PER PAGE -- THE DURABLE FIX, TAKEN (Phase 3 Task 8)
// ===========================================================================
// This used to be ONE test that walked seven pages under one 60s budget, with
// `test.slow()` tripling it. Task 7 measured that test at 49.6s against 60s on
// a fully WARM dev server and recorded the papering-over honestly: cold, inside
// a full `pnpm test:e2e`, it exceeded the budget and failed with "Test timeout
// of 60000ms exceeded" -- an EMPTY failure with no violation attached, which
// reads exactly like an accessibility regression and is not one. The follow-up
// said the durable fix is one test per page, "worth doing the next time that
// file is opened".
//
// Task 8 opens it and adds FOUR more pages, which is what makes the split
// mandatory rather than tidy: eleven pages under one budget is the same failure
// with more headroom spent. Split, each page pays its own first-hit Turbopack
// compile inside its own 60s and a slow page is NAMED in the report instead of
// being averaged into a total. `test.slow()` is gone.
//
// THE COST IS A SIGN-IN PER TEST. Each test gets a fresh browser context, so
// the session does not carry across; a password sign-in is a form POST and a
// redirect, which is seconds against a first-hit compile of tens of seconds.
// Paying it buys a report that says WHICH page is slow.
const SIGNED_IN_PAGES: [string, (w: E2eWorld) => string][] = [
  ["contacts list", (w) => `/${w.orgSlug}/contacts`],
  ["new contact", (w) => `/${w.orgSlug}/contacts/new`],
  [
    "contact detail + timeline",
    (w) => `/${w.orgSlug}/contacts/${w.managerOwnedContactId}`,
  ],
  ["companies list", (w) => `/${w.orgSlug}/companies`],
  ["new company", (w) => `/${w.orgSlug}/companies/new`],
  ["new artist", (w) => `/${w.orgSlug}/artists/new`],
  ["new venue", (w) => `/${w.orgSlug}/venues/new`],
  // ---- PHASE 3'S FOUR SURFACES (Task 8 brief § 3) ------------------------
  // The list, the create form, a detail page and the deleted list -- the same
  // four shapes the Phase 2 entries above cover, on the entity this phase
  // added. The DETAIL page is the one that earns its place twice over: it is
  // the only page in the product carrying three lib/list/ surfaces at once (the
  // lineup panel, the custom-fields panel and the activity timeline), plus the
  // status chip, so it is where a duplicate `id`, an orphaned
  // `aria-describedby` or a second `role="list"` with no accessible name would
  // land first.
  ["events list", (w) => `/${w.orgSlug}/events`],
  ["new event", (w) => `/${w.orgSlug}/events/new`],
  [
    // ALSO THE THREE-LIST RELATED PANEL (Task 8 brief § 3). The event detail
    // page carries the "Tasks, notes & documents" RelatedPanel — three lists on
    // one page, each with its own pager — and the operations fixtures now link a
    // task and a document to this event, so the panel is POPULATED here rather
    // than rendering three empty states. It is where a duplicate `id`, an
    // orphaned `aria-describedby` on a scan/priority chip, or a second
    // `role="list"` with no accessible name would land first.
    "event detail + lineup + timeline + related panel",
    (w) => `/${w.orgSlug}/events/${w.managerOwnedEventId}`,
  ],
  ["deleted events", (w) => `/${w.orgSlug}/events/deleted`],
  // ---- PHASE 4'S OPERATIONS SURFACES (Task 8 brief § 3) ------------------
  // The list, the create form and a detail page for the operations entity
  // (tasks), plus the notes list, the documents list and its deleted queue.
  // The documents list is the one carrying the SCAN CHIP and the inline
  // download/delete controls; the task detail carries the PRIORITY CHIP, the
  // task-status chip and the entity-link picker.
  ["tasks list", (w) => `/${w.orgSlug}/tasks`],
  ["new task", (w) => `/${w.orgSlug}/tasks/new`],
  ["task detail + link picker", (w) => `/${w.orgSlug}/tasks/${w.taskId}`],
  ["notes list", (w) => `/${w.orgSlug}/notes`],
  ["documents list + scan chips", (w) => `/${w.orgSlug}/documents`],
  ["deleted documents", (w) => `/${w.orgSlug}/documents/deleted`],
  // ---- PHASE 6 (NETWORK), TASK 2 -----------------------------------------
  // "This organisation's own profiles" -- empty for the manager's own
  // workspace here (no company has been published to the network by this
  // suite's fixtures), which is a real and common state: the "Publish a
  // record" picker, the empty-state copy and the list toolbar all render
  // over zero rows. The EDITOR page -- the most consequential screen in the
  // product, with its nine-field publish summary and seven radio ladders --
  // needs a real profile to scan and gets its own dedicated test below,
  // the same shape the finance panel's dedicated test uses.
  ["network profiles list", (w) => `/${w.orgSlug}/network/profiles`],
];

for (const [label, url] of SIGNED_IN_PAGES) {
  test(`${label} has no automated accessibility violations`, async ({ page }) => {
    await signIn(page, world, "manager");
    await page.goto(url(world));
    await expect(page.locator("main").first()).toBeVisible();
    await scan(page, label);
  });
}

// ===========================================================================
// SIDEBAR NAV BUILD: THE RAIL, PINNED OPEN
// ===========================================================================
// Every scan above runs against the sidebar's DEFAULT, COLLAPSED render (none
// of them hover or focus anything before scanning), so none of them can see
// the markup that only exists once it is expanded: the visible heading +
// subheading pair per item, and the group labels
// (components/nav/nav-group.tsx's `sr-only`/visible toggle). Pinning it open
// (a real click on a real button, not a simulated hover that a background
// scan could lose) is the deterministic way to put the rail in that second
// state before scanning -- the same "own dedicated test for a different
// RENDER of a page" shape the finance-panel and network-profile-editor tests
// below already use.
test("a page with the sidebar pinned open has no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts`);

  // REST-STATE REGISTER (re-review N2), measured, not eyeballed: <main>
  // centres itself with `mx-auto` in the flex row's LEFTOVER space, so the
  // rail's 64px footprint pushed the whole content column 32px right of the
  // header's own centred max-w-4xl column until the layout gained a matching
  // trailing spacer. Both columns derive from the same viewport width, so at
  // rest their left edges must coincide -- if this drifts, someone changed
  // one side of the counterweight without the other.
  const headerColumn = page.locator("header > div").first();
  const [headerBox, mainBox] = await Promise.all([
    headerColumn.boundingBox(),
    page.locator("main").boundingBox(),
  ]);
  expect(headerBox, "header column must have a box").not.toBeNull();
  expect(mainBox, "main column must have a box").not.toBeNull();
  expect(
    Math.abs((mainBox?.x ?? 0) - (headerBox?.x ?? 0)),
    "at rest, <main> must sit in register with the header's centred column",
  ).toBeLessThanOrEqual(1);

  const pinButton = page.getByRole("button", { name: "Pin navigation open" });
  await pinButton.click();
  await expect(pinButton).toHaveAttribute("aria-pressed", "true");

  // NON-VACUITY: the rail is genuinely expanded, not just clicked. The
  // subheading text only renders in the expanded state
  // (components/nav/nav-item.tsx), so seeing it proves the scan below is
  // actually exercising the markup this test exists to cover. Both of these
  // are CRM_AREAS entries (lib/nav/areas.ts), rendered unconditionally for
  // every role that reaches an org route -- unlike the Network/Admin groups,
  // there is no permission check to also get right here.
  await expect(page.getByText("People you work with")).toBeVisible();
  await expect(page.getByText("The businesses behind them", { exact: true })).toBeVisible();

  // THE INSET FOCUS RING, ASSERTED FROM THE COMPUTED STYLE, NOT THE
  // STYLESHEET (re-review N1). The rail's ring is inset by an UNLAYERED
  // `nav[aria-label="Primary"] :focus-visible` rule in globals.css, because
  // a Tailwind utility class for the same thing sits in @layer utilities and
  // silently LOSES to the unlayered base ring -- which is exactly what the
  // first cut shipped: a class that read correctly in the source and never
  // applied. A refactor that "tidies" the rule into a layer, or back onto
  // the component as a class, would regress the same invisible way; the
  // computed value on a genuinely keyboard-focused row is the only honest
  // witness. Tab moves focus from the just-clicked pin button onto the
  // rail's first row (keyboard focus is what makes `:focus-visible` match
  // reliably -- a programmatic .focus() leaves that to browser heuristics).
  await page.keyboard.press("Tab");
  const firstNavRow = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /^Overview/ });
  await expect(firstNavRow).toBeFocused();
  expect(
    await firstNavRow.evaluate((el) => window.getComputedStyle(el).outlineOffset),
    "the rail's focus ring must be inset (see globals.css's unlayered rail rule)",
  ).toBe("-2px");

  await scan(page, "contacts list, sidebar pinned open");
});

// ===========================================================================
// PHASE 5'S SURFACE: THE EVENT PAGE WITH THE FINANCE PANEL ON IT
// ===========================================================================
// ITS OWN TEST RATHER THAN A ROW IN THE TABLE ABOVE, and the reason is the
// role. Every page in `SIGNED_IN_PAGES` is scanned as the MANAGER, and a
// manager does not hold `view_finance` (20260903002000: owner, admin and
// finance, nobody else) -- so the manager's event-detail scan above, which is
// the same URL shape, renders NO finance panel at all and cannot see any of
// this. Scanning it needs a session that holds the key, and the finance role is
// MFA-required, so this test also pays for a real TOTP challenge.
//
// It is not a duplicate of that row. "One test per page" is about not putting
// eleven pages under one 60s budget; this is a different RENDER of one page,
// carrying markup no other scan in this file reaches: a summary TABLE with
// `<th scope="row">` headers and a `tabIndex={0}` scroll region, two chip
// vocabularies, a `<details>` edit disclosure per line with a full seven-field
// form inside it, the "Removed from this list" disclosure, and a pager. That is
// where a duplicate `id` (every edit form builds its ids from the entry id), an
// orphaned `aria-describedby` (`finance-blocked` is rendered ONLY when the
// panel is read-only), or a scrollable region with no keyboard access would
// land first.
//
// THE LEDGER EVENT, NOT THE GOLDEN-PATH ONE: it is planted with a fee, an
// income and a soft-deleted line, so the list, the summary and the removed
// disclosure all render with content rather than as empty states.
test("the event page WITH the finance panel has no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/events/${world.proLedgerEventId}`);
  await expect(page.locator("main").first()).toBeVisible();
  // NON-VACUITY: the panel is actually on the page being scanned. Without this
  // the test would report a clean scan of an event page with no finance on it,
  // which is the one thing it must not be able to do.
  await expect(page.getByRole("region", { name: "Finance", exact: true })).toHaveCount(1);
  await expect(page.locator("main")).toContainText(FINANCE_LINES.fixtureFee.description);
  await scan(page, "event detail + finance panel");
});

// ===========================================================================
// PHASE 6'S SURFACE: THE PUBLISH-FIELD EDITOR, POPULATED
// ===========================================================================
// ITS OWN TEST, the same shape as the finance panel's above: no fixture in
// this suite pre-seeds a company or a network profile, so this test creates
// both through the real UI (create a company, then use the "Publish a
// record" picker) before scanning -- otherwise the scan would find an empty
// draft with every field at its default, missing the seven radio ladders,
// the publish summary sentence and the "Hide now" quick actions that only
// render once a field is not hidden.
test("custom-field settings (read-only view) has no automated accessibility violations", async ({
  page,
}) => {
  // ==========================================================================
  // THE SETTINGS AREA HAD NEVER BEEN SCANNED ONCE
  // ==========================================================================
  // SIGNED_IN_PAGES covers lists, create forms, detail pages and the network
  // surfaces. It covers no settings page at all, so nothing under
  // /[orgSlug]/settings was known-good. This closes the read-only half of that.
  //
  // ==========================================================================
  // WHAT THIS CANNOT REACH, AND WHY THAT IS NOT A DETAIL
  // ==========================================================================
  // `manage_custom_fields` is OWNER AND ADMIN ONLY (20260828120000), and this
  // suite has no owner and no admin: `E2eRole` is manager | standard_user |
  // read_only | finance | booker, and sign-in.ts says so outright -- "owner and
  // admin are the other two and nothing here is either".
  //
  // So the EDITABLE render of this page -- the "Add a field" disclosure, and an
  // "Edit" disclosure per definition -- cannot be produced by any role this
  // suite can sign in as. Those are exactly the two controls whose target size
  // failed SC 2.5.8 and which this branch fixes, so THE FIX ITSELF IS NOT
  // COVERED HERE and this test must not be read as covering it.
  //
  // Writing the scan anyway, as a manager, is still worth it: it is the first
  // time anything under /settings has been scanned, and it arms every rule
  // against the read-only render. But a scan that creates a definition and
  // checks the disclosure needs an owner or admin in the shared fixture --
  // both MFA-required (CLAUDE.md § Session security), so it needs the TOTP
  // treatment `finance` already has. That is its own change, and it is the
  // bigger half of this finding: no Owner/Admin-only surface in the product
  // has ever been scanned, by anything.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/settings/custom-fields`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await scan(page, "custom-field settings (read-only)");
});

test("the network profile editor, populated, has no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill("Axe Scan Company");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(
    page.getByRole("heading", { name: "Axe Scan Company", level: 1 }),
  ).toBeVisible();

  await page.goto(`/${world.orgSlug}/network/profiles`);
  await page.locator("#publish-company-entity").selectOption({ label: "Axe Scan Company" });
  await page.locator("#publish-company-name").fill("Axe Scan Company");
  await page.getByRole("button", { name: "Create draft" }).first().click();
  await expect(page.getByRole("link", { name: "Axe Scan Company" })).toBeVisible();
  await page.getByRole("link", { name: "Axe Scan Company" }).click();
  await expect(page.getByRole("heading", { name: "Axe Scan Company", level: 1 })).toBeVisible();

  // Fill TWO values and move BOTH off `hidden` -- fix round 1, I1. A single
  // non-hidden field puts exactly one "Hide … now" quick-hide note on the
  // page, which is why the FIRST version of this test could not have caught
  // I1 (a duplicate `id` shared by every such note): with only one instance
  // mounted, a duplicate id is indistinguishable from a correct one. Two
  // fields is the minimum that puts the regression class within axe's reach.
  await page.locator("#headline").fill("Booking enquiries welcome");
  await page.getByRole("radio", { name: /Everyone on the network/i }).first().click();
  const cityRow = page.locator("li", { has: page.locator("#city") });
  await cityRow.locator("#city").fill("Manchester");
  await cityRow.getByRole("radio", { name: /Everyone on the network/i }).click();
  await page.getByRole("button", { name: "Save" }).click();
  // 4 of 9: the two always-shown fields (name, type) plus headline and city,
  // both just set to `network`.
  await expect(page.getByText(/4 of 9/)).toBeVisible();

  // NON-VACUITY: both quick-hide buttons are really on the page being
  // scanned, each with its OWN accessible name -- the two-instance state I1
  // needed to be reachable at all.
  const hideHeadline = page.getByRole("button", { name: "Hide headline now" });
  const hideCity = page.getByRole("button", { name: "Hide city now" });
  await expect(hideHeadline).toBeVisible();
  await expect(hideCity).toBeVisible();

  // THE BEHAVIOURAL HALF OF I1, IN A REAL BROWSER: each button's
  // `aria-describedby` must point at ITS OWN note, not a shared one. Before
  // the fix both resolved to the same id, so this pair of assertions would
  // have failed with two identical strings.
  const headlineDescribedBy = await hideHeadline.getAttribute("aria-describedby");
  const cityDescribedBy = await hideCity.getAttribute("aria-describedby");
  expect(headlineDescribedBy).not.toBeNull();
  expect(cityDescribedBy).not.toBeNull();
  expect(headlineDescribedBy).not.toBe(cityDescribedBy);
  // ...and the sentence each points at genuinely names ITS OWN field.
  await expect(page.locator(`#${headlineDescribedBy}`)).toContainText("Headline");
  await expect(page.locator(`#${cityDescribedBy}`)).toContainText("City");

  await scan(page, "network profile editor");
});

// ===========================================================================
// TASK 3'S TWO SURFACES: THE DIRECTORY, AND A PROFILE VIEWED BY A FOREIGN
// ORGANISATION
// ===========================================================================
// Both need a PUBLISHED profile with real content -- an empty directory or a
// draft would miss the markup these two routes exist for: the sortable Name
// column and ProfileCard's headline/location/website lines on the directory;
// the "You're connected"-shaped alert slot, ProfileCard again, and the
// disabled "Request connection" shell with its `aria-describedby` note on the
// profile page. ONE TEST, covering both, so the profile this scan needs is
// created and published once and the org switch (manager publishing in
// `world.orgSlug`, then the Pro org's booker viewing it as a stranger) reads
// as one continuous story rather than two tests racing a shared fixture.
test("the network directory and a foreign profile page have no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  // FIX ROUND 1, M2: SUFFIXED, LIKE EVERY NETWORK-PROFILE NAME IN
  // `fixtures.ts`. `world.orgSlug` already carries this run's random suffix
  // (`e2e-<8 hex>`), so reusing it here is free -- and load-bearing for
  // exactly the reason `fixtures.ts`'s own network-profile block gives: the
  // directory this name is published into is the one list in the product
  // with no per-run tenant boundary, so a bare literal collides with any
  // other run's row of the same name, past or concurrent.
  const companyName = `Axe Directory Company ${world.orgSlug}`;

  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill(companyName);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(
    page.getByRole("heading", { name: companyName, level: 1 }),
  ).toBeVisible();

  await page.goto(`/${world.orgSlug}/network/profiles`);
  await page
    .locator("#publish-company-entity")
    .selectOption({ label: companyName });
  await page.locator("#publish-company-name").fill(companyName);
  await page.getByRole("button", { name: "Create draft" }).first().click();
  await page.getByRole("link", { name: companyName }).click();
  await expect(
    page.getByRole("heading", { name: companyName, level: 1 }),
  ).toBeVisible();

  await page.locator("#headline").fill("Booking enquiries welcome");
  await page.getByRole("radio", { name: /Everyone on the network/i }).first().click();
  const cityRow = page.locator("li", { has: page.locator("#city") });
  await cityRow.locator("#city").fill("Manchester");
  await cityRow.getByRole("radio", { name: /Everyone on the network/i }).click();
  const emailRow = page.locator("li", { has: page.locator("#contact_email") });
  await emailRow.locator("#contact_email").fill("axe-scan@example.com");
  await emailRow.getByRole("radio", { name: /Connections only/i }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/4 of 9/)).toBeVisible();
  await page.getByRole("button", { name: "Publish to the network" }).click();
  await expect(page.getByText(/Published\./)).toBeVisible();

  // ---- SURFACE 1: THE DIRECTORY, POPULATED --------------------------------
  await page.goto(`/${world.orgSlug}/network`);
  await expect(page.getByRole("heading", { name: "Network", level: 1 })).toBeVisible();
  const directoryLink = page.getByRole("link", { name: companyName });
  await expect(directoryLink).toBeVisible();
  const profileHref = await directoryLink.getAttribute("href");
  expect(profileHref, "the directory row links somewhere").not.toBeNull();
  await scan(page, "network directory");

  // ---- SURFACE 2: THE SAME PROFILE, VIEWED BY A STRANGER ORGANISATION -----
  // `profileHref` is `/${world.orgSlug}/network/<id>` -- the id is what
  // matters; the org SEGMENT in the URL names the VIEWER's own workspace, not
  // the profile's, so this rebuilds it under the Pro org instead of reusing
  // the manager's own segment.
  const profileId = profileHref!.split("/").pop();
  await signOut(page);
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/network/${profileId}`);
  await expect(
    page.getByRole("heading", { name: companyName, level: 1 }),
  ).toBeVisible();
  // NON-VACUITY: the request control -- the exact markup this scan exists to
  // cover -- is really on the page. ENABLED, not disabled: Task 4 wired the
  // control's action, and booker (proOrgSlug, Pro tier, manage_network_
  // connections, and an own published profile from Task 3's fixtures) is a
  // genuinely capable sender regardless of whether it happens to be
  // connected to THIS particular profile -- that question decides what the
  // PROFILE shows, not whether the viewer may send a request at all.
  const requestButton = page.getByRole("button", { name: "Request connection" });
  await expect(requestButton).toBeVisible();
  await expect(requestButton).toBeEnabled();
  await scan(page, "network profile page (foreign viewer)");
});

// PHASE 6 TASK 4: THE REQUESTS INBOX/OUTBOX.
//
// `world.orgSlug` ("ALPHA") already carries a real row to scan without any
// extra setup here: Task 3's fixture hand-planted `networkAcceptedRequestId`
// FROM orgId TO proOrgId, so the "Sent" list renders one ACCEPTED row (a
// status chip, a counterparty link, a tabular-nums date) and "Received"
// renders its real empty state -- both list states covered by one visit,
// same economy the directory/foreign-profile test above uses.
test("the connection requests page (received and sent) has no automated accessibility violations", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/requests`);
  await expect(
    page.getByRole("heading", { name: "Connection requests", level: 1 }),
  ).toBeVisible();
  // NON-VACUITY: the Sent list's one accepted row is really on the page.
  await expect(page.getByText(world.networkBetaAnchorProfileName)).toBeVisible();
  await scan(page, "connection requests page");
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
