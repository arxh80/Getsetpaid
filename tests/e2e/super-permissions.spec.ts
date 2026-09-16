// =============================================================================
// PHASE 7 TASK 7 -- THE PERMISSION MATRIX, AT THE PAGE LAYER
// =============================================================================
// "An action is allowed only if ALL of these permit it ... Entitlements are
// enforced server-side -- hiding UI is not enforcement." (CLAUDE.md
// § Permissions.) The plan's named case for this task is "unreachable by a
// non-superuser, EVEN AN ORG OWNER".
//
// The RPC, table and grant layers are proved in
// tests/integration/security/phase7-permission-matrix.test.ts, which needs no
// browser. This file is the half that does: a real HTTP GET of every /super
// page and of the one /super route handler, as every principal a browser can
// be, through the app's own sign-in form.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE COULD NOT HAVE BEEN WRITTEN BEFORE THIS TASK
// -----------------------------------------------------------------------------
// `E2eRole` was `manager | standard_user | read_only | finance | booker` and
// sign-in.ts said so: "owner and admin are the other two and nothing here is
// either." So no e2e test in this repo had ever signed in as an Owner, and the
// /super refusal probes that existed were all driven by a manager with the
// standing note that "an Org Owner is MFA-required, so an owner probe would be
// measuring the MFA challenge rather than the superuser gate". That note was
// true of an owner fixture that did not walk the challenge, and it is the
// reason this task built one that does.
//
// -----------------------------------------------------------------------------
// EVERY REFUSAL HERE CARRIES TWO POSITIVE CONTROLS
// -----------------------------------------------------------------------------
// A green refusal proves nothing on its own: a mistyped URL, a page that
// renders nothing for anybody, and a fixture that never held the key all look
// exactly like a working guard. So before any refusal is trusted:
//
//   1. THE SURFACE EXISTS AND ANSWERS. `SUPER_SURFACES` is walked by the aal2
//      platform superuser first, and each entry names an element that is only
//      on that page -- so a URL typo or a blank page is red, by name.
//   2. THE PRINCIPAL IS REAL. The Owner and Admin personas are walked onto an
//      Owner/Admin-ONLY surface (`/settings/custom-fields`,
//      `manage_custom_fields`, one of the three permissions held by exactly
//      {owner, admin}) and the control is asserted PRESENT. That is the test
//      that tells "the superuser gate refused an Owner" apart from "this
//      session was never an Owner at all" -- which is precisely the shape of
//      the settings-scan failure this phase already paid for once.
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";
import { totpCode } from "../support/totp";

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  await tearDownWorld(world);
});

// =============================================================================
// THE INVENTORY -- globbed, not recalled
// =============================================================================
// Produced by `find app -path "*super*" -name "page.tsx"` and
// `find app -path "*super*" -name "route.ts"` against the tree, then given the
// one element that distinguishes each. `THE INVENTORY IS COMPLETE` below
// re-runs the glob at test time, so a Phase 8 page added under /super without
// a row here is a red test naming the file.
interface SuperSurface {
  url: string;
  /** The <h1> only this page renders -- the superuser's positive control. */
  heading: string;
  /** The <title> fragment `generateMetadata()` gates on identity. */
  title: RegExp;
}

const SUPER_SURFACES: SuperSurface[] = [
  { url: "/super", heading: "Platform", title: /Superuser/ },
  { url: "/super/audit-log", heading: "Audit log", title: /Audit log/ },
  { url: "/super/billing", heading: "Billing and feature overrides", title: /Billing overrides/ },
  { url: "/super/feedback", heading: "Feedback", title: /Feedback/ },
  { url: "/super/health", heading: "Platform health", title: /Platform health/ },
  { url: "/super/impersonation", heading: "Impersonation", title: /Impersonation/ },
  // Phase 8 Task 1. One page for both views (the list and `?doc=<slug>`), so
  // the census stays a list of literal URLs.
  { url: "/super/legal", heading: "Legal documents", title: /Legal documents/ },
  { url: "/super/organisations", heading: "Organisations", title: /Organisations/ },
];

// =============================================================================
// SIGNING IN
// =============================================================================
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

