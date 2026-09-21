import { expect, test } from "@playwright/test";
import {
  PASSWORD,
  accountStillExists,
  clearErasureState,
  countErasureJobs,
  createDisposableUser,
  erasureJobsFor,
  setUpWorld,
  tearDownWorld,
  type E2eUser,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 5: ACCOUNT ERASURE, THROUGH A BROWSER.
//
// supabase/tests/rls_phase8_erasure.sql proves the whole mechanism -- the
// tombstone, the thirteen blocking references, the Q131 guard, the traps, the
// rollback, the seam. What only a real browser and a real server can show:
//
//   1. THE ACCOUNT IS ACTUALLY GONE AND THE PERSON CANNOT SIGN IN. Not "the
//      row is absent from a table this test deleted from" -- a genuine sign-in
//      attempt, against live GoTrue, refused. That is the promise the page
//      makes, and it is the only assertion that can falsify it.
//   2. THE Q131 REFUSAL REACHES THE PERSON, in words, naming their workspace.
//      A guard that refuses correctly and says nothing leaves somebody
//      exercising a statutory right with no idea what to do next.
//   3. THE DISABLED BUTTON IS NOT THE CONTROL. Stripping the `disabled`
//      attribute and submitting must still be refused BY THE SERVER, with the
//      job count in Postgres asserted unchanged around the click -- the same
//      shape the Phase 6 network spec uses for its Free-tier refusal.
//   4. THE CONFIRMATION SURVIVES ITS OWN RE-RENDER. Starting an erasure
//      revalidates the page into a tree where this form is disabled; a message
//      held by the form would be thrown away by the re-render it caused, which
//      is the bug this phase shipped three times.
//
// THE ACCOUNT IT DESTROYS IS ONE IT MADE. Erasing a world user would leave
// every later assertion reading a database the fixtures no longer describe.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;
let doomed: E2eUser;

test.beforeAll(async () => {
  world = await setUpWorld();
  doomed = await createDisposableUser("self");
});

test.afterAll(async () => {
  if (world) {
    // The disposable account is deleted here only if the erasure did NOT run
    // (a failed test). A successful run has already removed it, and deleting
    // an absent id is a no-op.
    await clearErasureState([doomed?.id].filter((id): id is string => Boolean(id)));
    await tearDownWorld(world);
  }
});

test("the last Owner of a workspace with people and records in it is refused, and told why", async ({
  page,
}) => {
  await signIn(page, world, "owner");
  await page.goto("/account/erase");

  // THE PAGE IS REACHED, and it is not a 404: refusing to render the page
  // would say the feature does not exist, which is a different and worse
  // answer than "not yet, and here is what to do".
  await expect(page.getByRole("heading", { name: "Delete your account", level: 1 })).toBeVisible();

  // Q131, in words, naming the workspace. TWICE, and that is asserted rather
  // than worked around with `.first()`: the page renders the reason once as
  // the standing Alert above the control and once under the disabled button,
  // because a person who has scrolled to the button should not have to scroll
  // back to find out why it is dead.
  const warning = page.getByText(/You are the only owner of/);
  await expect(warning, "the Q131 reason should appear as the alert AND under the button").toHaveCount(2);
  await expect(warning.first()).toBeVisible();
  await expect(warning.first()).toContainText(world.orgName);
  await expect(warning.first()).toContainText("Make somebody else an owner");

  // THE CONTROL IS OFFERED AND DISABLED -- and that is a courtesy, not the
  // gate. Strip the attribute and submit for real.
  const button = page.getByRole("button", { name: "Delete my account" });
  await expect(button).toBeDisabled();

  const before = await countErasureJobs();
  await page.locator('input[name="confirmation"]').evaluate((el) => {
    (el as HTMLInputElement).disabled = false;
    (el as HTMLInputElement).value = "DELETE MY ACCOUNT";
  });
  await page
    .getByRole("button", { name: "Delete my account" })
    .evaluate((el) => el.removeAttribute("disabled"));
  await page.getByRole("button", { name: "Delete my account" }).click();

  // THE SERVER REFUSED, in the region the action cannot unmount, with the
  // database's own sentence.
  await expect(page.getByTestId("erasure-outcome")).toContainText(
    /only owner of|last owner of/i,
  );
  expect(await countErasureJobs(), "a refused erasure wrote a job row").toBe(before);
  expect(
    await accountStillExists(world.users.owner.id),
    "the Owner's account was erased despite the refusal",
  ).toBe(true);
});

test("a person deletes their own account, and cannot sign in afterwards", async ({ page }) => {
  // DENOMINATOR FIRST: the account exists and can sign in. Without this, "they
  // cannot sign in afterwards" is satisfied by an account that never worked.
  expect(await accountStillExists(doomed.id), "the disposable account was not created").toBe(true);

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(doomed.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  await page.goto("/account/erase");
  await expect(page.getByRole("heading", { name: "Delete your account", level: 1 })).toBeVisible();
  // Nothing is in this person's way: they belong to no workspace.
  await expect(page.getByText(/You are the only owner of/)).toHaveCount(0);
  // The page says what survives, in the person's own words rather than ours.
  await expect(page.getByText(/erased user/i)).toBeVisible();

  // THE CONFIRMATION PHRASE IS THE GATE. An empty box leaves the button
  // disabled; the phrase enables it. Typed, not pasted, because a typed phrase
  // is the thing a mis-click cannot produce.
  const button = page.getByRole("button", { name: "Delete my account" });
  await expect(button).toBeDisabled();
  await page.locator('input[name="confirmation"]').fill("DELETE MY ACCOUNT");
  await expect(button).toBeEnabled();
  await button.click();

  // THE CONFIRMATION LIVES ABOVE EVERYTHING THE ACTION CHANGES.
  await expect(page.getByTestId("erasure-outcome")).toContainText(
    "Your account is being deleted",
  );

  // THE WORK HAPPENS OUTSIDE THE REQUEST. Poll the database, not the page:
  // the account's own session is about to stop working, so the page is the
  // one witness that cannot be trusted to report the end of this.
  await expect
    .poll(
      async () => ((await accountStillExists(doomed.id)) ? "still there" : "gone"),
      {
        timeout: 90_000,
        intervals: [1_000, 2_000, 3_000],
        message: `the erasure never completed; jobs: ${JSON.stringify(await erasureJobsFor(doomed.id))}`,
      },
    )
    .toBe("gone");

  // AND THE PROMISE THE PAGE MADE: they cannot sign in again. A real attempt
  // against live GoTrue, through the real form.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(doomed.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("alert")).toBeVisible();
});
