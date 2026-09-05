import { expect, test, type Page } from "@playwright/test";
import { setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";

// PHASE 6 (NETWORK), TASK 2: THE PUBLISH-FIELD EDITOR, WALKED.
//
// `world.orgSlug` carries NO `organisation_subscriptions` row (fixtures.ts's
// own comment: "the main organisation deliberately has NO ... row on
// purpose") -- which is exactly the acceptance criterion's own workspace
// shape: "a Manager in a workspace with no subscription row creates a
// profile". The network_publish escape ("not yet billed => not yet gated")
// is what makes that legal, and this walk is what proves it end to end
// rather than only at the policy layer.
//
// One test for the golden path (create -> set visibility -> publish ->
// unpublish, the acceptance criterion's own three counts), and two
// INDEPENDENT role-breakout tests -- each creates its own profile as the
// manager first, rather than sharing state with the golden-path test, so a
// failure or a re-order of one test can never leave another starting from
// undefined state.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/**
 * As the manager: create a company, then a draft network profile for it
 * through the "Publish a record" picker. Returns the editor's own URL.
 */
async function createDraftProfile(page: Page, companyName: string): Promise<string> {
  await signIn(page, world, "manager");

  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill(companyName);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByRole("heading", { name: companyName, level: 1 })).toBeVisible();

  await page.goto(`/${world.orgSlug}/network/profiles`);
  await expect(page.getByRole("heading", { name: "Publish a record" })).toBeVisible();
  await page.locator("#publish-company-entity").selectOption({ label: companyName });
  await page.locator("#publish-company-name").fill(companyName);
  await page.getByRole("button", { name: "Create draft" }).first().click();

  const link = page.getByRole("link", { name: companyName });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: companyName, level: 1 })).toBeVisible();
  return page.url();
}

test("a Manager creates a profile, sets its visibility, publishes and unpublishes it", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  // ---- THE PRIVATE RECORD, BEFORE ANY PROFILE EXISTS ----------------------
  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill("Network Golden Path Ltd");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(
    page.getByRole("heading", { name: "Network Golden Path Ltd", level: 1 }),
  ).toBeVisible();
  const companyUrl = page.url();
  await expect(page.getByRole("heading", { name: "Network identity" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Not published to the network yet");

  // ---- "PUBLISH A RECORD", FROM THE COMPANY PAGE'S OWN LINK ---------------
  await page.getByRole("link", { name: "Publish this record" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/network/profiles$`));
  await expect(page.getByRole("heading", { name: "Publish a record" })).toBeVisible();
  await page
    .locator("#publish-company-entity")
    .selectOption({ label: "Network Golden Path Ltd" });
  await page.locator("#publish-company-name").fill("Network Golden Path Ltd");
  await page.getByRole("button", { name: "Create draft" }).first().click();
  const link = page.getByRole("link", { name: "Network Golden Path Ltd" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Network Golden Path Ltd", level: 1 }),
  ).toBeVisible();

  // Freshly created: a draft, and the summary already counts the two
  // always-shown fields (denominator 9).
  await expect(page.getByText(/2 of 9/)).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // ---- SET THE ACCEPTANCE CRITERION'S OWN THREE COUNTS --------------------
  // "publishes display_name + city, leaves contact_email at connections and
  // the rest hidden" -- display_name is always-shown, so this sets `city` to
  // `network` and `contact_email` to `connections`, leaving the other five
  // publishable fields at their default `hidden`. The summary should then
  // read 3 network (2 always-shown + city), 1 connections, 5 hidden.
  // Each field's value input and its visibility fieldset are SIBLINGS inside
  // one `<li>` (components/network/profile-editor.tsx), so the row is scoped
  // by that shared ancestor, not by the fieldset alone.
  const cityRow = page.locator("li", { has: page.locator("#city") });
  await cityRow.locator("#city").fill("Manchester");
  await cityRow.getByRole("radio", { name: /Everyone on the network/i }).click();

  const emailRow = page.locator("li", { has: page.locator("#contact_email") });
  await emailRow.locator("#contact_email").fill("booking@example.com");
  await emailRow.getByRole("radio", { name: /Connections only/i }).click();

  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText(/3 of 9/)).toBeVisible();
  await expect(page.getByText(/1 more to accepted connections/)).toBeVisible();
  await expect(page.getByText(/5 are hidden/)).toBeVisible();

  // ---- PUBLISH --------------------------------------------------------------
  await page.getByRole("button", { name: "Publish to the network" }).click();
  await expect(page.getByText(/Published\./)).toBeVisible();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();

  // ---- BACK ON THE COMPANY PAGE: THE IDENTITY ROW NOW SAYS PUBLISHED ------
  await page.goto(companyUrl);
  await expect(page.getByRole("heading", { name: "Network identity" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Not published to the network yet");
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage its network profile" })).toBeVisible();

  // ---- BACK TO THE EDITOR: UNPUBLISH -----------------------------------------
  await page.getByRole("link", { name: "Manage its network profile" }).click();
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByText(/Unpublished\./)).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
});

test("a Standard User sees the editor read-only, with the permission sentence (Q77: no manage_network_profile)", async ({
  page,
}) => {
  // THE ACCEPTANCE CRITERION NAMES A BOOKER; THIS SUITE'S "booker" E2E
  // PERSONA IS A MEMBER OF `world.proOrgSlug` ONLY (fixtures.ts: "THE
  // FINANCE USER IS IN BOTH; THE BOOKER IS IN THE PRO ONE ONLY" -- built for
  // the Phase 5 finance breakout test), and neither persona available there
  // (booker, finance) holds `manage_contacts`, so neither can create the
  // company this test needs. `standard_user` is a member of `world.orgSlug`
  // (the workspace with no subscription row) and, like a Booker, holds no
  // `manage_network_profile` at all (20260904002000: owner/admin/manager/
  // marketing only) -- so it exercises the SAME refusal reason ("permission",
  // not suspended or tier) this criterion is about. The Booker-specific case
  // is covered at the server-action level by
  // tests/integration/network/publish-editor-flow.test.ts's Constraint 11
  // test, which uses the real RLS fixture's `activeByRole.booker`.
  const editorUrl = await createDraftProfile(page, "Standard User Breakout Ltd");
  await signOut(page);
  await signIn(page, world, "standard_user");
  await page.goto(editorUrl);

  await expect(page.getByText("Read-only.")).toBeVisible();
  await expect(page.locator("main")).toContainText(/publish to the network/i);
  // HIDING THE UI IS NOT ENFORCEMENT -- the form is fully rendered, every
  // control disabled, never a hidden form and never an empty page.
  await expect(page.locator("input#displayName")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Publish to the network" }),
  ).toBeDisabled();
});

test("a Read Only member sees the same read-only editor", async ({ page }) => {
  const editorUrl = await createDraftProfile(page, "Read Only Breakout Ltd");
  await signOut(page);
  await signIn(page, world, "read_only");
  await page.goto(editorUrl);

  await expect(page.getByText("Read-only.")).toBeVisible();
  await expect(page.locator("input#displayName")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