/**
 * The superuser's account, STOPPED AT THE CHALLENGE.
 *
 * Brief principal 6. On the allowlist, in `platform_admins`, one factor short:
 * `isSuperuser()` is deliberately NOT aal-gated (lib/admin/superuser.ts), so
 * this session is the one that would reach a /super page if any page's own
 * gate were the render check rather than a real aal2 permission read.
 */
async function signInAsSuperuserAtAal1(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "the superuser must be CHALLENGED, or this principal is not aal1 and every " +
      "refusal it collects proves nothing about the aal2 gate",
  ).toBeVisible();
}

/**
 * A refusal that must be indistinguishable from "this page does not exist".
 *
 * The house contract, extended rather than forked -- the same shape
 * tenant-breakout.spec.ts's `expectRefused` and audit-log.spec.ts's
 * `expectStreamedRefusal` assert. 200 or 404, never 403 (a 403 confirms the
 * page exists, which is an enumeration oracle for the operator's console), the
 * not-found copy in the body, and NEITHER the /super layout's "Superuser"
 * chrome NOR the page's own <title> surviving into it -- a static `metadata`
 * export leaks the title into a streamed 404 whatever the body does, which is
 * why every /super page uses `generateMetadata()` with an identity check.
 */
async function expectRefused(page: Page, surface: SuperSurface, who: string) {
  const response = await page.goto(surface.url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${surface.url} must refuse ${who} as 404 or a streamed not-found -- never ` +
      `403, never a redirect; got ${status}`,
  ).toContain(status);
  expect(
    page.url(),
    `${surface.url} must not bounce ${who} to /login -- a bounce distinguishes ` +
      `an authenticated refusal from a signed-out one`,
  ).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(
    page.locator("body"),
    `${surface.url}'s refusal carried the /super layout's "Superuser" chrome to ${who}`,
  ).not.toContainText("Superuser");
  // THE HEADING AS A HEADING, not as a substring of the body. "Feedback" is
  // also the label on the app-wide feedback dialog that every signed-in page
  // renders, so a body-text search for it reports a leak on a page that leaked
  // nothing -- an assertion that is red for a reason unrelated to the boundary
  // is no better than one that is green for a reason unrelated to it.
  await expect(
    page.getByRole("heading", { name: surface.heading, level: 1 }),
    `${surface.url}'s refusal carried its own <h1> to ${who}`,
  ).toHaveCount(0);
  await expect(
    page,
    `${surface.url}'s refusal carried its own <title> to ${who} -- the same ` +
      `oracle through the tab title instead of the body`,
  ).not.toHaveTitle(surface.title);
}

