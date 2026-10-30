import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  countAuditRows,
  countIssuedInvoices,
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

/** One cell of the event's budget-vs-actuals table (finance.spec.ts's helper). */
function summaryCell(page: Page, row: string, column: 0 | 1): Locator {
  return page
    .getByRole("region", { name: "Budget versus actuals", exact: true })
    .locator("tbody tr")
    .filter({ has: page.locator(`th:text-is("${row}")`) })
    .locator("td")
    .nth(column);
}

test("THE GOLDEN PATH: settings behind step-up, a draft from the event's income plus a free line, issue, PDF, paid, income on the event", async ({ page }) => {
  // A real TOTP challenge happens inside signIn (finance is MFA-required),
  // which is also the fresh credential the settings page's step-up asks for.
  await signIn(page, world, "finance");

  // ---- 1. SETTINGS (step-up) ----------------------------------------------
  await page.goto(`/${world.proOrgSlug}/settings/invoicing`);
  await page.getByLabel("Number prefix").fill("E2E-");
  await page.getByLabel("Payment terms (days)").fill("14");
  await page.getByLabel("Account number").fill("87654321");
  await page.getByRole("button", { name: "Save invoice settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // The fraud guard: a bank change is audited (and queued for the Owners/Admins).
  expect(await countAuditRows("invoice_settings.bank_details_changed", world.proOrgId)).toBe(1);

  // ---- 2. A DRAFT FROM THE EVENT'S BUDGETED INCOME --------------------------
  await page.goto(`/${world.proOrgSlug}/events/${world.invoiceEventId}`);
  await expect(summaryCell(page, "Gross", 0)).toHaveText(INVOICE_INCOME.formatted);
  await expect(summaryCell(page, "Gross", 1)).toHaveText("£0.00");
  const section = page.getByRole("region", { name: "Invoice these lines" });
  await section.getByLabel(new RegExp(INVOICE_INCOME.description)).check();
  await section.getByRole("button", { name: "Create draft invoice" }).click();
  await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();

  // ---- 3. RECIPIENT, ADDRESS, ONE FREE LINE -------------------------------
  await page.getByRole("combobox", { name: /^Recipient/ }).selectOption({ label: PRO_SUPPLIER_NAME });
  await page.getByLabel("Recipient address").fill("1 Supplier Street, London");
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Line 2 description").fill("E2E golden line — production");
  await page.getByLabel("Line 2 quantity").fill("2");
  await page.getByLabel("Line 2 unit price").fill("150");
  await page.getByLabel("Line 2 VAT").selectOption("standard_20");
  // £3,000 + £300 net, £600 + £60 VAT = £3,960.
  await expect(totals(page)).toContainText("£3,960.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();

  // ---- 4. ISSUE -----------------------------------------------------------
  await page.getByRole("button", { name: "Issue invoice" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^Invoice E2E-\d{4}$/);
  const number = ((await heading.textContent()) ?? "").replace("Invoice ", "");

  // ---- 5. THE PDF ---------------------------------------------------------
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${number}.pdf`);
  expect((await readFile(await download.path())).subarray(0, 5).toString("latin1")).toBe("%PDF-");

  // ---- 6. PAID -------------------------------------------------------------
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.locator("main").getByText("Paid", { exact: true })).toBeVisible();

  // ---- 7. THE PAYOFF: THE INCOME IS ON THE EVENT, NET OF VAT ---------------
  // The pulled £3,000 flipped budgeted -> actual; the free line's £300 net
  // (not its £360 gross) became a new actual income line.
  await page.goto(`/${world.proOrgSlug}/events/${world.invoiceEventId}`);
  await expect(summaryCell(page, "Gross", 0)).toHaveText("£0.00");
  await expect(summaryCell(page, "Gross", 1)).toHaveText("£3,300.00");
  await expect(page.getByRole("region", { name: "Finance", exact: true })).toContainText(`Invoice ${number}`);
});

test("a Starter workspace reads its draft, and its disabled Issue control refuses server-side with disabled stripped", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.starterOrgSlug}/invoices/${world.starterDraftInvoiceId}`);
  await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Line 1 description")).toHaveValue(INVOICE_FIXTURES.starterLine);
  await expect(page.locator("#invoice-blocked")).toContainText("Finance is a Pro feature");

  const issue = page.getByRole("button", { name: "Issue invoice" });
  await expect(issue).toBeDisabled();
  // HIDING UI IS NOT ENFORCEMENT: strip the attribute and submit for real.
  await issue.evaluate((button) => button.removeAttribute("disabled"));
  await issue.click();
  await expect(page.getByRole("alert").filter({ hasText: "Finance is a Pro feature" })).toBeVisible();

  // AND NOTHING WAS ISSUED: the denominator is the database, not the page.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
  expect(await countIssuedInvoices(world.starterOrgId)).toBe(0);
});

test("the line editor works from the keyboard alone", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/new`);
  await page.getByRole("button", { name: "Add line" }).focus();
  await page.keyboard.press("Enter");
  // The new row's description takes focus (the editor moves it there).
  await expect(page.getByLabel("Line 2 description")).toBeFocused();
  await page.keyboard.type("Keyboard line");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Line 2 quantity")).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("3");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Line 2 unit price")).toBeFocused();
  await page.keyboard.type("10");
  await expect(totals(page)).toContainText("£36.00"); // 3 × £10 + 20% VAT
  await page.getByRole("button", { name: "Remove line 2" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Line 2 description")).toHaveCount(0);
  await expect(totals(page)).toContainText("£0.00");
});
