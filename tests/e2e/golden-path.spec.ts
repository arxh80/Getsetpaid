import { expect, test } from "@playwright/test";
import { setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE PHASE 2 GOLDEN PATH, WALKED.
//
// `CLAUDE.md` names it as "create contact -> create event -> add artist -> add
// venue -> add task -> view activity". This file walks the Phase 2 stretch;
// `events.spec.ts` walks the events stretch, and `operations.spec.ts` — added
// in Phase 4 Task 8 — walks the "add a task -> view activity" step against a
// real event's timeline. The three are siblings by design: whoever extends the
// sentence adds a spec, never rewrites another. The Phase 2 shape here is:
//
//     create contact -> create company -> link them -> add artist
//                    -> add venue -> add a room -> view the activity timeline
//
// One test, in order, sharing a page. Split into seven independent tests each
// would need its own six steps of setup, and the thing being protected is the
// SEQUENCE -- a link that works from a fresh company and not from one the user
// just created is exactly the defect this catches.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

test("the Phase 2 golden path, end to end, as a manager", async ({ page }) => {
  await signIn(page, world, "manager");

  // ---- 1. CREATE A CONTACT -------------------------------------------------
  await page.goto(`/${world.orgSlug}/contacts/new`);
  await page.locator('input[name="name"]').fill("Golden Path Agent");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(
    page.getByRole("heading", { name: "Golden Path Agent", level: 1 }),
  ).toBeVisible();
  const contactUrl = page.url();

  // ---- 2. CREATE A COMPANY -------------------------------------------------
  await page.goto(`/${world.orgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill("Golden Path Promotions");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(
    page.getByRole("heading", { name: "Golden Path Promotions", level: 1 }),
  ).toBeVisible();

  // ---- 3. LINK THEM --------------------------------------------------------
  // From the company side, which is the side whose picker reads contacts. The
  // option list is asserted to EXCLUDE nothing here; that it excludes
  // soft-deleted records is the subject of tenant-breakout.spec.ts.
  await page.locator('select[name="contactId"]').selectOption({ label: "Golden Path Agent" });
  await page.getByRole("button", { name: "Link", exact: true }).click();
  // `.first()`: the linked person appears both in the People list and in the
  // timeline entry the link just produced, and both are anchors to the same
  // record. Two matches is the page working, not a duplicate.
  await expect(
    page.getByRole("link", { name: "Golden Path Agent" }).first(),
  ).toBeVisible();

  // ---- 4. ADD AN ARTIST ----------------------------------------------------
  await page.goto(`/${world.orgSlug}/artists/new`);
  await page.locator('input[name="name"]').fill("Golden Path DJ");
  await page.getByRole("button", { name: "Create artist" }).click();
  await expect(
    page.getByRole("heading", { name: "Golden Path DJ", level: 1 }),
  ).toBeVisible();

  // ---- 5. ADD A VENUE ------------------------------------------------------
  await page.goto(`/${world.orgSlug}/venues/new`);
  await page.locator('input[name="name"]').fill("Golden Path Warehouse");
  await page.getByRole("button", { name: "Create venue" }).click();
  await expect(
    page.getByRole("heading", { name: "Golden Path Warehouse", level: 1 }),
  ).toBeVisible();

  // ---- 6. ADD A ROOM -------------------------------------------------------
  // Rooms belong to venues and are managed from the venue's own page -- there
  // is no /rooms route and there should not be one.
  await page.locator('input[name="roomName"]').fill("Main Room");
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.getByText("Main Room")).toBeVisible();

  // ---- 7. VIEW THE ACTIVITY TIMELINE ---------------------------------------
  // On the CONTACT, because it is the record that now has two different kinds
  // of event on it -- its own creation and the link -- and because the Task 7
  // defect that shipped past every other gate ("we couldn't load this
  // contact's activity") was on exactly this surface.
  await page.goto(contactUrl);
  // UNCONDITIONAL (deferred-minor L1139). This used to fall back to
  // `page.locator("main")` when the region was not found, which quietly
  // degraded the three assertions below from "the activity timeline says this"
  // to "somewhere on the page says this" -- and the timeline is a <section
  // aria-labelledby> whose accessible name coming loose is precisely the kind
  // of regression this step exists to catch. The region is asserted to exist
  // FIRST, so a missing landmark fails here with a clear message instead of
  // silently widening every assertion after it.
  const activity = page.getByRole("region", { name: /activity/i });
  await expect(
    activity,
    "the activity timeline must be a named region, not just markup in <main>",
  ).toHaveCount(1);
  await expect(activity).toContainText("CREATED", { ignoreCase: true });
  await expect(activity).toContainText("LINKED", { ignoreCase: true });
  await expect(activity).toContainText("Golden Path Promotions");
  // THE FAILURE MODE THAT SHIPPED. A timeline that cannot load renders this
  // sentence, and every other assertion above would still pass beside it.
  await expect(page.locator("main")).not.toContainText(
    "couldn't load this contact's activity",
  );
});

test("a read-only member cannot reach the create form, not just the button", async ({
  page,
}) => {
  // HIDING THE UI IS NOT ENFORCEMENT (`CLAUDE.md` § Permissions). The list page
  // renders "New contact" as a disabled <button> rather than a link, which is
  // the cosmetic half; this asserts the route itself refuses.
  await signIn(page, world, "read_only");
  await page.goto(`/${world.orgSlug}/contacts/new`);
  await expect(page.locator("main")).toContainText("Read-only");
  await expect(page.getByRole("button", { name: "Create contact" })).toHaveCount(0);
});

test("a standard user is told their list is scoped, not that it is empty", async ({
  page,
}) => {
  // TASK 3'S DEFECT, MADE EXECUTABLE. A Read Only user in a 71-contact
  // workspace was told "No contacts yet". The record-scoped list has to say
  // whose records it is showing, or it lies about the workspace.
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/contacts`);
  await expect(page.locator("main")).toContainText(
    /assigned to you|Others in this workspace may see more/i,
  );
  await expect(page.locator("main")).not.toContainText("No contacts yet");
});
