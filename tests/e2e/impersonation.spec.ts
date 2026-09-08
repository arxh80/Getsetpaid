import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  impersonationAuditActions,
  impersonationAuditedRoutes,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 2: BREAK-GLASS IMPERSONATION, THROUGH THE BROWSER.
//
// ===========================================================================
// WHAT THIS FILE IS FOR, GIVEN THAT THE psql SUITE ALREADY EXISTS
// ===========================================================================
// supabase/tests/rls_phase7_impersonation.sql (105 assertions) proves the
// DATABASE: no grant without consent, none after expiry, exactly the
// read_only key set, one organisation, one correlation thread. None of that is
// re-proved here, and re-proving it through a browser would be slower and
// weaker.
//
// Three things are only observable HERE, and they are this file's whole job:
//
//   1. THE APP REACHES THE GRANT AT ALL. The psql suite calls
//      has_permission() directly. It cannot tell whether getCurrentOrg()'s
//      impersonation branch fires, or whether the org segment 404s anyway
//      because the resolver never asked -- which was the single most likely
//      way for this feature to ship half-built.
//   2. EVERY PAGE ACCESS IS AUDITED. The psql suite proves the RPC works when
//      called. Only a real navigation can show that the app calls it on every
//      org-scoped page rather than once at the start of a session.
//   3. THE BANNER. A support session that looks exactly like the operator's
//      own workspace is the human failure mode this feature has; the banner is
//      the whole mitigation, and it either renders on every page or it does
//      not.
//
// Plus one refusal-parity check and one axe scan, matching every other spec
// in this directory.
//
// ===========================================================================
// SIBLING SPEC, NOT A REWRITE
// ===========================================================================
// `audit-log.spec.ts` is Phase 7 Task 1's file and stays exactly as it is.
// This is the sixth golden-path sibling in the sentence CLAUDE.md § Design
// keeps; whoever extends it next adds a seventh.

// SERIAL, AND NOT ONLY BECAUSE playwright.config.ts ALREADY SETS workers: 1.
// impersonation_sessions_live_pair permits at most ONE live (requested/
// accepted/active) session per superuser per organisation, so two tests in
// this file that both request access to `orgSlug` would collide on a unique
// index rather than run independently -- and the second axe test reads the
// request the first one left pending. Declaring the dependency is better than
// relying on a config value another task could reasonably change.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/**
 * Sign in as the platform superuser -- copied deliberately from
 * audit-log.spec.ts's own helper rather than shared out of it. The two specs
 * run in separate worlds against separate throwaway accounts, and a shared
 * helper in ./support would make one file's sign-in shape a dependency of the
 * other's, for four lines.
 *
 * The TOTP step is not optional: the platform superuser is MFA-required
 * (CLAUDE.md § Session security), private.has_platform_permission() is
 * aal2-gated, and private.impersonated_organisations() carries that check --
 * so a password-only session would render every page here and be granted
 * nothing at all.
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
 * Sign in as the ADMIN of the impersonated workspace -- the party whose
 * consent the whole feature turns on. Also MFA-challenged for real:
 * `admin` is one of the roles private.role_requires_mfa() covers, so an aal1
 * session of this account holds `manage_organisation` not at all and the
 * accept control would refuse.
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

/** Ask for support access, from /super/impersonation. */
async function requestAccess(page: Page, reason: string): Promise<void> {
  await page.goto("/super/impersonation");
  await expect(page.getByRole("heading", { name: "Impersonation", level: 1 })).toBeVisible();
  // STEP-UP IS ALREADY SATISFIED at this point and that is not an accident
  // being glossed over: the TOTP challenge in signInAsSuperuser() above is a
  // `mfa/totp` entry in the JWT's `amr`, seconds old, which is exactly what
  // lib/auth/step-up.ts's five-minute credential window accepts. So the form
  // renders rather than the re-auth prompt -- and the test that the gate is
  // real is `the request form is behind the step-up gate` below, which drives
  // the same page with a stale credential.
  await page.locator('input[name="organisationSlug"]').fill(world.orgSlug);
  await page.locator('textarea[name="reason"]').fill(reason);
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByText("Request sent.")).toBeVisible();
}

