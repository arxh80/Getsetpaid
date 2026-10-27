import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  countAuditRows,
  INVOICE_EVENT_NAME,
  INVOICE_FIXTURES,
  INVOICE_INCOME,
  PRO_SUPPLIER_NAME,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// INVOICES, PART 1 -- walked in a real browser. Tasks 9-13 each add their
// slice; Task 14 adds the golden path (the sixth sibling of golden-path,
// events, operations, finance and network), the Starter refusal and the
// keyboard-only line editor. Serial: the slices share one world.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;
test.beforeAll(async () => {
  world = await setUpWorld();
});
test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

function totals(page: Page) {
  return page.getByRole("region", { name: "Totals" });
}

test("a Finance user drafts an invoice, sees live totals, and saves it", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/new`);
  await expect(page.getByRole("heading", { name: "New invoice", level: 1 })).toBeVisible();

  await page.getByRole("combobox", { name: /^Recipient/ }).selectOption({ label: PRO_SUPPLIER_NAME });
  await page.getByLabel("Recipient address").fill("1 Supplier Street, London");
  await page.getByLabel("Line 1 description").fill("E2E draft line — sound hire");
  await page.getByLabel("Line 1 quantity").fill("2");
  await page.getByLabel("Line 1 unit price").fill("150.00");
  await page.getByLabel("Line 1 VAT").selectOption("standard_20");
  // 2 × £150 = £300 net, £60 VAT, £360 total -- the TS port, before any save.
  await expect(totals(page)).toContainText("£300.00");
  await expect(totals(page)).toContainText("£60.00");
  await expect(totals(page)).toContainText("£360.00");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.proOrgSlug}/invoices/[0-9a-f-]{36}$`));
  // A fresh GET: the totals now come from what the DATABASE stored.
  await page.reload();
  await expect(page.getByLabel("Line 1 description")).toHaveValue("E2E draft line — sound hire");
  await expect(totals(page)).toContainText("£360.00");

  await page.goto(`/${world.proOrgSlug}/invoices`);
  await expect(page.getByRole("main")).toContainText("£360.00");
  await expect(page.getByRole("main")).toContainText(INVOICE_FIXTURES.issuedNumber);
});

test("issuing the planted draft takes the workspace's next number, freezes it, and downloads as <number>.pdf", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${world.proDraftInvoiceId}`);
  await page.getByRole("button", { name: "Issue invoice" }).click();
  // The counter starts at 1: the planted FIX-0001 never came from it.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoice INV-0001");
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Invoice lines" })).toContainText(INVOICE_FIXTURES.draftLine);

  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("INV-0001.pdf");
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // AUDITED BEFORE A BYTE WAS SENT: exactly one row for this download.
  expect(await countAuditRows("invoice.pdf_downloaded", world.proDraftInvoiceId)).toBe(1);
});

test("the planted issued invoice is marked paid, then voided -- keeping its number, losing its actions", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${world.proIssuedInvoiceId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Invoice ${INVOICE_FIXTURES.issuedNumber}`);

  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.locator("main").getByText("Paid", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send invoice" })).toHaveCount(1);

  await page.getByLabel("Reason for voiding").fill("E2E wrong amount");
  await page.getByRole("button", { name: "Void invoice" }).click();
  await expect(page.locator("main").getByText("Void", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Invoice ${INVOICE_FIXTURES.issuedNumber}`);
  await expect(page.locator("main")).toContainText("Voided: E2E wrong amount");
  await expect(page.getByRole("button", { name: "Void invoice" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send invoice" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(1);
});

test("ticking an event's income line creates a draft with that line pulled in and linked", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/events/${world.invoiceEventId}`);
  await expect(page.getByRole("heading", { name: INVOICE_EVENT_NAME, level: 1 })).toBeVisible();
  const section = page.getByRole("region", { name: "Invoice these lines" });
  await section.getByLabel(new RegExp(INVOICE_INCOME.description)).check();
  await section.getByRole("button", { name: "Create draft invoice" }).click();

  await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Line 1 description")).toHaveValue(INVOICE_INCOME.description);
  await expect(page.getByLabel("Line 1 quantity")).toHaveValue("1.00");
  await expect(page.getByLabel("Line 1 unit price")).toHaveValue(/^3,?000\.00$/);
  await expect(page.locator("main")).toContainText("From event finance");
  // No recipient yet: the user picks one (spec § Screens 3).
  await expect(page.getByRole("combobox", { name: /^Recipient/ })).toHaveValue("");
});
