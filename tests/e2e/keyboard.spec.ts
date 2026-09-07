import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE KEYBOARD-ONLY SUITE (keyboard-a11y pass).
//
// ===========================================================================
// WHY THIS EXISTS BESIDE THE AXE SUITE
// ===========================================================================
// accessibility.spec.ts's own header says it: automated scanning finds the
// machine-checkable minority. axe cannot see that a focus was dropped to
// <body> by an unmounting trigger, that Escape does nothing, that a rail
// expands and traps, or that a combobox's active option never moves. Those
// are JOURNEYS — Tab, Enter, Escape, arrows — and this file walks them with
// no pointer events at all. (The one non-key primitive used is
// `locator.focus()` to place focus on a deep control before a journey
// starts: it stands in for the Tab presses that would get there, not for a
// mouse.)
//
// The journeys assert FOCUS POSITION, not only visible outcomes, because
// focus position is the thing every fix in this pass exists to protect.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** The id of the element that currently holds focus ("" when unset). */
function activeElementId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? "");
}

/** True while focus is inside the primary nav rail. */
function focusInsideRail(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const rail = document.querySelector('nav[aria-label="Primary"]');
    return rail !== null && rail.contains(document.activeElement);
  });
}

test("skip link is the first tab stop and lands focus on main", async ({ page }) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // First Tab from a fresh document: the skip link, visible only now.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  await page.keyboard.press("Enter");
  // #main carries tabIndex={-1} precisely so this is a real focus move.
  await expect
    .poll(() => activeElementId(page), {
      message: "skip link should move focus to #main",
    })
    .toBe("main");
});

test("rail expands on focus, Escape collapses it and holds through further tabbing", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  const rail = page.locator('nav[aria-label="Primary"]');
  await expect(rail).toBeVisible();

  const collapsedWidth = (await rail.boundingBox())?.width ?? 0;
  expect(collapsedWidth).toBeGreaterThan(0);

  // Tab until focus enters the rail (skip link, header controls, then the
  // pin button). Bounded so a regression fails loudly instead of spinning.
  let entered = false;
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Tab");
    if (await focusInsideRail(page)) {
      entered = true;
      break;
    }
  }
  expect(entered, "Tab never reached the primary nav rail").toBe(true);

  // Focus-within expands the rail (the width tween is ~240ms).
  await expect
    .poll(async () => (await rail.boundingBox())?.width ?? 0, {
      message: "rail should expand once focus is inside it",
    })
    .toBeGreaterThan(collapsedWidth + 40);

  // Escape collapses it…
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await rail.boundingBox())?.width ?? 0, {
      message: "Escape should collapse the focus-expanded rail",
    })
    .toBeLessThan(collapsedWidth + 8);

  // …and the collapse HOLDS while focus keeps moving inside the rail — a
  // naive focusWithin reset would re-expand on the very next Tab.
  await page.keyboard.press("Tab");
  expect(await focusInsideRail(page)).toBe(true);
  await page.waitForTimeout(400); // one full tween worth of settling time
  expect((await rail.boundingBox())?.width ?? 0).toBeLessThan(collapsedWidth + 8);
});

