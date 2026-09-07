import { expect, test } from "@playwright/test";
import {
  ALT_VENUE_NAME,
  ARTIST_NAME,
  DOCUMENT_NAMES,
  EVENT_NAMES,
  NOTE_BODIES,
  OTHER_ARTIST_NAME,
  ROOM_NAME,
  VENUE_NAME,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
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
  // NAMED AFTER WHAT IT PAGES (Task 8). The label was the bare word
  // "Pagination" until the event detail page put two pagers on one record and
  // axe reported `landmark-unique`; components/list/list-pager.tsx carries the
  // measurement. Asserting the SPECIFIC name here means the fix cannot be
  // reverted to a shared literal without this going red.
  const pager = page.getByRole("navigation", { name: "Pagination for contacts" });
  await expect(pager).toBeVisible();
  // The fixture has fewer contacts than one page, so BOTH directions are dead.
  await expect(pager.getByText("Previous")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(pager.getByText("Next")).toHaveAttribute("aria-disabled", "true");
});

// ===========================================================================
// PHASE 3 TASK 7: THE CROSS-ENTITY EVENT SURFACES
// ===========================================================================
// Three new page-level reads of `public.events` land on pages that are ABOUT
// something else -- a venue, an artist, the workspace itself -- and each one
// is a fresh chance to make the mistake this file exists to catch: a query
// that trusts a path parameter, or a list that reads without the tenant
// filter because RLS "will handle it". The psql suite proves the POLICIES on
// `events`; only a page can prove the page.
//
// THE STATUS IS ASSERTED ON THESE, through `expectRefused`. The Task 7 brief
// asked for `expect(response.status()).toBe(404)` on the new assertions
// because the existing ones "assert body text only" -- which was true when it
// was written and is no longer: final review I-11 put the status assertion
// into `expectRefused` above and every refusal in this file now goes through
// it. So the new assertions inherit it rather than adding a second copy.

