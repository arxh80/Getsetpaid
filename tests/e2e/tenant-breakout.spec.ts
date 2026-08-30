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

// ASSERTED AGAINST <body>, NOT <main>, AND THAT IS A FINDING NOT A PREFERENCE.
// A 404 raised inside the app shell renders TWO `main` landmarks, one nested in
// the other: `app/(app)/layout.tsx:150` opens `<main id="main">` and
// `app/not-found.tsx:21` opens its own `<main>` inside it. Measured on this
// stack -- `document.querySelectorAll("main").length` is 2 and
// `"main main"` is 1 on exactly the page every refusal below lands on.
// Nested `<main>` is invalid HTML and two `main` landmarks is a real
// screen-reader defect; it is reported in the Task 8 exit document rather than
// fixed here, because the same file serves the unauthenticated 404 where its
// `<main>` is correct. `body` is used so these assertions measure the REFUSAL
// and do not go red for the landmark bug as well.
const REFUSED = (page: import("@playwright/test").Page) => page.locator("body");

test("another tenant's workspace is not reachable by slug", async ({ page }) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.otherOrgSlug}/contacts`);
  // 404 rather than 403: a 403 confirms the workspace exists, which is
  // membership enumeration. The manager is a full-scope member of their OWN
  // workspace, so this is the tenant boundary and nothing else.
  await expect(REFUSED(page)).toContainText("Page not found");
  await expect(REFUSED(page)).not.toContainText("Other Tenant Secret");
});

test("another tenant's record is not reachable by id, from either slug", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  // Under the OTHER tenant's slug -- refused because the workspace is not ours.
  await page.goto(`/${world.otherOrgSlug}/contacts/${world.otherOrgContactId}`);
  await expect(REFUSED(page)).toContainText("Page not found");
  // And under OUR OWN slug, which is the interesting one: the workspace is
  // ours, the id is a real row, and only the tenant filter separates them.
  await page.goto(`/${world.orgSlug}/contacts/${world.otherOrgContactId}`);
  await expect(REFUSED(page)).toContainText("Page not found");
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
  await page.goto(`/${world.orgSlug}/contacts/${world.managerOwnedContactId}`);
  await expect(REFUSED(page)).toContainText("Page not found");
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
