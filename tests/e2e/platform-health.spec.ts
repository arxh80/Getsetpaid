import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  deleteIncidentAlert,
  plantIncidentAlert,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 5: THE PLATFORM HEALTH VIEW, THROUGH THE BROWSER.
//
// ===========================================================================
// WHAT THIS FILE IS FOR, GIVEN THAT TWO OTHER SUITES ALREADY EXIST
// ===========================================================================
// supabase/tests/rls_phase7_rate_limits.sql proves the DATABASE -- the
// policies, the counter arithmetic, the login lockout, the quarantine
// trigger, the snapshot's permission gate and its projection. tests/
// integration/security/rate-limit-network-discovery.test.ts proves the
// LIMITER end to end against a real Postgres through the real page function.
// Neither is re-proved here.
//
// Three things are only observable in a browser:
//
//   1. THE OPERATOR CAN ACTUALLY READ IT. The psql suite calls
//      platform_health_snapshot() directly; it cannot tell whether
//      /super/health reaches it, whether the numbers render, or whether the
//      alert list renders beside them.
//   2. IT IS READ POPULATED. Every assertion below runs with a real alert row
//      in the tree and with real workspaces behind the counts -- the brief is
//      explicit that an empty-state scan misses everything this task adds,
//      and it is right: the alert list, its labels and its Resolve control
//      only exist when there is a row.
//   3. THE REFUSAL IS THE SAME REFUSAL EVERY OTHER /super PAGE GIVES, title
//      included. A static `metadata` export would leak "Superuser" into a
//      non-superuser's streamed 404 even with an empty body -- the Task 1 fix
//      round's finding, re-asserted per route because it is per route.
//
// ===========================================================================
// THE ALERT ROW IS PLANTED, AND THAT IS NOT A SHORTCUT
// ===========================================================================
// public.incident_alerts has no INSERT policy and no INSERT grant for any
// client role: every writer is a SECURITY DEFINER function behind a trigger or
// the limiter, so there is no product path a browser could drive. Driving a
// real crossing here would mean 31 directory page loads in one minute inside
// an already-long suite, to produce a row whose CREATION is already measured
// in two other places. plantIncidentAlert() carries the same reasoning the
// audit-log spec's `auditProbe*` rows do.
//
// ===========================================================================
// SIBLING SPEC, NOT A REWRITE
// ===========================================================================
// overrides.spec.ts is Task 4 and stays exactly as it is. This is the next
// sibling.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