test("a venue page lists that venue's events, and only this tenant's", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/venues/${world.venueId}`);

  // NON-VACUITY FIRST. Both of this tenant's events are at this venue, so a
  // page that rendered nothing at all would satisfy every absence below.
  await expect(page.locator("main")).toContainText(EVENT_NAMES.managerOwned);
  await expect(page.locator("main")).toContainText(EVENT_NAMES.standardOwned);

  // AND THE OTHER TENANT'S EVENT IS NOT ON IT. The other tenant's event is at
  // the other tenant's venue, so this is the tenant filter and the venue
  // equality both -- and the point is that neither is enough on its own: an
  // `applyFilters` that pinned `venue_id` and dropped `organisation_id` would
  // still look right on this page, which is why the direct-id assertions below
  // exist beside it.
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.otherTenant);
  // Nor the soft-deleted one. Here the clause is `applyScope`'s rather than
  // hand-written, so this is the cheap confirmation that the shared machinery
  // is doing for this list what the home block has to do for itself.
  //
  // SCOPED TO THE SECTION, and the reason is worth reading before widening it.
  // The venue's TIMELINE legitimately names that event -- "Linked to Deleted
  // Night A." -- because the activity view's branches deliberately do not
  // filter the subject's or the other record's `deleted_at`
  // (lib/list/query.ts, TABLES_WITHOUT_SOFT_DELETE), which is the same choice
  // `loadEvent` makes for a deleted venue's name on a live event: on a detail
  // page the name renders, marked, and only the LINK is withheld. Asserting
  // over `main` would therefore measure the timeline's copy and go red for a
  // reason that has nothing to do with this list.
  const here = page.locator("section").filter({ hasText: "Events here" });
  await expect(here).not.toContainText(EVENT_NAMES.softDeleted);
});

test("another tenant's event is not reachable by id, from either slug", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  // Under the OTHER tenant's slug -- refused because the workspace is not ours.
  await expectRefused(page, `/${world.otherOrgSlug}/events/${world.otherOrgEventId}`);
  // And under OUR OWN slug, which is the interesting one: the workspace is
  // ours, the id is a real row, and only the tenant filter separates them.
  // `loadEvent` takes `organisation_id` as an argument and does not read it
  // off the path; this is the assertion that says so from outside.
  await expectRefused(page, `/${world.orgSlug}/events/${world.otherOrgEventId}`);
  await expect(REFUSED(page)).not.toContainText(EVENT_NAMES.otherTenant);
});

test("another tenant's operations records — task, note, document — are not reachable", async ({
  page,
}) => {
  // PHASE 4'S OPERATIONS ENTITIES, ON THE SAME BOUNDARY. Each has its own SELECT
  // policy and its own detail route, so "the tenant filter holds" is a separate
  // claim per entity a browser could not make before these routes existed. Every
  // refusal is a 404 with the secret string ABSENT — never a 403 that would
  // confirm the row exists (`expectRefused` asserts the status too).
  await signIn(page, world, "manager");

  // The other tenant's TASK — from our own slug (the interesting direction: the
  // workspace is ours, the id is a real row, only the tenant filter separates).
  await expectRefused(page, `/${world.orgSlug}/tasks/${world.otherOrgTaskId}`);
  await expect(REFUSED(page)).not.toContainText("Other Tenant Secret Task");

  // The other tenant's private NOTE.
  await expectRefused(page, `/${world.orgSlug}/notes/${world.otherOrgNoteId}`);
  await expect(REFUSED(page)).not.toContainText(NOTE_BODIES.otherTenant);

  // The other tenant's DOCUMENT — its detail page, and its download route (which
  // 404s a cross-tenant id, never distinguishing "not yours" from "not there").
  await expectRefused(page, `/${world.orgSlug}/documents/${world.otherOrgDocumentId}`);
  await expect(REFUSED(page)).not.toContainText(DOCUMENT_NAMES.otherTenant);
  const download = await page.request.get(
    `/${world.orgSlug}/documents/${world.otherOrgDocumentId}/download`,
    { maxRedirects: 0 },
  );
  expect(
    download.status(),
    "a cross-tenant download id must 404, never 302 or 409",
  ).toBe(404);

  // And this tenant's own documents list never carries the other tenant's file.
  await page.goto(`/${world.orgSlug}/documents`);
  await expect(page.locator("main")).not.toContainText(DOCUMENT_NAMES.otherTenant);
  // Non-vacuity: this tenant's OWN clean document IS on that list, so the
  // absence above is not a page that failed to render.
  await expect(
    page.getByRole("link", { name: DOCUMENT_NAMES.clean }),
  ).toHaveCount(1);
});

test("record scope holds on the venue's event list and on the event", async ({
  page,
}) => {
  // A standard user is a MEMBER here, so nothing about the TENANT refuses
  // them. `private.full_scope_organisations()` excluding their role is the
  // only control -- a different control from the one above, on a surface that
  // did not exist when the contacts version of this test was written.
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/venues/${world.venueId}`);

  // Their own event is there...
  await expect(page.locator("main")).toContainText(EVENT_NAMES.standardOwned);
  // ...and the manager's, at the same venue in the same workspace, is not.
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.managerOwned);
  // The list says WHY it is short, rather than leaving the shortness to speak
  // for itself -- the copy failure Phase 2 Task 3 shipped on the contacts list
  // and a browser found ("No contacts yet" on a 71-contact workspace).
  await expect(page.locator("main")).toContainText(
    "You’re seeing events assigned to you",
  );

  // And the record itself refuses them, which is the half a list assertion
  // cannot make: a list that filters correctly and a detail route that does
  // not is exactly the IDOR shape.
  await expectRefused(
    page,
    `/${world.orgSlug}/events/${world.managerOwnedEventId}`,
  );
});

