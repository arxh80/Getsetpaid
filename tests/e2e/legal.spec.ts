import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  legalAuditRows,
  legalDocumentVersions,
  restoreLegalDocumentSeed,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";
// RELATIVE, not `@/`: Playwright's transform does not resolve the alias, and
// these three modules import nothing, so they load as they are.
import { LEGAL_DOCUMENTS } from "../../lib/legal/documents";
import { SUB_PROCESSORS } from "../../lib/legal/sub-processors";
import { BROWSER_STORAGE } from "../../lib/legal/storage-inventory";

// PHASE 8 TASK 1: THE FIFTEEN LEGAL PAGES, THROUGH A REAL BROWSER.
//
// ===========================================================================
// WHAT ONLY THIS FILE CAN SEE
// ===========================================================================
// supabase/tests/rls_phase8_legal.sql proves the store: the public read, the
// immutability, the grammar, the audit trail. It cannot see:
//   1. that a SIGNED-OUT browser reaches every page at all (the middleware's
//      PUBLIC_PATHS) and that each page renders ITS OWN document -- a 200
//      carrying an empty shell, or fifteen URLs rendering one document, would
//      satisfy every status-code check;
//   2. that adding /legal to PUBLIC_PATHS did not make a NEIGHBOUR public;
//   3. that the operator's editor actually drafts, publishes and records a
//      review, and that the next visitor reads the result with no deploy;
//   4. that the draft notice appears and disappears on the real page.
//
// THE DENOMINATOR RULE (progress.md, standing lesson 1): every page this file
// scans or asserts on is first proved to have rendered its DOCUMENT -- its own
// <h1>, its version line, and a section heading from its body -- before any
// absence is trusted or axe is run.

test.describe.configure({ mode: "serial" });

// The document the golden walk revises. Its seeded version 1 is restored in
// afterAll, whatever happened.
const WALK_SLUG = "ai-use";
const WALK_TITLE = "AI Use Policy";

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) {
    await restoreLegalDocumentSeed(WALK_SLUG, world.superuser.id);
    await tearDownWorld(world);
  }
});