async function signInAsSuperuser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const heading = page.getByRole("heading", {
    name: "Enter your two-factor code",
  });
  await expect(heading).toBeVisible();
  await page
    .locator('input[name="code"]')
    .fill(totpCode(world.superuserTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

/** The streamed not-found contract, byte for byte the one every other /super
 *  spec asserts -- 404 or a streamed 200 carrying the identical document,
 *  never a 403, and never the word that tells a prober the route is real. */
async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${url} must refuse as 404 or a streamed not-found -- never 403; got ${status}`,
  ).toContain(status);
  expect(
    page.url(),
    `${url} must not bounce an authenticated probe to login`,
  ).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText("Superuser");
  await expect(page.locator("body")).not.toContainText("Platform health");
  // THE TITLE IS THE ORACLE. generateMetadata() re-runs isSuperuser(); a
  // static export would carry this string into the refusal regardless of what
  // the body rendered, which is the enumeration leak Task 1 measured.
  await expect(page).not.toHaveTitle(/Superuser/);
  await expect(page).not.toHaveTitle(/Platform health/);
}

// ===========================================================================
// THE OPERATOR READS THE HEALTH VIEW, POPULATED
// ===========================================================================
test("the superuser reads live counts and a real alert row at /super/health", async ({
  page,
}) => {
  const alertSummary = `E2E rate limit crossing ${world.orgSlug}`;
  const alertId = await plantIncidentAlert(world.orgId, alertSummary);

  try {
    await signInAsSuperuser(page);

    // Reached the way an operator reaches it -- through the landing page's
    // own link, not by typing the URL. A page nothing links to is a page
    // nobody finds.
    await page.goto("/super");
    await page.getByRole("link", { name: "Platform health" }).click();
    await expect(page).toHaveURL(/\/super\/health$/);
    await expect(
      page.getByRole("heading", { name: "Platform health", level: 1 }),
    ).toBeVisible();

    // ---- THE COUNTS ARE REAL NUMBERS, NOT DASHES. -------------------------
    // "—" is this page's honest "could not read one", deliberately different
    // from 0 -- so asserting a DIGIT is what distinguishes a working snapshot
    // from a page that rendered its own failure mode neatly.
    const activeWorkspaces = page
      .locator("div", { has: page.getByText("Active workspaces", { exact: true }) })
      .last();
    await expect(activeWorkspaces).toContainText(/\d/);

    // The world always has at least two organisations (the golden-path
    // workspace and the breakout tenant), so this is a floor the fixture
    // guarantees rather than a number that happens to be there.
    const activeText = await activeWorkspaces.innerText();
    const activeCount = Number(activeText.replace(/\D+/g, ""));
    expect(activeCount).toBeGreaterThanOrEqual(2);

    await expect(page.getByText("Workspace signups, last 7 days")).toBeVisible();
    await expect(page.getByText("Active memberships")).toBeVisible();
    await expect(page.getByText("Open incident alerts")).toBeVisible();

    // ---- THE TASK A M2 CAVEAT IS ON THE PAGE. -----------------------------
    // The backfill stamped seat_count = 1 and a placeholder period end onto
    // every pre-existing workspace. Rendering "Declared seats" without saying
    // so would be this page's own version of the thing SECURITY.md § 5's
    // truth pass exists to prevent.
    // `exact` because the caveat paragraph below also contains the phrase --
    // and asserting both separately is the point: the number and the sentence
    // that qualifies it must BOTH be on the page.
    await expect(page.getByText("Declared seats", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Declared seats, not billed truth/),
      "the seat figure must carry the backfill caveat, not stand as billed truth",
    ).toBeVisible();

    // ---- THE ALERT LIST HAS THE PLANTED ROW IN IT. ------------------------
    await expect(
      page.getByRole("heading", { name: "Incident alerts", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText(alertSummary)).toBeVisible();
    const row = page.locator("li", { hasText: alertSummary });
    // Rendered through its LABEL, not its raw enum value. Scoped to the ROW:
    // since the M5 pager landed, the type filter's own <option> carries the
    // same string, and an unscoped match would be asserting on a dropdown
    // entry rather than on the alert.
    await expect(row.getByText("Rate limit tripped")).toBeVisible();

    // ---- THE FILTER NARROWS, AND CLEARING RESTORES. -----------------------
    // Fix round 1, M5: this list used to be a flat 50-row read with no cursor
    // and no filter, which review finding I1's flood turns into "the real
    // alerts are unreachable from the UI". The pager and the two filters are
    // what CLAUDE.md's "Paginate everything" asks for, and a filter nobody
    // drives in a browser is a filter that works in theory.
    await page
      .getByLabel("Alert type")
      .selectOption({ label: "Upload quarantined" });
    await page.getByRole("button", { name: "Filter" }).click();
    // Only the planted row's absence is asserted, not an empty list: other
    // specs in this suite quarantine real uploads, so "no rows at all" would
    // be a claim about what else is running.
    await expect(page.getByText(alertSummary)).toHaveCount(0);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page.getByText(alertSummary)).toBeVisible();

    // ---- ATTRIBUTION AND SEARCH NARROW TOO. -------------------------------
    // The cleanup round's N2 and N3. The attribution filter is the answer to
    // the half of finding I1 that is mitigated rather than closed: the flood
    // an ordinary account can file is ENTIRELY unattributed, so "Attributed
    // to a workspace" is the one click that separates it from everything
    // else. The planted row carries world.orgId, so filtering to the
    // unattributed set must hide it -- driven here rather than argued,
    // because a filter nobody drives in a browser is a filter that works in
    // theory. The search is asserted the same way and for a blunter reason:
    // INCIDENT_ALERT_SPEC declared `searchColumn: "summary"` from the start
    // and nothing applied it, so `q` parsed, survived a "Next" click, and
    // filtered nothing.
    await page
      .getByLabel("Attribution")
      .selectOption({ label: "Not attributed to a workspace" });
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText(alertSummary)).toHaveCount(0);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page.getByText(alertSummary)).toBeVisible();

    await page.getByLabel("Search alerts").fill("no such alert summary");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText(alertSummary)).toHaveCount(0);
    // The positive control: the search MATCHES on a real fragment of the
    // summary, so the assertion above is the filter working rather than the
    // list being empty for some other reason.
    await page.getByLabel("Search alerts").fill(world.orgSlug);
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText(alertSummary)).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page.getByText(alertSummary)).toBeVisible();

    // ---- RESOLVING IS BOOKKEEPING, AND IT WORKS. --------------------------
    await row.getByRole("button", { name: "Resolve" }).click();
    await expect(row.getByRole("button", { name: "Resolve" })).toHaveCount(0);
    await expect(
      page.getByText(alertSummary),
      "a resolved alert stays listed -- it is evidence, and resolving is a flag",
    ).toBeVisible();
    await expect(row).toContainText(/resolved/i);
  } finally {
    await deleteIncidentAlert(alertId);
  }
});

// ===========================================================================
// REFUSAL PARITY, AND THE aal1 GATE
// ===========================================================================
test("a non-superuser gets the streamed not-found contract at /super/health", async ({
  page,
}) => {
  // A MANAGER, deliberately, and for audit-log.spec.ts's stated reason: an
  // Org Owner is MFA-required, so an owner probe would be measuring the MFA
  // challenge rather than the superuser gate. A manager reaches the app at
  // aal1 and is refused by the gate under test and nothing else.
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/health");
});

test("an aal1 superuser session reaches no health numbers", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
  ).toBeVisible();
  await page.goto("/super/health");
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "an aal1 superuser session must not reach the snapshot",
  ).toBeVisible();
  await expect(page.getByText("Active workspaces")).toHaveCount(0);
  await expect(page.getByText("Declared seats")).toHaveCount(0);
});

// ===========================================================================
// ACCESSIBILITY
//
// Scanned WITH an alert on the page, so the list, its labels and its Resolve
// control are all in the tree. An empty-state scan would reach the counts and
// miss every component the alerting half of this task added.
// ===========================================================================
test("/super/health has no detectable accessibility violations", async ({
  page,
}) => {
  const alertId = await plantIncidentAlert(
    world.orgId,
    "E2E accessibility scan fixture",
  );
  try {
    await signInAsSuperuser(page);
    await page.goto("/super/health");
    await expect(
      page.getByText("E2E accessibility scan fixture"),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations,
      JSON.stringify(results.violations, null, 2),
    ).toEqual([]);
  } finally {
    await deleteIncidentAlert(alertId);
  }
});
