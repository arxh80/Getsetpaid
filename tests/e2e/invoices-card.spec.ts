import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  cardPaymentsFor,
  countOrgAuditRows,
  INVOICE_EVENT_NAME,
  INVOICE_INCOME,
  invoiceGrossMinor,
  liveStripeAccountId,
  PRO_SUPPLIER_NAME,
  setUpWorld,
  signedWebhook,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// INVOICES, PART 2 -- the card-payment golden path, the seventh sibling of
// golden-path, events, operations, finance, network and invoices. Serial: the
// steps share one world, one linked Stripe account and one issued invoice.
// Nothing leaves the machine: STRIPE_MODE=fake, and the one redirect to
// checkout.stripe.test is read off the 303, never followed.
test.describe.configure({ mode: "serial" });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function scan(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

let world: E2eWorld;
test.beforeAll(async () => {
  world = await setUpWorld();
});
test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

// Shared by the serial steps below.
let invoiceId = "";
let invoiceNumber = "";
let token = "";
let grossMinor = 0;
const firstIntent = `pi_e2e${randomUUID().replaceAll("-", "").slice(0, 16)}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const eventId = () => `evt_e2e${randomUUID().replaceAll("-", "").slice(0, 16)}`;

async function postSigned(page: Page, event: Record<string, unknown>) {
  const { data, headers } = signedWebhook(event);
  return page.request.post("/api/stripe/webhook", { data, headers });
}

async function accountId(): Promise<string> {
  return liveStripeAccountId(world.proOrgId);
}

function paidEvent(account: string, intent: string, amount: number) {
  return {
    id: eventId(),
    type: "checkout.session.completed",
    created: nowSeconds(),
    account,
    data: {
      object: {
        id: `cs_fake_${invoiceId.replaceAll("-", "")}`,
        metadata: { invoice_id: invoiceId },
        payment_intent: intent,
        amount_total: amount,
        currency: "gbp",
        payment_status: "paid",
      },
    },
  };
}

/** The pay link a PDF carries: a plain /URI annotation (pdf-render.test.ts reads it the same way). */
function payUrlsIn(pdf: Buffer): string[] {
  return [...pdf.toString("latin1").matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]).filter((u) => u.includes("/pay/"));
}

async function downloadPdf(page: Page): Promise<Buffer> {
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  return readFile(await (await downloading).path());
}

/** One cell of the event's budget-vs-actuals table (invoices.spec.ts's helper). */
function summaryCell(page: Page, row: string, column: 0 | 1): Locator {
  return page
    .getByRole("region", { name: "Budget versus actuals", exact: true })
    .locator("tbody tr")
    .filter({ has: page.locator(`th:text-is("${row}")`) })
    .locator("td")
    .nth(column);
}

async function openAnonymous(browser: import("@playwright/test").Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

test("a Finance user links the workspace's Stripe account behind step-up, and it is audited once", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/settings/invoicing`);
  // POSITIVE CONTROL for the later refusals: before linking there is a button, and no "Connected".
  await expect(page.getByText(/^Connected on/)).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Stripe" }).click();
  // The fake's authorize URL is our own callback route. Next resolves a same-origin Server Action redirect to a
  // route handler on the server (that GET links the workspace), then the browser re-POSTs it and lands on the
  // handler's 405: a fake-only seam (the real redirect is off-site). So the link is read from the database and
  // the page reopened, not from the URL the browser was left on.
  await expect.poll(() => liveStripeAccountId(world.proOrgId).catch(() => ""), { timeout: 30_000 }).toMatch(/^acct_fake[A-Za-z0-9]+$/);
  await page.goto(`/${world.proOrgSlug}/settings/invoicing`);
  await expect(page.getByText(/^Connected on/)).toBeVisible();
  expect(await countOrgAuditRows("invoice_stripe_account.linked", world.proOrgId)).toBe(1);
});

