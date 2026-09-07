import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";

// PHASE 6 (NETWORK), TASK 4: REQUEST-TO-CONNECT, WALKED WITH TWO REAL
// ORGANISATIONS -- CONSTRAINT 17.
//
// ===========================================================================
// THE ACCEPTANCE CRITERION, VERBATIM, AND WHERE EACH CLAUSE IS WALKED
// ===========================================================================
// "ALPHA sends from its published company profile to BETA's published venue
// profile; BETA's requests page shows it; BETA accepts; both sides' profile
// pages now resolve the other's `connections` fields; BETA declines a second
// request from ALPHA and ALPHA cannot re-send; a Free-tier org's send is
// refused server-side even with the `disabled` attribute removed."
//
// ONE CLAUSE OF THAT CRITERION HAS SINCE FLIPPED: the founder changed Q79 on
// 2026-09-07 (20260907000000), so "ALPHA cannot re-send" became "ALPHA CAN
// send a fresh request after a decline". The decline walk below proves the
// as-changed behaviour; the quote above is the Task 4 brief's original text,
// kept verbatim because the rest of it still governs this file.
//
//   ALPHA   = world.orgSlug / world.users.manager, sending from its EXISTING
//             published company profile, `networkAlphaProfileId` (Task 3's
//             own fixture -- Q78 needs only ONE published profile of the
//             sender's, and this world already has it).
//   BETA    = world.proOrgSlug / world.users.booker (holds manage_network_
//             connections; Pro tier). Its published VENUE profile is
//             `networkBetaVenueProfileId`, a FRESH one this task's own
//             fixture block adds -- never reused from the hand-planted
//             `networkAcceptedRequestId` pair, whose live-pair slot is
//             already terminal (accepted).
//   DECLINE = `networkBetaDeclineProfileId`, a second fresh BETA profile, so
//             the accepted and declined lifecycles never share one
//             (from_organisation_id, to_network_profile_id) slot.
//
// Three tests, not one giant test: the accept walk, the decline-then-fresh-
// request walk (Q79 as changed), and the Free-tier server-side refusal, each independent so a
// failure in one does not hide the other two. No `test.describe.serial` --
// each test signs in and navigates fresh; none depends on another's browser
// state (Constraint: no serial mode).
let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

