import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  PASSWORD,
  createDisposableUser,
  deleteDisposableUser,
  type E2eUser,
} from "./support/fixtures";

// PHASE 10 TASK 22: "SIGN OUT EVERYWHERE", THROUGH TWO BROWSERS.
//
// tests/integration/session/sign-out-everywhere.test.ts proves the action
// revokes the other session's refresh token. What only a browser shows: the
// button is reachable, the clicking browser lands on /login, and the OTHER
// browser is thrown out the next time it refreshes.
//
// FORCING THE REFRESH. Browser B's access token stays valid for jwt_expiry
// (900s) after the revocation -- the stated residual. Rather than wait, the
// spec rewrites the expires_at inside B's own auth cookie to the past, so the
// proxy's getClaims() refreshes on B's next request. The same rewrite is run
// BEFORE the revocation as the positive control: it must leave B signed in,
// or the "lands on /login" below proves nothing.
//
// A DISPOSABLE ACCOUNT. A global sign-out revokes every session the user
// holds, so a world persona would sign the rest of the run out.

test.describe.configure({ mode: "serial" });

let user: E2eUser;

test.beforeAll(async () => {
  user = await createDisposableUser("signout-everywhere");
});

test.afterAll(async () => {
  if (user) await deleteDisposableUser(user.id);
});

async function signInAs(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Backdates expires_at in the @supabase/ssr session cookie so the next server
 * read refreshes. The number keeps its digit count, so the base64 keeps its
 * length and the chunk boundaries stay where @supabase/ssr put them.
 */
async function expireAccessTokenLocally(context: BrowserContext) {
  const chunks = (await context.cookies())
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  expect(chunks.length, "no Supabase auth cookie to rewrite").toBeGreaterThan(0);

  const joined = chunks.map((c) => c.value).join("");
  expect(joined.startsWith("base64-"), "auth cookie is not @supabase/ssr base64 form").toBe(true);
  const session = JSON.parse(Buffer.from(joined.slice(7), "base64url").toString("utf8"));
  session.expires_at = Number(session.expires_at) - 3600;
  const rewritten = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  expect(rewritten.length).toBe(joined.length);

  let offset = 0;
  await context.addCookies(
    chunks.map((c) => {
      const value = rewritten.slice(offset, offset + c.value.length);
      offset += c.value.length;
      return { ...c, value };
    }),
  );
}

test("signing out everywhere ends the other browser's session at its next refresh", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await signInAs(a);
    await signInAs(b);

    // POSITIVE CONTROL: a forced refresh on a live session keeps B signed in.
    await expireAccessTokenLocally(contextB);
    await b.goto("/account/sessions");
    await expect(b.getByRole("heading", { level: 1, name: "Sign out everywhere" })).toBeVisible();

    // The button is findable from the footer, by keyboard-reachable link.
    await a.goto("/account/privacy");
    await a.getByRole("link", { name: "Sign out everywhere" }).click();
    await expect(a.getByRole("heading", { level: 1, name: "Sign out everywhere" })).toBeVisible();
    await a.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(a).toHaveURL(/\/login/);

    // THE RESIDUAL: B's access token is still unexpired, so B still loads.
    await b.goto("/account/sessions");
    await expect(b.getByRole("heading", { level: 1, name: "Sign out everywhere" })).toBeVisible();

    // At its next refresh, B is signed out.
    await expireAccessTokenLocally(contextB);
    await b.goto("/account/sessions");
    await expect(b).toHaveURL(/\/login/);

    // Signed out, not locked out.
    await signInAs(a);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
