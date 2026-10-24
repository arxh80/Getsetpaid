import { expect, test } from "@playwright/test";
import {
  PASSWORD,
  createDisposableUser,
  deleteDisposableUser,
  localStack,
  type E2eUser,
} from "./support/fixtures";

// PHASE 10 TASK 7 (G16): SESSION FIXATION.
//
// An attacker who can plant a cookie (a sibling subdomain, a shared machine)
// sets an auth cookie before the victim signs in. The claim: the planted value
// is not accepted as a session, and signing in replaces it with one GoTrue
// minted. The planted value names the victim's own user id, so "not accepted"
// is about the forged signature, not an unknown user.
//
// Revocation at sign-out is proved in
// tests/integration/session/fixation-and-revocation.test.ts.

let user: E2eUser;

test.beforeAll(async () => {
  user = await createDisposableUser("session-fixation");
});

test.afterAll(async () => {
  if (user) await deleteDisposableUser(user.id);
});

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

test("a planted auth cookie is not accepted, and sign-in replaces it", async ({ context, page }) => {
  const ref = new URL(localStack().apiUrl).hostname.split(".")[0];
  const cookieName = `sb-${ref}-auth-token`;
  const now = Math.floor(Date.now() / 1000);
  const forgedJwt = [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: user.id, aud: "authenticated", role: "authenticated", aal: "aal1", iat: now, exp: now + 3600 }),
    "planted-signature",
  ].join(".");
  const planted =
    "base64-" +
    b64url({
      access_token: forgedJwt,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: "planted-refresh-token",
      user: { id: user.id, email: user.email, aud: "authenticated" },
    });
  await context.addCookies([
    { name: cookieName, value: planted, domain: "localhost", path: "/", sameSite: "Lax" },
  ]);

  // The planted session does not open a signed-in page.
  await page.goto("/account/sessions");
  await expect(page).toHaveURL(/\/login/);

  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const chunks = (await context.cookies())
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  expect(chunks.length, "sign-in left no auth cookie").toBeGreaterThan(0);
  const joined = chunks.map((c) => c.value).join("");
  expect(joined).not.toBe(planted);
  const session = JSON.parse(Buffer.from(joined.replace(/^base64-/, ""), "base64url").toString("utf8"));
  expect(session.user.id).toBe(user.id);
  expect(session.access_token).not.toBe(forgedJwt);
  expect(session.refresh_token).not.toBe("planted-refresh-token");

  // And the replacement is a real session.
  await page.goto("/account/sessions");
  await expect(page.getByRole("heading", { level: 1, name: "Sign out everywhere" })).toBeVisible();
});
