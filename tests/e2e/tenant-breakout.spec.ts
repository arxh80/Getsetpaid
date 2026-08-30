import { expect, test } from "@playwright/test";
import { setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// TENANT BREAKOUT AND RECORD SCOPE, THROUGH THE BROWSER.
//
// `CLAUDE.md` § Testing gates: "Tenant-breakout and network-leakage tests
// matter most". The psql and HTTP suites already prove the POLICIES; what they
// cannot prove is that the pages built on them do not route around one -- a
// server component that reads with the service-role key, a detail route that
// trusts its own path parameter, a link picker that offers a record the list
// hides. Those are page-level mistakes and only a page can catch them.
//
// Every assertion below is made as a REAL signed-in user holding a REAL anon-key
// session, which is the exact position an attacker with a stolen password is in.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

// ASSERTED AGAINST <body>, NOT <main>. It used to be a workaround: a 404 raised
// inside the app shell rendered TWO `main` landmarks, one nested in the other
// (`app/(app)/layout.tsx` opened `<main id="main">` and `app/not-found.tsx`
// opened its own inside it), and `body` kept these assertions measuring the
// REFUSAL rather than going red for the landmark bug too. Final review I-8
// fixed that -- `app/(app)/not-found.tsx` renders the same markup in a `<div>`
// -- and `body` stays because it is the right locator for "this page refused
// me" regardless of how the refusal is laid out.
const REFUSED = (page: import("@playwright/test").Page) => page.locator("body");

/**
 * Go to a URL that must be refused, and assert the STATUS as well as the words.
 *
 * ===========================================================================
 * WHY THE STATUS IS THE ASSERTION AND THE TEXT IS NOT ENOUGH
 * ===========================================================================
 * Final review I-11 (deferred-minor L1138). Every refusal here asserted
 * `toContainText("Page not found")` and nothing else, while the Task 8 exit
 * document recorded IDOR/BOLA as **Met** on the evidence "all 404, not 403 --
 * no membership or record enumeration. Asserted in Playwright." The status
 * code was not asserted anywhere in this file, so that row was argued rather
 * than measured.
 *
 * The property is load-bearing, not cosmetic: `app/not-found.tsx`'s own header
 * says in as many words that the page IS a security control and that a
 * distinguishing 403 there would be an enumeration oracle for other tenants'
 * slugs and ids. A future route that returns 403 for a cross-tenant id would
 * keep rendering the same words through an error boundary and every assertion
 * in this file would stay green.
 */
async function expectRefused(
  page: import("@playwright/test").Page,
  url: string,
) {
  const response = await page.goto(url);
  expect(response?.status(), `${url} must refuse with 404, never 403`).toBe(404);
  await expect(REFUSED(page)).toContainText("Page not found");
}

test("another tenant's workspace is not reachable by slug", async ({ page }) => {
  await signIn(page, world, "manager");
  // 404 rather than 403: a 403 confirms the workspace exists, which is
  // membership enumeration. The manager is a full-scope member of their OWN
  // workspace, so this is the tenant boundary and nothing else. The STATUS is
  // asserted, not only the words -- see expectRefused.
  await expectRefused(page, `/${world.otherOrgSlug}/contacts`);
  await expect(REFUSED(page)).not.toContainText("Other Tenant Secret");
});

test("another tenant's record is not reachable by id, from either slug", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  // Under the OTHER tenant's slug -- refused because the workspace is not ours.
  await expectRefused(
    page,
    `/${world.otherOrgSlug}/contacts/${world.otherOrgContactId}`,
  );
  // And under OUR OWN slug, which is the interesting one: the workspace is
  // ours, the id is a real row, and only the tenant filter separates them.
  await expectRefused(page, `/${world.orgSlug}/contacts/${world.otherOrgContactId}`);
  await expect(REFUSED(page)).not.toContainText("secret@other.test");
});

