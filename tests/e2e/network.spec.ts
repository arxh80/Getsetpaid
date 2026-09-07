import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setUpWorld, tearDownWorld, type E2eWorld } from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";

// PHASE 6 (NETWORK), TASK 6: THE NETWORK GOLDEN PATH -- the FIFTH sibling to
// golden-path.spec.ts / events.spec.ts / operations.spec.ts / documents.spec.ts
// / finance.spec.ts (CLAUDE.md § Design: "The four specs are siblings on
// purpose; whoever extends the sentence adds a fifth, not rewrites the
// others"). None of those four is touched by this task.
//
// A NAMING NOTE: this exact filename already existed, holding Task 2's own
// publish-editor component walk. That file is not this phase's golden path --
// it is a feature spec in the shape of network-discovery.spec.ts /
// network-connections.spec.ts / network-leakage.spec.ts -- so it was
// `git mv`-ed to `network-profile-editor.spec.ts` (history preserved, no test
// body changed) to make room for the golden path this brief names by exact
// path. See that file's own header for the fuller note.
//
// ===========================================================================
// THE ONE CONNECTED STORY, VERBATIM FROM THE BRIEF
// ===========================================================================
// "a Manager in org ALPHA publishes a venue profile with two fields at
// `network` and one at `connections`; a member of org BETA finds it in the
// directory and sees exactly those two; BETA requests a connection; ALPHA
// accepts; BETA now sees the third; BETA links the profile to its own
// private company record and the link appears on that record."
//
//   ALPHA = world.orgSlug / world.users.manager -- holds manage_venues (to
//           create the venue), manage_network_profile and
//           manage_network_connections (to publish and to accept).
//   BETA  = world.otherOrgSlug / world.otherMember -- FOUND IN A BROWSER WALK
//           (Constraint 17), NOT the brief's own first-draft choice of
//           `world.proOrgSlug` / `booker`. `proOrgId` is ALREADY organisation-
//           WIDE connected to `orgId` through Task 3's hand-planted
//           `networkAcceptedRequestId` (Q80: an accepted connection resolves
//           EVERY one of the connected organisation's published profiles'
//           `connections` fields, not just the one pair that was accepted) --
//           so a fresh ALPHA profile would already show its `connections`-
//           level field to `proOrgId` from the very first read, and the "BETA
//           sees exactly two fields, not the third, until ALPHA accepts"
//           step this test exists to prove would be false before the test
//           even started. `otherOrgId` carries NO connection to `orgId` at
//           all (fixtures.ts's own header on `otherMember`: "UNCONNECTED to
//           ALPHA -- no connection request touches otherOrgId"), which is
//           what makes it the correct BETA for a walk that has to start
//           genuinely disconnected. `otherMember` is a plain `manager` of
//           `otherOrgId` (MFA-optional, holds `manage_contacts`,
//           `manage_network_profile` and `manage_network_connections`, the
//           same three role grants ALPHA's manager holds) and, like
//           `freeMember` elsewhere in this suite, is signed in by hand rather
//           than through `signIn(page, world, role)` -- it is not one of the
//           fixed `E2eRole` personas that helper addresses (fixtures.ts's own
//           header on `otherMember` explains why: "adding it to `users`
//           would put a member of the second tenant inside the record every
//           breakout assertion in this suite reasons about"). `otherOrgId`
//           carries no `organisation_subscriptions` row either (fixtures.ts:
//           "unbilled (orgId, otherOrgId)"), so the same "not yet billed =>
//           not yet gated" escape that makes ALPHA's own publish legal here
//           applies to BETA too.
//
//   BETA HAS NO PUBLISHED PROFILE OF ITS OWN AT THE START, UNLIKE THE BRIEF'S
//   FIRST DRAFT ASSUMED. Q78: sending a request needs one of the sender's OWN
//   published profiles, so this walk has BETA publish a minimal one first --
//   its own private company, which doubles as the SAME record BETA later
//   links ALPHA's venue profile to. One company plays both parts: BETA's own
//   public identity (used to send the request) and BETA's own private CRM
//   record (which gains a "Linked profile" entry once BETA finds ALPHA's
//   venue on the network) -- exactly how a real booking agency would use the
//   two features together, and it keeps the walk to one company rather than
//   two unrelated fixtures.
//
// ONE TEST, ONE NARRATIVE. Not `test.describe.serial` and not split into
// several tests sharing state through `test.beforeAll` mutation: it is a
// single `test(...)` block that walks straight through, so a failure midway
// produces one clear stack trace at the exact step that broke, and there is
// no serial-mode skip for a later assertion to hide behind
// (FOLLOW-UPS.md § Phase 5: `finance.spec.ts`'s `test.describe.serial` made a
// golden-path failure SKIP the tier-gate test, "signal loss in exactly the
// suite that should not have any" -- this file has no `.serial` anywhere).
//
// Constraint 15 throughout: every assertion is a direct locator assertion,
// including the `not.toContainText`/`toHaveCount(0)` absence checks that are
// this test's own leakage proof -- never `if (await x.count())`.
let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** Sign in as `world.otherMember` -- not a fixed `E2eRole` persona (see the
 *  header above and fixtures.ts's own note on why). The manual form walk,
 *  mirroring network-discovery.spec.ts's own `signInAsFreeMember`. */
async function signInAsOtherMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.otherMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("ALPHA publishes a venue with two network fields and one connections field; BETA discovers it, connects, and links it to its own company", async ({
  page,
}) => {
  // ONE TEST, ELEVEN ROUTE VISITS, FOUR SIGN-IN CYCLES: the 60s default is the
  // exact budget accessibility.spec.ts:130-146 records as the failure mode
  // ("eleven pages under one budget"), so this test declares itself slow
  // (triple budget) rather than trusting warm routes to stay warm.
  test.slow();

  // SUFFIXED WITH THE RUN'S OWN orgSlug, per fixtures.ts's directory-naming
  // rule: the network directory is the one list in the product with no per-run
  // tenant boundary, so a hardcoded profile name collides with a leftover row
  // from any run that died before tearDownWorld and breaks the
  // `getByRole("link", { name })` lookups below with a strict-mode violation.
  const venueName = `Network Golden Path Venue ${world.orgSlug}`;
  const companyName = `Network Golden Path Bookers Ltd ${world.orgSlug}`;
  const connectionsEmail = `golden-path-connections-${world.orgSlug}@example.test`;

  // =========================================================================
  // ALPHA: CREATE THE VENUE, THEN PUBLISH IT FROM ITS OWN "Network identity"
  // ROW -- THE SAME "Publish this record" LINK network-profile-editor.spec.ts
  // WALKS FOR A COMPANY, HERE FOR A VENUE.
  // =========================================================================
  await signIn(page, world, "manager");

  await page.goto(`/${world.orgSlug}/venues/new`);
  await page.locator('input[name="name"]').fill(venueName);
  await page.getByRole("button", { name: "Create venue" }).click();
  await expect(page.getByRole("heading", { name: venueName, level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("Not published to the network yet");

  await page.getByRole("link", { name: "Publish this record" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/network/profiles$`));
  await expect(page.getByRole("heading", { name: "Publish a record" })).toBeVisible();
  // SCOPED TO THE VENUE FORM, NOT `.first()`. `CreateProfileForm` renders one
  // mini-form per manageable kind (company, artist, venue, agency), and
  // ALPHA's own base fixtures already publish a COMPANY profile or two
  // (`networkAlphaProfileId`/`networkDraftProfileId`) -- so by the time this
  // walk runs, that section can be the one with NOTHING LEFT to publish (a
  // disabled "Create draft" with `aria-describedby="publish-company-empty"`),
  // and `.first()` resolved to it instead of the venue form, which sorts
  // after company in `NETWORK_ENTITY_KINDS` order. Found in this browser walk
  // (Constraint 17). Each kind's mini-form is its own `<form>`
  // (components/network/create-profile-form.tsx), so the venue form is
  // scoped by the presence of the venue picker's own id inside it.
  const venueForm = page.locator("form", { has: page.locator("#publish-venue-entity") });
  await venueForm.locator("#publish-venue-entity").selectOption({ label: venueName });
  await venueForm.locator("#publish-venue-name").fill(venueName);
  await venueForm.getByRole("button", { name: "Create draft" }).click();

  const draftLink = page.getByRole("link", { name: venueName });
  await expect(draftLink).toBeVisible();
  await draftLink.click();
  await expect(page.getByRole("heading", { name: venueName, level: 1 })).toBeVisible();

  // The editor's own URL is /network/profiles/{id} -- the profile id is the
  // last path segment, and BETA needs it later to revisit the SAME profile
  // through its own org slug's public route (/network/{id}), not this one.
  const profileId = new URL(page.url()).pathname.split("/").pop();
  expect(profileId, "the editor URL ends in the profile's id").toMatch(
    /^[0-9a-f-]{36}$/,
  );

  // =========================================================================
  // ALPHA: HEADLINE + CITY AT `network`, CONTACT EMAIL AT `connections` --
  // THE ACCEPTANCE CRITERION'S OWN "two fields at network and one at
  // connections". Each field's value input and its visibility fieldset are
  // SIBLINGS inside one `<li>` (components/network/profile-editor.tsx), so
  // each row is scoped by that shared ancestor.
  // =========================================================================
  const headlineRow = page.locator("li", { has: page.locator("#headline") });
  await headlineRow.locator("#headline").fill("Golden-path enquiries welcome");
  await headlineRow.getByRole("radio", { name: /Everyone on the network/i }).click();

  const cityRow = page.locator("li", { has: page.locator("#city") });
  await cityRow.locator("#city").fill("Frome");
  await cityRow.getByRole("radio", { name: /Everyone on the network/i }).click();

  const emailRow = page.locator("li", { has: page.locator("#contact_email") });
  await emailRow.locator("#contact_email").fill(connectionsEmail);
  await emailRow.getByRole("radio", { name: /Connections only/i }).click();

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  // 2 always-shown + headline + city = 4 network; 1 connections
  // (contact_email); the remaining 4 publishable fields (bio, region,
  // country, website_url) stay hidden. 4 + 1 + 4 = 9, the fixed denominator.
  await expect(page.getByText(/4 of 9/)).toBeVisible();
  await expect(page.getByText(/1 more to accepted connections/)).toBeVisible();
  await expect(page.getByText(/4 are hidden/)).toBeVisible();

  await page.getByRole("button", { name: "Publish to the network" }).click();
  await expect(page.getByText(/Published\./)).toBeVisible();
  // THE STATUS CHIP, SCOPED TO ITS EXACT SLOT rather than `.first()`: the
  // editor page renders ProfileStatusChip as the h1's immediate sibling
  // (app/(app)/[orgSlug]/network/profiles/[profileId]/page.tsx), so `h1 + span`
  // is that one chip and a second "Published" anywhere else can never satisfy
  // this. `.first()` would keep passing on whichever sorted first.
  await expect(page.locator("h1 + span")).toHaveText("Published");

  // =========================================================================
  // BETA: ITS OWN COMPANY, PUBLISHED MINIMALLY -- Q78's "one of the sender's
  // own published profiles". Every publishable field stays at its default
  // `hidden`; this profile's own field visibility is not this test's subject.
  // =========================================================================
  await signOut(page);
  await signInAsOtherMember(page);

  await page.goto(`/${world.otherOrgSlug}/companies/new`);
  await page.locator('input[name="name"]').fill(companyName);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByRole("heading", { name: companyName, level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Publish this record" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.otherOrgSlug}/network/profiles$`));
  const companyForm = page.locator("form", { has: page.locator("#publish-company-entity") });
  await companyForm.locator("#publish-company-entity").selectOption({ label: companyName });
  await companyForm.locator("#publish-company-name").fill(companyName);
  await companyForm.getByRole("button", { name: "Create draft" }).click();
  const betaDraftLink = page.getByRole("link", { name: companyName });
  await expect(betaDraftLink).toBeVisible();
  await betaDraftLink.click();
  await expect(page.getByRole("heading", { name: companyName, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Publish to the network" }).click();
  await expect(page.getByText(/Published\./)).toBeVisible();

  // =========================================================================
  // BETA: FINDS ALPHA'S VENUE IN THE DIRECTORY BY SEARCH, SEES EXACTLY THE
  // TWO `network` FIELDS -- NOT THE `connections` ONE, NOT YET CONNECTED.
  // =========================================================================
  await page.goto(`/${world.otherOrgSlug}/network`);
  await expect(page.getByRole("heading", { name: "Network", level: 1 })).toBeVisible();
  await page.getByLabel("Search the network by name").fill(venueName);
  // exact: the keyboard-a11y pass put a command-palette trigger named
  // "Search Ctrl K" in every workspace header, and getByRole's default
  // substring match resolves both (strict-mode violation). Same at every
  // directory-search click in this suite.
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const directoryLink = page.getByRole("link", { name: venueName });
  await expect(directoryLink).toBeVisible();
  // THE TWO `network` FIELDS, RIGHT THERE IN THE DIRECTORY ROW.
  await expect(page.locator("main")).toContainText("Golden-path enquiries welcome");
  await expect(page.locator("main")).toContainText("Frome");
  // THE `connections` FIELD MUST NOT APPEAR ANYWHERE ON THIS PAGE -- BETA has
  // no accepted connection with ALPHA yet. This is the assertion the first
  // mutation test (un-mask one directory field) reddens.
  await expect(page.locator("main")).not.toContainText(connectionsEmail);

  await directoryLink.click();
  await expect(page.getByRole("heading", { name: venueName, level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("Golden-path enquiries welcome");
  await expect(page.locator("main")).toContainText("Frome");
  await expect(page.locator("main")).not.toContainText(connectionsEmail);
  await expect(page.getByText("You’re connected")).toHaveCount(0);

  // =========================================================================
  // BETA REQUESTS A CONNECTION, FROM THE ONE PUBLISHED PROFILE IT NOW HAS
  // (Q78). ConnectButton renders the single-profile branch -- a hidden
  // `fromProfileId` and a sentence, not a `<select>` -- because BETA holds
  // exactly one published profile.
  // =========================================================================
  await expect(page.locator("main")).toContainText(companyName);
  const sendButton = page.getByRole("button", { name: "Request connection" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByText("Request sent.")).toBeVisible();

  // =========================================================================
  // ALPHA ACCEPTS, ON ITS OWN REQUESTS PAGE.
  // =========================================================================
  await signOut(page);
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}/network/requests`);
  await expect(
    page.getByRole("heading", { name: "Connection requests", level: 1 }),
  ).toBeVisible();

  // The "From" column renders BETA's SENDING profile (its own company's
  // display name), never a tenant name -- CLAUDE.md's own words, walked here
  // rather than only asserted at the unit level.
  const fromBeta = page.locator("tr", { hasText: companyName });
  const pendingRow = fromBeta.filter({ hasText: "Pending" });
  await expect(pendingRow).toHaveCount(1);
  await pendingRow.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText(/Fields they marked/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, accept" }).click();
  // The row's new status is the confirmation (the transient state.message
  // unmounts in the same revalidation -- see network-connections.spec.ts's
  // own note on why that message cannot be reliably observed here).
  await expect(fromBeta.filter({ hasText: "Pending" })).toHaveCount(0);
  await expect(fromBeta.filter({ hasText: "Connected" })).toHaveCount(1);

  // =========================================================================
  // BETA NOW SEES THE THIRD FIELD -- THE ACCEPT-UNLOCK PAYOFF. Removing the
  // accept step's effect is the third mutation test, and this is the
  // assertion it reddens.
  // =========================================================================
  await signOut(page);
  await signInAsOtherMember(page);
  await page.goto(`/${world.otherOrgSlug}/network/${profileId}`);
  await expect(page.getByRole("heading", { name: venueName, level: 1 })).toBeVisible();
  await expect(page.getByText("You’re connected")).toBeVisible();
  await expect(page.locator("main")).toContainText(connectionsEmail);
  // The two `network` fields are unaffected by the accept.
  await expect(page.locator("main")).toContainText("Golden-path enquiries welcome");
  await expect(page.locator("main")).toContainText("Frome");

  // =========================================================================
  // BETA LINKS THE PROFILE TO ITS OWN PRIVATE COMPANY RECORD (Q73/Q82) --
  // EXPLICIT SEARCH-AND-CONFIRM, NEVER SUGGESTED. The link is BETA's own
  // private fact; ALPHA is never told (Q82 -- proven adversarially in
  // network-leakage.spec.ts, not repeated here). The SAME company BETA just
  // published its own identity from also carries this section -- the
  // "Network identity" row (its OWN published profile) and the "Linked
  // profile" row (a profile SOMEBODY ELSE published) sit side by side on one
  // company page and are never conflated (components/network/
  // linked-identity-section.tsx's own header).
  // =========================================================================
  // BACK TO THE SAME COMPANY -- no second company created; the list page's
  // own link is the way back to it.
  await page.goto(`/${world.otherOrgSlug}/companies`);
  await page.getByRole("link", { name: companyName }).click();
  await expect(page.getByRole("heading", { name: companyName, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked profile" })).toBeVisible();

  await page.getByRole("button", { name: "Link to a network profile" }).click();
  await page.getByLabel("Search the network by name").fill(venueName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const linkRow = page.locator("li", { hasText: venueName });
  await expect(linkRow).toHaveCount(1);
  await linkRow.getByRole("button", { name: "Link" }).click();

  // THE LINK SHOWS ON THE PRIVATE RECORD -- the brief's own last clause,
  // asserted on the RESULTING STATE rather than the transient success
  // message. FOUND IN THIS BROWSER WALK (Constraint 17): the successful link
  // revalidates this page server-side, and LinkedIdentitySection swaps from
  // `LinkPicker` (which held the transient "Linked." message inside the now-
  // unmounted search form) to `LinkedIdentity` (which does not render that
  // message at all) in the SAME revalidation the action's own redirect-free
  // response completes -- the identical shape network-connections.spec.ts's
  // own comment on the accept-row payoff already documents: "the row
  // appearing ... is the confirmation," not a transient string a page can
  // reliably still be showing when the assertion runs. Asserting the search
  // form's absence and the linked state's presence is what survives that
  // race; the search results list from the step above is gone, and exactly
  // one link to the venue's profile remains: this one.
  await expect(page.getByLabel("Search the network by name")).toHaveCount(0);
  await expect(page.locator("main")).toContainText("Linked to");
  await expect(page.getByRole("link", { name: venueName })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Unlink" })).toBeVisible();
});