test("an artist's event history comes from the lineup, not from a column", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/artists/${world.artistId}`);

  // SCOPED TO THE SECTION, NOT TO `main` (fix round 1). This route carries the
  // activity timeline as well, and the timeline renders a `link_removed` entry
  // naming the other record -- "Standard Night A is no longer linked to this
  // one." So an absence assertion over the whole page would be measuring the
  // timeline's copy rather than the history list, and would go red for a
  // reason that has nothing to do with the two-step read.
  const history = page.locator("section").filter({ hasText: "Event history" });

  // The artist is on the manager-owned event's bill, so this is the two-step
  // read (`event_lineup` -> ids -> `events`) working end to end: the name can
  // only be here if BOTH queries ran and agreed.
  await expect(history).toContainText(EVENT_NAMES.managerOwned);

  // AND NOT THE EVENT THEY WERE UNBOOKED FROM (M-3). The fixture puts a
  // SOFT-DELETED `event_lineup` row on Standard Night A for this artist, so
  // this absence is now a test of step one's hand-written
  // `.is("deleted_at", null)` -- drop that clause and a removed slot puts the
  // event back into the artist's history. It doubles as the assertion that
  // separates "reads the lineup" from "reads every event at a venue this
  // artist once played".
  await expect(history).not.toContainText(EVENT_NAMES.standardOwned);
  await expect(history).not.toContainText(EVENT_NAMES.otherTenant);
  // And the soft-deleted event is not here either -- step two's `deleted_at`
  // filter, which `applyScope` writes for every `fetchListPage` list.
  await expect(history).not.toContainText(EVENT_NAMES.softDeleted);
});

test("the workspace home shows this tenant's upcoming events and no other's", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);

  await expect(page.locator("main")).toContainText("Upcoming events");
  // Both of this tenant's LIVE events are in the future, so both are inside
  // the block's five.
  await expect(page.locator("main")).toContainText(EVENT_NAMES.managerOwned);
  await expect(page.locator("main")).toContainText(EVENT_NAMES.standardOwned);
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.otherTenant);

  // AND NOT THE SOFT-DELETED ONE, which is the assertion this test was missing.
  //
  // `loadUpcomingEvents` is not a `fetchListPage` call, so `applyScope` does
  // NOT write `deleted_at is null` for it -- the loader writes the clause by
  // hand, and nothing errors if somebody deletes the line. The fixture's
  // deleted event starts SOONER than either live one, so an unfiltered query
  // would put it at the top of the five rather than somewhere a short fixture
  // might not reach. This is the one surface where a soft-delete leak lands on
  // the first screen a user sees.
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.softDeleted);
  // The venue name is a LINK, not a bare string: the block joins two tables
  // and this is the assertion that the second query ran as this caller.
  await expect(
    page.locator(`main a[href="/${world.orgSlug}/venues/${world.venueId}"]`).first(),
  ).toBeVisible();
});

// ===========================================================================
// PHASE 3 TASK 8: THE PICKERS, AND THE OTHER TENANT'S LINEUP
// ===========================================================================
// Until Task 8's fixtures the other tenant's `event_lineup` was EMPTY, so every
// cross-tenant event assertion above was satisfied by there being no lineup to
// leak. `event_lineup` has its own three policies (20260901011000) reached
// through `event_lineup_select_via_event`, which is a different expression from
// `events_select_view_crm`, and no assertion made from a browser could tell the
// two apart. It now has an artist and a slot.
//
// AND PICKERS ARE THE SHAPE THAT ESCAPES A LIST ASSERTION. Phase 2's Task 4
// review found it on `loadLinkOptions`: a `<select>` is a SECOND query with its
// own filters, and dropping one is invisible to every assertion made about the
// list the same page renders. The event form has three of them (venue, room,
// artist) and every one is a fresh chance to make it.

test("the event form's pickers offer this tenant's records and no other's", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/events/new`);

  const venuePicker = page.locator('select[name="venueId"]');
  await expect(venuePicker).toHaveCount(1);
  const venueOptions = await venuePicker.locator("option").allTextContents();
  // NON-VACUITY FIRST, and with a denominator: "No venue yet" plus this
  // tenant's two venues is three, so an empty picker cannot satisfy the
  // absences below.
  expect(venueOptions).toHaveLength(3);
  expect(venueOptions.join("\n")).toContain(VENUE_NAME);
  expect(venueOptions.join("\n")).toContain(ALT_VENUE_NAME);
  expect(venueOptions.join("\n")).not.toContain("Other Tenant Venue");

  const roomPicker = page.locator('select[name="venueRoomId"]');
  await expect(roomPicker).toHaveCount(1);
  const roomOptions = await roomPicker.locator("option").allTextContents();
  // "No particular room" plus the one live room in this tenant.
  expect(roomOptions).toHaveLength(2);
  expect(roomOptions.join("\n")).toContain(ROOM_NAME);

  // THE ARTIST PICKER LIVES ON THE RECORD, NOT ON THE CREATE FORM -- the
  // lineup is added on the event's own page, so this half is asserted there.
  await page.goto(`/${world.orgSlug}/events/${world.managerOwnedEventId}`);
  const artistPicker = page.locator('select[name="artistId"]');
  await expect(artistPicker).toHaveCount(1);
  const artistOptions = await artistPicker.locator("option").allTextContents();
  // "Choose an artist" plus this tenant's one artist.
  expect(artistOptions).toHaveLength(2);
  expect(artistOptions.join("\n")).toContain(ARTIST_NAME);
  expect(artistOptions.join("\n")).not.toContain(OTHER_ARTIST_NAME);

  // AND THE OTHER TENANT'S ARTIST IS NOT REACHABLE BY ID EITHER, which is the
  // half a picker assertion cannot make: a picker that filters correctly and a
  // detail route that does not is the IDOR shape.
  await expectRefused(page, `/${world.orgSlug}/artists/${world.otherOrgArtistId}`);
  await expect(REFUSED(page)).not.toContainText(OTHER_ARTIST_NAME);
});

