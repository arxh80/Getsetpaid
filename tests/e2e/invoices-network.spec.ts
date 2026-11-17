import { expect, test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  countAuditRows,
  DELIVERY_COMPANY_NAME,
  enrolTotp,
  liveDeliveryId,
  setUpWorld,
  tearDownWorld,
  type E2eRole,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signInByEmail } from "./support/sign-in";

// INVOICES, PART 3 -- NETWORK DELIVERY, walked in a real browser. The seventh
// sibling of the golden path: the Pro workspace's Finance user drafts and
// issues an invoice to a company it has linked to a connected workspace's
// profile, delivers it, and the RECEIVING workspace's Owner reads it in the
// inbox and downloads the PDF; then the sender withdraws it and the receiver's
// page becomes not-found. Serial: the steps share one world and one invoice.
test.describe.configure({ mode: "serial" });

// The Pro workspace's planted invoice_settings.business_name (fixtures.ts).
const SENDER_BUSINESS_NAME = "E2E Pro Promotions Ltd";
const DELIVER_REGION = "Deliver in GetSetPaid";

let world: E2eWorld;
let invoiceId = "";
let invoiceNumber = "";
let deliveryId = "";

test.beforeAll(async () => {
  world = await setUpWorld();
});
test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  // Non-vacuity: a scan that evaluated nothing would also report no violations.
  expect(results.passes.length).toBeGreaterThan(0);
  expect(results.violations).toEqual([]);
}

/** Tab (and only Tab) until the named button has focus, then press Enter. */
async function pressByKeyboard(page: Page, name: string) {
  const target = page.getByRole("button", { name, exact: true });
  await expect(target).toBeVisible();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");
}

/** A page in its own fresh context, signed in as one role (a session is per context). */
async function pageAs(browser: Browser, role: E2eRole): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, world, role);
  return page;
}

async function expectNotFound(page: Page, url: string) {
  const response = await page.goto(url);
  expect([200, 404], `${url} must refuse as 404 or a streamed not-found`).toContain(response?.status() ?? -1);
  expect(page.url()).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
}

test("the sender issues an invoice to a linked company", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/new`);
  await expect(page.getByRole("heading", { name: "New invoice", level: 1 })).toBeVisible();
  await page.getByRole("combobox", { name: /^Recipient/ }).selectOption({ label: DELIVERY_COMPANY_NAME });
  await page.getByLabel("Recipient address").fill("1 Customer Street, Bristol");
  await page.getByLabel("Line 1 description").fill("E2E network line: stage build");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 unit price").fill("150.00");
  await page.getByLabel("Line 1 VAT").selectOption("standard_20");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.proOrgSlug}/invoices/[0-9a-f-]{36}$`));
  invoiceId = page.url().split("/").pop() ?? "";

  await page.getByRole("button", { name: "Issue invoice" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^Invoice \S+$/);
  invoiceNumber = ((await heading.textContent()) ?? "").replace(/^Invoice /, "");
  expect(invoiceNumber).not.toBe("");
});

test("the sender delivers it in GetSetPaid, keyboard only", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await expect(page.getByRole("region", { name: DELIVER_REGION })).toBeVisible();

  await pressByKeyboard(page, `Deliver to ${world.networkAlphaProfileName}`);
  await expect(page.getByTestId("delivery-outcome")).toContainText("Delivered");
  await expect(page.getByText(`Delivered to ${world.networkAlphaProfileName} on`)).toBeVisible();

  deliveryId = await liveDeliveryId(invoiceId);
  expect(deliveryId).not.toBe("");
  expect(await countAuditRows("invoice.delivered", deliveryId)).toBe(1);
  await scan(page);
});

test("an invoice to a contact shows no delivery control", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${world.proIssuedInvoiceId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Invoice /);
  await expect(page.getByRole("region", { name: DELIVER_REGION })).toHaveCount(0);
  // Control: the delivered invoice's page, which step 2 showed the region on, still has it.
  await page.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await expect(page.getByRole("region", { name: DELIVER_REGION })).toBeVisible();
});

