import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  FINANCE_LINES,
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";
import { totpCode } from "../support/totp";

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
/**
 * WAIT FOR THE REAL PAGE, NOT FOR `main` (fix round 2, review finding N6).
 *
 * Every signed-in scan in this file used to wait only for
 * `expect(page.locator("main").first()).toBeVisible()`. That is satisfied by
 * the ROUTE'S `loading.tsx`, which renders a skeleton INSIDE the shell's
 * `main` -- so on a slow stream axe could analyse the skeleton instead of the
 * page. It did: a full-suite run failed `contact detail + timeline` on
 * `page-has-heading-one (1 nodes)` and passed the same test in isolation.
 *
 * The failure direction was safe -- no `loading.tsx` in this app contains an
 * `<h1>`, so a scan that caught a skeleton always failed loudly on that rule
 * rather than passing green against a subject that was never rendered -- but a
 * gate that is only accidentally correct is not a gate. Waiting for the page's
 * own `<h1>` makes "the scan saw the real page" structural: the skeleton
 * cannot satisfy it, and the element it waits for is the same one the rule
 * that flaked is about.
 *
 * Deliberately the `<h1>` and not a networkidle/timeout: every page this file
 * scans has exactly one, which is what `page-has-heading-one` asserts, so this
 * is the cheapest witness that is also load-bearing.
 */
async function settled(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

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
  // ---- PHASE 8 TASK 5 (ERASURE) ------------------------------------------
  // /account/erase, scanned as the MANAGER and therefore with its control
  // REACHABLE: a Manager is the last Owner of nothing, so the Q131 warning is
  // absent, the step-up gate is satisfied by the sign-in that just happened,
  // and the typed-confirmation field and its danger button are both in the
  // tree. Scanned as an Owner it would be a page of prose with a disabled
  // button and no field -- the state that proves least.
  ["delete your account", () => "/account/erase"],
  // ---- PHASE 10 TASK 22 ----------------------------------------------------
  // Scanned, never pressed: a global sign-out would end the manager's other
  // sessions mid-run.
  ["sign out everywhere", () => "/account/sessions"],
];

