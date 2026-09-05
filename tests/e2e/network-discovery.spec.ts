import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 6 (NETWORK), TASK 3: THE DIRECTORY AND THE PROFILE-AS-SEEN-BY-THE-
// CALLER PAGE, WALKED WITH TWO ORGANISATIONS -- CONSTRAINT 17.
//
// ===========================================================================
// THE THREE VIEWPOINTS, AND WHY EACH NEEDS A DIFFERENT ORGANISATION
// ===========================================================================
// `world.orgId` ("ALPHA") publishes `networkAlphaProfileId`. Three OTHER
// organisations look at it, and each is chosen for what it proves:
//
//   world.freeOrgSlug   (freeMember)  a genuinely FREE-TIER workspace, on a
//                       real `plan_id='free'` subscription row -- not
//                       `world.orgSlug`'s no-subscription escape, which
//                       `entitlementsPermitNetworkPublish` treats as UNGATED
//                       (lib/network/access.ts's own header). NOT connected to
//                       ALPHA, so this is also the "unconnected viewer" case:
//                       the `connections`-level field must stay masked.
//   world.proOrgSlug    (booker)      CONNECTED to ALPHA through the
//                       hand-planted `networkAcceptedRequestId` -- the
//                       acceptance criterion's own words, "until Task 4
//                       exists". The `connections`-level field must resolve.
//   world.orgSlug       (manager)     ALPHA ITSELF, viewing its own draft and
//                       its own published profile through this same route --
//                       the ownership branch.
let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** Sign in as `world.freeMember` -- not one of the fixed `E2eRole` personas
 *  every other test in this suite addresses by role, so this is the manual
 *  form walk `signIn()` itself performs, without the role-keyed lookup. Free
 *  is MFA-optional at MVP (CLAUDE.md), so there is no TOTP step here. */
async function signInAsFreeMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.freeMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("a Free-tier, unconnected viewer browses the directory, finds ALPHA's profile, and sees masked fields plus a disabled, explained request control", async ({
  page,
}) => {
  await signInAsFreeMember(page);

  // ---- FREE SEES THE DIRECTORY IN FULL ------------------------------------
  // CLAUDE.md § Subscription tiers: Free is "view-only network browsing", not
  // "no browsing". No tier gate on this route at all (getNetworkReadAccess
  // carries none).
  await page.goto(`/${world.freeOrgSlug}/network`);
  await expect(page.getByRole("heading", { name: "Network", level: 1 })).toBeVisible();
  const link = page.getByRole("link", { name: world.networkAlphaProfileName });
  await expect(link).toBeVisible();
  // The published, network-level headline is right there in the results —
  // this is the directory, not an empty shell.
  await expect(page.locator("main")).toContainText("Booking enquiries welcome");

  // ---- OPEN IT: EXACTLY THE `network` FIELDS, NOTHING FROM `connections` --
  await link.click();
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("Bristol");
  await expect(page.locator("main")).toContainText("Booking enquiries welcome");
  // `contact_email` is `connections`-level and freeOrg has no accepted request
  // with ALPHA -- so it must NOT be on the page at all (ProfileCard omits a
  // null field entirely, never a "hidden" placeholder).
  await expect(page.locator("main")).not.toContainText("alpha-connections@example.test");
  // Nor the "You're connected" affordance, which only renders for the
  // `connected` source.
  await expect(page.getByText("You’re connected")).toHaveCount(0);

  // ---- THE REQUEST CONTROL: RENDERED, DISABLED, EXPLAINED -----------------
  // Constraint 12: hiding a button is not enforcement, and Free-tier honesty
  // means this is a real control on the page, not an absent one.
  const request = page.getByRole("button", { name: "Request connection" });
  await expect(request).toBeVisible();
  await expect(request).toBeDisabled();
  const describedBy = await request.getAttribute("aria-describedby");
  expect(describedBy, "the button names a note").not.toBeNull();
  // THE ACCEPTANCE CRITERION'S OWN WORDS: the sentence names the PLAN as the
  // reason and says an OWNER can change it.
  await expect(page.locator(`#${describedBy}`)).toContainText("paid feature");
  await expect(page.locator(`#${describedBy}`)).toContainText("Owner");
});

