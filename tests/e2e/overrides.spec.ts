import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  expireBillingOverride,
  expireFeatureOverride,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 4: BILLING + FEATURE OVERRIDES, THROUGH THE BROWSER.
//
// ===========================================================================
// WHAT THIS FILE IS FOR, GIVEN THAT THE psql SUITE ALREADY EXISTS
// ===========================================================================
// supabase/tests/rls_phase7_overrides.sql proves the DATABASE: the shared
// effective-tier function, the sanctioned-path marker, read-time expiry on
// both sides, downgrade safety (denies a write, deletes nothing) and the
// audit trail. None of that is re-proved here.
//
// Three things are only observable HERE:
//
//   1. THE OPERATOR CAN ACTUALLY DO IT. The psql suite calls the RPCs
//      directly. It cannot tell whether /super/billing reaches them -- step-up,
//      the form fields, the active-override list.
//   2. THE EFFECTIVE TIER ACTUALLY CHANGES WHAT THE CUSTOMER SEES. world.orgId
//      is a real Starter workspace (CLAUDE.md § Subscription tiers: 5 custom
//      fields per entity). Granting a Pro override through the UI is walked
//      all the way to a DIFFERENT SENTENCE on the customer's own settings
//      page ("5 fields used" -> "doesn't limit how many") -- the same
//      lib/entitlements/policy.ts code path every write-access gate in the
//      app calls, so this is not a special case built for the test.
//   3. THE CLOCK IS SHOWN TO THE ORG'S OWN ADMIN, and the feature-override
//      badge that proves the OTHER half of the wiring (CLAUDE.md: "gate
//      nothing existing") is visible to every member, not just admins.
//
// Plus one refusal-parity check and one axe scan, matching every other spec
// in this directory.
//
// ===========================================================================
// SIMULATED EXPIRY, NOT A REAL WAIT
// ===========================================================================
// expireBillingOverride()/expireFeatureOverride() backdate expires_at
// directly in Postgres -- the same "there is no product path that ages a
// clock forward" reasoning organisation-lifecycle.spec.ts's setOrganisationSuspended()
// already documents for suspension. Read-time expiry means the app needs
// nothing else done to it: the very next read simply stops finding the row.
//
// ===========================================================================
// SIBLING SPEC, NOT A REWRITE
// ===========================================================================
// organisation-lifecycle.spec.ts is Task 3 and stays exactly as it is. This
// is the next sibling.

test.describe.configure({ mode: "serial" });

// A FIXED UK WALL CLOCK WITH NO ZONE, far in the future -- events.spec.ts's
// own convention for a `datetime-local` fill, and for the identical reason:
// `<input type="datetime-local">` submits a zone-less local string, and
// lib/format/date.ts's londonWallClockToInstant() interprets it as UK LOCAL
// time, not UTC. A COMPUTED `new Date(...).toISOString()` is UTC -- filling
// that in directly is off by the BST offset. MEASURED, not assumed: the first
// cut of this file did exactly that, and every grant in every test here
// failed with "Pick a date and time in the future" because the computed
// instant landed at-or-before the real "now" once reinterpreted as London
// time. A fixed, distant literal sidesteps the computation entirely, the same
// way events.spec.ts's GOLDEN_EVENT date does.
const EXPIRES_AT = "2027-06-01T12:00";

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** Copied from organisation-lifecycle.spec.ts rather than shared out of it,
 *  for that file's own stated reason: separate worlds, separate throwaway
 *  accounts. */
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