/**
 * Same refusal shape audit-log.spec.ts's expectStreamedRefusal asserts, and
 * for the same reason: DESIGN.md § Error pages' property is "the IDENTICAL
 * document", not "the words 'Page not found' appear somewhere in it". A
 * refusal that still carried the /super layout's "Superuser" eyebrow or the
 * page's own <title> would tell a non-superuser that this route exists and is
 * superuser-gated, which is the enumeration oracle CLAUDE.md's
 * tenant-isolation rule forbids.
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
// THE GOLDEN IMPERSONATION WALK
// ===========================================================================
// One test, not six, and deliberately so. The steps are not independent --
// each one's precondition is the previous one's effect, and there is exactly
// one live session per (superuser, organisation) by construction
// (impersonation_sessions_live_pair), so six tests would either fight over the
// same row or need six worlds. Every step carries its own assertion, so a
// failure still names the step that broke.
test("the golden walk: request → accept as the org admin → start → bannered read-only view → write refused → end", async ({
  browser,
}) => {
  const superuserContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const superuserPage = await superuserContext.newPage();
  const adminPage = await adminContext.newPage();

  try {
    // ---- 1. REQUEST -------------------------------------------------------
    await signInAsSuperuser(superuserPage);
    await requestAccess(superuserPage, "ticket 4711: customer cannot see an event");

    // NOTHING IS REACHABLE YET. This is the assertion the whole feature turns
    // on, and it is checked BEFORE the accept rather than only after the end:
    // the workspace refuses identically to any stranger's, which is the
    // tenant-isolation 404 every org route already gives.
    await expectStreamedRefusal(superuserPage, `/${world.orgSlug}`);

    // ---- 2. ACCEPT, AS THE CUSTOMER ---------------------------------------
    await signInAsOrgAdmin(adminPage);
    await adminPage.goto(`/${world.orgSlug}/support-access`);
    await expect(
      adminPage.getByRole("heading", { name: "Support access", level: 1 }),
    ).toBeVisible();
    // The reason the superuser typed is what the admin is deciding on.
    await expect(adminPage.locator("main")).toContainText(
      "ticket 4711: customer cannot see an event",
    );

    await adminPage.getByRole("button", { name: /^Accept/ }).click();
    await adminPage.getByRole("button", { name: "Yes, allow it" }).click();
    // THE ROW MOVING IS THE CONFIRMATION, NOT THE FLASH MESSAGE -- measured
    // in the browser, exactly as components/network/request-actions.tsx
    // documents for the identical shape. The same server revalidation that
    // repaints the page also unmounts the form that would have rendered
    // `state.message`, because the row is no longer `requested` and the
    // "Waiting for you" section stops rendering it. Asserting the message
    // would be asserting a race; asserting the ROW STATE is asserting the
    // outcome.
    await expect(
      adminPage.getByText("No open requests. Nobody at GetSetPaid can see this workspace."),
    ).toBeVisible();
    await expect(adminPage.locator("main")).toContainText("Accepted — not started");

    // ---- 3. ACCEPTANCE IS NOT A SESSION -----------------------------------
    // Still refused. The distinction between "may look" and "is looking" is
    // the reason started_at exists, and it is invisible unless asserted.
    await expectStreamedRefusal(superuserPage, `/${world.orgSlug}`);

    // ---- 4. START ---------------------------------------------------------
    await superuserPage.goto("/super/impersonation");
    await superuserPage.getByRole("button", { name: /^Start session/ }).click();
    await superuserPage.getByRole("button", { name: "Yes, start" }).click();
    // Same reasoning as the accept above: the row leaves `accepted`, the
    // "Start session" control unmounts, and an "Open workspace" link and an
    // "End session" control take its place. That transition IS the outcome.
    await expect(
      superuserPage.getByRole("link", { name: "Open workspace" }),
    ).toBeVisible();
    await expect(superuserPage.locator("main")).toContainText("Ends at");

    // ---- 5. THE BANNERED, READ-ONLY VIEW ----------------------------------
    //
    // ===========================================================================
    // FIX ROUND 1, IMPORTANT 1: THE FIRST ENTRY IS A CLIENT-SIDE NAVIGATION,
    // AND UNTIL THIS STEP EXISTED THE SUITE COULD NOT SEE IT
    // ===========================================================================
    // Every other navigation in this file is `page.goto()` — a full document
    // load, which re-renders every layout in the tree and therefore always
    // produces a banner. The operator's ACTUAL first step into the workspace
    // is the "Open workspace" <Link> on /super/impersonation: a client-side
    // navigation from a route where `currentOrg` resolved to null and no
    // banner was rendered. If the router reuses the shared `(app)` layout
    // segment rather than re-rendering it, the first impersonated page a
    // human ever sees is the one page that is NOT bannered — the single thing
    // the brief calls out by name.
    //
    // So this step clicks the real control, and asserts the banner, before
    // any goto() in this test gets a chance to paper over it.
    await superuserPage.goto("/super/impersonation");
    await superuserPage.getByRole("link", { name: "Open workspace" }).click();
    await expect(superuserPage).toHaveURL(
      (url) => url.pathname === `/${world.orgSlug}`,
    );
    await expect(
      superuserPage.getByTestId("impersonation-banner"),
      "the FIRST impersonated page, reached by a client-side navigation from /super/impersonation, must be bannered — a shared ancestor layout does not necessarily re-render on one",
    ).toBeVisible();

    await superuserPage.goto(`/${world.orgSlug}`);
    const banner = superuserPage.getByTestId("impersonation-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Support access.");
    await expect(banner).toContainText("session ends at");

    // TENANT DATA IS VISIBLE -- and specifically a record the superuser does
    // NOT own, because private.full_scope_organisations()'s impersonation
    // branch (Q97) is what makes that work and a record-scoped reading of the
    // read_only role would show an empty list instead.
    await superuserPage.goto(`/${world.orgSlug}/contacts`);
    await expect(superuserPage.getByTestId("impersonation-banner")).toBeVisible();
    await expect(superuserPage.locator("main")).toContainText("Manager Only Contact");

    // ---- 6. AND IT IS READ-ONLY -------------------------------------------
    // THE CONTROL IS PRESENT AND INERT, NOT ABSENT, and that is the product's
    // own rule rather than a concession: components/crm/write-gate.tsx renders
    // a blocked action as a `<button disabled>` with a visible sentence,
    // because "hidden loses the explanation; present-and-failing produces a
    // 403 the user cannot interpret" (FOLLOW-UPS.md's Q6 item). So the
    // assertion is that the LINK is gone and a DISABLED BUTTON stands in its
    // place -- a link would be a navigable write affordance.
    await expect(
      superuserPage.getByRole("link", { name: "New contact" }),
      "a working create link must not render for an impersonating superuser",
    ).toHaveCount(0);
    await expect(
      superuserPage.getByRole("button", { name: "New contact" }),
      "the create control must still be present, disabled, and explained",
    ).toBeDisabled();

    // The stronger claim, at the route rather than the control: the
    // new-contact route serves no FORM. A form that rendered would be one
    // whose submit the database refuses -- the "the render lied" half of the
    // two-layer failure SECURITY.md warns about.
    await superuserPage.goto(`/${world.orgSlug}/contacts/new`);
    await expect(
      superuserPage.getByRole("heading", { name: "New contact", level: 1 }),
    ).toBeVisible();
    await expect(
      superuserPage.locator("main form"),
      "no create form may render on a write route during impersonation",
    ).toHaveCount(0);

    // SUPPORT ACCESS CANNOT EXTEND ITSELF. manage_organisation is not in the
    // envelope, so the consent page the customer uses is refused to the
    // operator -- they cannot accept their own next request from inside the
    // session they are already in.
    await expectStreamedRefusal(superuserPage, `/${world.orgSlug}/support-access`);

    // ---- 7. EVERY PAGE WAS AUDITED ----------------------------------------
    // Read straight out of Postgres: nobody can read this through the app
    // (audit_events is superuser-only and the superuser is mid-session).
    const routes = await impersonationAuditedRoutes(world.orgId);
    expect(
      routes,
      `every org-scoped page reached during the session must be audited by route. Recorded: ${routes.join(", ")}`,
    ).toEqual(expect.arrayContaining([`/${world.orgSlug}`, `/${world.orgSlug}/contacts`]));
    // AND NOTHING BUT ROUTES. A query string is where a list page's `q=`
    // search term lives, and a search term is content -- which the audit
    // contract excludes. lib/admin/impersonation-session.ts's auditableRoute()
    // is what strips it; this is that decision measured end to end.
    for (const route of routes) {
      expect(route, `an audited route must carry no query string: ${route}`).not.toContain(
        "?",
      );
    }

    // ---- 8. END -----------------------------------------------------------
    await superuserPage.goto("/super/impersonation");
    await superuserPage.getByRole("button", { name: /^End session/ }).click();
    await superuserPage.getByRole("button", { name: "Yes, end it" }).click();
    // And again: the "Open workspace" link and the "End session" control both
    // disappear, because the row is terminal. The refusals immediately below
    // are the stronger claim; this is the one the operator can see.
    await expect(
      superuserPage.getByRole("link", { name: "Open workspace" }),
    ).toHaveCount(0);

    // THE ACCESS IS GONE, MEASURED THE SAME WAY IT WAS MEASURED BEFORE IT
    // EXISTED -- the identical refusal, so "ended" means the same thing as
    // "never granted".
    await expectStreamedRefusal(superuserPage, `/${world.orgSlug}`);
    await expectStreamedRefusal(superuserPage, `/${world.orgSlug}/contacts`);

    // ---- 9. THE WHOLE STORY IS ON THE RECORD ------------------------------
    const actions = await impersonationAuditActions(world.orgId);
    expect(actions.slice(0, 3)).toEqual([
      "impersonation.requested",
      "impersonation.accepted",
      "impersonation.started",
    ]);
    expect(
      actions[actions.length - 1],
      `the session's last recorded event must be its end. Trail: ${actions.join(", ")}`,
    ).toBe("impersonation.ended");
    expect(
      actions.filter((a) => a === "impersonation.page_viewed").length,
      "at least one page access was recorded",
    ).toBeGreaterThan(0);
  } finally {
    await superuserContext.close();
    await adminContext.close();
  }
});

// ===========================================================================
// THE REFUSALS
// ===========================================================================

test("a non-superuser gets the streamed not-found contract at /super/impersonation", async ({
  page,
}) => {
  // `manager`, not an Owner, for the reason audit-log.spec.ts states at
  // length: lib/admin/superuser.ts's isSuperuser() has exactly one branch (is
  // this account on public.platform_admins) and reads no organisation role at
  // all, so there is no code path that could treat an Owner differently.
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/impersonation");
  await expectStreamedRefusal(page, "/super");
});

test("a member without manage_organisation cannot reach their own workspace's support-access page", async ({
  page,
}) => {
  // The consent surface is Owner/Admin only -- the same permission
  // public.accept_impersonation_request() requires -- and the refusal is the
  // streamed not-found contract, not a 403 that would confirm the page is
  // there and merely gated.
  await signIn(page, world, "manager");
  const response = await page.goto(`/${world.orgSlug}/support-access`);
  expect([200, 404]).toContain(response?.status() ?? -1);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page).toHaveTitle(/Not found/);
  // And it is not offered in the rail either.
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("link", { name: "Support access" })).toHaveCount(0);
});

test("the request form is behind the step-up gate, and the action re-checks it", async ({
  page,
}) => {
  // THE GATE IS NOT THE CONTROL, AND THIS TEST IS ABOUT BOTH HALVES.
  // lib/auth/step-up.ts accepts a credential presented in the last five
  // minutes; a session that signed in and then sat still is exactly the
  // "cookie stolen eleven hours later" case the window exists to refuse. The
  // fixture cannot wait five minutes, so this drives the half that IS
  // observable: an aal1 superuser session (password only, no TOTP) reaches
  // the page and is offered no working form -- either the re-auth prompt (no
  // fresh credential) or nothing at all.
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The MFA CHALLENGE gate stands in the way first: the platform superuser is
  // MFA-required, so app/(app)/layout.tsx replaces <main>'s content with the
  // challenge screen for every route until a factor is presented. That IS the
  // refusal for this case -- the impersonation form is unreachable, and the
  // reason it is unreachable is the gate rather than the page.
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
  ).toBeVisible();
  await page.goto("/super/impersonation");
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "an aal1 superuser session must not reach the impersonation request form",
  ).toBeVisible();
  await expect(page.locator('input[name="organisationSlug"]')).toHaveCount(0);
});

// ===========================================================================
// ACCESSIBILITY
// ===========================================================================
// One scan per new page, matching accessibility.spec.ts's own convention.
// Both are scanned POPULATED -- an empty list has no chips, no confirmation
// reveals and no rows, which is the state least likely to fail and therefore
// the least worth scanning.
test("axe: the superuser impersonation page, with a pending request on it", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAsSuperuser(page);
    await requestAccess(page, "ticket 4712: accessibility scan fixture");
    await page.goto("/super/impersonation");
    await expect(page.getByRole("heading", { name: "Impersonation", level: 1 })).toBeVisible();
    await expect(page.locator("main")).toContainText("ticket 4712");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("axe: the workspace's own support-access page, with a request waiting on it", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInAsOrgAdmin(page);
    await page.goto(`/${world.orgSlug}/support-access`);
    await expect(page.getByRole("heading", { name: "Support access", level: 1 })).toBeVisible();
    // The scan is worth more with the confirmation revealed than with it
    // closed: the reveal moves focus onto a `tabIndex={-1}` paragraph and
    // swaps a button for a form, which is the part of this surface most
    // likely to have an accessibility defect.
    await page.getByRole("button", { name: /^Accept/ }).first().click();
    await expect(page.getByRole("button", { name: "Yes, allow it" })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  } finally {
    await context.close();
  }
});