test("a CONNECTED viewer sees the connections-level field resolve, and the connected notice", async ({
  page,
}) => {
  await signIn(page, world, "booker");
  await page.goto(`/${world.proOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("You’re connected")).toBeVisible();
  // THE CONNECTIONS-LEVEL FIELD, RESOLVED -- the hand-planted accepted request
  // is what makes this different from the Free-tier test above, which read
  // the SAME profile and did NOT see this value.
  await expect(page.locator("main")).toContainText("alpha-connections@example.test");
  // The network-level field is unaffected either way.
  await expect(page.locator("main")).toContainText("Bristol");

  // NOW ENABLED (Task 4 wired the control's action) -- booker holds
  // manage_network_connections in a Pro-tier workspace that already has a
  // published profile of its own (`networkBetaAnchorProfileId`, planted by
  // Task 3), so `getNetworkConnectionAccess` says yes and `ownProfiles` is
  // non-empty. tests/e2e/network-connections.spec.ts is where the send/
  // accept/decline walk itself lives; this test's own job stays the
  // connections-field resolution above, updated only so it does not assert a
  // now-false fact about the control's disabled state.
  const request = page.getByRole("button", { name: "Request connection" });
  await expect(request).toBeEnabled();
});

test("ALPHA's own DRAFT profile 404s for a foreign, unconnected viewer -- no existence leak", async ({
  page,
}) => {
  await signInAsFreeMember(page);
  const response = await page.goto(
    `/${world.freeOrgSlug}/network/${world.networkDraftProfileId}`,
  );
  expect(response?.status(), "a draft must refuse with 404, never 403").toBe(404);
  await expect(
    page.getByRole("heading", { name: "Page not found." }),
  ).toBeVisible();
});

test("the SAME draft is visible to its OWNER, with the Draft chip, not a 404", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkDraftProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkDraftProfileName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  // The ownership branch renders no request control at all -- you cannot
  // connect to yourself.
  await expect(page.getByRole("button", { name: "Request connection" })).toHaveCount(0);
});

test("ALPHA's owner viewing its OWN published profile sees every field it stored, unmasked, with the Published chip", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  // THE POSITIVE CONTROL: the connections-level field, which a foreign
  // unconnected viewer never sees, is right there for the owner.
  await expect(page.locator("main")).toContainText("alpha-connections@example.test");
  await expect(page.locator("main")).toContainText("Bristol");
});

test("a hostile profile's values render as inert text -- the RENDER path refuses them, not just the form", async ({
  page,
}) => {
  // THE `hostileContactId` PATTERN, over a network profile. Every hostile
  // field on `networkHostileProfileId` is `network`-visibility, planted
  // directly PAST any form, so this measures ProfileCard's `safeHref()` guard
  // and React's own escaping -- not the write-side validator, which a form
  // bypass (a migration, a future admin path) would skip entirely.
  await signInAsFreeMember(page);
  await page.goto(`/${world.freeOrgSlug}/network/${world.networkHostileProfileId}`);

  // NEITHER `onerror` NOR the inline `<script>` FIRED. This is NOT "the title
  // must not contain the word FIRED" -- the page's own `<title>` legitimately
  // contains the raw, INERT text of the hostile display name (browsers never
  // parse `<title>` content as markup, so the literal characters
  // `<img src=x onerror="...">` sitting there is expected and harmless). What
  // would prove an actual firing is `document.title` having been REPLACED
  // wholesale by the marker string the `onerror`/`<script>` payloads assign --
  // a short string, not the full "<name> · Network · <org> · GetSetPaid" this
  // page's own `generateMetadata` always produces.
  const title = await page.title();
  expect(title, "the SSR-rendered title survives, unreplaced").toContain(" · Network · ");
  expect(title).not.toBe("NETWORK-NAME-FIRED");
  expect(title).not.toBe("NETWORK-HEADLINE-FIRED");
  expect(title).not.toBe("NETWORK-BIO-FIRED");

  // The raw text is still ON THE PAGE -- omitted-if-hostile would look like a
  // bug to the publisher; shown-as-text is the honest refusal.
  await expect(page.locator("main")).toContainText("Hostile Network Venue");
  await expect(page.locator("main")).toContainText(
    "NETWORK-BIO-FIRED", // the literal characters of the <script> body, as text
  );

  // THE HREF ITSELF: a `javascript:` value must never become a clickable
  // link. There must be NO anchor whose href is the hostile scheme -- the
  // page may still show the raw string as plain text (ProfileCard's own
  // fallback for a website `safeHref()` refuses).
  const hostileAnchor = page.locator('a[href^="javascript:"]');
  await expect(hostileAnchor).toHaveCount(0);
});
