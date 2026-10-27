import { expect, test, type Page } from "@playwright/test";
import {
  INVOICE_FIXTURES,
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