test("record scope holds inside one tenant, on the list and on the record", async ({
  page,
}) => {
  // A standard user is a MEMBER here. Nothing about the tenant refuses them;
  // `private.full_scope_organisations()` excluding their role is the only
  // control, and it is a different control from the tenant filter.
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/contacts`);
  await expect(page.locator("main")).not.toContainText("Manager Only Contact");
  await expectRefused(
    page,
    `/${world.orgSlug}/contacts/${world.managerOwnedContactId}`,
  );
});

test("a stored javascript: or data: URL renders inert, never as a link", async ({
  page,
}) => {
  // The values were planted through Postgres precisely BECAUSE the form
  // refuses them -- see the fixture's note. What is measured here is
  // `safeHref()` on the way OUT.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts/${world.hostileContactId}`);

  // No anchor anywhere on the page carries a dangerous scheme.
  const dangerous = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
  );
  expect(dangerous).toEqual([]);

  // The legitimate one is still a link, so the assertion above is not passing
  // because nothing rendered.
  await expect(
    page.locator('a[href="https://x.com/legitimate"]'),
  ).toHaveCount(1);

  // The refused values are still SHOWN -- as text. Hiding them would lose
  // data the user typed; rendering them as links is the defect.
  await expect(page.locator("main")).toContainText("javascript:document.title=");

  // And the markup in the name never became markup: React escaped it, so the
  // page carries no <img> and the payload never ran.
  //
  // `not.toContain` would be the WRONG assertion and the first draft made it:
  // the contact's NAME contains the literal text "XSS-FIRED", so the document
  // title contains it too, correctly, as escaped text. What must not happen is
  // the payload RUNNING, which would replace the whole title with the marker.
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.title()).not.toBe("XSS-FIRED");
  expect(await page.title()).not.toBe("DATA-FIRED");
  expect(await page.title()).not.toBe("HREF-FIRED");
  // The title is still the record's, so the assertions above are not passing
  // against a page that failed to render.
  expect(await page.title()).toContain("Hostile Values");
});

test("soft-deleted records are on the deleted screen and nowhere else", async ({
  page,
}) => {
  // SOFT-DELETE FILTERING IS THE APPLICATION'S JOB, NOT THE POLICY'S (Task 2
  // § 4.1, restated in the Task 8 brief § 5): nothing errors when a screen
  // forgets, so it cannot be asserted in SQL. Three screens, one record.
  await signIn(page, world, "manager");

  await page.goto(`/${world.orgSlug}/contacts/${world.managerOwnedContactId}`);
  // TWO STEPS, BY DESIGN (`components/crm/delete-restore.tsx`): the first
  // button swaps itself for a question and a "Yes, delete". A one-click delete
  // is what that component exists not to be, so the test clicks both.
  await page.getByRole("button", { name: /^Delete contact$/i }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByRole("button", { name: /Restore/i })).toBeVisible();

  // 1. Gone from the live list.
  await page.goto(`/${world.orgSlug}/contacts`);
  await expect(page.locator("main")).not.toContainText("Manager Only Contact");

  // 2. Present on the deleted list.
  await page.goto(`/${world.orgSlug}/contacts/deleted`);
  await expect(page.locator("main")).toContainText("Manager Only Contact");

  // 3. AND NOT OFFERED BY A LINK PICKER. This is the one a list-page assertion
  // would miss: `loadLinkOptions` is a different query with its own
  // `deleted_at` filter, and dropping that filter is invisible to every other
  // gate (Task 4 review, mutation 8).
  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill("Picker Probe Co");
  await page.getByRole("button", { name: "Create company" }).click();
  const picker = page.locator('select[name="contactId"]');
  await expect(picker).toBeVisible();
  const options = await picker.locator("option").allTextContents();
  expect(options.join("\n")).not.toContain("Manager Only Contact");
  // Non-vacuity: the picker is offering SOMETHING, so the assertion above is
  // not passing against an empty select.
  expect(options.length).toBeGreaterThan(1);
});

test("the pager announces an unavailable direction rather than removing it", async ({
  page,
}) => {
  // A DELIBERATE DECISION, ASSERTED SO IT STAYS ONE. `components/list/list-pager.tsx`
  // keeps both directions as anchors even when they lead nowhere, so keyboard
  // focus survives reaching the last page, and marks the dead one
  // `aria-disabled`. Read as a defect by anyone who meets it without the
  // comment; the failure that WOULD be a defect is the attribute going missing
  // and leaving two live-looking links.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/contacts`);
  const pager = page.getByRole("navigation", { name: "Pagination" });
  await expect(pager).toBeVisible();
  // The fixture has fewer contacts than one page, so BOTH directions are dead.
  await expect(pager.getByText("Previous")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(pager.getByText("Next")).toHaveAttribute("aria-disabled", "true");
});