test("an issued invoice's PDF carries the pay link", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/events/${world.invoiceEventId}`);
  await expect(page.getByRole("heading", { name: INVOICE_EVENT_NAME, level: 1 })).toBeVisible();
  const section = page.getByRole("region", { name: "Invoice these lines" });
  await section.getByLabel(new RegExp(INVOICE_INCOME.description)).check();
  await section.getByRole("button", { name: "Create draft invoice" }).click();
  await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
  await page.getByRole("combobox", { name: /^Recipient/ }).selectOption({ label: PRO_SUPPLIER_NAME });
  await page.getByLabel("Recipient address").fill("1 Supplier Street, London");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^Invoice INV-\d{4}$/);
  invoiceNumber = ((await heading.textContent()) ?? "").replace("Invoice ", "");
  invoiceId = /\/invoices\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? "";
  expect(invoiceId).not.toBe("");
  grossMinor = await invoiceGrossMinor(invoiceId);
  expect(grossMinor).toBeGreaterThan(0);

  const urls = payUrlsIn(await downloadPdf(page));
  expect(urls).toHaveLength(1);
  token = urls[0].slice(urls[0].indexOf("/pay/") + "/pay/".length);
  expect(token).toContain(invoiceId);
});

test("the recipient's pay page: not shared-cacheable, accessible, and the button hands off to Stripe -- by mouse and by keyboard", async ({ browser, baseURL }) => {
  const { context, page } = await openAnonymous(browser, baseURL);
  try {
    const response = await page.goto(`/pay/${token}`);
    const cacheControl = response?.headers()["cache-control"] ?? "";
    // The exact values payPageHeaders() sets: a page whose URL is the credential is never cached and sends no Referer.
    expect(cacheControl).toBe("no-store");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    test.info().annotations.push({ type: "cache-control", description: cacheControl });

    await expect(page.getByRole("heading", { name: `Invoice ${invoiceNumber}`, level: 1 })).toBeVisible();
    await expect(page.getByText(`£${(grossMinor / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay by card" })).toBeVisible();
    await scan(page);

    // The server's answer, read without following it (no DNS lookup ever happens).
    const direct = await page.request.post(`/pay/${token}/start`, { maxRedirects: 0 });
    expect(direct.status()).toBe(303);
    expect(direct.headers()["location"]).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    // The button itself: its form POST is answered 303 to the fake Checkout host. Chromium then refuses to follow
    // it (the fake origin is deliberately not in the CSP form-action) and reports no response, so the route
    // handler fetches the server's real answer without following it, records it, and passes it on.
    const starts: { status: number; location: string }[] = [];
    await page.route(`**/pay/${token}/start`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      starts.push({ status: response.status(), location: response.headers()["location"] ?? "" });
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Pay by card" }).click();
    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0].status).toBe(303);
    expect(starts[0].location).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\//);

    // KEYBOARD: Tab reaches the button, Enter submits it.
    await page.goto(`/pay/${token}`);
    await expect(page.getByRole("heading", { name: `Invoice ${invoiceNumber}`, level: 1 })).toBeVisible();
    await page.waitForLoadState("load");
    // Tab from the top of the document until the button has focus: the skip link and the footer are not the target.
    const payButton = page.getByRole("button", { name: "Pay by card" });
    for (let i = 0; i < 10 && !(await payButton.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(page.getByRole("button", { name: "Pay by card" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1].status).toBe(303);
    expect(starts[1].location).toMatch(/^https:\/\/checkout\.stripe\.test\/c\/pay\//);
  } finally {
    await context.close();
  }
});

test("Stripe's signed webhook marks it paid by card; the income lands on the event net of VAT", async ({ page }) => {
  const account = await accountId();
  // CONTROL FIRST: a bad signature is refused and changes nothing.
  const forged = await page.request.post("/api/stripe/webhook", {
    data: JSON.stringify(paidEvent(account, firstIntent, grossMinor)),
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
  });
  expect(forged.status()).toBe(400);
  expect(await cardPaymentsFor(invoiceId)).toEqual([]);

  const ok = await postSigned(page, paidEvent(account, firstIntent, grossMinor));
  expect(ok.status()).toBe(200);
  expect(await cardPaymentsFor(invoiceId)).toEqual([{ outcome: "applied", amount_minor: String(grossMinor), refunded_minor: "0" }]);

  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await expect(page.locator("main")).toContainText("Paid by card on");
  await expect(page.locator("main").getByText("Paid", { exact: true })).toBeVisible();

  // The pulled income flipped budgeted -> actual at its NET (£3,000), not the card's gross.
  await page.goto(`/${world.proOrgSlug}/events/${world.invoiceEventId}`);
  await expect(summaryCell(page, "Gross", 0)).toHaveText("£0.00");
  await expect(summaryCell(page, "Gross", 1)).toHaveText(INVOICE_INCOME.formatted);
  await expect(page.getByRole("region", { name: "Finance", exact: true })).toContainText(`Actual${INVOICE_INCOME.description}`);
});

test("the thanks page says so, and is accessible", async ({ browser, baseURL }) => {
  const { context, page } = await openAnonymous(browser, baseURL);
  try {
    await page.goto(`/pay/${token}/thanks`);
    await expect(page.getByRole("heading", { name: /Payment received/, level: 1 })).toBeVisible();
    await scan(page);
  } finally {
    await context.close();
  }
});

test("a tampered token and a paid invoice's token refuse alike, with no amount; only the paid one names the seller", async ({ browser, baseURL }) => {
  const { context, page } = await openAnonymous(browser, baseURL);
  try {
    const refused = page.getByRole("heading", { name: "This invoice can’t be paid online", level: 1 });
    const sellerSentence = "Contact E2E Pro Promotions Ltd to pay it.";

    await page.goto(`/pay/${token}`);
    await expect(refused).toBeVisible();
    await expect(page.getByText(sellerSentence)).toBeVisible();
    await expect(page.locator("body")).not.toContainText("£");
    await expect(page.getByRole("button", { name: "Pay by card" })).toHaveCount(0);

    // Flip the FIRST signature character (all 6 bits significant); the last one carries only 4, so flipping it can decode to the same MAC.
    const [id, sig] = token.split(".");
    const tampered = `${id}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(tampered).not.toBe(token);
    await page.goto(`/pay/${tampered}`);
    await expect(refused).toBeVisible();
    await expect(page.getByText("Check the link in your invoice email")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("£");
    await expect(page.locator("body")).not.toContainText("E2E Pro Promotions");
    await expect(page.locator("body")).not.toContainText(invoiceNumber);
    await scan(page);

    // And its POST goes nowhere near Stripe.
    const start = await page.request.post(`/pay/${token}/start`, { maxRedirects: 0 });
    expect(start.status()).toBe(303);
    expect(start.headers()["location"]).not.toMatch(/checkout\.stripe\.test/);
  } finally {
    await context.close();
  }
});

test("a second payment for the same invoice puts 'Refund it in Stripe' on the invoice page", async ({ page }) => {
  const second = `pi_e2e${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const res = await postSigned(page, paidEvent(await accountId(), second, grossMinor));
  expect(res.status()).toBe(200);
  expect((await cardPaymentsFor(invoiceId)).map((p) => p.outcome)).toEqual(["applied", "after_paid"]);

  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await expect(page.locator("main")).toContainText("Refund it in Stripe.");
});

test("a signed refund shows 'Refunded in Stripe' against the payment", async ({ page }) => {
  const res = await postSigned(page, {
    id: eventId(),
    type: "charge.refunded",
    created: nowSeconds(),
    account: await accountId(),
    data: { object: { payment_intent: firstIntent, amount_refunded: 50000 } },
  });
  expect(res.status()).toBe(200);
  expect((await cardPaymentsFor(invoiceId))[0].refunded_minor).toBe("50000");

  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/invoices/${invoiceId}`);
  await expect(page.locator("main")).toContainText("Refunded in Stripe: £500.00");
});

test("once disconnected, a newly issued invoice's PDF has no pay link", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.proOrgSlug}/settings/invoicing`);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected on")).toBeVisible();
  await expect(page.getByText(/^Connected on/)).toHaveCount(0);

  await page.goto(`/${world.proOrgSlug}/invoices/${world.proDraftInvoiceId}`);
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Invoice INV-\d{4}$/);
  const pdf = await downloadPdf(page);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(payUrlsIn(pdf)).toEqual([]);
});

test("a Starter workspace's settings page offers no Connect button; Pro's does", async ({ page }) => {
  await signIn(page, world, "finance");
  await page.goto(`/${world.starterOrgSlug}/settings/invoicing`);
  await expect(page.getByRole("heading", { name: "Invoice settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Stripe" })).toHaveCount(0);

  // POSITIVE CONTROL: the Pro workspace (disconnected above) does show it.
  await page.goto(`/${world.proOrgSlug}/settings/invoicing`);
  await expect(page.getByRole("button", { name: "Connect Stripe" })).toBeVisible();
});

test("the OAuth callback refuses a signed-out caller and a forged state alike, with no workspace and no reason", async ({ page, browser, baseURL }) => {
  const forged = "/api/stripe/connect/callback?code=fake_code_aaaaaaaa&state=forged-state-0000000000000000000000000000";
  // Signed out: the middleware bounces it to /login before the handler runs.
  const { context, page: anonymous } = await openAnonymous(browser, baseURL);
  try {
    const bounced = await anonymous.request.get(forged, { maxRedirects: 0 });
    expect([302, 307, 308]).toContain(bounced.status());
    expect(bounced.headers()["location"]).toMatch(/\/login/);
  } finally {
    await context.close();
  }

  // Signed in, but the state was never begun by this user: back to `/`, no workspace slug, no stripe= key.
  await signIn(page, world, "finance");
  const refused = await page.request.get(forged, { maxRedirects: 0 });
  expect(refused.status()).toBe(303);
  const location = new URL(refused.headers()["location"] ?? "", "http://x.test");
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
});
