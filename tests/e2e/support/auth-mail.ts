import { expect, type Browser, type Page } from "@playwright/test";
import { localStack } from "./fixtures";

// ===========================================================================
// THE MAIL CATCHER AND THE SIGN-UP / SIGN-IN FORMS, FOR THE AUTH-JOURNEY SPECS
// ===========================================================================
// Shared by invite-pre-hijack.spec.ts (G11, Phase 10 Task 4) and
// first-proof-password.spec.ts (G11's residual, Phase 10 Task 20). Emailed
// links are read out of the local mail catcher (Mailpit, `[local_smtp]` in
// supabase/config.toml); the forms are driven through the real pages.
// ===========================================================================

export const BAD_SIGN_IN = "That email and password don't match. Check both and try again.";

/**
 * A confirmation or recovery link: GoTrue's own /auth/v1/verify (the default
 * templates), or our /auth/callback with a token hash (the templates Phase 10
 * Task 20 routes through the callback, so the first proof always reaches it).
 */
export const CONFIRM_LINK = /\/auth\/v1\/verify|\/auth\/callback\?token_hash=/;

export interface Mail {
  id: string;
  subject: string;
}

function mailUrl(): string {
  const url = localStack().mailUrl;
  if (!url) throw new Error("`supabase status` reported no local mail catcher (MAILPIT_URL).");
  return url;
}

/** Every message addressed to `address`, newest first. */
export async function mailTo(address: string): Promise<Mail[]> {
  const res = await fetch(
    `${mailUrl()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  const body = (await res.json()) as { messages?: { ID: string; Subject: string }[] };
  return (body.messages ?? []).map((m) => ({ id: m.ID, subject: m.Subject }));
}

/** Waits (bounded) until `address` has received `count` messages matching `subject`; newest first. */
export async function waitForMail(address: string, subject: RegExp, count = 1): Promise<Mail[]> {
  let matching: Mail[] = [];
  await expect
    .poll(
      async () => {
        matching = (await mailTo(address)).filter((m) => subject.test(m.subject));
        return matching.length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(count);
  return matching;
}

/** The first link in a message whose href matches `marker`, HTML entities decoded. */
export async function linkIn(mail: Mail, marker: string | RegExp): Promise<string> {
  const res = await fetch(`${mailUrl()}/api/v1/message/${mail.id}`);
  const { HTML } = (await res.json()) as { HTML: string };
  const href = [...HTML.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, "&"))
    .find((h) => (typeof marker === "string" ? h.includes(marker) : marker.test(h)));
  if (!href) throw new Error(`No link matching "${marker}" in "${mail.subject}".`);
  return href;
}

/** A page in a fresh browser context: its own cookie jar, so its own person. */
export async function newPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

/** Sign up through the real form; with confirmations on it lands on check-email. */
export async function signUp(page: Page, address: string, password: string): Promise<void> {
  await page.goto("/signup");
  await page.locator('input[name="fullName"]').fill("Someone");
  await page.locator('input[name="email"]').fill(address);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/signup\/check-email/);
}

export async function submitSignIn(page: Page, address: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(address);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The sign-in is refused, with the one enumeration-safe message. */
export async function expectSignInRefused(page: Page, address: string, password: string): Promise<void> {
  await submitSignIn(page, address, password);
  await expect(page.getByText(BAD_SIGN_IN)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
}

/** The sign-in succeeds: it leaves /login. */
export async function expectSignInWorks(page: Page, address: string, password: string): Promise<void> {
  await submitSignIn(page, address, password);
  await expect(page).not.toHaveURL(/\/login/);
}
