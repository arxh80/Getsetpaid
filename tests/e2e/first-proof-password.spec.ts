import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  PASSWORD,
  authUserByEmail,
  createDisposableUser,
  localStack,
  setUpInviteWorld,
  tearDownInviteWorld,
  type E2eUser,
  type InviteWorld,
} from "./support/fixtures";
import {
  CONFIRM_LINK,
  expectSignInRefused,
  expectSignInWorks,
  linkIn,
  newPage,
  signUp,
  waitForMail,
} from "./support/auth-mail";

// ===========================================================================
// G11's RESIDUAL: A PASSWORD CHOSEN AFTER THE PROOF (Phase 10 Task 20, Q245)
// ===========================================================================
// GoTrue keeps the FIRST password on an unconfirmed re-sign-up, and confirming
// does not replace it (measured on v2.196.0 by Task 4). So a squatter who
// signs up as somebody else's address first, with a password of their own,
// owns the account the real owner later confirms -- whichever route the owner
// takes to prove the inbox. Each route is a case below; the squatter always
// signs up STRAIGHT TO GoTrue with the anon key, as an attacker would, so the
// app's own sign-up form gives them nothing.
//
// The fix: an address's FIRST proof (app/auth/callback/route.ts, through
// lib/auth/first-proof.ts) keeps the password only when the browser proving it
// is the browser whose sign-up created the account. Otherwise it replaces the
// password, signs out every other session, and sends the confirmer to
// /set-password, the only page the proxy lets them reach until they choose
// one. Postgres is read only to assert outcomes, never to make anything work.
// ===========================================================================

const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ADDRESSES = {
  resignup: `fp-resignup-${run}@example.test`,
  original: `fp-original-${run}@example.test`,
  magic: `fp-magic-${run}@example.test`,
  recovery: `fp-recovery-${run}@example.test`,
  control: `fp-control-${run}@example.test`,
};
const P1 = "Squatter-chose-this-1";
const P2 = "Owner-chose-this-2!";
const P3 = "Owner-chose-after-3!";

let world: InviteWorld;
let confirmed: E2eUser;

test.beforeAll(async () => {
  world = await setUpInviteWorld();
  confirmed = await createDisposableUser("first-proof");
});

test.afterAll(async () => {
  await tearDownInviteWorld(world, [...Object.values(ADDRESSES), confirmed.email]);
});