// =============================================================================
// GATE 0: THE INVENTORY IS COMPLETE
// =============================================================================
test("every /super page in the tree is on this file's list", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(process.cwd(), "app", "(app)", "super");
  const found: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${url}/${entry.name}`);
      } else if (entry.name === "page.tsx") {
        found.push(url);
      }
    }
  };
  walk(root, "/super");
  // A page added under /super by a later phase lands HERE, by path, instead of
  // quietly never being probed by any principal.
  expect(found.sort()).toEqual(SUPER_SURFACES.map((s) => s.url).sort());
});

// =============================================================================
// POSITIVE CONTROL 1: THE SURFACES EXIST AND ANSWER
// =============================================================================
test("POSITIVE CONTROL: the aal2 platform superuser reaches every /super surface", async ({
  page,
}) => {
  // WITHOUT THIS, EVERY REFUSAL BELOW IS A REFUSAL OF NOTHING. A mistyped URL
  // and a page that renders blank both produce a perfect "Page not found" for
  // every principal in this file.
  await signInAsSuperuser(page);
  for (const surface of SUPER_SURFACES) {
    const response = await page.goto(surface.url);
    expect(
      response?.status(),
      `${surface.url} must be reachable by the aal2 superuser`,
    ).toBe(200);
    await expect(
      page.getByRole("heading", { name: surface.heading, level: 1 }),
      `${surface.url} did not render its own heading for the one principal ` +
        `that is supposed to see it`,
    ).toBeVisible();
    await expect(page).toHaveTitle(surface.title);
  }
});

// =============================================================================
// POSITIVE CONTROL 2: THE OWNER AND ADMIN PERSONAS REALLY HOLD THEIR KEYS
// =============================================================================
// THE TEST THAT TELLS THE TWO GREEN REFUSALS APART. `/settings/custom-fields`
// is gated on `manage_custom_fields`, one of the three permissions in
// `role_permissions` held by exactly {owner, admin}, and it is aal2-gated
// inside has_permission() like every owner/admin key. If the new personas were
// signing in at aal1, or were seeded with the wrong role, this goes red here --
// and every "even an Org Owner is refused at /super" test below stops being a
// test of a fixture that was never an Owner.
//
// It is also the first time this repo has EVER rendered an Owner/Admin-only
// surface in a browser: nothing had signed in as either role, so the controls
// on this page had never been in a DOM any test looked at.
for (const role of ["owner", "admin"] as const) {
  test(`POSITIVE CONTROL: the ${role} persona reaches an Owner/Admin-only surface`, async ({
    page,
  }) => {
    await signIn(page, world, role);
    const response = await page.goto(`/${world.orgSlug}/settings/custom-fields`);
    expect(
      response?.status(),
      `an ${role} at aal2 must reach the custom-fields settings page`,
    ).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Custom fields", level: 1 }),
    ).toBeVisible();
    // THE CONTROL, not just the page. A page that rendered its heading and no
    // form would satisfy a heading-only assertion and would mean the key was
    // NOT held -- the exact shape of this phase's settings-scan failure, where
    // a scan came back green because the fixture was a manager and the
    // Owner/Admin controls were simply never in the DOM.
    //
    // The disclosure is the permission statement: `CustomFieldEditor` renders
    // `<AddField>` only when `getCrmWriteAccess(org, "manage_custom_fields")`
    // returns canWrite, and the sentence "Your role in this workspace can view
    // records but not change them" in its place otherwise -- which is exactly
    // what a manager gets (asserted below).
    // I6, fix round 1: THE DISCLOSURE AS A <summary>, not as the text "Add a
    // field". `CustomFieldEditor` renders that exact string TWICE, and the two
    // mean opposite things: a `<summary>` opening the real form when the key is
    // held, and a bare `<h2>` above "All 5 of this plan's custom fields ... are
    // in use" when the WORKSPACE IS AT ITS QUOTA -- a tier condition, not a
    // permission one. A text-only assertion passed on both, so a quota failure
    // would have arrived as this test's own message: "this session does not
    // hold manage_custom_fields". The world org is Starter and uses fewer than
    // five today, so it passes either way; the point is that when it stops
    // passing, it says the true reason.
    const disclosure = page.locator("details > summary", { hasText: "Add a field" });
    await expect(
      disclosure,
      `the ${role} persona reached the page without the control it is gated ` +
        `on, which means this session does not hold manage_custom_fields and ` +
        `every refusal it collects elsewhere is meaningless`,
    ).toBeVisible();
    await expect(
      page.getByText("custom fields for this record type are in use"),
      `the workspace is AT its custom-field limit, so the form is withheld for ` +
        `a TIER reason and this test can say nothing about manage_custom_fields. ` +
        `Free a slot in the fixture rather than reading this as a refusal.`,
    ).toHaveCount(0);

    // THEN THE FORM ITSELF, AFTER OPENING IT -- and the order is not
    // cosmetic. The submit button sits inside a COLLAPSED <details>, which the
    // accessibility tree does not expose, so `getByRole("button")` resolves to
    // ZERO elements against a page that is rendering the control perfectly.
    // Asserting the closed state would have been a test that fails for a
    // reason unrelated to permissions, in a file whose whole subject is
    // assertions that pass for reasons unrelated to permissions.
    await disclosure.click();
    await expect(
      page.getByRole("button", { name: /Add field/i }),
      `the ${role} persona opened the disclosure and found no submit control`,
    ).toBeVisible();
    await signOut(page);
  });
}

test("a Manager does NOT reach the Owner/Admin-only surface -- the same control, negated", async ({
  page,
}) => {
  // The other half of the denominator. If /settings/custom-fields rendered its
  // "Add field" control for everybody, the two positive controls above would
  // be green for a reason that has nothing to do with the Owner/Admin keys.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/settings/custom-fields`);
  await expect(
    page.getByRole("heading", { name: "Custom fields", level: 1 }),
    "the manager must REACH the page -- if they cannot, the count assertion " +
      "below is about a page that did not render rather than about a key",
  ).toBeVisible();
  await expect(
    page.getByText("Add a field", { exact: true }),
    "a manager holds no manage_custom_fields key and must not get the control",
  ).toHaveCount(0);
  // AND THE PAGE SAID WHY. Without this the count above is satisfied just as
  // well by a page that rendered nothing at all below the heading -- which is
  // the same thing as the control being absent for the wrong reason.
  // `.first()`: the sentence is rendered TWICE and deliberately so -- once by
  // `WriteBlockedNote` above the editor and once in place of the form, the
  // page's own comment explaining that "two different explanations for one
  // situation is how a user concludes one of them is wrong". So this is a
  // strict-mode violation rather than a real ambiguity, and the count is
  // asserted beside it so a future change to one of the two copies is visible
  // here rather than silently halving the explanation.
  await expect(
    page.getByText(
      "Your role in this workspace can view records but not change them",
    ),
  ).toHaveCount(2);
  await expect(
    page
      .getByText(
        "Your role in this workspace can view records but not change them",
      )
      .first(),
  ).toBeVisible();
});

