import { expect, type Page } from "@playwright/test";
import { PASSWORD, type E2eRole, type E2eWorld } from "./fixtures";
import { totpCode } from "../../support/totp";

/**
 * EVERY ROLE PRESENTS A TOTP CODE (since 2026-11-10, 20261110003000).
 *
 * `private.role_requires_mfa()` is true for every organisation role, and
 * `public.has_permission()` refuses an MFA-required membership on an aal1
 * session, so a persona that skipped the challenge would hold no key at all
 * and every assertion would pass or fail for the MFA reason. The challenge is
 * ASSERTED present for each sign-in (not branched on the page), so a gate that
 * stopped appearing is a failure here rather than a silent skip. Each persona's
 * secret is `world.totpSecrets[role]`, enrolled by `setUpWorld`.
 *
 * History: finance joined the challenged set in Phase 5 Task 5, owner and admin
 * in Phase 7 Task 7, and the rest with the audit of 2026-11-09 (finding 1).
 */
const CHALLENGE_HEADING = "Enter your two-factor code";

/**
 * Sign in through the real form, at `/login`, with a real password.
 *
 * NOT a cookie injected into the context. The session cookie is written by
 * `@supabase/ssr` through the app's own route, and a hand-made one would test
 * a session shape the product never produces -- which is the same mistake the
 * psql suite's hand-made JWT claims made before they were given a real `aal`
 * claim (`run-rls-tests.sh`, "ASSURANCE LEVEL PER FIXTURE USER").
 *
 * After the password, the helper walks the per-sign-in TOTP challenge: a real
 * RFC 6238 code, generated from the factor `setUpWorld` enrolled, presented to
 * the live GoTrue verifier on the app's own gate screen (see above for why
 * every role does this).
 */
export async function signIn(
  page: Page,
  world: E2eWorld,
  role: E2eRole,
): Promise<void> {
  await signInByEmail(page, world.users[role].email, world.totpSecrets[role]);
}

/**
 * The same walk for a persona outside `world.users` (the other tenant's
 * member, the Free member, a planted member): password, then the TOTP
 * challenge with that persona's enrolled secret.
 */
export async function signInByEmail(
  page: Page,
  email: string,
  totpSecret: string,
): Promise<void> {
  await page.goto("/login");
  // ADDRESSED BY `name`, NOT BY LABEL. Every field on this form renders its
  // label as "<Label> Required", and the password field is additionally
  // accompanied by a "Show password" toggle -- so `getByLabel("Password")`
  // matches nothing exactly and two things loosely. The form control's `name`
  // is what the Server Action reads (`components/auth/login-form.tsx:32,46`),
  // so it is the most stable handle and the one closest to what is submitted.
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The app lands on whichever workspace it resolves; the assertion that
  // matters is only that the sign-in got past the form.
  await expect(page).not.toHaveURL(/\/login/);

  await presentTotpCode(page, totpSecret);
}

/**
 * Walk the app's per-sign-in MFA challenge (components/auth/mfa-challenge-gate.tsx).
 *
 * THE GATE IS ASSERTED PRESENT FIRST, and that assertion is the interesting
 * half: `signInWithPassword()` returns an aal1 session and Supabase does NOT
 * re-prompt on its own (lib/auth/mfa-gate.ts's fix-round-1 note), so this
 * screen appearing is the product's own gate doing the work. If it ever stopped
 * appearing, this goes red here rather than leaving a user quietly
 * browsing at aal1 with no keys.
 *
 * The code is generated from the secret `setUpWorld` enrolled and verified
 * against the LIVE verifier -- no stub, no injected `aal` claim.
 */
async function presentTotpCode(page: Page, secret: string): Promise<void> {
  const heading = page.getByRole("heading", { name: CHALLENGE_HEADING });
  await expect(heading).toBeVisible();
  await page
    .locator('input[name="code"]')
    .fill(totpCode(secret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  // The gate is gone: the action verified, upgraded the session in place and
  // redirected to `next`. A wrong code re-renders the same screen with an
  // error, so this is a real assertion and not a formality.
  await expect(heading).toHaveCount(0);
}

/** Sign out, so the next test's sign-in starts from nothing. */
export async function signOut(page: Page): Promise<void> {
  // NO CONDITIONAL LOCATOR (Task 8 fix round 1). This used to be
  // `if (await button.count())`, which silently did nothing when the button was
  // absent -- the exact shape the "no conditional locators" rule forbids. Every
  // caller invokes it from a signed-in page, so the button is asserted present
  // and then clicked; a missing "Sign out" is now a failure, not a skip.
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/);
}