async function signInAsFreeMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.freeMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("ALPHA sends to BETA's venue; BETA sees it in Received and accepts; both sides then resolve the other's connections field", async ({
  page,
}) => {
  // ---- ALPHA SENDS ---------------------------------------------------------
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkBetaVenueProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkBetaVenueProfileName, level: 1 }),
  ).toBeVisible();

  // ALPHA HAS TWO PUBLISHED PROFILES, so ConnectButton renders a "Send from"
  // `<select>` (Task 3's own `networkHostileProfileId` is ALSO published, and
  // "Hostile Network Venue..." sorts before "Network Discovery Alpha Ltd..."
  // alphabetically -- exactly the wrong default for this walk). Choose the
  // real one explicitly.
  await page
    .locator("#connect-from-profile")
    .selectOption(world.networkAlphaProfileId);

  const sendButton = page.getByRole("button", { name: "Request connection" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByText("Request sent.")).toBeVisible();

  // ---- BETA'S REQUESTS PAGE SHOWS IT, PENDING -----------------------------
  await signOut(page);
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/network/requests`);
  await expect(
    page.getByRole("heading", { name: "Connection requests", level: 1 }),
  ).toBeVisible();

  // TWO ROWS FROM ALPHA CAN EXIST IN "RECEIVED": Task 3's own fixture already
  // hand-planted an ACCEPTED request from ALPHA, so filtering on "From ALPHA"
  // alone is ambiguous. `.filter({ hasText: "Pending" })` narrows to the ONE
  // row THIS test just created -- safe because playwright.config.ts runs this
  // suite with `workers: 1, fullyParallel: false`, so no other test's write
  // can land between this filter being built and it being asserted.
  const fromAlpha = page.locator("tr", { hasText: world.networkAlphaProfileName });
  const pendingRow = fromAlpha.filter({ hasText: "Pending" });
  await expect(pendingRow).toHaveCount(1);
  // BASELINE: the pre-existing accepted row, so the count below is a real
  // delta rather than an assumption about how many rows exist in total.
  await expect(fromAlpha.filter({ hasText: "Connected" })).toHaveCount(1);

  // ---- BETA ACCEPTS, WITH ITS CONFIRMATION ---------------------------------
  await pendingRow.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText(/Fields they marked/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, accept" }).click();

  // THE ROW'S NEW STATUS IS THE CONFIRMATION, NOT A TRANSIENT MESSAGE.
  // FOUND IN THIS BROWSER WALK (Constraint 17): once accepted, the row no
  // longer matches `status === "pending"`, so the Actions cell -- the same
  // client component instance that would have shown
  // acceptConnectionRequestAction's returned `state.message` -- unmounts in
  // the SAME revalidation that renders the new "Connected" chip, faster than
  // a page can observe the message text. Asserting the chip change is the
  // reliable signal; components/network/request-actions.tsx's own header now
  // records this the same way lib/network/links.ts's AddLinkForm precedent
  // does ("the row appearing in the list ... is the confirmation").
  await expect(fromAlpha.filter({ hasText: "Pending" })).toHaveCount(0);
  await expect(fromAlpha.filter({ hasText: "Connected" })).toHaveCount(2);

  // ---- BOTH SIDES NOW RESOLVE THE OTHER'S CONNECTIONS FIELD ---------------
  // BETA (still signed in) reading ALPHA's profile: alpha-connections@... is
  // ALPHA's `connections`-level field (Task 3's own fixture data).
  await page.goto(`/${world.proOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(page.getByText("You’re connected")).toBeVisible();
  await expect(page.locator("main")).toContainText("alpha-connections@example.test");

  // ALPHA reading BETA's venue: beta-venue-connections@... is the
  // `connections`-level field this task's own fixture set on the venue.
  await signOut(page);
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkBetaVenueProfileId}`);
  await expect(page.getByText("You’re connected")).toBeVisible();
  await expect(page.locator("main")).toContainText("beta-venue-connections@example.test");
});

test("BETA declines a second request; ALPHA can then send a fresh one (Q79 as changed 2026-09-07)", async ({
  page,
}) => {
  // ---- ALPHA SENDS TO THE DECLINE TARGET -----------------------------------
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkBetaDeclineProfileId}`);
  // Same "Send from" selection as the accept test -- see its own comment.
  await page
    .locator("#connect-from-profile")
    .selectOption(world.networkAlphaProfileId);
  await page.getByRole("button", { name: "Request connection" }).click();
  await expect(page.getByText("Request sent.")).toBeVisible();

  // ---- BETA DECLINES, TOLD BEFORE THE CLICK WHAT A DECLINE NOW MEANS ------
  // Until the founder's 2026-09-07 Q79 change (20260907000000) this walk
  // proved the opposite ending -- "Declining is final" in the confirmation,
  // then ALPHA's re-send refused by the live-pair index with the
  // "already have a connection request" sentence. Both halves flipped
  // together: the confirmation now promises a fresh request is possible, and
  // the final block below proves the database agrees.
  await signOut(page);
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/network/requests`);
  // Runs AFTER the accept test (sequential, single worker), so ALPHA's
  // Received rows are now: one hand-planted Connected, one just-Connected
  // (from the accept test), and this one, still Pending -- exactly one.
  const fromAlpha = page.locator("tr", { hasText: world.networkAlphaProfileName });
  const pendingRow = fromAlpha.filter({ hasText: "Pending" });
  await expect(pendingRow).toHaveCount(1);
  await pendingRow.getByRole("button", { name: "Decline" }).click();
  // Q79, STATED BEFORE THE CLICK: the confirmation names the consequence --
  // this request is answered for good, the PAIR is not blocked.
  await expect(
    page.getByText(/they’ll be able to send a new request/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, decline" }).click();
  // The row's status is the confirmation -- see the accept test's own note on
  // why the transient `state.message` cannot reliably be observed here.
  await expect(fromAlpha.filter({ hasText: "Pending" })).toHaveCount(0);
  await expect(fromAlpha.filter({ hasText: "Declined" })).toHaveCount(1);

  // ---- ALPHA CAN RE-SEND ----------------------------------------------------
  // The real, server-enforced proof: the narrowed live-pair index
  // (20260907000000) no longer counts the declined row, so the identical send
  // through the ordinary form path succeeds -- a fresh request beside the
  // declined record, not a resurrection of it (the psql suite's NR6b asserts
  // the two-rows shape; this walk asserts the user-visible half).
  await signOut(page);
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkBetaDeclineProfileId}`);
  await page
    .locator("#connect-from-profile")
    .selectOption(world.networkAlphaProfileId);
  const resendButton = page.getByRole("button", { name: "Request connection" });
  await expect(resendButton).toBeEnabled();
  await resendButton.click();
  await expect(page.getByText("Request sent.")).toBeVisible();

  // ---- AND BETA SEES BOTH RECORDS: the old Declined, the new Pending ------
  await signOut(page);
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/network/requests`);
  await expect(fromAlpha.filter({ hasText: "Pending" })).toHaveCount(1);
  await expect(fromAlpha.filter({ hasText: "Declined" })).toHaveCount(1);
});

test("a Free-tier org's send is refused server-side, even with the disabled attribute stripped", async ({
  page,
}) => {
  // Free tier's own `getNetworkConnectionAccess` reason is "tier", which
  // renders the disabled shell as a REAL `<form>` around a disabled
  // `<button type="submit">` (components/network/connect-button.tsx) --
  // stripping `disabled` and submitting reaches the real Server Action, the
  // same `tests/e2e/finance.spec.ts:265-287` strip-and-submit pattern this
  // task's acceptance criteria name by that citation.
  await signInAsFreeMember(page);
  await page.goto(`/${world.freeOrgSlug}/network/${world.networkBetaVenueProfileId}`);

  const sendButton = page.getByRole("button", { name: "Request connection" });
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeDisabled();

  // NON-VACUOUS BASELINE (fix round 1, F1): exactly ONE element carries the
  // tier explanation before the click -- the persistent note beside the
  // control. If the count assertion below stayed at 1 after the click, this
  // baseline is what proves it, rather than an assumption.
  const paidFeatureText = page.getByText(/paid feature/);
  await expect(paidFeatureText).toHaveCount(1);

  await sendButton.evaluate((el) => el.removeAttribute("disabled"));
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // THE SERVER, NOT THE BROWSER, REFUSES -- asserted on the RETURNED ERROR
  // ALERT SPECIFICALLY (role="alert", components/ui/alert.tsx's tone="error"
  // shape), not `.first()` over a locator the persistent note already
  // satisfied before the click. `.filter({ hasText: ... })` rather than a
  // bare `getByRole("alert")`: Next.js's own hidden route announcer
  // (`#__next-route-announcer__`) also carries `role="alert"` and is present
  // on every page regardless of what happened, so a bare role locator is a
  // two-element strict-mode violation the moment the real alert renders
  // beside it -- filtering to the one that actually carries the refusal text
  // is what makes this the discriminating assertion rather than a second
  // vacuous one. FIX ROUND 1, F1: `.first()` on `/paid feature/` passed
  // whether or not the stripped submit ever reached the server -- including
  // against the exact ConnectButton defect this task fixed (a form with no
  // `action` falling back to a same-page GET, which re-renders the identical
  // persistent note and nothing else). Both assertions below fail on that
  // regression: no `role="alert"` element contains "paid feature" at all, and
  // the text count stays at 1 instead of growing to 2 -- verified by
  // reintroducing the exact defect and confirming this test reddens, then
  // reverting (recorded in the task report's Fix round 1 section).
  const errorAlert = page.getByRole("alert").filter({ hasText: /paid feature/ });
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toContainText("Owner");
  await expect(paidFeatureText).toHaveCount(2);
});
