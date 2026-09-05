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
// Three tests, not one giant test: the accept walk, the decline-then-cannot-
// resend walk, and the Free-tier server-side refusal, each independent so a
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

test("BETA declines a second request; ALPHA cannot re-send to the same profile", async ({
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

  // ---- BETA DECLINES, TOLD BEFORE THE CLICK THAT IT IS FINAL --------------
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
  // Q79, STATED BEFORE THE CLICK: the confirmation names the consequence.
  await expect(page.getByText(/Declining is final/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, decline" }).click();
  // The row's status is the confirmation -- see the accept test's own note on
  // why the transient `state.message` cannot reliably be observed here.
  await expect(fromAlpha.filter({ hasText: "Pending" })).toHaveCount(0);
  await expect(fromAlpha.filter({ hasText: "Declined" })).toHaveCount(1);

  // ---- ALPHA CANNOT RE-SEND -------------------------------------------------
  // The control is still ENABLED (this page does not track terminal request
  // state), and the database's live-pair index refuses the second send -- a
  // real, server-enforced refusal surfaced through the ordinary form error
  // path, not a client-side guess.
  await signOut(page);
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkBetaDeclineProfileId}`);
  const resendButton = page.getByRole("button", { name: "Request connection" });
  await expect(resendButton).toBeEnabled();
  await resendButton.click();
  await expect(page.getByText(/already have a connection request/)).toBeVisible();
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

  await sendButton.evaluate((el) => el.removeAttribute("disabled"));
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // THE SERVER, NOT THE BROWSER, REFUSES. The same tier explanation the
  // disabled shell already showed -- lib/network/access.ts's EXPLANATION.tier
  // -- because a submitted form and a disabled control must not disagree
  // about why (Constraint 12). `.first()`: the persistent note beside the
  // control and the returned error Alert now BOTH carry this sentence, so
  // there are genuinely two matching elements on the page after the refusal.
  await expect(page.getByText(/paid feature/).first()).toBeVisible();
  await expect(page.getByText(/paid feature/).first()).toContainText("Owner");
});
