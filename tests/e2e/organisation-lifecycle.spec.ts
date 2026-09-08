import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  organisationLifecycleAudit,
  setOrganisationSuspended,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 3: ORGANISATION LIFECYCLE, THROUGH THE BROWSER.
//
// ===========================================================================
// WHAT THIS FILE IS FOR, GIVEN THAT THE psql SUITE ALREADY EXISTS
// ===========================================================================
// supabase/tests/rls_phase7_lifecycle.sql (69 assertions) proves the DATABASE:
// the invariant, consequence P7 against three different attackers, the
// sanctioned-path marker, the audit summary and its correlation thread, and
// both sides of the Q88/Q92/Q101 network clocks. None of that is re-proved
// here.
//
// Three things are only observable HERE:
//
//   1. THE OPERATOR CAN ACTUALLY DO IT. The psql suite calls the RPCs
//      directly. It cannot tell whether /super/organisations reaches them --
//      whether step-up lets the form render, whether the action wires the two
//      fields through, whether the page 404s for the operator who owns it.
//   2. THE CUSTOMER IS TOLD. CLAUDE.md § Superuser dashboard requires these
//      actions to "notify the org's admin", and with no notification subsystem
//      at MVP the banner IS the notification. A banner that renders on some
//      routes, or that says a workspace is read-only without saying for how
//      long the data is kept, is a notification that has not been sent.
//   3. IT IS ACTUALLY REVERSIBLE FROM THE UI. "Shipping suspend without
//      reinstate is a one-way door" is FOLLOW-UPS.md's phrase, and a reinstate
//      that works in psql and not in the browser is that door with a sign on
//      it.
//
// Plus one refusal-parity check and one axe scan, matching every other spec in
// this directory.
//
// ===========================================================================
// WHAT IS DELIBERATELY *NOT* HERE: THE DIRECTORY BOUNDARY
// ===========================================================================
// Q88's "visible until the subscription period ends" and Q92's "gone past the
// retention window" are boundaries in TIME, and moving a browser across one
// means rewriting `organisation_subscriptions.current_period_end` mid-spec and
// hoping no cache sits between the edit and the render. Both sides of both
// clocks are asserted where they can be asserted honestly:
// rls_phase7_lifecycle.sql § LN drives the predicate, and
// network_leakage_phase6.sql § LJ drives the DIRECTORY VIEW from a real
// counterparty's session with only `current_period_end` moving. This file
// would add a slower, flakier third copy of the same measurement.
//
// ===========================================================================
// SIBLING SPEC, NOT A REWRITE
// ===========================================================================
// `impersonation.spec.ts` and `audit-log.spec.ts` are Tasks 2 and 1 and stay
// exactly as they are. This is the next sibling; whoever extends the set adds
// another rather than rewriting these.

// SERIAL, AND NOT ONLY BECAUSE playwright.config.ts ALREADY SETS workers: 1.
// Every test in this file changes the lifecycle state of the ONE workspace the
// shared world provides, and a suspended workspace turns every later assertion
// anywhere into a suspension assertion. Declaring the dependency is better
// than relying on a config value another task could reasonably change.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/**
 * Sign in as the platform superuser.
 *
 * The TOTP step is not optional and it does double duty: the superuser is
 * MFA-required (CLAUDE.md § Session security) so
 * private.has_platform_permission() would refuse an aal1 session outright,
 * AND the `mfa/totp` entry it puts in the JWT's `amr` is seconds old, which is
 * exactly what lib/auth/step-up.ts's five-minute window accepts. So the
 * lifecycle forms render rather than the re-auth prompt -- and the test that
 * the gate is real is the aal1 one at the bottom of this file.
 */
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

/**
 * Sign in as an ADMIN of the customer workspace -- the persona consequence P7
 * is about. `admin` holds `manage_organisation` on a live workspace, so if any
 * un-suspend affordance existed anywhere in the product this is the account
 * that would be offered it. Also MFA-challenged for real: `admin` is one of
 * the roles private.role_requires_mfa() covers.
 *
 * Copied from impersonation.spec.ts rather than shared out of it, deliberately
 * and for that file's own stated reason: the two specs run in separate worlds
 * against separate throwaway accounts, and sharing four lines would make one
 * file's sign-in shape a dependency of the other's.
 */
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

