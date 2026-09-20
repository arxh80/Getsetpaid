import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  clearExportState,
  countExportDownloadAudit,
  expireExportArchive,
  exportJobsFor,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 4: THE TWO EXPORTS, THROUGH A BROWSER.
//
// supabase/tests/rls_phase8_exports.sql proves the register (attribution, the
// permission, the meters, the IDOR and expiry gates, the woken fulfilment
// seam); tests/integration/export/runner.test.ts opens the archive and reads
// what is in it. What only a browser can show:
//
//   1. THE WHOLE ASYNC LOOP CLOSES. A person presses a button, the page says
//      the export has started, the work happens OUTSIDE the request, and a
//      later load of the same page offers a download link. Nothing short of a
//      real server can show that the post-response nudge runs at all.
//   2. THE DOWNLOAD RESOLVES TO REAL BYTES -- a 302 to a signed URL that
//      serves a zip -- and is AUDITED, with the audit count read out of
//      Postgres around the request.
//   3. THE TWO CONTROLLERS ARE TWO PAGES, and each says honestly what it does
//      not contain.
//   4. IDOR AND EXPIRY REFUSE IN A REAL SESSION: a colleague with the same
//      workspace role cannot download somebody else's archive, and an expired
//      one refuses its own requester -- both as an indistinguishable 404.
//   5. A STANDARD USER IS REFUSED, and the refusal is the server's: the
//      control is not rendered, and their attempt at the download route for
//      the Owner's real archive 404s.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) {
    await clearExportState(Object.values(world.users).map((u) => u.id));
    await tearDownWorld(world);
  }
});

/**
 * Reload until the export is ready, or fail saying what state it stuck in.
 *
 * THE WAIT IS THE POINT, not an inconvenience: "async and bounded" means the
 * archive is NOT built inside the request that asked for it, so a page that
 * showed a download link immediately would mean the requirement was not met.
 */
async function waitForReady(page: Page, url: string, userId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(url);
        const jobs = await exportJobsFor(userId);
        return jobs[0]?.status ?? "none";
      },
      {
        timeout: 90_000,
        intervals: [1_000, 2_000, 3_000],
        message: "the export never left the queue -- the post-response nudge did not run",
      },
    )
    .toBe("succeeded");
  await expect(page.getByTestId("export-download")).toBeVisible();
}