for (const [label, url] of SIGNED_IN_PAGES) {
  test(`${label} has no automated accessibility violations`, async ({ page }) => {
    await signIn(page, world, "manager");
    await page.goto(url(world));
    await settled(page);
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
  // BEFORE THE MEASUREMENT, not just before the scan (fix round 2, N6): the
  // skeleton and the page are different DOM, so measuring the columns' left
  // edges against a still-streaming route would measure the wrong thing.
  await settled(page);

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
  await settled(page);
  // NON-VACUITY: the panel is actually on the page being scanned. Without this
  // the test would report a clean scan of an event page with no finance on it,
  // which is the one thing it must not be able to do.
  await expect(page.getByRole("region", { name: "Finance", exact: true })).toHaveCount(1);
  await expect(page.locator("main")).toContainText(FINANCE_LINES.fixtureFee.description);
  await scan(page, "event detail + finance panel");
});

test("custom-field settings, EDITABLE, has no automated accessibility violations", async ({
  page,
}) => {
  // ==========================================================================
  // THE SETTINGS AREA HAD NEVER BEEN SCANNED ONCE, AND THEN THE FIRST SCAN OF
  // IT COULD NOT SEE THE CONTROLS IT WAS WRITTEN FOR
  // ==========================================================================
  // `SIGNED_IN_PAGES` covers lists, create forms, detail pages and the network
  // surfaces, and no settings page at all. The scan that closed that (#23) had
  // to sign in as a MANAGER, because `manage_custom_fields` is Owner/Admin only
  // (20260828120000) and this suite had neither role -- so the editable render
  // was never in the DOM, the two SC 2.5.8 target-size fixes that commit made
  // were not covered by it, and its own body said so.
  //
  // Phase 7 Task 7 built the missing half: `E2eRole` now carries `owner` and
  // `admin`, both in MFA_REQUIRED_ROLES with real TOTP secrets, so this scan
  // signs in as the Owner and measures the render those fixes are about.
  //
  // ==========================================================================
  // TWO NON-VACUITY CONTROLS, BECAUSE A GREEN SCAN HERE HAS TWO INNOCENT-
  // LOOKING WAYS TO MEAN NOTHING
  // ==========================================================================
  // `CustomFieldEditor` withholds the add form for TWO unrelated reasons, and
  // an axe scan cannot tell either of them from a clean page:
  //
  //   * PERMISSION -- no `manage_custom_fields`, which is what made the first
  //     version of this test green against the pre-fix padding.
  //   * QUOTA -- the workspace is at its tier's custom-field limit, in which
  //     case the string "Add a field" still renders, as a bare <h2> over an
  //     explanation, with no <summary> and no form.
  //
  // So the disclosure is asserted as a `details > summary` (the permission
  // statement) and the at-limit sentence as absent (the tier statement), each
  // with a message naming its own cause -- the same disambiguation
  // super-permissions.spec.ts makes on this page, for the same reason.
  await signIn(page, world, "owner");
  await page.goto(`/${world.orgSlug}/settings/custom-fields?entity=contact`);
  await expect(
    page.getByRole("heading", { name: "Custom fields", level: 1 }),
  ).toBeVisible();

  const addDisclosure = page.locator("details > summary", {
    hasText: "Add a field",
  });
  await expect(
    addDisclosure,
    "the Owner persona reached the page without the control it is gated on, " +
      "so this session does not hold manage_custom_fields and a clean scan " +
      "would only mean the controls were never rendered",
  ).toBeVisible();
  await expect(
    page.getByText("custom fields for this record type are in use"),
    "the workspace is AT its custom-field limit, so the form is withheld for " +
      "a TIER reason and this scan covers none of the controls it is about. " +
      "Free a slot in the fixture rather than reading this as coverage.",
  ).toHaveCount(0);

  // A REAL DEFINITION, CREATED THROUGH THE REAL FORM. The fixture seeds none,
  // and the "Edit" <summary> -- one of the two controls #23 resized -- renders
  // once PER DEFINITION. A bare visit renders zero of them, so the scan would
  // still be measuring a page without its subject on it.
  //
  // `single_select` deliberately: it is the one type whose stored choices
  // render back into the row, so the list item is at its fullest.
  // BY `name=`, NOT BY LABEL TEXT, and that was measured rather than chosen:
  // components/ui/field.tsx appends a visible "Required"/"Optional" word
  // INSIDE the <label>, so the accessible name of the label field is
  // "Label Required" and `getByLabel("Label", { exact: true })` matches
  // nothing at all -- a twenty-second timeout that looks like a missing
  // control rather than a mis-spelled selector. The form's `name` attributes
  // are the same strings the Server Action reads, so they cannot drift from
  // the thing being filled in.
  await addDisclosure.click();
  const addForm = page.locator('form:has(button:text-is("Add field"))');
  await addForm.locator('input[name="label"]').fill("Dressing room tier");
  await addForm.locator('input[name="key"]').fill("dressing_room_tier");
  await addForm.locator('select[name="fieldType"]').selectOption("single_select");
  // The choices box lives inside its OWN collapsed <details>, and a collapsed
  // <details> hides its contents from the renderer as well as from the
  // accessibility tree -- `fill` on it fails as "not visible". Opening it is
  // what a person does too.
  await addForm.locator("summary", { hasText: "Choices" }).click();
  await addForm
    .locator('textarea[name="options"]')
    // `name = What people see`, one per line -- the stored key on the left.
    // A bare label is refused by the form's own validation ("can't be a
    // choice name"), which is the app working, not the scan.
    .fill(["green_room = Green room", "shared = Shared", "none = None"].join("\n"));
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByText("Dressing room tier").first()).toBeVisible();

  // BOTH DISCLOSURES OPEN BEFORE THE SCAN, and that is not tidiness. A
  // collapsed <details> hides its contents from the accessibility tree, so the
  // "Choices" summary inside each form -- the OTHER control #23 resized, whose
  // padding sat on the <details> instead of the <summary> -- is unreachable by
  // axe while its parent is shut. Scanning with them closed is the same
  // vacuity in a different costume.
  const editDisclosure = page.locator("details > summary", {
    hasText: "Edit",
  });
  await expect(
    editDisclosure,
    "no per-definition Edit disclosure rendered after creating a definition, " +
      "so the control this scan exists to measure is not on the page",
  ).toBeVisible();
  // OPEN, NOT TOGGLE. A <summary> click toggles, and the add disclosure is
  // still open after a successful submit (React keeps the DOM node), so a
  // blind click on it SHUT the form -- measured. Each is clicked only if its
  // <details> is not already open.
  for (const summary of [
    editDisclosure,
    page.locator("details > summary", { hasText: "Add a field" }),
  ]) {
    const isOpen = await summary.evaluate(
      (el) => (el.parentElement as HTMLDetailsElement).open,
    );
    if (!isOpen) await summary.click();
  }
  // The two "Choices" summaries -- one in the edit form, one in the add form
  // -- are the OTHER control #23 resized, and they exist in the DOM whether
  // or not their own <details> is open. What they need is a visible ANCESTOR:
  // shut the add or edit disclosure above them and axe cannot see them at all.
  await expect(
    page.locator("summary", { hasText: "Choices" }),
    "the Choices disclosures are not visible, so their parent forms are shut " +
      "and axe cannot evaluate the targets this scan is here to evaluate",
  ).toHaveCount(2);
  await expect(
    page.locator("summary", { hasText: "Choices" }).first(),
  ).toBeVisible();
  await expect(
    page.locator("summary", { hasText: "Choices" }).last(),
  ).toBeVisible();

  await scan(page, "custom-field settings (editable, Owner)");

  // ==========================================================================
  // AXE DOES NOT CATCH THE DEFECT THIS PAGE WAS FIXED FOR -- MEASURED
  // ==========================================================================
  // With #23's padding reverted (the Edit summary bare, the Choices padding
  // back on its <details>) and every disclosure rendered and open, the scan
  // above still PASSED. axe's `target-size` rule exempts an undersized target
  // with enough clear space around it, and these summaries sit alone on their
  // lines -- so a clean scan here says nothing about SC 2.5.8 on them. The
  // rule this page actually needs is the stricter house rule #23 applied
  // (every summary target at least 24px tall), so it is measured directly.
  // Height only: "Edit" is wider than 24px by its text alone, and the
  // Choices summary spans its form.
  const targets = [
    { name: "Edit", locator: editDisclosure },
    ...[0, 1].map((i) => ({
      name: `Choices #${i + 1}`,
      locator: page.locator("summary", { hasText: "Choices" }).nth(i),
    })),
  ];
  for (const { name, locator } of targets) {
    const box = await locator.boundingBox();
    expect(box, `${name} summary has no box, so it was not rendered`).not.toBeNull();
    expect(
      box!.height,
      `${name} summary is ${box!.height}px tall -- under SC 2.5.8's 24px`,
    ).toBeGreaterThanOrEqual(24);
  }

  // PUT THE WORKSPACE BACK. Every later test in this file scans contact
  // surfaces, and a live custom field renders on all of them -- leaving one
  // behind would make an unrelated scan's subject depend on this one having
  // run. Removing is a soft delete, which is enough: the field leaves the
  // forms.
  await page
    .getByRole("button", { name: "Remove Dressing room tier" })
    .click();
  await expect(page.getByText("Removed fields")).toBeVisible();
  await signOut(page);
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

// ===========================================================================
// PHASE 7 TASK 1'S SURFACE: THE SUPERUSER AUDIT LOG, POPULATED
// ===========================================================================
// Its own dedicated test, same shape as the finance panel's above: NOT one
// of the fixed `E2eRole` personas `signIn()` addresses (platform-superuser
// status is `platform_admins` membership, not an organisation role -- see
// tests/e2e/support/fixtures.ts's own header on `world.superuser`), and MFA-
// required, so this test also pays for a real TOTP challenge. It scans the
// route area's own minimal header (app/(app)/super/layout.tsx -- no org
// rail, a different landmark structure from every other page this file
// scans), the five-field filter form, and a POPULATED results table: an
// empty table would miss the `<details>` before/after disclosures, the
// monospace id cells and the pager, which is exactly the markup a duplicate
// `id` or an orphaned `aria-describedby` would land in.
async function signInAsSuperuser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const heading = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(heading).toBeVisible();
  await page.locator('input[name="code"]').fill(totpCode(world.superuserTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

test("the superuser audit log, populated, has no automated accessibility violations", async ({
  page,
}) => {
  await signInAsSuperuser(page);
  await page.goto(
    `/super/audit-log?action=${encodeURIComponent("e2e.audit_probe_alpha")}`,
  );
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  // NON-VACUITY: the filtered probe row is really on the page being scanned.
  await expect(page.locator("main")).toContainText("e2e.audit_probe_alpha");
  await scan(page, "superuser audit log");
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