test("delete confirmation: focus moves to the question, Escape cancels and restores the trigger", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts/${world.managerOwnedContactId}`);

  const trigger = page.getByRole("button", { name: /Delete contact/ });
  await expect(trigger).toBeVisible();
  // Stands in for the Tab presses that would reach it — see the header.
  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Enter");
  // The revealed question takes focus — never either answer button, so a
  // repeated Enter cannot confirm what was just asked.
  const question = page.getByText(/Delete Manager Only Contact\?/);
  await expect(question).toBeVisible();
  await expect(question).toBeFocused();
  await expect(page.getByRole("button", { name: "Yes, delete" })).toBeVisible();

  // Escape cancels the same way "Keep it" does, and focus returns to the
  // remounted trigger rather than dropping to <body>.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Yes, delete" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete contact/ })).toBeFocused();

  // Nothing was deleted by any of that.
  await expect(page.getByRole("heading", { name: "Manager Only Contact" })).toBeVisible();
});

test("command palette: Ctrl+K opens, arrows move the active option, Enter navigates, focus lands on main", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const input = dialog.getByRole("combobox");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "true");

  // Empty query: the browse state — every rail section is an option.
  const contactsOption = dialog.getByRole("option", { name: /^Contacts/ });
  await expect(contactsOption).toBeVisible();

  // The active option follows the arrows via aria-activedescendant, and the
  // FIRST option is active on open, so one ArrowDown lands on the second.
  const firstOptionId = await dialog
    .getByRole("option")
    .first()
    .getAttribute("id");
  await expect(input).toHaveAttribute("aria-activedescendant", firstOptionId ?? "");
  await page.keyboard.press("ArrowDown");
  const secondOptionId = await dialog
    .getByRole("option")
    .nth(1)
    .getAttribute("id");
  await expect(input).toHaveAttribute("aria-activedescendant", secondOptionId ?? "");
  await page.keyboard.press("Home");
  await expect(input).toHaveAttribute("aria-activedescendant", firstOptionId ?? "");

  // Type to filter, Enter to take the active (first) option: Contacts.
  await input.fill("contacts");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/contacts$`));
  await expect(dialog).toHaveCount(0);
  // Focus lands where the skip link lands, on the content that changed.
  await expect
    .poll(() => activeElementId(page), {
      message: "palette navigation should land focus on #main",
    })
    .toBe("main");
});

test("command palette: record search finds this tenant's record and never the other tenant's", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole("combobox");

  // A record hit, served by the debounced server search through the same
  // list query path the contacts page uses.
  await input.fill("Manager Only Contact");
  const hit = dialog.getByRole("option", { name: /Manager Only Contact/ });
  await expect(hit).toBeVisible();

  // Keyboard to it and through it: the first flat option is the record hit
  // (no section or action matches this query), so Enter takes it.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/${world.orgSlug}/contacts/${world.managerOwnedContactId}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Manager Only Contact" }),
  ).toBeVisible();

  // TENANT BOUNDARY, FROM THE PALETTE. The other tenant's contact is a real
  // row with a real name; the palette must return nothing for it — the
  // search runs through getCurrentOrg + the tenant clause + RLS, and this
  // is the browser-visible assertion of all three. The settled "Nothing
  // matches" state is the non-vacuity control: the search demonstrably
  // completed, and THEN the name is asserted absent.
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await input.fill("Other Tenant Secret");
  await expect(
    dialog.getByText(/Nothing matches “Other Tenant Secret”/),
  ).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Other Tenant Secret Event");

  // Escape closes and the page behind is untouched.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("command palette: open state passes the axe scan", async ({ page }) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

  // Same tag set as accessibility.spec.ts, including best-practice — the tag
  // that found the landmark defects there. The palette is the one surface
  // that suite cannot reach (it exists only after a keypress).
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    results.passes.length,
    "axe evaluated no rules at all, so \"0 violations\" means nothing",
  ).toBeGreaterThan(0);
  for (const v of results.violations) {
    console.log(
      `AXE palette :: ${v.id} [${v.impact}] ${v.help}\n` +
        v.nodes.map((n) => `     - ${n.target.join(" ")}`).join("\n"),
    );
  }
  expect(
    results.violations.map((v) => `palette: ${v.id} (${v.nodes.length} nodes)`),
  ).toEqual([]);
});

test("login page: whole form is reachable and operable by keyboard alone", async ({
  page,
}) => {
  await page.goto("/login");

  // Tab reaches email, password, the show-password toggle and the submit,
  // in DOM order, with no trap: after the form the focus keeps moving.
  await page.keyboard.press("Tab"); // skip link
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  const email = page.locator('input[name="email"]');
  const password = page.locator('input[name="password"]');
  let reachedSubmit = false;
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Tab");
    const onSubmit = await page
      .getByRole("button", { name: "Sign in" })
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (onSubmit) {
      reachedSubmit = true;
      break;
    }
  }
  expect(reachedSubmit, "Tab never reached the Sign in button").toBe(true);

  // And the form actually submits from the keyboard: fill and press Enter
  // in a field (implicit submission through the default submit button —
  // the path the Button pending-guard must not break).
  await email.fill(world.users.manager.email);
  await password.fill("wrong-password-on-purpose");
  await password.press("Enter");
  // A refusal proves the submit happened; the error is announced inline.
  await expect(
    page.getByText("That email and password don't match. Check both and try again."),
  ).toBeVisible();
});
