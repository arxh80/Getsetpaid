import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  closedByOwnerAuditReasons,
  closureBackupCount,
  countContactsNamed,
  organisationLifecycleState,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 9c JOB 3b -- the Owner closes their own workspace (founder
// 2026-09-30, Q176/Q178, reversing Q104). The customer's half of the flow
// /super/closures (super-closures.spec.ts) decides.
//
//   1. The Owner, at aal2 with a credential seconds old (the real TOTP
//      sign-in satisfies the step-up gate), reads the section and its
//      consequences, and the page is scanned WITH the section in the tree.
//   2. A Manager sees no close section at all -- and a FORGED submission of
//      the Owner's own form (its server-rendered action fields copied into the
//      Manager's page and submitted natively) is refused, with the workspace
//      row and its closure backup count read unchanged out of Postgres.
//   3. The Owner types a wrong slug: refused beside the field, still active.
//   4. The right slug and a reason: `owner_closed`, one closure backup job,
//      the reason on the audit row, the confirmation in the region the
//      revalidation cannot unmount.
//   5. The Manager reads the banner (closed by its Owner, the reason, the
//      pending decision) on a CRM page, which is scanned; the create control
//      is disabled with the closure sentence; and a forged create POST is
//      refused with the contact count unchanged.
//
// DENOMINATORS: the Manager's create control is asserted ENABLED and the
// form captured before the closure, so its absence afterwards is the closure
// and not the role or the tier (world.orgId is on a real Starter row).

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

/**
 * Put a server-rendered form (copied from another page) into this page and
 * submit it NATIVELY -- the progressive-enhancement POST Next.js accepts
 * without JavaScript -- then wait for the response document. This is the
 * forged-request shape: the action id and its bound fields are real, the
 * session is whoever is signed in here.
 */
async function forgeSubmit(page: Page, formHtml: string, fields: Record<string, string>): Promise<void> {
  expect(formHtml, "the captured form carries no server-action fields to forge").toContain("$ACTION");
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(
      ({ html, values }) => {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const form = holder.querySelector("form") as HTMLFormElement;
        for (const [name, value] of Object.entries(values)) {
          const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
          if (input) input.value = value;
        }
        for (const el of Array.from(form.querySelectorAll("[disabled]"))) el.removeAttribute("disabled");
        document.body.appendChild(holder);
        HTMLFormElement.prototype.submit.call(form);
      },
      { html: formHtml, values: fields },
    ),
  ]);
}

test("an Owner closes the workspace; a Manager cannot, reads the banner, and cannot write", async ({
  page,
  browser,
}) => {
  const settingsUrl = `/${world.orgSlug}/settings/export`;
  const contactName = `E2E closure forged contact ${world.orgId.slice(0, 8)}`;
  const reason = `E2E: ${world.orgName} is winding down at the end of the season`;

  // ---- 1. the Owner reads the section -----------------------------------
  await signIn(page, world, "owner");
  await page.goto(settingsUrl);
  const section = page.locator("#close-workspace");
  await expect(section.getByRole("heading", { level: 2, name: "Close this workspace" })).toBeVisible();
  await expect(section.getByText(/full backup/)).toBeVisible();
  await expect(section.getByText(/deleted permanently/)).toBeVisible();
  await expect(section.getByText(/If nobody decides, it is deleted/)).toBeVisible();
  const ownerForm = page.getByTestId("close-workspace-form");
  await expect(ownerForm, "the step-up gate rendered the prompt, not the form").toBeVisible();
  await scan(page);
  const capturedCloseForm = await ownerForm.evaluate((el) => el.outerHTML);

  // ---- 2. a Manager: no section, and a forged close is refused ------------
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  try {
    await signIn(manager, world, "manager");

    // The create control is live before the closure (the denominator), and
    // its form is captured for the forged write in step 5.
    await manager.goto(`/${world.orgSlug}/contacts`);
    await expect(manager.getByRole("link", { name: "New contact" })).toBeVisible();
    await manager.goto(`/${world.orgSlug}/contacts/new`);
    const contactForm = manager.locator("form").filter({ has: manager.locator('input[name="name"]') });
    await expect(contactForm).toBeVisible();
    const capturedContactForm = await contactForm.evaluate((el) => el.outerHTML);

    await manager.goto(settingsUrl);
    await expect(manager.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
    await expect(manager.getByRole("heading", { name: "Close this workspace" })).toHaveCount(0);
    await expect(manager.getByTestId("close-workspace-form")).toHaveCount(0);

    expect(await organisationLifecycleState(world.orgId)).toBe("active");
    expect(await closureBackupCount(world.orgId)).toBe(0);
    await forgeSubmit(manager, capturedCloseForm, {
      confirmSlug: world.orgSlug,
      reason: "E2E: a forged close by a Manager",
    });
    expect(await organisationLifecycleState(world.orgId), "a Manager's forged POST closed the workspace").toBe(
      "active",
    );
    expect(await closureBackupCount(world.orgId)).toBe(0);
    expect(await closedByOwnerAuditReasons(world.orgId)).toEqual([]);

    // ---- 3. the Owner mistypes the slug ------------------------------------
    await page.getByLabel(/Type the workspace’s URL name to confirm/).fill(`${world.orgSlug}-typo`);
    await page.getByRole("textbox", { name: /Why are you closing it/ }).fill(reason);
    await page.getByRole("button", { name: "Close this workspace" }).click();
    await expect(ownerForm.getByText(/Type the workspace’s URL name exactly/)).toBeVisible();
    expect(await organisationLifecycleState(world.orgId)).toBe("active");
    expect(await closureBackupCount(world.orgId)).toBe(0);

    // ---- 4. the right slug and a reason -------------------------------------
    await page.getByLabel(/Type the workspace’s URL name to confirm/).fill(world.orgSlug);
    await page.getByRole("textbox", { name: /Why are you closing it/ }).fill(reason);
    await page.getByRole("button", { name: "Close this workspace" }).click();
    await expect(page.getByTestId("export-outcome")).toContainText("The workspace is closed.");
    await expect(page.getByTestId("close-workspace-done")).toBeVisible();
    await expect(page.getByTestId("close-workspace-form")).toHaveCount(0);

    expect(await organisationLifecycleState(world.orgId)).toBe("owner_closed");
    expect(await closureBackupCount(world.orgId)).toBe(1);
    expect(await closedByOwnerAuditReasons(world.orgId)).toEqual([reason]);

    // ---- 5. the Manager reads a closed workspace -----------------------------
    await manager.goto(`/${world.orgSlug}/contacts`);
    const banner = manager.getByTestId("suspended-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Read-only.");
    await expect(banner).toContainText("was closed by its Owner");
    await expect(banner).toContainText(reason);
    await expect(banner.getByTestId("owner-closed-next")).toContainText("awaiting a decision by GetSetPaid");
    await expect(banner).not.toContainText("is suspended");
    const blocked = manager.getByRole("button", { name: "New contact" });
    await expect(blocked).toBeDisabled();
    await expect(manager.getByText("This workspace was closed by its Owner, so it’s read-only.")).toBeVisible();
    await scan(manager);

    // A forged create, through the form captured while it was live.
    await manager.goto(`/${world.orgSlug}/contacts/new`);
    await expect(manager.locator('input[name="name"]')).toHaveCount(0);
    await forgeSubmit(manager, capturedContactForm, { name: contactName });
    expect(await countContactsNamed(world.orgId, contactName), "a write landed in a closed workspace").toBe(0);
    expect(await organisationLifecycleState(world.orgId)).toBe("owner_closed");
  } finally {
    await managerContext.close();
  }
});
