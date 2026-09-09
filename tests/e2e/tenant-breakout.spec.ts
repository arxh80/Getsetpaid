import { expect, test, type Page } from "@playwright/test";
import {
  ALT_VENUE_NAME,
  ARTIST_NAME,
  countSentConnectionRequests,
  DOCUMENT_NAMES,
  EVENT_NAMES,
  FINANCE_EVENT_NAMES,
  FINANCE_LINES,
  NOTE_BODIES,
  OTHER_ARTIST_NAME,
  PASSWORD,
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
 * Go to a URL that must be refused, and assert the refusal contract.
 *
 * ===========================================================================
 * TWO REFUSAL SHAPES, SINCE THE LOADING-SKELETONS PASS -- AND WHY
 * ===========================================================================
 * Final review I-11 made the HTTP status the assertion here, because a
 * distinguishing 403 is an enumeration oracle for other tenants' slugs and
 * ids, and "Page not found" words alone would stay green through a future
 * error boundary that 403s. That property is unchanged. What changed is
 * WHERE the status can still carry it.
 *
 * The loading-skeletons pass put a `loading.tsx` on every org segment, and a
 * loading file is a Suspense boundary: on a document request Next flushes the
 * shell (status 200) the moment the boundary's fallback is ready, so a
 * `notFound()` thrown by a PAGE below that boundary can only swap the BODY to
 * the not-found document -- the status line is already on the wire. This is
 * the framework's documented streaming trade-off (Next injects
 * `<meta name="robots" content="noindex">` into exactly this response). So:
 *
 *   WORKSPACE-level refusals (a slug the caller cannot see) happen in
 *   `app/(app)/[orgSlug]/layout.tsx`, ABOVE every loading boundary, before
 *   anything flushes -> still a real HTTP 404. `expectRefusedAtWorkspace`.
 *
 *   RECORD-level refusals (a valid slug, a foreign or out-of-scope id)
 *   happen in the page, BELOW the boundary -> HTTP 200 + the identical
 *   streamed not-found document. `expectRefused`.
 *
 * WHY 200 DOES NOT REOPEN THE ORACLE: the oracle is a DIFFERENCE between
 * "exists, not yours" and "does not exist". Both run the identical
 * RLS-filtered query, get the identical zero rows, throw the identical
 * notFound() at the identical point, and stream the identical document with
 * the identical status. That indistinguishability is no longer implied by a
 * fixed status code, so it is measured directly by the parity test below
 * ("REFUSAL PARITY..."), which is now the load-bearing assertion. What this
 * helper still pins per probe: never a 403, never a bounce to /login for an
 * authenticated probe (status uniformity), only the two statuses the two
 * legitimate refusal shapes produce, and the refusal copy itself.
 */