/**
 * The refusal shape audit-log.spec.ts and impersonation.spec.ts both assert,
 * copied for the same reason they copy each other: DESIGN.md § Error pages'
 * property is "the IDENTICAL document", not "the words 'Page not found' appear
 * somewhere in it". A refusal still carrying the /super chrome or a <title>
 * naming the area would tell a non-superuser the route exists and is
 * superuser-gated -- the enumeration oracle the tenant-isolation rule forbids.
 */
async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${url} must refuse as 404 or a streamed not-found (200) -- never 403; got ${status}`,
  ).toContain(status);
  expect(page.url(), `${url} must not bounce an authenticated probe to login`).not.toMatch(
    /\/login/,
  );
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(
    page.locator("body"),
    `${url}'s refusal must not carry the /super layout's "Superuser" chrome`,
  ).not.toContainText("Superuser");
  await expect(
    page,
    `${url}'s refusal must not carry a <title> that names the superuser area`,
  ).not.toHaveTitle(/Superuser/);
}

// ===========================================================================
// THE GOLDEN LIFECYCLE WALK
// ===========================================================================
// One test, not four. The steps are not independent -- each one's precondition
// is the previous one's effect, and there is one workspace in the world -- so
// four tests would fight over the same row. Every step carries its own
// assertion, so a failure still names the step that broke.
test("the golden walk: suspend → the workspace's own people are told → reopen → it works again", async ({
  browser,
}) => {
  const operator = await browser.newContext();
  const customer = await browser.newContext();
  const operatorPage = await operator.newPage();
  const customerPage = await customer.newPage();

  try {
    // ---- BEFORE. The customer's workspace is ordinary. -------------------
    await signIn(customerPage, world, "manager");
    await customerPage.goto(`/${world.orgSlug}/contacts`);
    await expect(
      customerPage.getByTestId("suspended-banner"),
      "the workspace must start un-suspended, or every assertion below is vacuous",
    ).toHaveCount(0);

    // ---- SUSPEND, from the operator's own surface. -----------------------
    await signInAsSuperuser(operatorPage);
    await operatorPage.goto("/super/organisations");
    await expect(
      operatorPage.getByRole("heading", { name: "Organisations", level: 1 }),
    ).toBeVisible();

    const reason = "Non-payment: invoice 902 is 21 days overdue.";
    await operatorPage
      .locator('form:has-text("Suspend a workspace") input[name="organisationSlug"]')
      .fill(world.orgSlug);
    await operatorPage
      .locator('form:has-text("Suspend a workspace") textarea[name="reason"]')
      .fill(reason);
    await operatorPage.getByRole("button", { name: "Suspend workspace" }).click();
    await expect(operatorPage.getByText("is suspended")).toBeVisible();

    // The workspace now appears in the operator's wound-down list, with the
    // reason they typed -- which is what a colleague reads later instead of
    // asking them.
    await operatorPage.goto("/super/organisations");
    await expect(operatorPage.getByText(reason)).toBeVisible();
    await expect(operatorPage.getByText("Retained until")).toBeVisible();

    // ---- THE CUSTOMER IS TOLD. This is the notification. -----------------
    await customerPage.goto(`/${world.orgSlug}/contacts`);
    const banner = customerPage.getByTestId("suspended-banner");
    await expect(banner).toBeVisible();
    await expect(banner, "what happened").toContainText("Read-only.");
    await expect(banner, "which state").toContainText("suspended");
    await expect(banner, "how long the data is kept").toContainText("Your data is kept until");
    await expect(banner, "that it is reversible, and by whom").toContainText(
      "Contact GetSetPaid support",
    );

    // THE OPERATOR'S REASON *IS* IN IT -- SELF-REVIEW FIX (20260908032000).
    // The first cut withheld it here, on the theory that the operator's
    // phrasing is an internal note. It is not: public.organisations is
    // readable by every active member and RLS filters rows, not columns, so
    // `GET /rest/v1/organisations?select=lifecycle_reason` returned it to any
    // member from a browser while the one screen they actually read hid it.
    // This assertion is what stops that regressing to disclosed-by-accident
    // and withheld-by-design, which is the worst of the three arrangements.
    await expect(
      banner,
      "the reason must be on the screen the customer reads, not only in the API",
    ).toContainText("invoice 902");

    // ...on every route, not just the one. The banner renders from the app
    // shell precisely so no page has to remember it.
    await customerPage.goto(`/${world.orgSlug}/events`);
    await expect(customerPage.getByTestId("suspended-banner")).toBeVisible();

    // ---- REOPEN, from the same surface. ----------------------------------
    await operatorPage.goto("/super/organisations");
    await operatorPage.getByRole("button", { name: "Reopen" }).first().click();
    await operatorPage
      .locator('textarea[name="reason"]')
      .last()
      .fill("Paid in full 2026-09-08.");
    await operatorPage.getByRole("button", { name: "Yes, reopen" }).click();
    await expect(operatorPage.getByText("is active again")).toBeVisible();

    // ---- AFTER. The banner is gone, for the same person, on the same page.
    await customerPage.goto(`/${world.orgSlug}/contacts`);
    await expect(
      customerPage.getByTestId("suspended-banner"),
      "reinstatement must be visible to the customer, not only to the operator",
    ).toHaveCount(0);

    // ---- THE RECORD. Read straight out of Postgres, because nobody can read
    // audit_events through the app except the superuser, and the reason the
    // operator typed is the half that cannot be checked anywhere else.
    const audit = await organisationLifecycleAudit(world.orgId);
    expect(
      audit.map((row) => row.action),
      "both transitions are on the record, in order",
    ).toEqual(["organisation.suspended", "organisation.reinstated"]);
    expect(audit[0].reason, "verbatim, not paraphrased").toBe(reason);
    expect(audit[1].reason).toBe("Paid in full 2026-09-08.");
  } finally {
    // Belt and braces: the walk reinstates through the UI, but a failure
    // halfway would leave the shared world suspended and turn every later
    // spec into a suspension assertion.
    await setOrganisationSuspended(world.orgId, false);
    await operator.close();
    await customer.close();
  }
});

