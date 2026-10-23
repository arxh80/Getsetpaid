// =============================================================================
// PHASE 10 TASK 21 -- AN OWNER REMOVES A MEMBER, AND THE REMOVAL BITES
// =============================================================================
// The integration suite (tests/integration/org/member-management.test.ts)
// proves who may remove and demote whom. This walks the one thing it cannot:
// an Owner removes a member through the real page, and that member's NEXT
// page load in the workspace -- in their own, still-signed-in browser -- is
// refused with the not-found contract (DESIGN.md § Error pages). Sessions are
// deliberately not revoked (coordinator decision 5): every read re-checks
// membership in the database, so the removal takes effect on the next request.
//
// Plus the remove control's focus round-trip (the delete-confirmation pattern,
// keyboard.spec.ts) and an axe scan of the members page as an Owner WITH the
// row controls rendered -- the non-vacuity of that scan is asserted first.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  deletePlantedMember,
  plantActiveMember,
  setUpWorld,
  tearDownWorld,
  PASSWORD,
  type E2eUser,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

let world: E2eWorld;
let leaver: E2eUser;
const LEAVER_NAME = "E2E Leaving Booker";

test.beforeAll(async () => {
  world = await setUpWorld();
  leaver = await plantActiveMember(world.orgId, "booker", LEAVER_NAME);
});

test.afterAll(async () => {
  if (leaver) await deletePlantedMember(leaver.id);
  await tearDownWorld(world);
});

async function signInByEmail(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const removeButton = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^Remove ${name}$`) });

test("the remove confirmation takes focus, and Escape returns it to the trigger", async ({ page }) => {
  await signIn(page, world, "owner");
  await page.goto(`/${world.orgSlug}/members`);
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();

  const trigger = removeButton(page, LEAVER_NAME);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const question = page.getByText(new RegExp(`Remove ${LEAVER_NAME} from`));
  await expect(question).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(removeButton(page, LEAVER_NAME)).toBeFocused();
});

test("axe: the members page as an Owner, with the row controls rendered", async ({ page }) => {
  await signIn(page, world, "owner");
  await page.goto(`/${world.orgSlug}/members`);
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
  // Non-vacuity: the controls this scan is about are on the page.
  await expect(removeButton(page, LEAVER_NAME)).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Role for ${LEAVER_NAME}` })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  expect(results.violations.map((v) => `${v.id} (${v.nodes.length} nodes)`)).toEqual([]);
});

test("an Owner removes a member, and that member's next page load is refused", async ({ page, browser }) => {
  // The member, signed in in their own browser, can read the workspace.
  const leaverContext = await browser.newContext();
  const leaverPage = await leaverContext.newPage();
  try {
    await signInByEmail(leaverPage, leaver.email);
    await leaverPage.goto(`/${world.orgSlug}/contacts`);
    await expect(leaverPage.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();

    await signIn(page, world, "owner");
    await page.goto(`/${world.orgSlug}/members`);
    await removeButton(page, LEAVER_NAME).click();
    await page.getByRole("button", { name: "Yes, remove" }).click();
    // The outcome survives the row it came from (components/ui/action-outcome.tsx).
    await expect(page.getByTestId("members-outcome")).toContainText("Removed.");
    await expect(page.getByText(LEAVER_NAME)).toHaveCount(0);

    // Their next request, same session: refused at the workspace boundary
    // ([orgSlug]/layout.tsx, above every loading boundary), so a real 404 --
    // never a 403, never a bounce to /login (tenant-breakout.spec.ts's
    // expectRefusedAtWorkspace).
    const response = await leaverPage.goto(`/${world.orgSlug}/contacts`);
    expect(response?.status()).toBe(404);
    expect(leaverPage.url()).not.toMatch(/\/login/);
    await expect(leaverPage.locator("body")).toContainText("Page not found");
  } finally {
    await leaverContext.close();
  }
});