// =============================================================================
// THE REFUSALS
// =============================================================================
test("anonymous: every /super surface is unreachable with no session at all", async ({
  page,
}) => {
  for (const surface of SUPER_SURFACES) {
    const response = await page.goto(surface.url);
    // Signed out, the app's own auth gate bounces to /login BEFORE the
    // superuser gate is consulted -- which is the correct order and a
    // different contract from the authenticated refusals below, so it is
    // asserted as itself rather than bent into `expectRefused`.
    expect(
      page.url(),
      `${surface.url} must not serve a signed-out caller; got ${response?.status()}`,
    ).toMatch(/\/login/);
    await expect(
      page.getByRole("heading", { name: surface.heading, level: 1 }),
      `${surface.url} leaked its heading to a signed-out caller`,
    ).toHaveCount(0);
  }
});

for (const role of ["read_only", "owner", "admin"] as const) {
  test(`${role}: every /super surface refuses identically to a page that does not exist`, async ({
    page,
  }) => {
    // `owner` is THE PLAN'S NAMED CASE, at aal2, holding every in-tenant
    // permission there is -- and holding none of them is the point: an
    // organisation role is not platform policy, and the intersection in
    // CLAUDE.md § Permissions has to fail on the platform term alone.
    await signIn(page, world, role);
    for (const surface of SUPER_SURFACES) {
      await expectRefused(page, surface, role);
    }
  });
}

test("the platform superuser BELOW aal2 reaches no /super surface", async ({ page }) => {
  // Principal 6, and the one every task from 1 to 6 claimed without proving in
  // one place. `isSuperuser()` is not aal-gated, so this session passes the
  // identity check and must still be stopped by the assurance level -- the
  // shape is the challenge screen persisting, not a not-found document.
  //
  // WHICH CONTROL IS BEING MEASURED HERE, stated because it is not /super's own
  // (review finding I7). Every /super page gates on `isSuperuser()`, which
  // reads identity and not assurance, so `generateMetadata()` would hand this
  // session the real <title> and notFound() would not fire; what stops it is
  // the APP-WIDE MFA challenge gate, and what this test therefore proves is
  // that the challenge gate still covers /super -- a real property, and the one
  // that goes red if a later phase exempts the operator's console from it. The
  // aal2 term itself is proved at the DATA layer instead, where every /super
  // page's reads go through private.has_platform_permission(): the permission
  // matrix drives `superuserAal1` against all thirteen RPCs and all seven
  // tables, and mutation 1 (see that file's header) reds 24 of 224 -- 21 of
  // them this principal's own (13 RPC refusals, 7 table reads, 1 table write)
  // and 3 cascade. Re-measured in the pre-merge fix round; fix round 1's own
  // M1 change moved these figures and did not re-run them.
  await signInAsSuperuserAtAal1(page);
  const challenge = page.getByRole("heading", { name: "Enter your two-factor code" });
  for (const surface of SUPER_SURFACES) {
    await page.goto(surface.url);
    await expect(
      challenge,
      `${surface.url} let an aal1 superuser session past the challenge`,
    ).toBeVisible();
    await expect(
      page.locator("body"),
      `${surface.url} rendered its content to an aal1 superuser session`,
    ).not.toContainText(surface.heading);
  }
});

