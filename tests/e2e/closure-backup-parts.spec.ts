import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  countExportDownloadAudit,
  exportDownloadParts,
  plantOwnerClosedWorkspace,
  plantReadyAccountExport,
  deleteExportJobAndArchive,
  removeOrganisations,
  removePlantedBackup,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { CLOSURE_BACKUP_FAILED_LINE, PARTS_TOGETHER_LINE } from "../../lib/org/closure-contract";

// Q228 Task 4 -- the Owner's closure page lists every backup part and offers
// "Contact us" when the backup failed.
//
// DENOMINATORS: Contact us is absent on a SUCCEEDED backup and for a Manager
// of the FAILED one (so its presence is the failure and the role, not the
// page); a single-part export still renders "Download the archive" and no
// parts list; the download refusals are compared with a ghost job id.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;
let failed: { id: string; slug: string; backupJobId: string };
let twoPart: { id: string; slug: string; backupJobId: string };
let ordinaryJobId: string | null = null;

test.beforeAll(async () => {
  world = await setUpWorld();
  const member = { id: world.users.manager.id, name: "E2E Part Member" };
  failed = await plantOwnerClosedWorkspace("bf", world.users.owner, member, { backup: "failed" });
  twoPart = await plantOwnerClosedWorkspace("bp", world.users.owner, member, { backup: "two_parts" });
});

test.afterAll(async () => {
  try {
    if (twoPart) await removePlantedBackup(twoPart.backupJobId);
    if (ordinaryJobId) await deleteExportJobAndArchive(ordinaryJobId);
    await removeOrganisations([failed?.id, twoPart?.id].filter((x): x is string => Boolean(x)));
  } finally {
    if (world) await tearDownWorld(world);
  }
});

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("a failed closure backup offers Contact us to the Owner only", async ({ page, browser }) => {
  await signIn(page, world, "owner");
  await page.goto(`/${failed.slug}/settings/export`);
  const box = page.getByTestId("closure-backup-failed");
  await expect(box).toContainText(CLOSURE_BACKUP_FAILED_LINE);
  const link = page.getByRole("link", { name: "Contact us" });
  await expect(link).toHaveCount(1);
  // Either the configured mailto, or the contact page when none is configured.
  const href = (await link.getAttribute("href")) ?? "";
  if (href.startsWith("mailto:")) {
    const subject = decodeURIComponent(href.split("subject=")[1] ?? "");
    expect(subject).toContain(failed.slug);
    expect(subject).toContain(failed.backupJobId);
  } else {
    expect(href).toBe("/legal/contact");
  }
  await scan(page);

  // DENOMINATOR: a succeeded backup shows no Contact us.
  await page.goto(`/${twoPart.slug}/settings/export`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact us" })).toHaveCount(0);

  // The Manager of the failed workspace: the page renders, no Contact us.
  const ctx = await browser.newContext();
  const mpage = await ctx.newPage();
  try {
    await signIn(mpage, world, "manager");
    await mpage.goto(`/${failed.slug}/settings/export`);
    await expect(mpage.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
    await expect(mpage.getByRole("link", { name: "Contact us" })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("a two-part backup lists both parts, downloads one audited, and refuses forgeries identically", async ({
  page,
  browser,
}) => {
  const job = twoPart.backupJobId;
  await signIn(page, world, "owner");
  await page.goto(`/${twoPart.slug}/settings/export`);
  const links = page.getByTestId("export-part-download");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveText(/^Part 1 of 2/);
  await expect(links.nth(1)).toHaveText(/^Part 2 of 2/);
  // Each link is the authorised download route for ITS part.
  await expect(links.nth(0)).toHaveAttribute("href", `/account/exports/${job}/download?part=1`);
  await expect(links.nth(1)).toHaveAttribute("href", `/account/exports/${job}/download?part=2`);
  await expect(page.getByText(PARTS_TOGETHER_LINE(2))).toBeVisible();
  await scan(page);

  const before = await countExportDownloadAudit(job);
  const ok = await page.request.get(`/account/exports/${job}/download?part=2`, { maxRedirects: 0 });
  expect(ok.status()).toBe(302);
  expect(ok.headers()["location"] ?? "").toMatch(/^https?:\/\/[^/]+\/storage\/v1\/object\/sign\//);
  expect(await countExportDownloadAudit(job)).toBe(before + 1);
  expect((await exportDownloadParts(job)).at(-1)).toBe(2);

  // 404 parity.
  const ghost = await page.request.get(
    `/account/exports/00000000-0000-4000-8000-000000000000/download?part=2`,
    { maxRedirects: 0 },
  );
  expect(ghost.status()).toBe(404);
  const ghostBody = await ghost.text();
  expect(ghostBody).toBe("Not found");
  const afterOk = await countExportDownloadAudit(job);
  for (const q of ["0", "3", "abc", "", "-1"]) {
    const r = await page.request.get(`/account/exports/${job}/download?part=${q}`, { maxRedirects: 0 });
    expect(r.status(), `?part=${q}`).toBe(404);
    expect(await r.text(), `?part=${q}`).toBe(ghostBody);
  }
  expect(await countExportDownloadAudit(job)).toBe(afterOk);

  // T7: a colleague of the same workspace cannot download the Owner's part.
  const ctx = await browser.newContext();
  const mpage = await ctx.newPage();
  try {
    await signIn(mpage, world, "manager");
    const stolen = await mpage.request.get(`/account/exports/${job}/download?part=2`, { maxRedirects: 0 });
    expect(stolen.status(), "a colleague downloaded the Owner's part").toBe(404);
    expect(await stolen.text()).toBe(ghostBody);
    expect(await countExportDownloadAudit(job)).toBe(afterOk);
  } finally {
    await ctx.close();
  }
});

test("a single-part export is exactly as before: one Download the archive link, no parts list", async ({
  page,
}) => {
  // A real ordinary job of the Owner's, on a workspace they may export. The
  // plant is an ACCOUNT export, so list it on the account page.
  ordinaryJobId = await plantReadyAccountExport(world.users.owner.id);
  await signIn(page, world, "owner");
  await page.goto("/account/exports");
  await expect(page.getByTestId("export-download")).toHaveCount(1);
  await expect(page.getByText("Download the archive")).toBeVisible();
  await expect(page.getByTestId("export-part-download")).toHaveCount(0);
  await expect(page.getByText(/parts together are the whole backup/)).toHaveCount(0);
});
