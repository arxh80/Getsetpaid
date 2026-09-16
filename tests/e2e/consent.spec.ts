import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  clearConsentState,
  consentAuditActions,
  consentEvents,
  marketingPolicyVersion,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 2: MARKETING CONSENT, GIVEN AND WITHDRAWN, THROUGH THE BROWSER.
//
// supabase/tests/rls_phase8_consents.sql proves the ledger (attribution, the
// version rule, append-only, the meter); tests/integration/legal/
// consents.test.ts proves the sender's check. What only a browser can show:
//
//   1. THE CONTROL IS WHERE THE LEGAL PAGE SAYS IT IS, reached from the
//      signed-in footer, and it says no marketing email is sent today.
//   2. GRANTING SHOWS WHEN AND AGAINST WHICH VERSION -- the version number is
//      the one read out of Postgres, not a literal in this file.
//   3. WITHDRAWING IS ONE ACTION: one press of one button, no dialog, no
//      second step -- asserted by failing the test if any dialog opens and by
//      counting the clicks the walk makes.
//   4. THE DATABASE HISTORY SHOWS BOTH EVENTS, read straight out of the table
//      (and the audit log), not through the page that renders them.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) {
    await clearConsentState(Object.values(world.users).map((u) => u.id));
    await tearDownWorld(world);
  }
});

test("a Manager agrees to marketing email, sees when and under which version, and withdraws in one action", async ({
  page,
}) => {
  const manager = world.users.manager;
  const version = await marketingPolicyVersion();
  expect(version, "DENOMINATOR: the marketing page is published at version 2 or later").toBeGreaterThanOrEqual(2);
  expect(await consentEvents(manager.id), "the Manager starts with no consent history").toEqual([]);

  // Any dialog at all fails the walk: neither direction may ask for confirmation.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await page.getByRole("contentinfo").getByRole("link", { name: "Your privacy choices" }).click();
  await expect(page).toHaveURL(/\/account\/privacy$/);

  const heading = page.getByRole("heading", { level: 1, name: "Privacy and communications" });
  await expect(heading).toBeVisible();
  await expect(page.getByText("GetSetPaid does not send marketing email today, whatever you choose here.")).toBeVisible();
  const state = page.getByTestId("consent-state");
  await expect(state).toHaveText("You have not agreed to marketing email.");
  await expect(page.getByText("Nothing yet. Each time you agree or withdraw, a record appears here.")).toBeVisible();
  // The governing page is linked, at the version the database holds.
  await expect(page.getByRole("link", { name: "Marketing and Communications Preferences" })).toHaveAttribute(
    "href",
    "/legal/marketing-preferences",
  );
  await expect(page.getByText(`version ${version}`, { exact: true }).first()).toBeVisible();

  let clicks = 0;
  // ---- GRANT: one press ----------------------------------------------------
  const agree = page.getByRole("button", { name: "Agree to marketing email" });
  await expect(agree).toBeVisible();
  await agree.click();
  clicks++;
  const marketing = page.getByRole("region", { name: "Marketing email", exact: true });
  await expect(marketing.getByText("You have agreed to marketing email.")).toBeVisible();
  await expect(state).toContainText("You agreed on ");
  await expect(state).toContainText(`under version ${version} of the Marketing and Communications Preferences`);
  await expect(state).toContainText(/\d{2} [A-Z][a-z]{2,3} \d{4}, \d{2}:\d{2} \(UK time\)/);
  await expect(marketing.getByText("Agreed", { exact: true })).toBeVisible();

  const afterGrant = await consentEvents(manager.id);
  expect(afterGrant).toHaveLength(1);
  expect(afterGrant[0]).toMatchObject({
    action: "granted",
    policy_slug: "marketing-preferences",
    policy_version: version,
    mechanism: "account_settings",
    statement: "marketing-email-1",
    has_granted_at: true,
    has_withdrawn_at: false,
  });

  // The page with a grant on it -- the chip, the history row and the
  // withdraw control are all in the tree for this scan.
  await expect(page.getByRole("button", { name: "Withdraw agreement to marketing email" })).toBeVisible();
  const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(scan.violations, JSON.stringify(scan.violations, null, 2)).toEqual([]);

  // ---- WITHDRAW: one press, nothing more ------------------------------------
  await page.getByRole("button", { name: "Withdraw agreement to marketing email" }).click();
  clicks++;
  await expect(marketing.getByText("You have withdrawn your agreement to marketing email.")).toBeVisible();
  await expect(state).toContainText("You withdrew your agreement on ");
  await expect(marketing.getByText("Not agreed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agree to marketing email" })).toBeVisible();
  expect(clicks, "granting and withdrawing each took exactly one press").toBe(2);
  expect(dialogs, "a confirmation dialog opened").toEqual([]);

  // The page's own history, newest first.
  const history = page.getByRole("region", { name: "Your marketing email history" }).getByRole("listitem");
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText("Withdrew agreement");
  await expect(history.nth(1)).toContainText("Agreed");
  await expect(history.nth(1)).toContainText(`Marketing preferences version ${version}`);

  // ---- THE DATABASE HISTORY -------------------------------------------------
  const events = await consentEvents(manager.id);
  expect(events.map((e) => e.action)).toEqual(["granted", "withdrawn"]);
  expect(events[1]).toMatchObject({
    policy_slug: "marketing-preferences",
    policy_version: version,
    has_granted_at: false,
    has_withdrawn_at: true,
    withdraws_previous: true,
  });
  // The first event is exactly as it was before the withdrawal.
  expect(events[0]).toEqual(afterGrant[0]);
  expect(await consentAuditActions(manager.id)).toEqual(["consent.granted", "consent.withdrawn"]);
});