async function signInAsSuperuser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const heading = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(heading).toBeVisible();
  await page.locator('input[name="code"]').fill(totpCode(world.superuserTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

/** The page rendered ITS document: title as <h1>, a version line, a body. */
async function expectDocumentRendered(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.getByTestId("legal-version")).toContainText(/Version \d+ · Effective \d{2} \p{L}{3,4} \d{4}/u);
  const body = page.getByTestId("legal-body");
  await expect(body).toBeVisible();
  // At least one section heading FROM THE STORED TEXT -- not the shell's.
  await expect(body.getByRole("heading", { level: 2 }).first()).toBeVisible();
}

async function scan(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(results.passes.length, `${label}: axe evaluated nothing`).toBeGreaterThan(0);
  expect(
    results.violations.map((v) => `${label}: ${v.id} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`),
  ).toEqual([]);
}

// ===========================================================================
// SIGNED OUT
// ===========================================================================
test("signed out, every one of the fifteen pages renders its own document and the draft notice", async ({
  page,
}) => {
  expect(LEGAL_DOCUMENTS).toHaveLength(15);
  const seenHeadings = new Set<string>();
  for (const doc of LEGAL_DOCUMENTS) {
    const response = await page.goto(`/legal/${doc.slug}`);
    expect(response?.status(), `/legal/${doc.slug}`).toBe(200);
    expect(page.url(), `/legal/${doc.slug} bounced a signed-out visitor`).not.toMatch(/\/login/);
    await expectDocumentRendered(page, doc.title);
    await expect(page).toHaveTitle(`${doc.title} · GetSetPaid`);
    // Every seeded version is unreviewed, so every page must say so.
    await expect(page.getByTestId("legal-draft-notice")).toBeVisible();
    await expect(page.getByTestId("legal-draft-notice")).toContainText("Pending legal review.");
    // No placeholder leaks through unrendered.
    await expect(page.getByTestId("legal-body")).not.toContainText("{{");
    // Fifteen DIFFERENT documents, not one document fifteen times.
    const first = await page.getByTestId("legal-body").getByRole("heading", { level: 2 }).first().innerText();
    seenHeadings.add(`${doc.slug}:${first}`);
  }
  expect(seenHeadings.size).toBe(15);
});

test("signed out, the index and the sign-in page's footer both list all fifteen", async ({ page }) => {
  await page.goto("/legal");
  await expect(page.getByRole("heading", { level: 1, name: "Legal" })).toBeVisible();
  const main = page.locator("main");
  for (const doc of LEGAL_DOCUMENTS) {
    await expect(main.getByRole("link", { name: doc.title, exact: true })).toHaveAttribute(
      "href",
      `/legal/${doc.slug}`,
    );
  }

  await page.goto("/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  const footer = page.getByRole("navigation", { name: "Legal" });
  await expect(footer.getByRole("link")).toHaveCount(15);
  await footer.getByRole("link", { name: "Privacy Notice", exact: true }).click();
  await expect(page).toHaveURL(/\/legal\/privacy$/);
  await expectDocumentRendered(page, "Privacy Notice");
});

test("signed out, /legal's neighbours still require a session", async ({ page }) => {
  // POSITIVE CONTROL: a legal page answers without a redirect.
  const open = await page.request.get("/legal/terms", { maxRedirects: 0 });
  expect(open.status()).toBe(200);
  // ...and an unknown legal slug is a plain 404, not a bounce.
  const missing = await page.request.get("/legal/not-a-page", { maxRedirects: 0 });
  expect(missing.status()).toBe(404);

  for (const path of ["/legalese", "/legal-hold", "/super/legal", "/super", "/legal/..%2F..%2Fsuper/legal"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect([307, 308, 404], `${path}: ${response.status()}`).toContain(response.status());
    if (response.status() !== 404) {
      expect(response.headers().location, `${path} must bounce to sign-in`).toMatch(/\/login/);
    }
  }
  // The two that MUST redirect (they exist, and a 404 there would hide a
  // page that is being served to nobody for the wrong reason).
  for (const path of ["/legalese", "/super/legal"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(307);
    expect(response.headers().location).toMatch(/\/login\?next=/);
  }
  // And a browser actually following it ends at the form, not the editor.
  await page.goto("/super/legal");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { level: 1, name: "Legal documents" })).toHaveCount(0);
});

test("the generated parts render from code: the storage table, the subprocessor table, the contact", async ({
  page,
}) => {
  await page.goto("/legal/cookies");
  await expectDocumentRendered(page, "Cookie Policy");
  const storage = page.getByRole("region", { name: "Cookies and browser storage set by GetSetPaid" });
  await expect(storage.locator("tbody tr")).toHaveCount(BROWSER_STORAGE.length);
  for (const item of BROWSER_STORAGE) {
    await expect(storage).toContainText(item.name);
  }

  await page.goto("/legal/subprocessors");
  await expectDocumentRendered(page, "Subprocessors");
  const vendors = page.getByRole("region", { name: "Subprocessors" });
  await expect(vendors.locator("tbody tr")).toHaveCount(SUB_PROCESSORS.length);
  for (const vendor of SUB_PROCESSORS) {
    await expect(vendors).toContainText(vendor.name);
  }
  await expect(vendors).toContainText("Not yet signed");
  // Founder 2026-09-30: the database region is named (Q145) and the
  // application host's region is PENDING, never guessed (Q142).
  await expect(vendors).toContainText("data hosted in Ireland (eu-west-1)");
  await expect(vendors).toContainText("IONOS SE");
  await expect(vendors).toContainText("server region PENDING");
  await expect(vendors).not.toContainText("(deployment setting)");

  // The contact is configuration, not stored text: EITHER a mailto link OR
  // the sentence saying none is configured -- exactly one, never the raw
  // placeholder, never an empty link.
  for (const slug of ["contact", "vulnerability-disclosure"]) {
    await page.goto(`/legal/${slug}`);
    await expect(page.getByTestId("legal-body")).toBeVisible();
    const link = page.getByTestId("support-contact");
    const unset = page.getByTestId("support-contact-unset");
    const counts = [await link.count(), await unset.count()];
    expect(counts[0] + counts[1], `${slug}: no contact rendered at all`).toBeGreaterThan(0);
    expect(counts[0] === 0 || counts[1] === 0, `${slug}: both shapes at once`).toBe(true);
    if (counts[0] > 0) {
      await expect(link.first()).toHaveAttribute("href", /^mailto:[^\s]+@[^\s]+$/);
    } else {
      await expect(unset.first()).toContainText("no contact address has been configured");
    }
    await expect(page.getByTestId("legal-body")).not.toContainText("{{support_email}}");
  }
});

test("signed out, representative legal pages have no automated accessibility violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const doc of [
    { slug: "privacy", title: "Privacy Notice" },
    { slug: "cookies", title: "Cookie Policy" },
    { slug: "subprocessors", title: "Subprocessors" },
    { slug: "contact", title: "Contact and Complaints" },
  ]) {
    await page.goto(`/legal/${doc.slug}`);
    await expectDocumentRendered(page, doc.title);
    await expect(page.getByTestId("legal-draft-notice")).toBeVisible();
    // 320px: the page itself must not scroll sideways (WCAG 1.4.10); only the
    // tables' own focusable regions may.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `/legal/${doc.slug} scrolls horizontally at 320px`).toBeLessThanOrEqual(0);
    await scan(page, `/legal/${doc.slug} @320`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/legal");
  await expect(page.getByRole("heading", { level: 1, name: "Legal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service", exact: true }).first()).toBeVisible();
  await scan(page, "/legal");
});

// ===========================================================================
// SIGNED IN
// ===========================================================================
test("signed in, the app footer links to the legal pages, which read the same", async ({ page }) => {
  await signIn(page, world, "manager");
  await page.goto(`/${world.orgSlug}`);
  const link = page.getByRole("link", { name: "Legal and privacy" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/legal$/);
  await expect(page.getByRole("heading", { level: 1, name: "Legal" })).toBeVisible();
  await page.goto("/legal/terms");
  await expectDocumentRendered(page, "Terms of Service");
  await expect(page.getByTestId("legal-draft-notice")).toBeVisible();
});

// ===========================================================================
// THE GOLDEN WALK: DRAFT -> PUBLISH -> THE PUBLIC PAGE CHANGES -> REVIEW
// ===========================================================================
test("the superuser drafts, publishes and records counsel's review, and the public page follows each step", async ({
  browser,
}) => {
  const operatorContext = await browser.newContext();
  const visitorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const visitor = await visitorContext.newPage();
  const marker = `E2E revision ${world.orgSlug}`;
  const reviewer = `E2E Counsel ${world.orgSlug} LLP`;

  try {
    // ---- BEFORE: the seeded version, unreviewed, read signed out ----------
    const before = await legalDocumentVersions(WALK_SLUG);
    expect(before.map((v) => `${v.version}:${v.status}`)).toEqual(["1:published"]);
    await visitor.goto(`/legal/${WALK_SLUG}`);
    await expectDocumentRendered(visitor, WALK_TITLE);
    await expect(visitor.getByTestId("legal-version")).toContainText("Version 1 ·");
    await expect(visitor.getByTestId("legal-draft-notice")).toBeVisible();

    // ---- THE EDITOR LIST ----------------------------------------------------
    await signInAsSuperuser(operator);
    await operator.goto("/super");
    await operator.getByRole("link", { name: "Legal documents", exact: true }).click();
    await expect(operator.getByRole("heading", { level: 1, name: "Legal documents" })).toBeVisible();
    const list = operator.getByRole("region", { name: "Legal documents" });
    await expect(list.locator("tbody tr")).toHaveCount(15);
    await expect(list.getByText("Not reviewed")).toHaveCount(15);
    await scan(operator, "/super/legal (list)");

    // ---- DRAFT ----------------------------------------------------------------
    await list.getByRole("link", { name: WALK_TITLE, exact: true }).click();
    await expect(operator).toHaveURL(new RegExp(`/super/legal\\?doc=${WALK_SLUG}$`));
    await operator.getByRole("button", { name: "Start a new draft" }).click();
    await expect(operator.getByText("Draft created from the current version.")).toBeVisible();
    await expect(operator.getByRole("heading", { name: "Draft — version 2" })).toBeVisible();

    const body = operator.getByLabel(/^Text/);
    const current = await body.inputValue();
    expect(current, "the draft was not copied from the published text").toContain("## GetSetPaid does not use AI");
    await body.fill(`${current.trimEnd()}\n\n## Revision\n\n${marker}.\n`);
    await operator.getByRole("button", { name: "Save draft" }).click();
    await expect(operator.getByText("Draft saved.")).toBeVisible();
    const preview = operator.getByTestId("legal-draft-preview");
    await expect(preview).toContainText(marker);
    await expect(preview.getByTestId("legal-draft-notice")).toBeVisible();

    // A hostile link is refused at save time, beside the field, and not stored.
    await body.fill(`${current.trimEnd()}\n\n[click](javascript:alert(1))\n`);
    await operator.getByRole("button", { name: "Save draft" }).click();
    await expect(operator.getByText("The draft wasn’t saved.")).toBeVisible();
    await expect(operator.getByRole("alert").filter({ hasText: "is not allowed" })).toBeVisible();
    const stored = await legalDocumentVersions(WALK_SLUG);
    expect(stored.find((v) => v.status === "draft")?.body).toContain(marker);
    expect(stored.find((v) => v.status === "draft")?.body).not.toContain("javascript:");
    await operator.reload();
    await expect(operator.getByTestId("legal-draft-preview")).toContainText(marker);

    // THE EDITOR, POPULATED: draft form, review form, publish form, preview.
    await expect(operator.getByRole("button", { name: "Publish version 2" })).toBeVisible();
    await expect(operator.getByRole("button", { name: "Record counsel’s review" }).first()).toBeVisible();
    await scan(operator, "/super/legal?doc=ai-use (draft open)");

    // ---- THE DRAFT IS PRIVATE -------------------------------------------------
    await visitor.reload();
    await expectDocumentRendered(visitor, WALK_TITLE);
    await expect(visitor.getByTestId("legal-version")).toContainText("Version 1 ·");
    await expect(visitor.getByTestId("legal-body")).not.toContainText(marker);

    // ---- PUBLISH --------------------------------------------------------------
    const publishForm = operator.locator("form", {
      has: operator.getByRole("button", { name: "Publish version 2" }),
    });
    await publishForm.getByRole("checkbox").check();
    await publishForm.getByRole("button", { name: "Publish version 2" }).click();
    await expect(operator.getByText("Published. The public page now shows this version.")).toBeVisible();

    await visitor.reload();
    await expectDocumentRendered(visitor, WALK_TITLE);
    await expect(visitor.getByTestId("legal-version")).toContainText("Version 2 ·");
    await expect(visitor.getByTestId("legal-body")).toContainText(marker);
    // Published unreviewed -> the notice is still there.
    await expect(visitor.getByTestId("legal-draft-notice")).toBeVisible();

    const afterPublish = await legalDocumentVersions(WALK_SLUG);
    expect(afterPublish.map((v) => `${v.version}:${v.status}`)).toEqual(["1:superseded", "2:published"]);

    // ---- RECORD COUNSEL'S REVIEW OF THE PUBLIC VERSION ----------------------
    await operator.reload();
    const reviewForm = operator.locator("form", {
      has: operator.getByLabel(/Reviewed by \(version 2\)/),
    });
    await reviewForm.getByLabel(/Reviewed by \(version 2\)/).fill(reviewer);
    await reviewForm.getByRole("checkbox").check();
    await reviewForm.getByRole("button", { name: "Record counsel’s review" }).click();
    await expect(operator.getByText("Counsel’s review recorded.")).toBeVisible();

    await visitor.reload();
    await expectDocumentRendered(visitor, WALK_TITLE);
    await expect(visitor.getByTestId("legal-version")).toContainText("Version 2 ·");
    await expect(visitor.getByTestId("legal-version")).toContainText("Reviewed by legal counsel");
    // THE NOTICE IS GONE -- and the page that lost it is the page with the
    // document on it, proved just above.
    await expect(visitor.getByTestId("legal-draft-notice")).toHaveCount(0);
    // The reviewer's name is the operator's, not the public's.
    await expect(visitor.locator("body")).not.toContainText(reviewer);
    // Every OTHER page still carries its notice.
    await visitor.goto("/legal/terms");
    await expectDocumentRendered(visitor, "Terms of Service");
    await expect(visitor.getByTestId("legal-draft-notice")).toBeVisible();

    // ---- THE AUDIT TRAIL, read straight out of Postgres ----------------------
    const audit = await legalAuditRows(world.superuser.id);
    expect(audit.map((a) => a.action)).toEqual([
      "legal_document.draft_created",
      "legal_document.draft_updated",
      "legal_document.published",
      "legal_document.counsel_review_recorded",
    ]);
    for (const row of audit) {
      expect(row.after, "an audit row carries document text").not.toContain("E2E revision");
      expect(row.after, "an audit row carries the reviewer's name").not.toContain("E2E Counsel");
    }
  } finally {
    await operatorContext.close();
    await visitorContext.close();
    await restoreLegalDocumentSeed(WALK_SLUG, world.superuser.id);
  }
});