// ===========================================================================
// THE CUSTOMER'S OWN ADMIN STILL CANNOT UNDO IT -- CONSEQUENCE P7, IN A
// BROWSER
// ===========================================================================
// rls_phase7_lifecycle.sql § LP proves the database refuses. This proves the
// PRODUCT does not offer it: the banner names support rather than implying a
// setting exists, and there is no control anywhere in the workspace that would
// change it. A UI that offered a button the database refuses would be a worse
// failure than either half alone.
test("a suspended workspace offers its own Admin no way to undo it", async ({ page }) => {
  try {
    await setOrganisationSuspended(world.orgId, true);
    await signInAsOrgAdmin(page);
    await page.goto(`/${world.orgSlug}`);

    const banner = page.getByTestId("suspended-banner");
    await expect(banner).toBeVisible();
    await expect(
      banner,
      "the copy must not imply an admin can fix it -- consequence P7",
    ).toContainText("It can’t be reversed from inside the workspace");

    // And the operator's surface is not theirs, whatever their role here.
    await expectStreamedRefusal(page, "/super/organisations");
  } finally {
    await setOrganisationSuspended(world.orgId, false);
  }
});

// ===========================================================================
// REFUSAL PARITY, AND THE STEP-UP GATE
// ===========================================================================
test("a non-superuser gets the streamed not-found contract at /super/organisations", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/organisations");
});

test("an aal1 superuser session reaches no lifecycle form", async ({ page }) => {
  // lib/auth/step-up.ts accepts a credential presented in the last five
  // minutes; the fixture cannot wait five minutes, so this drives the half
  // that IS observable. The MFA challenge stands in the way first -- the
  // superuser is MFA-required, so app/(app)/layout.tsx replaces <main>'s
  // content with the challenge screen for every route until a factor is
  // presented. That IS the refusal for this case, and the reason it is a
  // refusal is the gate rather than the page.
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
  ).toBeVisible();
  await page.goto("/super/organisations");
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "an aal1 superuser session must not reach the suspend form",
  ).toBeVisible();
  await expect(page.locator('input[name="organisationSlug"]')).toHaveCount(0);
});

// ===========================================================================
// ACCESSIBILITY -- the 30th scan in the suite.
//
// Scanned WITH a wound-down workspace on the page, so the list, its status
// text and the reveal-confirm's trigger are all in the tree. An empty-state
// scan would miss every component this task actually added.
// ===========================================================================
test("/super/organisations has no detectable accessibility violations", async ({
  page,
}) => {
  try {
    await setOrganisationSuspended(world.orgId, true);
    await signInAsSuperuser(page);
    await page.goto("/super/organisations");
    await expect(
      page.getByRole("heading", { name: "Organisations", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Reopen/ }).first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  } finally {
    await setOrganisationSuspended(world.orgId, false);
  }
});
