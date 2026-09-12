import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  clearFeedbackState,
  countFeedbackAudit,
  countFeedbackScreenshotObjects,
  feedbackRowByMessage,
  fillFeedbackBudget,
  plantFeedback,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 6: IN-APP FEEDBACK, THROUGH THE BROWSER.
//
// ===========================================================================
// WHAT THIS FILE IS FOR, GIVEN THAT TWO OTHER SUITES ALREADY EXIST
// ===========================================================================
// supabase/tests/rls_phase7_feedback.sql proves the DATABASE (attribution,
// the meter, the policies, the view-audit RPC's guard) and the runner's HTTP
// block proves the raw PostgREST path; tests/integration/security/
// feedback-budget.test.ts proves the same through supabase-js. None of that
// is re-proved here. Four things are only observable in a browser:
//
//   1. THE WARNING IS BEFORE THE PICKER -- a DOM-order fact about the dialog.
//   2. THE ROUTE IS CAPTURED FROM WHERE THE USER WAS, with no field for it:
//      the dialog is opened over a record page and the row's `route` is that
//      page's path, read back out of Postgres.
//   3. THE SCREENSHOT-VIEW AUDIT FIRES ON THE REAL PATH: the operator follows
//      the real "View screenshot" link, lands on a signed storage URL, and the
//      audit row count read straight from Postgres goes from 0 to 1. Task 5's
//      I4 shipped an audit that was a silent no-op; this drives the path
//      rather than reading the code.
//   4. THE REFUSAL IS EXPLAINED IN HUMAN TIME, through formatRetryAfter, and
//      the superuser reads the list POPULATED (the brief: not an empty state).
//
// SIBLING SPEC, NOT A REWRITE. platform-health.spec.ts is Task 5 and stays.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

