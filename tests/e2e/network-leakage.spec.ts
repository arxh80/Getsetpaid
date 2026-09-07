import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 6 (NETWORK), TASK 5: THE NETWORK-LEAKAGE MATRIX, IN A BROWSER.
//
// ===========================================================================
// WHAT THIS ADDS THAT THE OTHER TWO LAYERS CANNOT
// ===========================================================================
// `supabase/tests/network_leakage_phase6.sql` drives the matrix at the policy
// layer and the appended HTTP block drives it at PostgREST. Both prove the
// DATABASE refuses. Neither can prove what the APPLICATION does with a request
// it is allowed to make: a route that resolves an id before it checks the
// tenant, a page that renders a name out of a cache, a 403 where the product
// promised a refusal. Those are Next.js facts and only a browser sees them.
// (Since the loading-skeletons pass a RECORD-level refusal under the viewer's
// own slug streams as HTTP 200 + the identical not-found document -- the page's
// notFound() lands after the loading boundary has flushed the status line --
// while a WORKSPACE-level refusal still carries the literal 404. See
// tenant-breakout.spec.ts's expectRefused header and its REFUSAL PARITY test;
// here `expectRecordRefused` asserts the same contract plus per-probe parity
// against a nonexistent id.)
//
// ===========================================================================
// THE TWO DISTANCES, AND WHY EACH IS THE PERSONA IT IS
// ===========================================================================
//   UNCONNECTED  `world.otherMember` -- a manager of `world.otherOrgId`, added
//                by this task (see the fixture's own header). MFA-optional, so
//                a password sign-in really does hold `view_crm` and
//                `view_network`: a 404 below is the TENANT BOUNDARY and not a
//                session that holds nothing. No connection request touches
//                that organisation.
//   CONNECTED    `booker` in `world.proOrgSlug`, which IS connected to ALPHA
//                through the hand-planted `networkAcceptedRequestId`. The
//                acceptance criterion the whole phase turns on is that this
//                changes exactly one thing -- `connections`-level FIELDS
//                resolve -- and grants access to NO tenant table.
//
// `tests/e2e/network-discovery.spec.ts` already walks the FIELD half from both
// distances (a Free-tier unconnected viewer sees the masked field; the
// connected booker sees it resolve). This file deliberately does not repeat
// it: what it adds is the PRIVATE-RECORD half, which no browser test covered.
let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** Sign in as `world.otherMember` -- the manual form walk, like
 *  `signInAsFreeMember` in network-discovery.spec.ts, because this is not one
 *  of the fixed `E2eRole` personas `signIn()` addresses by role. `manager` is
 *  MFA-optional, so there is no TOTP step. */
