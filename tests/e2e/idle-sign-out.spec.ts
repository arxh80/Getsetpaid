import { expect, test, type Page } from "@playwright/test";
import { IDLE_TIMEOUT_MS, activityStorageKey } from "@/lib/auth/idle-timeout";
import { PASSWORD, createDisposableUser, deleteDisposableUser, type E2eUser } from "./support/fixtures";

// AUDIT 2026-11-09: THE AUTH COOKIE IS httpOnly, SO THE IDLE TIMER SIGNS OUT
// THROUGH THE SERVER.
//
// The idle timer used to end the session with a browser Supabase client, which
// needed a script-readable auth cookie. It now calls a server action. Only a
// browser shows that the pair holds: the cookie is out of scripts' reach AND
// an expired idle clock still ends the session for real, not just the page.
//
// The clock is the localStorage key the timer reads; the spec backdates it.

let user: E2eUser;

test.beforeAll(async () => {
  user = await createDisposableUser("idle-sign-out");
});

test.afterAll(async () => {
  if (user) await deleteDisposableUser(user.id);
});

/** Sets "last activity" to `agoMs` in the past, then has the timer re-check. */
async function backdateActivity(page: Page, agoMs: number) {
  await page.evaluate(
    ([key, ago]) => {
      window.localStorage.setItem(key as string, String(Date.now() - (ago as number)));
      window.dispatchEvent(new Event("focus"));
    },
    [activityStorageKey(user.id), agoMs],
  );
}

test("an expired idle clock signs the session out on the server, with an auth cookie no script can read", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const isAuthCookie = (name: string) => /^sb-.+-auth-token(\.\d+)?$/.test(name);
  const authCookies = (await context.cookies()).filter((c) => isAuthCookie(c.name));
  expect(authCookies.length, "no Supabase auth cookie after sign-in").toBeGreaterThan(0);
  for (const c of authCookies) expect(c.httpOnly, `${c.name} is readable by page scripts`).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("auth-token");

  // The timer has mounted once it has written its own clock.
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), activityStorageKey(user.id)))
    .not.toBeNull();

  // CONTROL: inside the warning window the timer reads the backdated clock and
  // does NOT sign out. Without this, the sign-out below could be anything.
  await backdateActivity(page, IDLE_TIMEOUT_MS - 30_000);
  await expect(page.getByRole("button", { name: "Stay signed in" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  await backdateActivity(page, IDLE_TIMEOUT_MS + 1_000);
  await expect(page).toHaveURL(/\/login\?error=idle_timeout/);
  await expect(page.getByText("You were signed out after 30 minutes of inactivity.")).toBeVisible();

  // Signed out for real: the cookie is gone and the app sends them to sign in.
  expect((await context.cookies()).filter((c) => isAuthCookie(c.name))).toHaveLength(0);
  await page.goto("/account/privacy");
  await expect(page).toHaveURL(/\/login/);
});