async function expectRefused(
  page: import("@playwright/test").Page,
  url: string,
) {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${url} must refuse as 404 or a streamed not-found (200) -- never 403, ` +
      `never a redirect; got ${status}`,
  ).toContain(status);
  expect(page.url(), `${url} must not bounce an authenticated probe to login`)
    .not.toMatch(/\/login/);
  await expect(REFUSED(page)).toContainText("Page not found");
}

/**
 * A refusal that happens at the WORKSPACE boundary -- a slug the signed-in
 * caller cannot see. `app/(app)/[orgSlug]/layout.tsx` throws this notFound()
 * above every loading boundary, so nothing has flushed and the literal HTTP
 * 404 is still asserted, exactly as before the loading-skeletons pass.
 */
async function expectRefusedAtWorkspace(
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
  // workspace, so this is the tenant boundary and nothing else. A WORKSPACE
  // refusal happens in the layout, above every loading boundary, so the
  // literal HTTP 404 is still asserted -- see expectRefusedAtWorkspace.
  await expectRefusedAtWorkspace(page, `/${world.otherOrgSlug}/contacts`);
  await expect(REFUSED(page)).not.toContainText("Other Tenant Secret");
});

test("another tenant's record is not reachable by id, from either slug", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  // Under the OTHER tenant's slug -- refused because the workspace is not
  // ours, at the layout, so the literal 404 still holds.
  await expectRefusedAtWorkspace(
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

/**
 * A well-formed UUID that matches no row anywhere. Fixed, not random: the
 * parity assertion below compares two requests, and a deterministic probe
 * keeps a failure reproducible run to run.
 */
const GHOST_ID = "00000000-0000-4000-8000-000000000000";

test("REFUSAL PARITY: a foreign record and a nonexistent record are indistinguishable, per entity family", async ({
  page,
}) => {
  // ==========================================================================
  // THE LOAD-BEARING ENUMERATION-ORACLE ASSERTION.
  // ==========================================================================
  // Before the loading-skeletons pass, the oracle property -- "exists, not
  // yours" must not be tellable from "does not exist" -- was IMPLIED by every
  // refusal carrying the same literal 404. Streaming took that implication
  // away for record-level refusals (see expectRefused's header), so this test
  // asserts the property DIRECTLY: for each entity family, probe a real,
  // live row belonging to another tenant and a well-formed id that matches
  // nothing, and require the same HTTP status and the same rendered document.
  //
  // The bodies are compared as rendered innerText, not raw bytes: every
  // response carries a fresh CSP nonce and React stream ids, so two raw
  // bodies differ even for the SAME url requested twice -- rendered text is
  // the practical level at which "the identical 404 page" is decidable.
  // innerText does not see the head, comments, data attributes or the flight
  // payload; a leak through those channels is prevented by construction (the
  // record read happens only below the loading boundary, generateMetadata
  // falls back identically for both cases) rather than by this comparison,
  // so the document TITLE is compared as well as a cheap head-channel probe,
  // and the raw-byte channel is covered by the status equality plus the copy
  // assertions in expectRefused.
  await signIn(page, world, "manager");

  await expectRefusalParity(page, world.orgSlug, [
    ["contact", `contacts/${world.otherOrgContactId}`, `contacts/${GHOST_ID}`],
    ["event", `events/${world.otherOrgEventId}`, `events/${GHOST_ID}`],
    ["task", `tasks/${world.otherOrgTaskId}`, `tasks/${GHOST_ID}`],
    ["note", `notes/${world.otherOrgNoteId}`, `notes/${GHOST_ID}`],
    ["artist", `artists/${world.otherOrgArtistId}`, `artists/${GHOST_ID}`],
  ] as const);
});

test("REFUSAL PARITY from the counterparty: meeting, venue and company note refuse identically to ghosts", async ({
  page,
}) => {
  // The remaining alphaPrivateRoutes families (network-leakage.spec.ts's
  // matrix), driven through the SAME parity contract as the test above but
  // from the OTHER side of the boundary: the counterparty's member, signed
  // in for real, probes ALPHA's live meeting, venue and company note under
  // its own slug against ghost ids. Together the two tests cover all eight
  // entity families with a detail page.
  await signInAsOtherMember(page);

  await expectRefusalParity(page, world.otherOrgSlug, [
    ["meeting", `meetings/${world.meetingId}`, `meetings/${GHOST_ID}`],
    ["venue", `venues/${world.venueId}`, `venues/${GHOST_ID}`],
    ["company note", `notes/${world.companyNoteId}`, `notes/${GHOST_ID}`],
  ] as const);
});

/** The parity loop both REFUSAL PARITY tests drive -- see the header comment
 *  on the first of them for the full argument. */
async function expectRefusalParity(
  page: import("@playwright/test").Page,
  slug: string,
  families: ReadonlyArray<readonly [string, string, string]>,
) {
  for (const [label, foreignPath, ghostPath] of families) {
    const foreign = await page.goto(`/${slug}/${foreignPath}`);
    const foreignStatus = foreign?.status() ?? -1;
    await expect(REFUSED(page)).toContainText("Page not found");
    const foreignText = await page.locator("body").innerText();
    const foreignTitle = await page.title();

    const ghost = await page.goto(`/${slug}/${ghostPath}`);
    const ghostStatus = ghost?.status() ?? -1;
    await expect(REFUSED(page)).toContainText("Page not found");
    const ghostText = await page.locator("body").innerText();
    const ghostTitle = await page.title();

    expect(
      foreignStatus,
      `${label}: a foreign row and a nonexistent id must share one status -- ` +
        "a difference is an existence oracle",
    ).toBe(ghostStatus);
    expect(
      foreignText,
      `${label}: a foreign row and a nonexistent id must render the identical ` +
        "document -- a difference is an existence oracle",
    ).toBe(ghostText);
    expect(
      foreignTitle,
      `${label}: the document title must not differ between a foreign row ` +
        "and a nonexistent id -- generateMetadata must fall back identically",
    ).toBe(ghostTitle);
    expect(
      [200, 404],
      `${label}: the shared refusal status must be 404 or a streamed ` +
        `not-found (200), never 403; got ${foreignStatus}`,
    ).toContain(foreignStatus);
  }
}

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
// (Since the loading-skeletons pass "the status assertion" means the
// streaming-aware contract in expectRefused's header, with the oracle carried
// by the REFUSAL PARITY test above.)

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
  // Under the OTHER tenant's slug -- refused because the workspace is not
  // ours, at the layout: literal 404.
  await expectRefusedAtWorkspace(
    page,
    `/${world.otherOrgSlug}/events/${world.otherOrgEventId}`,
  );
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

// ===========================================================================
// PHASE 5 TASK 5: THE FINANCE BREAKOUT -- ROLE, TIER AND TENANT
// ===========================================================================
// Finance is the most restricted surface in the product: a read needs
// `view_finance`, a write needs `manage_finance` AND the Pro `finance_module`
// entitlement, and aal2 is folded into both keys inside
// `public.has_permission()` (20260827210000). Task 4 proves all three at the
// database and PostgREST layers.
//
// WHAT IS LEFT FOR A BROWSER is the layer above them, and it is a different
// control: the event page decides whether to MOUNT the panel at all
// (`financeReadable &&`, app/(app)/[orgSlug]/events/[eventId]/page.tsx). A page
// that mounted it for everybody would still leak nothing -- RLS returns no rows
// -- but it would tell a Booker that this event has a finance sheet, show them
// an all-zeros budget-vs-actuals table, and offer them an add form that 42501s.
// That is a real defect no policy assertion can see, and the two tests below
// are the only place in the suite that can.

test("a Booker on the same event gets no finance panel and no finance data", async ({
  page,
}) => {
  // THE BOOKER IS NOT A WEAK ROLE. They hold `view_crm` and seven `manage_*`
  // keys (20260903002000's header: "a Booker builds lineups ... but neither
  // runs the money"), they are FULL-SCOPE (`private.full_scope_organisations()`
  // excludes only standard_user and read_only), and they are a member of the
  // very workspace whose ledger this is. `view_finance` is the only thing they
  // do not have, so it is the only thing this test can be measuring.
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/events/${world.proLedgerEventId}`);

  // NON-VACUITY FIRST. The page rendered, and this session can see the event
  // itself -- so every absence below is a gate closing rather than a 404, an
  // empty workspace or a failed render.
  await expect(
    page.getByRole("heading", { name: FINANCE_EVENT_NAMES.proLedger, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("Tasks, notes & documents");

  // ---- NO PANEL. ASSERTED DIRECTLY, AT COUNT 0 (Constraint 15) ------------
  // Never `if (await panel.count())`: a conditional locator turns into a no-op
  // the day the thing it looks for is renamed, which is precisely when this
  // assertion has to fire. Three handles on the same absence -- the region, its
  // heading and the add control -- because a partial render is a real outcome:
  // a panel whose <section> lost its label would still be a finance panel.
  await expect(page.getByRole("region", { name: "Finance", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Finance", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Budget versus actuals", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add finance line" })).toHaveCount(0);

  // ---- AND NO FINANCE DATA ANYWHERE IN THE DOCUMENT ----------------------
  // The second half, and a different control: the panel could be gone while a
  // summary query still ran and printed a total somewhere. Asserted against
  // <body> rather than <main>, so a figure smuggled into a header, a title or a
  // hidden element counts as a leak.
  for (const line of [
    FINANCE_LINES.fixtureFee,
    FINANCE_LINES.fixtureIncome,
    FINANCE_LINES.removed,
  ]) {
    await expect(page.locator("body")).not.toContainText(line.description);
    await expect(page.locator("body")).not.toContainText(line.formatted);
  }
});

test("a Finance user cannot reach another tenant's finance, from either slug", async ({
  page,
}) => {
  // THE SESSION HOLDS view_finance AND manage_finance, at aal2, in ITS OWN
  // workspace -- which is what makes this a tenant test rather than a role one.
  // The keys are held; the organisation is not theirs.
  await signIn(page, world, "finance");

  // NON-VACUITY: this session really can read finance where it is entitled to.
  // Without this, every refusal below would be satisfied by a session that sees
  // no finance anywhere -- exactly what an unpresented MFA factor would produce.
  await page.goto(`/${world.proOrgSlug}/events/${world.proLedgerEventId}`);
  await expect(
    page.getByRole("region", { name: "Finance", exact: true }),
  ).toHaveCount(1);
  await expect(page.locator("main")).toContainText(FINANCE_LINES.fixtureFee.description);
  await expect(page.locator("main")).toContainText(FINANCE_LINES.fixtureFee.formatted);

  // ---- THE OTHER TENANT'S EVENT, UNDER THE OTHER TENANT'S SLUG -----------
  // A workspace this user is no member of: layout refusal, literal 404.
  await expectRefusedAtWorkspace(
    page,
    `/${world.otherOrgSlug}/events/${world.otherOrgEventId}`,
  );
  await expect(REFUSED(page)).not.toContainText(FINANCE_LINES.otherTenant.description);
  await expect(REFUSED(page)).not.toContainText(FINANCE_LINES.otherTenant.formatted);

  // ---- AND UNDER THIS SESSION'S OWN SLUG, WHICH IS THE INTERESTING ONE ----
  // The workspace is ours, the id is a real row with real finance lines on it,
  // and only the tenant filter separates them. This is the IDOR shape.
  await expectRefused(page, `/${world.proOrgSlug}/events/${world.otherOrgEventId}`);
  await expect(REFUSED(page)).not.toContainText(FINANCE_LINES.otherTenant.description);
  await expect(REFUSED(page)).not.toContainText(FINANCE_LINES.otherTenant.formatted);

  // ---- AND THE MAIN WORKSPACE, WHICH THIS USER IS NOT A MEMBER OF --------
  // A third tenant, reached by slug rather than by id: a layout refusal, so
  // the literal 404 still holds and nothing here enumerates workspaces.
  await expectRefusedAtWorkspace(
    page,
    `/${world.orgSlug}/events/${world.managerOwnedEventId}`,
  );
  await expect(REFUSED(page)).not.toContainText(EVENT_NAMES.managerOwned);
});

// ===========================================================================
// PHASE 6 (NETWORK), TASK 6: THE NETWORK BREAKOUT BLOCK
// ===========================================================================
// The psql suite (`rls_phase6_network.sql`) and the consolidated adversarial
// proof (`network_leakage_phase6.sql`, `tests/e2e/network-leakage.spec.ts`)
// already prove the POLICIES and walk the browser leakage matrix in full --
// this block does not repeat either. Its job, matching every other section of
// this file, is narrower: the TENANT-ISOLATION angle specifically, through
// this suite's own `otherOrgId`/`otherMember` pair (the second tenant every
// other breakout test in this file already reasons about), plus the one
// Constraint-12 proof the brief names by its own DB-row-count clause, which
// no existing network spec asserts.
//
// `tests/e2e/network-discovery.spec.ts` already has a draft-404 test and a
// disabled-request-control test, both using `world.freeMember` -- a
// deliberately different fixture, chosen there for the TIER angle ("Free sees
// the directory in full"). Reusing `otherMember` here instead is what makes
// this the TENANT angle rather than a duplicate: `otherMember` is a plain
// `manager` of `otherOrgId`, MFA-optional, holding `view_network` at aal1,
// with no tier or suspension complication at all -- so a 404 here is provably
// the tenant boundary and nothing else.

/** Sign in as `world.otherMember` -- not one of the fixed `E2eRole` personas
 *  `signIn()` addresses by role (deliberately: see fixtures.ts's own header on
 *  `otherMember`, "adding it to `users` would put a member of the second
 *  tenant inside the record every breakout assertion in this suite reasons
 *  about"). The manual form walk, mirroring network-discovery.spec.ts's own
 *  `signInAsFreeMember`. */
async function signInAsOtherMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.otherMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("ALPHA's draft profile refuses a foreign tenant, and ALPHA's draft never appears in that tenant's directory", async ({
  page,
}) => {
  await signInAsOtherMember(page);

  // ---- THE DIRECT ID: REFUSED, NEVER 403 (no existence leak) ---------------
  // (A record-level refusal under the viewer's own slug -- streamed since the
  // loading-skeletons pass, per expectRefused's header.)
  // Same discipline `expectRefused` already applies to every other entity in
  // this file, over the SAME draft profile network-discovery.spec.ts uses for
  // the tier-angle version of this claim (`world.networkDraftProfileId`,
  // owned by `world.orgId` -- ALPHA in this file's own naming).
  await expectRefused(page, `/${world.otherOrgSlug}/network/${world.networkDraftProfileId}`);
  await expect(REFUSED(page)).not.toContainText(world.networkDraftProfileName);

  // ---- THE DIRECTORY: SEARCHED BY THE DRAFT'S OWN NAME, ZERO RESULTS -------
  // Neither masking view ever carries a `status = 'draft'` row (N2's own
  // dependency set), so this is not "the search box is bad at finding it" --
  // there is nothing in `network_directory` for it to find. Asserted with a
  // direct search rather than scanning an unfiltered first page, so pagination
  // and unrelated fixtures from every other spec file sharing this database
  // (Constraint 15: no scanning-and-hoping) cannot make this pass by accident.
  await page.goto(`/${world.otherOrgSlug}/network`);
  await page.getByLabel("Search the network by name").fill(world.networkDraftProfileName);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: world.networkDraftProfileName })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(world.networkDraftProfileName);
});

test("a Free-tier org's connection request is refused server-side even with disabled stripped, and its own sent-request row count in the database does not move", async ({
  page,
}) => {
  // THE TARGET: ALPHA's own published profile (`networkAlphaProfileId`),
  // reached from a genuinely FREE-TIER workspace (`freeOrgSlug`'s real
  // `plan_id='free'` row -- not `world.orgSlug`'s no-subscription escape,
  // which `entitlementsPermitNetworkPublish` treats as UNGATED). The same
  // shape `network-connections.spec.ts`'s own Free-tier test walks against a
  // DIFFERENT profile; this test's own contribution is the DB-row-count
  // assertion neither that test nor `network-discovery.spec.ts`'s Free-tier
  // test makes.
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.freeMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // ---- THE BASELINE, BEFORE ANY CLICK --------------------------------------
  // A denominator for the "unchanged" claim below (Constraint 14): reading it
  // AFTER the submit and finding "0" would prove nothing if it was already "0"
  // before the fixture ever touched this organisation, or already nonzero for
  // an unrelated reason. `freeOrgId` has sent no request of any kind in this
  // world's fixture -- so the honest expectation is exactly 0, stated rather
  // than assumed.
  const before = await countSentConnectionRequests(world.freeOrgId);
  expect(before, "the Free org has sent no connection request before this test").toBe(0);

  await page.goto(`/${world.freeOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();

  const sendButton = page.getByRole("button", { name: "Request connection" });
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeDisabled();

  // ---- HIDING UI IS NOT ENFORCEMENT (Constraint 12) ------------------------
  // Strip the attribute and submit for real -- `components/network/
  // connect-button.tsx`'s disabled branch carries a real `action`, precisely
  // so a stripped submit reaches `sendConnectionRequestAction` rather than
  // falling back to a same-page GET (the `tests/e2e/finance.spec.ts:265-287`
  // pattern this task's own brief names by that citation).
  await sendButton.evaluate((el) => el.removeAttribute("disabled"));
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // ---- THE REFUSAL CARRIES THE TIER SENTENCE -------------------------------
  const errorAlert = page.getByRole("alert").filter({ hasText: /paid feature/ });
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toContainText("Owner");

  // ---- AND NOTHING WAS WRITTEN: THE ROW COUNT DID NOT MOVE -----------------
  // Read straight out of Postgres, not through the same client whose refusal
  // is being measured -- a refusal that returned the right sentence while the
  // INSERT went through anyway is exactly the two-layer failure this
  // assertion exists to catch, and the UI alone cannot rule it out.
  const after = await countSentConnectionRequests(world.freeOrgId);
  expect(after, "no row was inserted despite the stripped, submitted form").toBe(before);
});