async function signInAsOtherMember(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.otherMember.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * The private records of ALPHA (`world.orgSlug`) a counterparty must not
 * reach, as `<label, path-under-a-slug>` pairs. One per row of the Task 5
 * matrix that has a DETAIL PAGE.
 *
 * `documents` is deliberately absent and its absence is measured, not assumed:
 * `app/(app)/[orgSlug]/documents/[documentId]/` contains only `download/
 * route.ts` -- there is no document detail page in the product, so
 * `/documents/<id>` is a 404 for its own tenant too and would have been a
 * probe that passes for the wrong reason. The document row of the matrix is
 * driven through the download Route Handler instead, in all three tests below,
 * which is the stronger surface anyway: it is the one path that mints a signed
 * URL.
 */
/**
 * The HTTP status of `path`, fetched through the page's own signed-in context.
 *
 * `page.goto()` IS NOT USED FOR THE STATUS ASSERTIONS, and the reason is
 * measured: it returns `null` when a navigation produces no new document, and
 * on this suite's artist route it did exactly that -- the positive-control loop
 * read `undefined` for a page that renders perfectly. A null response would
 * have to be handled with a conditional, which Constraint 15 forbids for
 * precisely this reason: it degrades the assertion to a no-op. `page.request`
 * shares the browser context's cookies, so it is the same authenticated
 * session, and it always yields a response with a real status line.
 */
async function statusOf(page: Page, path: string): Promise<number> {
  // maxRedirects: 0 so a bounce to /login shows up as its own 3xx status
  // rather than a followed 200 -- status uniformity is part of the contract.
  const response = await page.request.get(path, { maxRedirects: 0 });
  return response.status();
}

/** A well-formed UUID that matches no row anywhere. Deterministic on purpose. */
const GHOST_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The streaming-aware record refusal (see the header note): `path` is
 * `<family>/<id>` under `slug`. Asserts the status is 404 or a streamed
 * not-found 200 -- never 403, never a redirect -- AND that it equals the
 * status of the same family probed with an id that matches nothing, which is
 * the per-probe existence-oracle assertion the fixed 404 used to imply.
 */
async function expectRecordRefused(
  page: Page,
  slug: string,
  path: string,
  label: string,
) {
  const real = await statusOf(page, `/${slug}/${path}`);
  const ghost = await statusOf(
    page,
    `/${slug}/${path.replace(/[^/]+$/, GHOST_ID)}`,
  );
  expect(
    [200, 404],
    `ALPHA's ${label} must refuse as 404 or a streamed not-found (200), ` +
      `never 403 (a 403 confirms the row exists); got ${real}`,
  ).toContain(real);
  expect(
    real,
    `ALPHA's ${label}: a real foreign row and a nonexistent id must share ` +
      `one status -- a difference is an existence oracle (got ${real} vs ${ghost})`,
  ).toBe(ghost);
}

function alphaPrivateRoutes(w: E2eWorld): ReadonlyArray<readonly [string, string]> {
  return [
    ["contact", `contacts/${w.managerOwnedContactId}`],
    ["event", `events/${w.managerOwnedEventId}`],
    ["task", `tasks/${w.taskId}`],
    ["meeting", `meetings/${w.meetingId}`],
    ["company note", `notes/${w.companyNoteId}`],
    ["private note", `notes/${w.privateNoteId}`],
    ["venue", `venues/${w.venueId}`],
    ["artist", `artists/${w.artistId}`],
  ] as const;
}

test("an UNCONNECTED counterparty, signed in for real, reaches none of ALPHA's private records", async ({
  page,
}) => {
  await signInAsOtherMember(page);

  // THE SESSION IS LIVE AND HOLDS ITS KEYS. Without this, every 404 below is
  // satisfied by a session that cannot render anything -- the browser form of
  // the "an assertion run as a user who belongs to neither org proves less
  // than it appears to" problem the psql suite's § LA is about.
  await page.goto(`/${world.otherOrgSlug}/contacts`);
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Other Tenant Secret" })).toBeVisible();

  // ...AND IT CAN READ THE NETWORK, so `view_network` is genuinely held and the
  // network 404 below is not the read gate closing.
  await page.goto(`/${world.otherOrgSlug}/network`);
  await expect(page.getByRole("heading", { name: "Network", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("link", { name: world.networkAlphaProfileName }),
  ).toBeVisible();

  // THE MATRIX. Every id is a real, live row in ALPHA; every one is addressed
  // through the counterparty's OWN slug, which is the request an attacker
  // sends (the org slug is in every URL and the record id is guessable from
  // nothing, but a leaked or enumerated one must still refuse).
  for (const [label, path] of alphaPrivateRoutes(world)) {
    await expectRecordRefused(page, world.otherOrgSlug, path, label);
  }

  // THE FILE BYTES. The download Route Handler is the one path in the product
  // that mints a signed URL, so a refusal here is the difference between "no
  // link on a page" and "no bytes". BOTH of ALPHA's fixture documents, because
  // the clean one and the quarantined one take different branches inside
  // `issueDownloadUrl` for their own tenant and a counterparty must not reach
  // either branch.
  for (const [label, id] of [
    ["clean", world.cleanDocumentId],
    ["quarantined", world.quarantinedDocumentId],
  ] as const) {
    const download = await page.request.get(
      `/${world.otherOrgSlug}/documents/${id}/download`,
      { maxRedirects: 0 },
    );
    expect(
      download.status(),
      `ALPHA's ${label} document must not mint a signed URL for a counterparty`,
    ).toBe(404);
  }

  // AND THROUGH ALPHA'S OWN SLUG, which is the other half of the same attack:
  // knowing the victim's slug must not help either. A workspace this viewer
  // is no member of refuses at the layout, above every loading boundary, so
  // the literal 404 still holds here.
  expect(
    await statusOf(page, `/${world.orgSlug}/contacts/${world.managerOwnedContactId}`),
    "ALPHA's own slug does not admit a non-member",
  ).toBe(404);
});

test("a CONNECTED counterparty reaches none of them either -- accept unlocks fields, not tables", async ({
  page,
}) => {
  // N4, in a browser. `world.proOrgSlug` holds an ACCEPTED connection with
  // ALPHA (`networkAcceptedRequestId`), and network-discovery.spec.ts proves
  // that connection is live by reading a `connections`-level field through it.
  // This is the other half of the same sentence: it grants access to no tenant
  // table, and the ids are the identical nine.
  await signIn(page, world, "booker");

  // THE CONNECTION IS LIVE, asserted here rather than assumed from another
  // spec file -- otherwise every 404 below could be an unconnected viewer's.
  await page.goto(`/${world.proOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(page.getByText("You’re connected")).toBeVisible();
  await expect(page.locator("main")).toContainText("alpha-connections@example.test");

  // An accepted connection grants no access to any tenant table (N4): the
  // identical refusal-and-parity contract as the unconnected pass above.
  for (const [label, path] of alphaPrivateRoutes(world)) {
    await expectRecordRefused(page, world.proOrgSlug, path, label);
  }

  for (const [label, id] of [
    ["clean", world.cleanDocumentId],
    ["quarantined", world.quarantinedDocumentId],
  ] as const) {
    const download = await page.request.get(
      `/${world.proOrgSlug}/documents/${id}/download`,
      { maxRedirects: 0 },
    );
    expect(
      download.status(),
      `a connected counterparty must not mint a signed URL for the ${label} document either`,
    ).toBe(404);
  }
});

test("POSITIVE CONTROL: ALPHA's own manager opens every one of those records, and reaches the download gate", async ({
  page,
}) => {
  // Without this, both tests above are satisfied by nine ids that name nothing
  // and a route handler that 404s for everybody. This is the denominator for
  // the whole file: the same nine paths, the same fixture, a member of the
  // tenant that owns them.
  await signIn(page, world, "manager");

  for (const [label, path] of alphaPrivateRoutes(world)) {
    expect(
      await statusOf(page, `/${world.orgSlug}/${path}`),
      `ALPHA's own manager must OPEN its ${label} -- otherwise the 404s above ` +
        "are a broken fixture, not a boundary",
    ).toBe(200);
  }

  // THE DOWNLOAD ROUTE'S POSITIVE CONTROL IS A 409, NOT A 302, AND THAT IS A
  // MEASUREMENT RATHER THAN A COMPROMISE.
  //
  // The brief's matrix row reads "ALPHA's holder gets a 302", and that IS
  // asserted in the suite -- `tests/e2e/documents.spec.ts`'s "a clean upload
  // lands Ready and downloads via a signed URL" walks a real upload through
  // the pipeline and asserts 302 on its href. It cannot be asserted HERE on
  // `world.cleanDocumentId`, because that fixture is a `documents` ROW planted
  // by `setUpWorld` with no bytes behind it in Storage: `issueDownloadUrl`
  // authorises the caller, reaches `createSignedUrl` for an object that does
  // not exist, and answers 500. Measured, not guessed -- an earlier draft of
  // this test asserted 302 and got 500.
  //
  // `world.quarantinedDocumentId` gives the exact pair this control needs
  // without inventing a fixture: 409 is returned only AFTER the authorisation
  // check passes (`app/(app)/[orgSlug]/documents/[documentId]/download/
  // route.ts` and documents.spec.ts's own 409 test), so 404-for-a-counterparty
  // vs 409-for-the-owner is the route distinguishing the tenant, which is
  // precisely what the two tests above claim it does.
  const owned = await page.request.get(
    `/${world.orgSlug}/documents/${world.quarantinedDocumentId}/download`,
    { maxRedirects: 0 },
  );
  expect(
    owned.status(),
    "the owning tenant reaches the scan-status gate (409); a counterparty never gets past 404",
  ).toBe(409);
});

// THE IDOR PROBE IS TWO TESTS, NOT ONE WITH TWO SIGN-INS, and the reason is
// mechanical: `signIn()` and `signInAsOtherMember()` both start at `/login`,
// and an already-authenticated page is redirected off it before the email
// field exists. Two tests get two fresh browser contexts, which is what the
// two distances actually need.
test("the IDOR probe, UNCONNECTED: ALPHA's DRAFT profile 404s, and the published one renders masked", async ({
  page,
}) => {
  // network-discovery.spec.ts drives this id from the FREE-tier viewer.
  // Neither of the two distances this file is about had ever driven it.
  await signInAsOtherMember(page);
  // A record-level refusal under the viewer's own slug: streamed, so the
  // contract is 404-or-200-never-403 plus parity against a nonexistent id
  // (expectRecordRefused), then the rendered refusal itself.
  await expectRecordRefused(
    page,
    world.otherOrgSlug,
    `network/${world.networkDraftProfileId}`,
    "draft profile",
  );
  await page.goto(`/${world.otherOrgSlug}/network/${world.networkDraftProfileId}`);
  await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();

  // THE PAIRED CONTROL, same session, same route shape: the PUBLISHED id
  // renders. So the 404 is the draft, not the route.
  await page.goto(`/${world.otherOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();
  // ...and it is the MASKED view: `contact_email` is `connections`-level and
  // this organisation has no accepted request with ALPHA.
  await expect(page.locator("main")).not.toContainText("alpha-connections@example.test");
});

test("the IDOR probe, CONNECTED: an accepted connection does not unlock the counterparty's DRAFT", async ({
  page,
}) => {
  // The interesting half. A draft is the one thing an accepted connection most
  // plausibly looks like it should unlock -- both organisations have agreed to
  // see each other, after all -- and it does not: `network_profiles_select_
  // published_directory` requires `status = 'published'` and no other policy
  // reaches another tenant's row at all.
  await signIn(page, world, "booker");
  // Same streamed refusal-and-parity contract as the unconnected probe: an
  // accepted connection does not unlock the counterparty's DRAFT.
  await expectRecordRefused(
    page,
    world.proOrgSlug,
    `network/${world.networkDraftProfileId}`,
    "draft profile (connected)",
  );
  await page.goto(`/${world.proOrgSlug}/network/${world.networkDraftProfileId}`);
  await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();

  // THE PAIRED CONTROL on the same session: the PUBLISHED profile renders, and
  // renders CONNECTED -- so the 404 above is the draft and not a viewer who
  // cannot see ALPHA at all.
  await page.goto(`/${world.proOrgSlug}/network/${world.networkAlphaProfileId}`);
  await expect(
    page.getByRole("heading", { name: world.networkAlphaProfileName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("You’re connected")).toBeVisible();
});