test("a person exports their own account data, waits for it, and downloads real bytes", async ({
  page,
}) => {
  const manager = world.users.manager;
  expect(await exportJobsFor(manager.id), "the Manager starts with no exports").toEqual([]);

  await signIn(page, world, "manager");
  await page.goto("/account/exports");

  // The page is honest about the split BEFORE anything is pressed.
  await expect(page.getByRole("heading", { level: 1, name: "A copy of your data" })).toBeVisible();
  await expect(
    page.getByText("It does not contain a workspace’s records", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("no-exports")).toBeVisible();

  await page.getByRole("button", { name: "Export my account data" }).click();

  // The confirmation survives the re-render its own action caused -- the bug
  // this phase shipped three times, and the reason <ActionOutcome> exists.
  await expect(page.getByTestId("export-outcome")).toContainText("Your export has started");

  await waitForReady(page, "/account/exports", manager.id);

  const [job] = await exportJobsFor(manager.id);
  expect(job.kind).toBe("account");
  expect(job.organisation_id, "an account export must belong to no workspace").toBeNull();
  expect(Number(job.byte_size)).toBeGreaterThan(0);
  expect(Number(job.row_count)).toBeGreaterThan(0);

  // AXE, WITH A FINISHED JOB ON THE PAGE -- the state that has the status
  // chip, the counts, the download link and the withheld disclosure in the
  // tree. An empty-state scan would reach none of them.
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

  // THE DOWNLOAD. page.request shares the browser's cookies and follows the
  // 302, so this is the real route, the real audit and the real signed URL.
  expect(await countExportDownloadAudit(job.id)).toBe(0);
  const response = await page.request.get(`/account/exports/${job.id}/download`);
  expect(response.status()).toBe(200);
  const body = await response.body();
  expect(body.length).toBeGreaterThan(0);
  expect(body.subarray(0, 2).toString("latin1"), "that is not a zip").toBe("PK");
  expect(
    await countExportDownloadAudit(job.id),
    "the download was not audited -- no audit row must mean no URL",
  ).toBe(1);
});

test("an Owner exports the workspace after step-up, and a colleague cannot download it", async ({
  page,
  browser,
}) => {
  const owner = world.users.owner;
  const url = `/${world.orgSlug}/settings/export`;

  // The Owner is MFA-required, so this sign-in walks the real TOTP challenge
  // -- which is also what satisfies the step-up gate: a credential presented
  // within the last five minutes.
  await signIn(page, world, "owner");
  await page.goto(url);

  await expect(page.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
  await expect(
    page.getByText("It is built with YOUR access, not with everybody’s", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Export this workspace" }).click();
  await expect(page.getByTestId("export-outcome")).toContainText("Your export has started");

  await waitForReady(page, url, owner.id);

  const [job] = await exportJobsFor(owner.id);
  expect(job.kind).toBe("workspace");
  expect(job.organisation_id).toBe(world.orgId);

  const ownerDownload = await page.request.get(`/account/exports/${job.id}/download`);
  expect(ownerDownload.status()).toBe(200);
  expect((await ownerDownload.body()).subarray(0, 2).toString("latin1")).toBe("PK");

  // ---- THE ADMIN OF THE SAME WORKSPACE, in their own browser context -----
  // They hold `export_organisation_data` too. They still cannot download the
  // Owner's archive, and cannot even see that it exists: an archive is a
  // snapshot taken under ONE person's access rights.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await signIn(adminPage, world, "admin");
    await adminPage.goto(url);
    await expect(
      adminPage.getByTestId("no-exports"),
      "the Admin can see that a colleague exported the workspace",
    ).toBeVisible();

    const stolen = await adminPage.request.get(`/account/exports/${job.id}/download`);
    expect(stolen.status(), "an Admin downloaded a colleague's archive").toBe(404);
  } finally {
    await adminContext.close();
  }

  // Still exactly one audited download: the refusals wrote none.
  expect(await countExportDownloadAudit(job.id)).toBe(1);

  // ---- EXPIRY, read-time -------------------------------------------------
  await expireExportArchive(job.id);
  const expired = await page.request.get(`/account/exports/${job.id}/download`);
  expect(expired.status(), "an expired archive was still served").toBe(404);
  expect(
    await countExportDownloadAudit(job.id),
    "a refused download wrote an audit row",
  ).toBe(1);

  await page.goto(url);
  await expect(page.getByText("This archive has expired", { exact: false })).toBeVisible();
  await expect(page.getByTestId("export-download")).toHaveCount(0);
});

test("a Standard User is refused the workspace export, server-side", async ({ page }) => {
  const owner = world.users.owner;
  const [ownerJob] = await exportJobsFor(owner.id);
  expect(ownerJob, "DENOMINATOR: there is a real archive for them to fail to reach").toBeTruthy();

  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/settings/export`);

  // The page renders -- a 404 would imply the feature does not exist -- and
  // says who can do it. The CONTROL is what the permission gates.
  await expect(page.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
  await expect(page.getByText("Only an Owner or an Admin of", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export this workspace" })).toHaveCount(0);

  // ...and the refusal is the SERVER's: the Owner's real archive 404s for
  // them, indistinguishably from one that does not exist.
  const stolen = await page.request.get(`/account/exports/${ownerJob.id}/download`);
  expect(stolen.status()).toBe(404);
  const invented = await page.request.get(
    "/account/exports/00000000-0000-4000-8000-000000000000/download",
  );
  expect(invented.status(), "a real archive and an invented one must refuse alike").toBe(404);

  // Their OWN account export is not gated at all -- the statutory route must
  // not be the only route, and a Standard User has the same rights as anyone.
  await page.goto("/account/exports");
  await expect(page.getByRole("button", { name: "Export my account data" })).toBeEnabled();
});