// =============================================================================
// THE ROUTE HANDLER -- the one non-page surface under /super
// =============================================================================
test("the feedback screenshot route refuses every non-superuser with a literal 404", async ({
  page,
}) => {
  // A ROUTE HANDLER, not a page: nothing streams, so the literal status is
  // still assertable and is asserted (lib/feedback/screenshot.ts's own step 1
  // -- "identity -- isSuperuser(), else 404").
  //
  // POSITIVE CONTROL FIRST, and it is the whole reason this test is honest: a
  // NONEXISTENT feedback id is 404 for the superuser too, so a refusal of a
  // nonexistent id proves nothing. The superuser is walked to a 404 on a ghost
  // id, so the ghost is established as the baseline, and then each refused
  // principal gets the SAME 404 on the same id -- parity, which is the
  // property, rather than a status code in isolation.
  const ghost = "00000000-0000-4000-8000-0000000000ff";
  const url = `/super/feedback/${ghost}/screenshot`;

  await signInAsSuperuser(page);
  const asSuperuser = await page.request.get(url);
  expect(
    asSuperuser.status(),
    "the route must answer the superuser at all -- if this is not 404 the " +
      "baseline below is wrong and the refusals mean something else",
  ).toBe(404);
  await signOut(page);

  for (const role of ["read_only", "owner", "admin"] as const) {
    await signIn(page, world, role);
    const response = await page.request.get(url);
    expect(
      response.status(),
      `${url} must refuse ${role} identically to the superuser's own 404 on a ` +
        `ghost id -- never 403, never 409, never a redirect`,
    ).toBe(404);
    expect(
      await response.text(),
      `${url} leaked a reason to ${role}`,
    ).not.toMatch(/quarantin|scan|storage|Superuser/i);
    await signOut(page);
  }
});

// =============================================================================
// THE SERVICE-ROLE KEY IS NOT IN THE BROWSER
// =============================================================================
// Brief principal 8: `service_role` and `postgres` are not tested as "refused",
// because they bypass by design. What is asserted instead is that neither is
// REACHABLE from the browser -- and "grep the built client chunks, not just the
// source", which is what this does: every script the page actually loads is
// fetched back over HTTP and searched.
test("no script the browser loads contains the service-role key", async ({ page }) => {
  const stack = JSON.parse(
    (await import("node:child_process")).execSync("supabase status -o json", {
      encoding: "utf8",
    }),
  ) as Record<string, string>;
  const serviceRoleKey = stack.SERVICE_ROLE_KEY;
  const anonKey = stack.ANON_KEY;
  expect(serviceRoleKey && anonKey, "could not read the local stack's keys").toBeTruthy();
  expect(
    serviceRoleKey,
    "the two keys must differ, or the positive control below proves nothing",
  ).not.toBe(anonKey);

  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts`);

  const scripts = await page.locator("script[src]").evaluateAll((els) =>
    els.map((e) => (e as HTMLScriptElement).src),
  );
  expect(
    scripts.length,
    "the page loaded no external scripts, so searching them measures nothing",
  ).toBeGreaterThan(0);

  // The DOCUMENT counts too: Next inlines `NEXT_PUBLIC_*` into the RSC payload
  // as readily as into a chunk, so searching only `<script src>` would leave
  // the likeliest hiding place unread.
  let sawAnonKey = false;
  const sources: { name: string; body: string }[] = [
    { name: "the document itself", body: await page.content() },
  ];
  for (const src of scripts) {
    sources.push({ name: src, body: await (await page.request.get(src)).text() });
  }
  for (const { name, body } of sources) {
    expect(
      body.includes(serviceRoleKey),
      `${name} contains the SERVICE-ROLE key -- it bypasses RLS and must never ` +
        `leave the server (CLAUDE.md § Non-negotiable rules)`,
    ).toBe(false);
    if (body.includes(anonKey)) sawAnonKey = true;
  }

  // THE POSITIVE CONTROL. The anon key IS meant to be in the bundle -- the
  // browser client authenticates with it. Finding it proves the fetch, the
  // decode and the substring search all work, so "the service key was not
  // found" is a statement about the service key and not about a search that
  // was looking at nothing.
  expect(
    sawAnonKey,
    "the ANON key was not found in any loaded script either, so this test's " +
      "search found nothing at all and its service-key assertion is vacuous",
  ).toBe(true);
});
