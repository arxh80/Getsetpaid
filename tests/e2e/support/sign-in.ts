import { expect, type Page } from "@playwright/test";
import { PASSWORD, type E2eRole, type E2eWorld } from "./fixtures";

/**
 * Sign in through the real form, at `/login`, with a real password.
 *
 * NOT a cookie injected into the context. The session cookie is written by
 * `@supabase/ssr` through the app's own route, and a hand-made one would test
 * a session shape the product never produces -- which is the same mistake the
 * psql suite's hand-made JWT claims made before they were given a real `aal`
 * claim (`run-rls-tests.sh`, "ASSURANCE LEVEL PER FIXTURE USER").
 *
 * Only roles for which MFA is OPTIONAL are signed in here. Manager,
 * standard_user and read_only are all such roles at MVP; owner, admin and
 * finance are challenged for a TOTP code at every sign-in
 * (`SECURITY.md` § 4), which is asserted in the integration suite and is not
 * what a golden-path walk is measuring.
 */
export async function signIn(
  page: Page,
  world: E2eWorld,
  role: E2eRole,
): Promise<void> {
  await page.goto("/login");
  // ADDRESSED BY `name`, NOT BY LABEL. Every field on this form renders its
  // label as "<Label> Required", and the password field is additionally
  // accompanied by a "Show password" toggle -- so `getByLabel("Password")`
  // matches nothing exactly and two things loosely. The form control's `name`
  // is what the Server Action reads (`components/auth/login-form.tsx:32,46`),
  // so it is the most stable handle and the one closest to what is submitted.
  await page.locator('input[name="email"]').fill(world.users[role].email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The app lands on whichever workspace it resolves; the assertion that
  // matters is only that the sign-in got past the form.
  await expect(page).not.toHaveURL(/\/login/);
}

/** Sign out, so the next test's sign-in starts from nothing. */
export async function signOut(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Sign out" });
  if (await button.count()) {
    await button.first().click();
    await expect(page).toHaveURL(/\/login/);
  }
}