async function signInAsOrgAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.orgAdmin.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const heading = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(heading).toBeVisible();
  await page.locator('input[name="code"]').fill(totpCode(world.orgAdminTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect([200, 404], `${url} must refuse as 404 or a streamed not-found -- never 403; got ${status}`).toContain(
    status,
  );
  expect(page.url(), `${url} must not bounce an authenticated probe to login`).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText("Superuser");
  await expect(page).not.toHaveTitle(/Superuser/);
}

// ===========================================================================
// THE GOLDEN WALK: A PRO BILLING OVERRIDE ON A STARTER WORKSPACE
// ===========================================================================
test("the golden walk: grant a Pro override → the Starter workspace's own limit lifts → the clock is shown → (simulated) expiry restores it", async ({
  browser,
}) => {
  const operator = await browser.newContext();
  const customer = await browser.newContext();
  // A THIRD context for the org's own Owner/Admin -- NOT a second signInAs
  // call on `customerPage`. Measured: `customerPage` is already signed in as
  // "manager", and navigating an already-authenticated session to /login
  // does not render the email/password form at all (the app redirects it
  // away), so a second sign-in on the same page times out waiting for an
  // input that will never appear. Every persona in this suite gets its own
  // context, the same discipline organisation-lifecycle.spec.ts's operator/
  // customer split already uses -- this is that split with a third party.
  const admin = await browser.newContext();
  const operatorPage = await operator.newPage();
  const customerPage = await customer.newPage();
  const adminPage = await admin.newPage();

  try {
    // ---- BEFORE. world.orgId is really Starter: 5 custom fields per entity.
    await signIn(customerPage, world, "manager");
    await customerPage.goto(`/${world.orgSlug}/settings/custom-fields?entity=contact`);
    await expect(customerPage.getByText(/of\s*5\s*fields used/)).toBeVisible();

    // ---- GRANT, from the operator's own surface. ---------------------------
    await signInAsSuperuser(operatorPage);
    await operatorPage.goto("/super/billing");
    await expect(
      operatorPage.getByRole("heading", { name: "Billing and feature overrides", level: 1 }),
    ).toBeVisible();

    const reason = "Negotiating a Pro-tier annual contract, trial pending signature.";
    await operatorPage
      .locator('form:has-text("Grant a billing override") input[name="organisationSlug"]')
      .fill(world.orgSlug);
    await operatorPage
      .locator('form:has-text("Grant a billing override") select[name="overrideTier"]')
      .selectOption("pro");
    // A FIXED UK WALL CLOCK WITH NO ZONE, far in the future -- the same
    // convention events.spec.ts uses for its own `datetime-local` fill, and
    // for the identical reason: `<input type="datetime-local">` submits a
    // zone-less local string, and lib/format/date.ts's
    // londonWallClockToInstant() interprets it as UK LOCAL time, not UTC.
    // `new Date(...).toISOString()` is UTC -- filling that in directly is off
    // by the BST offset (measured: it landed at-or-before "now" and the form
    // refused with "Pick a date and time in the future").
    await operatorPage
      .locator('form:has-text("Grant a billing override") input[name="expiresAt"]')
      .fill(EXPIRES_AT);
    await operatorPage
      .locator('form:has-text("Grant a billing override") textarea[name="reason"]')
      .fill(reason);
    await operatorPage.getByRole("button", { name: "Grant billing override" }).click();
    await expect(operatorPage.getByText("Billing override granted")).toBeVisible();

    // The operator's own list shows it, with the tier and the reason. SCOPED
    // to the list's own section: the success alert above ALSO names the slug
    // ("Billing override granted for e2e-…"), so an unscoped getByText(slug)
    // is a strict-mode violation (two matches) -- measured.
    const activeBillingList = operatorPage.locator("section", {
      has: operatorPage.getByRole("heading", { name: "Active billing overrides" }),
    });
    await expect(activeBillingList.getByText(world.orgSlug)).toBeVisible();
    await expect(activeBillingList.getByText(reason)).toBeVisible();

    // ---- THE EFFECTIVE TIER ACTUALLY CHANGED. -----------------------------
    await customerPage.goto(`/${world.orgSlug}/settings/custom-fields?entity=contact`);
    await expect(customerPage.getByText(/doesn.t limit how many/)).toBeVisible();

    // ---- THE CLOCK, SHOWN TO THE ORG'S OWN ADMIN. --------------------------
    await signInAsOrgAdmin(adminPage);
    await adminPage.goto(`/${world.orgSlug}`);
    const summary = adminPage.getByTestId("billing-override-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Pro");

    // ---- (SIMULATED) EXPIRY RESTORES THE STARTER DENIAL. -------------------
    await expireBillingOverride(world.orgId);
    await customerPage.goto(`/${world.orgSlug}/settings/custom-fields?entity=contact`);
    await expect(customerPage.getByText(/of\s*5\s*fields used/)).toBeVisible();
    await adminPage.goto(`/${world.orgSlug}`);
    await expect(adminPage.getByTestId("billing-override-summary")).toHaveCount(0);
  } finally {
    // Belt and braces: an override left active would turn every later spec
    // that reads world.orgId's tier into an override assertion.
    await expireBillingOverride(world.orgId);
    await operator.close();
    await customer.close();
    await admin.close();
  }
});

// ===========================================================================
// FEATURE OVERRIDES: THE ONE CONSUMER THAT PROVES THE WIRING
// ===========================================================================
test("a feature override lights up the early-access badge for every member, and expiry turns it off", async ({
  browser,
}) => {
  const operator = await browser.newContext();
  const customer = await browser.newContext();
  const operatorPage = await operator.newPage();
  const customerPage = await customer.newPage();

  try {
    await signIn(customerPage, world, "standard_user");
    await customerPage.goto(`/${world.orgSlug}`);
    await expect(customerPage.getByText("Early access preview")).toHaveCount(0);

    await signInAsSuperuser(operatorPage);
    await operatorPage.goto("/super/billing");
    await operatorPage
      .locator('form:has-text("Grant a feature override") input[name="organisationSlug"]')
      .fill(world.orgSlug);
    await operatorPage
      .locator('form:has-text("Grant a feature override") select[name="flagKey"]')
      .selectOption("early_access_preview");
    await operatorPage
      .locator('form:has-text("Grant a feature override") input[name="expiresAt"]')
      .fill(EXPIRES_AT);
    await operatorPage
      .locator('form:has-text("Grant a feature override") textarea[name="reason"]')
      .fill("design partner for the new panel");
    await operatorPage.getByRole("button", { name: "Grant feature override" }).click();
    await expect(operatorPage.getByText("Feature override granted")).toBeVisible();

    // ANY MEMBER, not just an admin -- a standard_user sees it too.
    await customerPage.goto(`/${world.orgSlug}`);
    await expect(customerPage.getByText("Early access preview")).toBeVisible();

    await expireFeatureOverride(world.orgId, "early_access_preview");
    await customerPage.goto(`/${world.orgSlug}`);
    await expect(customerPage.getByText("Early access preview")).toHaveCount(0);
  } finally {
    await expireFeatureOverride(world.orgId, "early_access_preview");
    await operator.close();
    await customer.close();
  }
});

// ===========================================================================
// REFUSAL PARITY, AND THE STEP-UP GATE
// ===========================================================================
test("a non-superuser gets the streamed not-found contract at /super/billing", async ({ page }) => {
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/billing");
});

test("an aal1 superuser session reaches no override form", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Enter your two-factor code" })).toBeVisible();
  await page.goto("/super/billing");
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "an aal1 superuser session must not reach the grant forms",
  ).toBeVisible();
  await expect(page.locator('input[name="organisationSlug"]')).toHaveCount(0);
});

// ===========================================================================
// ACCESSIBILITY
//
// Scanned WITH an active override on the page, so the list and its clock are
// in the tree -- an empty-state scan would miss what this task added.
// ===========================================================================
test("/super/billing has no detectable accessibility violations", async ({ page }) => {
  try {
    await signInAsSuperuser(page);
    await page.goto("/super/billing");
    await page
      .locator('form:has-text("Grant a billing override") input[name="organisationSlug"]')
      .fill(world.orgSlug);
    await page
      .locator('form:has-text("Grant a billing override") select[name="overrideTier"]')
      .selectOption("pro");
    await page
      .locator('form:has-text("Grant a billing override") input[name="expiresAt"]')
      .fill(EXPIRES_AT);
    await page
      .locator('form:has-text("Grant a billing override") textarea[name="reason"]')
      .fill("accessibility scan fixture");
    await page.getByRole("button", { name: "Grant billing override" }).click();
    await expect(page.getByText("Billing override granted")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  } finally {
    await expireBillingOverride(world.orgId);
  }
});