/** A 1x1 transparent PNG. Sniffed as image/png by lib/security/file-allowlist. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) {
    await clearFeedbackState([
      ...Object.values(world.users).map((u) => u.id),
      world.superuser.id,
    ]);
    await tearDownWorld(world);
  }
});

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

async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect([200, 404], `${url} must refuse as 404 or a streamed not-found -- never 403; got ${status}`).toContain(status);
  expect(page.url()).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText("Superuser");
  await expect(page.locator("body")).not.toContainText("Search feedback");
  await expect(page).not.toHaveTitle(/Superuser/);
  await expect(page).not.toHaveTitle(/Feedback/);
}

// ===========================================================================
// THE GOLDEN WALK: submit with a screenshot, read it populated, open the
// screenshot (audited), triage it.
// ===========================================================================
test("a member sends feedback from a record page and the superuser reads, opens and triages it", async ({
  page,
}) => {
  const message = `E2E feedback ${world.orgSlug} the venue picker forgets my filter`;
  const recordPath = `/${world.orgSlug}/contacts/${world.managerOwnedContactId}`;

  await signIn(page, world, "manager");
  await page.goto(recordPath);
  await expect(page).toHaveURL(new RegExp(`${world.managerOwnedContactId}$`));

  // ---- THE DIALOG, FROM THE HEADER, OVER THE RECORD --------------------
  await page.getByRole("button", { name: "Feedback" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Send feedback" })).toBeVisible();

  // ---- THE WARNING IS BEFORE THE PICKER, AND WIRED TO IT ---------------
  const warning = page.locator("#feedback-screenshot-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Before you attach a screenshot");
  await expect(warning).toContainText("operator will be able to see it");
  const picker = page.locator("#feedback-screenshot");
  await expect(picker).toHaveAttribute("aria-describedby", /feedback-screenshot-warning/);
  const warningPrecedesPicker = await page.evaluate(() => {
    const w = document.getElementById("feedback-screenshot-warning")!;
    const p = document.getElementById("feedback-screenshot")!;
    return (w.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(warningPrecedesPicker, "the warning must come BEFORE the file input in DOM order").toBe(true);

  // ---- SUBMIT WITH A SCREENSHOT ------------------------------------------
  await dialog.getByLabel(/Category/).selectOption("bug");
  await dialog.getByLabel(/Message/).fill(message);
  await picker.setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await dialog.getByRole("button", { name: "Send feedback" }).click();
  await expect(dialog.getByText("Done. Thanks — your feedback has been recorded.")).toBeVisible();

  // ---- WHAT THE DATABASE STAMPED, READ FROM POSTGRES ---------------------
  const row = await feedbackRowByMessage(message);
  expect(row, "the row must exist").not.toBeNull();
  expect(row!.userId).toBe(world.users.manager.id);
  expect(row!.userEmail).toBe(world.users.manager.email);
  expect(row!.organisationId).toBe(world.orgId);
  expect(row!.organisationRole).toBe("manager");
  expect(row!.route, "the route is where the user WAS, never a typed field").toBe(recordPath);
  expect(row!.screenshotScanStatus).toBe("clean");
  expect(row!.status).toBe("new");
  expect(await countFeedbackAudit("feedback.submitted", row!.id)).toBe(1);

  await dialog.getByRole("button", { name: "Close" }).click();
  await signOut(page);

  // ---- THE SUPERUSER READS IT POPULATED, THROUGH THE LANDING PAGE --------
  await signInAsSuperuser(page);
  await page.goto("/super");
  await page.getByRole("link", { name: "Feedback" }).click();
  await expect(page).toHaveURL(/\/super\/feedback$/);
  await expect(page.getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
  await expect(page.getByText(message)).toBeVisible();
  const item = page.locator("li", { hasText: message });
  await expect(item).toContainText(world.users.manager.email);
  await expect(item).toContainText("manager");
  await expect(item).toContainText(recordPath);
  await expect(item.getByText("Bug", { exact: true })).toBeVisible();
  // THE CHIP, not the <option> of the same name inside the Status select
  // beside it -- getByText("New") resolves to both (a strict-mode violation
  // this spec's first real run surfaced, fix round 1).
  await expect(item.locator("span", { hasText: /^New$/ })).toBeVisible();

  // ---- FILTERS NARROW AND CLEAR --------------------------------------------
  // exact: the header's (closed) Feedback <dialog> keeps its own required
  // "Category" select in the DOM, so the page-level label matches two.
  await page.getByLabel("Category", { exact: true }).selectOption("idea");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByText(message)).toHaveCount(0);
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page.getByText(message)).toBeVisible();
  await page.getByLabel("Workspace slug").fill(world.otherOrgSlug);
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByText(message)).toHaveCount(0);
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page.getByText(message)).toBeVisible();

  // ---- THE SCREENSHOT VIEW IS AUDITED ON THE REAL PATH ---------------------
  expect(await countFeedbackAudit("feedback.screenshot_viewed", row!.id)).toBe(0);
  await item.getByRole("link", { name: "View screenshot" }).click();
  await expect(page).toHaveURL(/\/storage\/v1\/object\/sign\/feedback-screenshots\//);
  expect(
    await countFeedbackAudit("feedback.screenshot_viewed", row!.id),
    "following the real link must write exactly one feedback.screenshot_viewed row",
  ).toBe(1);

  // ---- TRIAGE: the status flag, audited ------------------------------------
  await page.goto("/super/feedback");
  const item2 = page.locator("li", { hasText: message });
  await item2.getByLabel("Status").selectOption("read");
  await item2.getByRole("button", { name: "Update" }).click();
  await expect(item2.getByText("Done. Marked Read.")).toBeVisible();
  await expect(item2.locator("span", { hasText: /^Read$/ })).toBeVisible();
  expect(await countFeedbackAudit("feedback.status_changed", row!.id)).toBe(1);
  expect((await feedbackRowByMessage(message))!.status).toBe("read");
});

// ===========================================================================
// THE REFUSAL IS A REAL REFUSAL THE UI EXPLAINS, IN HUMAN TIME
// ===========================================================================
test("an exhausted feedback budget is refused with a human wait, not raw seconds -- and writes NO screenshot bytes", async ({ page }) => {
  await fillFeedbackBudget(world.users.standard_user.id);
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}`);
  await page.getByRole("button", { name: "Feedback" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Category/).selectOption("idea");
  await dialog.getByLabel(/Message/).fill("E2E eleventh submission");
  // Fix round 1 (I1): a screenshot is ATTACHED to the refused submission,
  // and the bucket is counted before and after. The first cut uploaded it
  // (5 MiB through the service-role client, then a scan) before the metered
  // insert refused the row, so a spent budget could still burn storage.
  await page.locator("#feedback-screenshot").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  const objectsBefore = await countFeedbackScreenshotObjects();
  await dialog.getByRole("button", { name: "Send feedback" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("Too many feedback submissions");
  // formatRetryAfter: an hour-long window reads as minutes, never "3541 seconds".
  await expect(alert).toContainText(/Try again in \d+ (minute|minutes|hour|hours)\./);
  await expect(alert).not.toContainText(/\d{3,} seconds/);
  expect(await feedbackRowByMessage("E2E eleventh submission")).toBeNull();
  // A count taken after the response cannot see a transient row; what this
  // asserts is that NOTHING IS LEFT BEHIND. That no upload is attempted at
  // all is the unit test's proof (submit-action-budget.test.ts: `upload`
  // never called for a spent budget).
  expect(
    await countFeedbackScreenshotObjects(),
    "a refused submission must leave storage.objects as it found it",
  ).toBe(objectsBefore);
});

// ===========================================================================
// THE PROMISED SIZE IS REACHABLE (cleanup round, N5)
// ===========================================================================
// The dialog promises "up to 5 MiB"; a Server Action's body is capped by
// next.config.ts's serverActions.bodySizeLimit, and Next's DEFAULT is 1 MB.
// Every earlier upload test used a 1x1 PNG, so nothing here had ever posted a
// body over 1 MB, and a real 1440p screenshot (routinely 1-4 MB) died as a
// framework 413 behind Next's generic "A server error occurred" -- the
// dialog's own sentences were unreachable. Two sizes, one test: a 2 MiB
// image lands as the app's own success, and a 6 MiB one is refused by the
// app's own TOO_BIG sentence -- proving the app-level check still fires
// ABOVE the promise rather than the framework answering first.
test("a screenshot over 1 MB lands, and one over 5 MiB is refused by the dialog's own sentence", async ({
  page,
}) => {
  const message = `E2E feedback ${world.orgSlug} a real-sized screenshot`;
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await page.getByRole("button", { name: "Feedback" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Category/).selectOption("bug");
  await dialog.getByLabel(/Message/).fill(message);
  await page
    .locator("#feedback-screenshot")
    .setInputFiles({ name: "big.png", mimeType: "image/png", buffer: paddedPng(2 * 1024 * 1024) });
  await dialog.getByRole("button", { name: "Send feedback" }).click();
  await expect(dialog.getByText("Done. Thanks — your feedback has been recorded.")).toBeVisible();
  const row = await feedbackRowByMessage(message);
  expect(row, "the 2 MiB submission must land as a row").not.toBeNull();
  expect(row!.screenshotScanStatus).toBe("clean");

  // Above the promise: the APP's sentence, not a framework error page.
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Feedback" }).click();
  await dialog.getByLabel(/Category/).selectOption("bug");
  await dialog.getByLabel(/Message/).fill(`${message} oversized`);
  await page
    .locator("#feedback-screenshot")
    .setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: paddedPng(6 * 1024 * 1024) });
  await dialog.getByRole("button", { name: "Send feedback" }).click();
  await expect(dialog.getByRole("alert")).toContainText("That screenshot is larger than the 5 MiB limit.");
  await expect(page.locator("body")).not.toContainText("A server error occurred");
  expect(await feedbackRowByMessage(`${message} oversized`)).toBeNull();
});

/**
 * A PNG signature followed by zero padding to `size` bytes. `sniffAndAllow`
 * reads the leading magic bytes only, so this is "an image" to the pipeline
 * and inert to the EICAR stub; it is generated here, never a committed
 * fixture.
 */