test("the receiver reads it in the inbox, opens it and downloads the PDF", async ({ page }) => {
  await signIn(page, world, "owner");
  await page.goto(`/${world.orgSlug}`);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Received" })).toBeVisible();

  await page.goto(`/${world.orgSlug}/invoices/received`);
  await expect(page.getByRole("heading", { name: "Received invoices", level: 1 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: invoiceNumber });
  await expect(row).toContainText(SENDER_BUSINESS_NAME);
  await expect(row.locator("span.tabular-nums", { hasText: "£360.00" })).toBeVisible();
  await scan(page);

  await row.getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByRole("heading", { name: `Invoice ${invoiceNumber}`, level: 1 })).toBeVisible();
  await expect(page.getByText(/^From /)).toBeVisible();
  await scan(page);

  const pdf = await page.request.get(`/${world.orgSlug}/invoices/received/${deliveryId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect(await countAuditRows("invoice.received_pdf_downloaded", deliveryId)).toBe(1);
});

test("refusal parity on the received routes", async ({ browser }) => {
  // An empty id would make every refusal below pass for the wrong reason.
  expect(deliveryId).not.toBe("");
  // The sender is not the recipient of its own delivery.
  const finance = await pageAs(browser, "finance");
  const senderSide = `/${world.proOrgSlug}/invoices/received/${deliveryId}`;
  await expectNotFound(finance, senderSide);
  expect((await finance.request.get(`${senderSide}/pdf`)).status()).toBe(404);

  // A member of the receiving workspace without view_finance.
  const manager = await pageAs(browser, "manager");
  const receiverSide = `/${world.orgSlug}/invoices/received/${deliveryId}`;
  await expectNotFound(manager, receiverSide);
  await expectNotFound(manager, `/${world.orgSlug}/invoices/received`);
  expect((await manager.request.get(`${receiverSide}/pdf`)).status()).toBe(404);

  // Control: the receiving Owner reaches the very same URLs, so neither
  // refusal above is a missing fixture.
  const owner = await pageAs(browser, "owner");
  expect((await owner.goto(receiverSide))?.status()).toBe(200);
  await expect(owner.getByRole("heading", { name: `Invoice ${invoiceNumber}`, level: 1 })).toBeVisible();
  expect((await owner.request.get(`${receiverSide}/pdf`)).status()).toBe(200);
});

test("an outsider who belongs to neither workspace cannot reach the delivery, under any slug", async ({ browser }) => {
  expect(deliveryId).not.toBe("");
  // otherOwner is the Owner (so holds view_finance) of a THIRD workspace; only
  // the delivery id is foreign to them. Enrolled here: the world gives it no TOTP secret.
  const page = await (await browser.newContext()).newPage();
  await signInByEmail(page, world.otherOwner.email, await enrolTotp(world.otherOwner.email));

  // Positive control: under their own slug the inbox renders for them (200, empty).
  expect((await page.goto(`/${world.otherOrgSlug}/invoices/received`))?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "No invoices received yet" })).toBeVisible();

  // The real delivery id under their own slug: record-level not-found, and a 404 PDF.
  const ownSlug = `/${world.otherOrgSlug}/invoices/received/${deliveryId}`;
  await expectNotFound(page, ownSlug);
  expect((await page.request.get(`${ownSlug}/pdf`)).status()).toBe(404);

  // The receiving workspace's slug: not a member, so the workspace-level literal 404.
  const receiverSlug = `/${world.orgSlug}/invoices/received/${deliveryId}`;
  expect((await page.goto(receiverSlug))?.status()).toBe(404);
  await expect(page.locator("body")).toContainText("Page not found");
  expect((await page.request.get(`${receiverSlug}/pdf`)).status()).toBe(404);
  // (Same-shape control: alpha's Owner gets 200 on this very URL and its /pdf in the previous test.)
});

test("the sender withdraws it and the receiver sees not-found", async ({ browser }) => {
  const finance = await pageAs(browser, "finance");
  await finance.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await pressByKeyboard(finance, "Withdraw");
  await expect(finance.getByTestId("delivery-outcome")).toContainText("Withdrawn");
  await expect(finance.getByRole("button", { name: `Deliver to ${world.networkAlphaProfileName}` })).toBeVisible();

  const owner = await pageAs(browser, "owner");
  await expectNotFound(owner, `/${world.orgSlug}/invoices/received/${deliveryId}`);
  await owner.goto(`/${world.orgSlug}/invoices/received`);
  await expect(owner.getByRole("heading", { name: "No invoices received yet" })).toBeVisible();
});
