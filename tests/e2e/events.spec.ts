import { expect, test } from "@playwright/test";
import {
  ALT_VENUE_NAME,
  ARTIST_NAME,
  EVENT_NAMES,
  HOSTILE_TICKET_LINK,
  ROOM_NAME,
  VENUE_NAME,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE PHASE 3 GOLDEN PATH, WALKED.
//
// `CLAUDE.md` § Design names the path this phase is judged on: "create contact
// -> create event -> add artist -> add venue -> add task -> view activity".
// Contacts are Phase 2 (tests/e2e/golden-path.spec.ts walks them) and tasks are
// Phase 4, so the segment Phase 3 owns is:
//
//     create event -> add artist to the bill -> change the venue
//                  -> view the activity timeline
//
// ONE TEST, IN ORDER, SHARING A PAGE, and every step asserted before the next
// one runs. The sequence is the subject: an event that can be created and an
// event that can have an artist added to it are two facts, and "an artist can
// be added to an event the user has just created" is a third one that neither
// implies. The Phase 2 spec's header makes the same argument and this file is
// deliberately its sibling rather than its replacement.
//
// ===========================================================================
// NO CONDITIONAL LOCATORS, ANYWHERE IN THIS FILE
// ===========================================================================
// Task 8 brief § 2, and it is a rule rather than a style. `if (await x.count())`
// turns an assertion into a coin toss that always lands heads: the block is
// skipped when the thing is missing, which is the only case worth testing. Where
// a count is what is being asserted, it is asserted with `toHaveCount(n)` and
// `n` is written down as a denominator, and the per-entry assertions follow it.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** The name the golden path gives the event it creates. */
const GOLDEN_EVENT = "Golden Path Night";

test("the Phase 3 golden path, end to end, as a manager", async ({ page }) => {
  await signIn(page, world, "manager");

  // ---- 1. CREATE AN EVENT --------------------------------------------------
  // THROUGH THE LIST'S OWN CONTROL, not by typing the /new URL. The "New event"
  // control is a `NewRecordAction`, which renders a LINK when the caller may
  // write and a disabled `<button>` when they may not -- so reaching the form
  // by clicking it is also the assertion that a manager gets the link half.
  await page.goto(`/${world.orgSlug}/events`);
  await page.getByRole("link", { name: "New event" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/events/new$`));

  await page.locator('input[name="name"]').fill(GOLDEN_EVENT);
  // A UK WALL CLOCK WITH NO ZONE, which is what `<input type="datetime-local">`
  // submits and what `londonWallClockToInstant` expects (lib/format/date.ts).
  // A fixed date rather than a computed one: this event is never read by the
  // "upcoming" filter or by the workspace home block, so it has no reason to
  // move with the clock, and a fixed string is one fewer thing to explain when
  // this test fails.
  await page.locator('input[name="startsAt"]').fill("2027-03-12T22:00");
  await page.locator('select[name="status"]').selectOption("confirmed");
  await page.locator('select[name="venueId"]').selectOption(world.venueId);
  // AND A ROOM, which is the one three-column composite FK in the phase
  // (`events_venue_room_fkey`, pinned to the venue AND the tenant). The room
  // `<select>` is an `<optgroup>` over every live room in the workspace,
  // because there is no cascade without JavaScript -- so picking one here is
  // also the assertion that the group for this venue exists and is populated.
  await page.locator('select[name="venueRoomId"]').selectOption(world.venueRoomId);
  await page.getByRole("button", { name: "Create event" }).click();

  await expect(
    page.getByRole("heading", { name: GOLDEN_EVENT, level: 1 }),
  ).toBeVisible();
  const eventUrl = page.url();
  // The venue and the room the form was given are what the record now says.
  await expect(page.locator("main")).toContainText(VENUE_NAME);
  await expect(page.locator("main")).toContainText(ROOM_NAME);

  // ---- 2. ADD AN ARTIST TO THE BILL ---------------------------------------
  // The lineup panel is on the event's own page; there is no /lineup route and
  // there should not be one, exactly as rooms live on the venue's page.
  const lineup = page.getByRole("region", { name: /lineup/i });
  await expect(
    lineup,
    "the lineup must be a named region, not just markup in <main>",
  ).toHaveCount(1);
  // Before: the panel says so in words rather than being merely short.
  await expect(lineup).toContainText("No lineup yet");

  await page.locator('select[name="artistId"]').selectOption(world.artistId);
  await page.getByRole("button", { name: "Add to lineup" }).click();

  // ONE ROW, AND THE DENOMINATOR IS WRITTEN DOWN. `toHaveCount(1)` first, so a
  // panel that rendered two rows (or none) fails here with a count rather than
  // being read past by a `.first()` in the assertion below it.
  const bill = lineup.getByRole("listitem");
  await expect(bill).toHaveCount(1);
  // AND THE ARTIST IS A LINK, not a bare string: the panel resolves the
  // `artist_id` on the lineup row against `public.artists` under the caller's
  // own policies, and the anchor is the only evidence from outside that the
  // second read happened and agreed.
  await expect(
    bill.first().getByRole("link", { name: ARTIST_NAME }),
  ).toHaveAttribute("href", `/${world.orgSlug}/artists/${world.artistId}`);

  // ---- 3. CHANGE THE VENUE ------------------------------------------------
  // "Add a venue" in the golden-path sentence is a step this phase can only
  // take as an EDIT: `venueId` is set on the create form above, so the
  // interesting operation -- and the one Task 4's fix round found a real defect
  // in, where React 19's form reset snapped every `<select>` back to its
  // mounted option -- is changing it afterwards.
  await page.getByRole("link", { name: "Edit event" }).click();
  await expect(page.locator('input[name="name"]')).toHaveValue(GOLDEN_EVENT);
  await page.locator('select[name="venueId"]').selectOption(world.altVenueId);
  // The room has to go with it: `events_venue_room_fkey` pins the room to the
  // event's venue, so keeping E2E Main Room while moving to E2E Basement is a
  // write the database refuses. Clearing it is what a user does, and doing it
  // here proves the form can express it.
  await page.locator('select[name="venueRoomId"]').selectOption("");
  await page.getByRole("button", { name: "Save changes" }).click();

  // `updateEventAction` redirects back to the record (lib/crm/events.ts), so a
  // refused save leaves the form on screen with a message beside the field.
  // Asserting the landing here means a validation failure fails as "still on
  // the edit form" rather than three lines later as "the venue did not change",
  // which is the same red with the cause removed.
  await expect(page).toHaveURL(eventUrl);
  await expect(
    page.getByRole("heading", { name: GOLDEN_EVENT, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(ALT_VENUE_NAME);
  await expect(page.locator("main")).not.toContainText(VENUE_NAME);
  await expect(page.locator("main")).not.toContainText(ROOM_NAME);

  // ---- 4. VIEW THE ACTIVITY TIMELINE --------------------------------------
  const activity = page.getByRole("region", { name: /activity/i });
  await expect(
    activity,
    "the activity timeline must be a named region, not just markup in <main>",
  ).toHaveCount(1);

  // THREE ENTRIES, AND THREE IS THE POINT.
  //
  // The three steps above produce exactly three rows of `public.activity_events`
  // for this subject, one per branch, and nothing else does:
  //
  //   record_created   `events` in the subjects CTE, at `created_at`
  //   link_added       `event_lineup` from the EVENT's side, at the slot's
  //                    `created_at` (the ARTIST's side is a separate branch on
  //                    a different subject and is not on this page)
  //   record_updated   the same CTE, at `updated_at`, and ONLY because
  //                    20260901030000 emits it when `updated_at > created_at`
  //
  // No `status_changed`: the edit above deliberately leaves `status` alone, and
  // the trigger's `of status` column list means an UPDATE that does not touch
  // the column writes no history row. No venue-side `link_added` either -- that
  // branch emits `subject_type = 'venue'` and belongs on the venue's page.
  //
  // The count is asserted BEFORE the per-entry text, so a fourth entry nobody
  // predicted fails here with a number instead of shifting the indices below
  // and failing as a wrong sentence.
  const entries = activity.getByRole("listitem");
  await expect(
    entries,
    "created + lineup add + edit == three timeline entries, newest first",
  ).toHaveCount(3);

  // NEWEST FIRST, WHICH IS THE REVERSE OF THE ORDER THEY HAPPENED IN.
  // The brief lists them chronologically (`record_created`, `link_added`,
  // `record_updated`); this surface is explicitly "newest first" and says so on
  // screen, so the rendered order is the chronological one reversed. Asserted
  // by INDEX rather than by "somewhere in the region contains", because the
  // ordering is the property -- a timeline that renders the right three entries
  // in the wrong order is the defect this step exists to catch.
  await expect(entries.nth(0)).toContainText("Last edited");
  await expect(entries.nth(1)).toContainText("Linked");
  await expect(entries.nth(1)).toContainText(ARTIST_NAME);
  await expect(entries.nth(2)).toContainText("Created");

  // THE FAILURE MODE THAT SHIPPED IN PHASE 2, on the same component: a timeline
  // that cannot load renders a sentence, and every assertion above would still
  // pass beside it if the region happened to render its rows first.
  await expect(page.locator("main")).not.toContainText(
    "couldn’t load this event’s activity",
  );
});

test("a read-only member cannot reach /events/new, not just the button", async ({
  page,
}) => {
  // HIDING THE UI IS NOT ENFORCEMENT (`CLAUDE.md` § Permissions), and Task 3
  // shipped this list with a "New event" control pointing at a route that did
  // not exist -- so until Task 4 landed the form there was nothing here to
  // refuse. This is the assertion that the ROUTE decides, before any form is
  // rendered: `getCrmWriteAccess(org, "manage_events")` on the server, with the
  // INSERT policy (20260901011000) refusing the write underneath it regardless.
  await signIn(page, world, "read_only");
  await page.goto(`/${world.orgSlug}/events/new`);

  // The page is served -- it is an explanation, not a 404 -- and it carries no
  // form.
  await expect(page.locator("main")).toContainText("Read-only");
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
  await expect(page.locator('input[name="name"]')).toHaveCount(0);
  await expect(page.locator('select[name="status"]')).toHaveCount(0);
});

test("a standard user is told their events list is scoped, not that it is empty", async ({
  page,
}) => {
  // THE PHASE 2 DEFECT, ON THE PHASE 3 SURFACE. A Read Only user in a
  // 71-contact workspace was told "No contacts yet"; the events list is the
  // third record-scoped surface this phase adds, and open decision 17 keeps the
  // behaviour deliberately, which makes the COPY the whole control.
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/events`);

  await expect(page.locator("main")).toContainText(
    "You’re seeing events assigned to you",
  );
  // The list is not empty for them -- they own one event -- so the note above
  // is being rendered beside real rows rather than instead of them.
  await expect(page.locator("main")).toContainText(EVENT_NAMES.standardOwned);
  await expect(page.locator("main")).not.toContainText("No events yet");
  await expect(page.locator("main")).not.toContainText("No events assigned to you");
});

test("the status chip says the status in words, not only in colour", async ({
  page,
}) => {
  // DESIGN.md § Working palette: "Status must never be colour-only -- always
  // pair with a text label or shape." `StatusChip` renders `STATUS_LABELS`
  // unconditionally and has no icon-only variant, and this is the assertion
  // from outside that says so: the label is TEXT on the page, reachable by a
  // text query, with no reference to a class or a colour anywhere in this test.
  //
  // The fixture's manager-owned event is `confirmed`, and nothing has changed
  // its status -- so "Confirmed" appears on the detail page exactly once, in
  // the chip. A `status_changed` timeline entry would be a second occurrence,
  // and its absence is what makes the count assertion below meaningful rather
  // than incidental.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/events/${world.managerOwnedEventId}`);
  await expect(
    page.getByRole("heading", { name: EVENT_NAMES.managerOwned, level: 1 }),
  ).toBeVisible();

  const chip = page.locator("main").getByText("Confirmed", { exact: true });
  await expect(chip).toHaveCount(1);
  await expect(chip).toBeVisible();
  // NOT A BUTTON AND NOT A LINK. Nothing about a status is interactive here;
  // the way to filter by status is the list toolbar's own labelled control.
  await expect(
    page.getByRole("button", { name: "Confirmed" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Confirmed" })).toHaveCount(0);
});

test("a stored ticket link the renderer refuses is text, never an anchor", async ({
  page,
}) => {
  // WHAT IS MEASURED IS `safeHref()` ON THE WAY OUT, not the form on the way
  // in. The value was planted through Postgres, and it is NOT `javascript:` --
  // `events_ticket_link_is_http` is a validated CHECK, so no writer on this
  // stack including `postgres` can store one. The fixture's constant carries
  // the full argument, and the exit document carries the finding.
  //
  // The property is the same one either way: the anchor's `href` is the URL
  // parser's answer or there is no anchor. A page that wrote the raw column
  // into `href` would pass every other test in this file.
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/events/${world.hostileEventId}`);
  await expect(
    page.getByRole("heading", { name: EVENT_NAMES.hostileTicket, level: 1 }),
  ).toBeVisible();

  // 1. The value is SHOWN. Hiding it would lose data the user recorded and
  //    leave them unable to correct it.
  await expect(page.locator("main")).toContainText(HOSTILE_TICKET_LINK);

  // 2. And it is shown as text: no anchor on the page points at it.
  await expect(
    page.locator(`main a[href="${HOSTILE_TICKET_LINK}"]`),
  ).toHaveCount(0);

  // 3. NO ANCHOR ANYWHERE ON THE PAGE CARRIES A DANGEROUS SCHEME. The broad
  //    version of the assertion, so a future column that becomes an href on
  //    this route is covered by it without anyone remembering to extend this
  //    test.
  const dangerous = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
  );
  expect(dangerous).toEqual([]);

  // 4. NON-VACUITY. The page rendered, and it renders real anchors -- so (2)
  //    and (3) are not passing against a blank document. "Events" is the
  //    breadcrumb back to the list, which every event detail page carries.
  //
  //    `main`-SCOPED, AND THAT SCOPING IS NOW ALSO AN ASSERTION (sidebar nav
  //    build, review finding 1): the persistent rail carries its own "Events"
  //    link with the identical accessible name, but the rail is a SIBLING of
  //    `<main>` (app/(app)/layout.tsx), never inside it -- so `main` finding
  //    exactly ONE "Events" link is simultaneously the breadcrumb non-vacuity
  //    check and a regression trip-wire for the rail ever moving back inside
  //    the content landmark.
  await expect(
    page.locator("main").getByRole("link", { name: "Events", exact: true }),
  ).toHaveCount(1);
});