function paddedPng(size: number): Buffer {
  const out = Buffer.alloc(size);
  PNG.copy(out, 0, 0, Math.min(PNG.length, size));
  return out;
}

// ===========================================================================
// REFUSAL PARITY, AND THE aal1 GATE
// ===========================================================================
test("a non-superuser gets the streamed not-found contract at /super/feedback", async ({ page }) => {
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/feedback");
});

test("an aal1 superuser session reaches no feedback", async ({ page }) => {
  const planted = await plantFeedback(world.users.manager.id, world.orgId, "manager", "E2E aal1 probe row");
  try {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(world.superuser.email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Enter your two-factor code" })).toBeVisible();
    await page.goto("/super/feedback");
    // The MFA interstitial replaces the whole of <main>, so "the planted row
    // is not on the page" would be true of ANY page and proves nothing
    // (fix round 1, M6). What proves the page refused is that the list's own
    // chrome -- its h1 and its search control -- is absent while the
    // challenge is up. (The <title> is NOT asserted here: generateMetadata
    // gates on isSuperuser(), which this session IS, so the tab reads
    // "Feedback · Superuser" over the challenge -- true of every /super page
    // under the superuser's own aal1 session, and not a leak to anyone else;
    // the non-superuser title gating is the refusal-parity test above.)
    await expect(page.getByRole("heading", { name: "Enter your two-factor code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Feedback", level: 1 })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Search feedback");
    // THE LOAD-BEARING ASSERTION: the screenshot route -- a route handler,
    // so a literal 404 -- for the same aal1 session, with no audit row.
    const res = await page.request.get(`/super/feedback/${planted}/screenshot`);
    expect(res.status()).toBe(404);
    expect(await countFeedbackAudit("feedback.screenshot_viewed", planted)).toBe(0);
  } finally {
    // cleared in afterAll with everything else
  }
});

// ===========================================================================
// ACCESSIBILITY -- the list POPULATED, and the OPEN dialog
// ===========================================================================
test("/super/feedback has no detectable accessibility violations, populated", async ({ page }) => {
  await plantFeedback(world.users.manager.id, world.orgId, "manager", "E2E accessibility scan row");
  await signInAsSuperuser(page);
  await page.goto("/super/feedback");
  await expect(page.getByText("E2E accessibility scan row")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test("the open feedback dialog has no detectable accessibility violations", async ({ page }) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  await page.getByRole("button", { name: "Feedback" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Send feedback" })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
