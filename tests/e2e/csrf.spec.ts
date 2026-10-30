import { expect, test, type Response } from "@playwright/test";
import {
  countContactsNamed,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 10 TASK 7 (G12): CSRF, PINNED RATHER THAN ASSUMED.
//
// The app has no CSRF token of its own. Two framework behaviours carry it,
// and this spec proves both against the running app:
//
//   1. Next refuses a Server Action whose Origin host differs from Host
//      (unless serverActions.allowedOrigins lists it -- pinned empty by
//      tests/unit/security/next-config.test.ts). A real create-contact POST
//      is captured from a genuine submission (its Next-Action id, headers and
//      body) and replayed with the signed-in session's cookies, once with
//      Origin https://evil.example and once with the app's own origin. Only
//      the second creates a row, counted in Postgres. (Next lets a request
//      with NO Origin through; a browser always sends one on a cross-site
//      POST, so that is the hand-crafted, cookie-less case, not CSRF.)
//   2. The Supabase auth cookies are SameSite=Lax or stricter, read off the
//      Set-Cookie headers the sign-in actually sent (the cookie jar would
//      report an unset attribute as Lax, so it is not the evidence).
//
// The create-contact write needs neither Task 5's server mark nor a step-up
// token, so the positive control measures the Origin check alone.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?=/;

test("a cross-origin Server Action is refused; the same POST from the app's origin succeeds", async ({
  page,
}) => {
  const setCookies: string[] = [];
  const collect = async (response: Response) => {
    for (const h of await response.headersArray()) {
      if (h.name.toLowerCase() === "set-cookie") setCookies.push(...h.value.split("\n"));
    }
  };
  page.on("response", collect);
  await signIn(page, world, "manager");
  page.off("response", collect);

  // ---- SameSite on every auth cookie the sign-in set ----------------------
  const authCookies = setCookies.filter((c) => AUTH_COOKIE.test(c));
  expect(authCookies.length, "the sign-in set no sb-*-auth-token cookie").toBeGreaterThan(0);
  for (const c of authCookies) {
    expect(c, `auth cookie without SameSite=Lax/Strict: ${c.split("=")[0]}`).toMatch(
      /;\s*SameSite=(Lax|Strict)\b/i,
    );
  }

  // ---- capture a genuine create-contact POST ------------------------------
  const suffix = `${Date.now()}`;
  const genuine = `CSRF Genuine ${suffix}`;
  const forged = `CSRF Forged ${suffix}`;
  const control = `CSRF Control ${suffix}`;
  const newPath = `/${world.orgSlug}/contacts/new`;

  const response = await page.goto(newPath);
  // The proxy's per-request CSP reaches the page (the builder is pinned in
  // tests/unit/security/headers.test.ts; this pins that it is wired).
  expect(response?.headers()["content-security-policy"]).toMatch(/frame-ancestors 'none'/);

  const post = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      new URL(req.url()).pathname === newPath &&
      req.headers()["next-action"] !== undefined &&
      // The page also posts another action on load (it records the current
      // workspace); only the create carries the typed name.
      (req.postData() ?? "").includes(genuine),
  );
  await page.locator('input[name="name"]').fill(genuine);
  await page.getByRole("button", { name: "Create contact" }).click();
  const captured = await post;
  await expect(page.getByRole("heading", { name: genuine, level: 1 })).toBeVisible();

  const headers = await captured.allHeaders();
  const body = captured.postData() ?? "";
  expect(body.includes(genuine), "the captured POST did not carry the typed name").toBe(true);
  const replayHeaders: Record<string, string> = {};
  for (const name of ["next-action", "content-type", "accept", "next-router-state-tree"]) {
    if (headers[name] !== undefined) replayHeaders[name] = headers[name];
  }
  const replay = (name: string, origin: string) =>
    page.request.post(newPath, {
      headers: { ...replayHeaders, origin },
      data: body.split(genuine).join(name),
      maxRedirects: 0,
    });

  // ---- the forged POST: refused, nothing written ---------------------------
  const evil = await replay(forged, "https://evil.example");
  expect(evil.status(), "a cross-origin Server Action was not refused").toBe(500);
  expect(await countContactsNamed(world.orgId, forged)).toBe(0);

  // ---- POSITIVE CONTROL: same session, same body, the app's own origin ----
  const own = await replay(control, new URL(page.url()).origin);
  expect(own.status(), `the same-origin replay failed: ${(await own.text()).slice(0, 300)}`).toBeLessThan(400);
  expect(await countContactsNamed(world.orgId, control)).toBe(1);
});