/** The squatter: signs `address` up with P1 straight to GoTrue, anon key, no app involved. */
async function squat(address: string): Promise<void> {
  const { apiUrl, anonKey } = localStack();
  const attacker = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await attacker.auth.signUp({ email: address, password: P1 });
  expect(error).toBeNull();
  await waitForMail(address, /confirm/i, 1);
  // [auth.email] max_frequency = "1s": the owner's own step re-sends a mail to
  // this account, and inside a second that is a 429, which is not the case.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

/**
 * Everything that must hold once the owner has proved the inbox in `owner`:
 * they are on /set-password and can reach nothing else; the squatter's P1 is
 * already dead; the owner chooses P3; P3 signs in and nothing earlier does.
 */
async function expectForcedPasswordChoice(
  browser: Browser,
  owner: Page,
  address: string,
  earlier: string[],
): Promise<void> {
  await expect(owner).toHaveURL(/\/set-password/);
  await expect.poll(async () => (await authUserByEmail(address))?.emailConfirmed).toBe(true);

  // WCAG 2.2 AA on the new page, with the same tags and non-vacuity control
  // as accessibility.spec.ts.
  await expect(owner.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  const axe = await new AxeBuilder({ page: owner })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(axe.passes.length, "axe evaluated no rules on /set-password").toBeGreaterThan(0);
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

  // The gate: nothing but this page (and signing out) is reachable.
  for (const path of ["/orgs", "/account", "/invites", "/"]) {
    await owner.goto(path);
    await expect(owner, `${path} must bounce to /set-password`).toHaveURL(/\/set-password/);
  }

  // The squatter's password died at the proof, BEFORE the owner chose anything.
  await expectSignInRefused(await newPage(browser), address, P1);

  await owner.locator('input[name="password"]').fill(P3);
  await owner.getByRole("button", { name: "Save password" }).click();
  await expect(owner).not.toHaveURL(/\/(set-password|login)/);
  // The mark is gone: the hub no longer bounces.
  await owner.goto("/account");
  await expect(owner).not.toHaveURL(/\/(set-password|login)/);

  await expectSignInWorks(await newPage(browser), address, P3);
  for (const password of earlier) {
    await expectSignInRefused(await newPage(browser), address, password);
  }
}

// ---------------------------------------------------------------------------
// (a) The owner signs up over the squatter and confirms their own email.
// ---------------------------------------------------------------------------
test("(a) an owner who signs up over a squatter and confirms must choose a new password; P1 is dead", async ({
  browser,
}) => {
  const address = ADDRESSES.resignup;
  await squat(address);

  const owner = await newPage(browser);
  await signUp(owner, address, P2);
  const [newest] = await waitForMail(address, /confirm/i, 2);
  await owner.goto(await linkIn(newest, CONFIRM_LINK));

  await expectForcedPasswordChoice(browser, owner, address, [P1, P2]);
});

// ---------------------------------------------------------------------------
// (b) The owner follows the SQUATTER's original confirmation email.
// ---------------------------------------------------------------------------
test("(b) an owner who follows the squatter's own confirmation email must choose a new password; P1 is dead", async ({
  browser,
}) => {
  const address = ADDRESSES.original;
  await squat(address);
  const [original] = await waitForMail(address, /confirm/i, 1);

  const owner = await newPage(browser);
  await owner.goto(await linkIn(original, CONFIRM_LINK));

  await expectForcedPasswordChoice(browser, owner, address, [P1]);
});

// ---------------------------------------------------------------------------
// (c2) The owner asks the login page for an emailed sign-in link. On an
// unconfirmed account GoTrue sends a SIGN-UP confirmation instead (measured,
// Task 4 fix round 1, M-A), and following it confirms the account.
// ---------------------------------------------------------------------------
test("(c2) an owner who proves the inbox through the emailed sign-in link must choose a new password; P1 is dead", async ({
  browser,
}) => {
  const address = ADDRESSES.magic;
  await squat(address);

  const owner = await newPage(browser);
  await owner.goto("/magic-link");
  await owner.locator('input[name="email"]').fill(address);
  await owner.getByRole("button", { name: "Email me a link" }).click();
  await expect(owner).toHaveURL(/\/magic-link\/sent/);
  const [newest] = await waitForMail(address, /confirm/i, 2);
  await owner.goto(await linkIn(newest, CONFIRM_LINK));

  await expectForcedPasswordChoice(browser, owner, address, [P1]);
});

// ---------------------------------------------------------------------------
// (e) The squatter asks GoTrue for a password reset and the owner follows it.
// Verifying a recovery link confirms the account and leaves P1 working
// (measured, Task 4 fix round 1, M-B); the app has no "Forgot password" page,
// but GoTrue's endpoint answers anybody with the anon key.
// ---------------------------------------------------------------------------
test("(e) an owner who follows a recovery email the squatter requested must choose a new password; P1 is dead", async ({
  browser,
}) => {
  const address = ADDRESSES.recovery;
  await squat(address);
  const { apiUrl, anonKey } = localStack();
  const attacker = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await attacker.auth.resetPasswordForEmail(address)).error).toBeNull();
  const [reset] = await waitForMail(address, /reset/i, 1);

  const owner = await newPage(browser);
  await owner.goto(await linkIn(reset, CONFIRM_LINK));

  await expectForcedPasswordChoice(browser, owner, address, [P1]);
});

// ---------------------------------------------------------------------------
// (c) POSITIVE CONTROL: an ordinary sign-up confirmed in the browser that made
// it keeps the password it chose, and is never sent to /set-password.
// ---------------------------------------------------------------------------
test("(c) a sign-up confirmed in the same browser lands signed in and keeps its own password", async ({
  browser,
}) => {
  const address = ADDRESSES.control;
  const person = await newPage(browser);
  await signUp(person, address, P2);
  const [confirmation] = await waitForMail(address, /confirm/i, 1);
  await person.goto(await linkIn(confirmation, CONFIRM_LINK));

  await expect.poll(async () => (await authUserByEmail(address))?.emailConfirmed).toBe(true);
  await expect(person).not.toHaveURL(/\/(set-password|login|signup)/);
  await person.goto("/account");
  await expect(person).not.toHaveURL(/\/(set-password|login)/);

  await expectSignInWorks(await newPage(browser), address, P2);
});

// ---------------------------------------------------------------------------
// (d) An account created ALREADY confirmed (here by the Admin API, as every
// fixture user is) has its address recorded as proved at birth -- the
// auth.users trigger in 20261104000000 -- so its first emailed sign-in link,
// which goes through the callback, is not a "first proof" and replaces
// nothing. Without that row this link would destroy the password its owner
// chose.
// ---------------------------------------------------------------------------
test("(d) an account born confirmed signs in by emailed link without being sent to /set-password, and its password survives", async ({
  browser,
}) => {
  const page = await newPage(browser);
  await page.goto("/magic-link");
  await page.locator('input[name="email"]').fill(confirmed.email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page).toHaveURL(/\/magic-link\/sent/);
  const [link] = await waitForMail(confirmed.email, /sign-in link/i, 1);
  await page.goto(await linkIn(link, "type=magiclink"));

  await expect(page).not.toHaveURL(/\/(set-password|login)/);
  await page.goto("/set-password");
  await expect(page).not.toHaveURL(/\/(set-password|login)/);

  await expectSignInWorks(await newPage(browser), confirmed.email, PASSWORD);
});