test("a soft-deleted event is on the deleted screen and nowhere else", async ({
  page,
}) => {
  // ITS OWN FIXTURE EVENT, NEVER A RECORD ANOTHER TEST NEEDS LIVE (Task 8
  // brief § 1). Deleting a shared record inside a test makes every later test
  // in the file depend on the order this one ran in, and that hidden ordering
  // dependency is a known Phase 2 defect -- reproducing it here would be
  // self-inflicted. `EVENT_NAMES.softDeleted` is planted already deleted, in
  // the same statement that creates it, so there is no window in which the
  // world holds a live event nobody meant to create.
  await signIn(page, world, "manager");

  // 1. Not on the live list.
  await page.goto(`/${world.orgSlug}/events`);
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.softDeleted);
  // Non-vacuity: the live list is not empty, so the absence above is a filter
  // working rather than a page that failed to render.
  await expect(page.locator("main")).toContainText(EVENT_NAMES.managerOwned);

  // 2. On the deleted list.
  await page.goto(`/${world.orgSlug}/events/deleted`);
  await expect(page.locator("main")).toContainText(EVENT_NAMES.softDeleted);
  // And that screen shows ONLY deleted events, which is the assertion that
  // stops it being "every event with a different heading".
  await expect(page.locator("main")).not.toContainText(EVENT_NAMES.managerOwned);

  // 3. AND ITS OWN PAGE STILL SERVES IT, with the restore control -- `loadEvent`
  //    deliberately does not filter `deleted_at`, because the restore queue
  //    links straight here and a 404 after deleting is the shape that makes
  //    people afraid of the delete button.
  await page.goto(`/${world.orgSlug}/events/${world.softDeletedEventId}`);
  await expect(
    page.getByRole("heading", { name: EVENT_NAMES.softDeleted, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore event/i }),
  ).toHaveCount(1);
});
