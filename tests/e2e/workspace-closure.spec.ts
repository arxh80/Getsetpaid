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
import { CLOSE_MESSAGES } from "../../lib/org/closure-contract";
import { signIn } from "./support/sign-in";

// PHASE 8 TASK 9c JOB 3b -- the Owner closes their own workspace (founder
// 2026-09-30, Q176/Q178, reversing Q104). The customer's half of the flow
// /super/closures (super-closures.spec.ts) decides.
//
//   1. The Owner, at aal2 with a credential seconds old (the real TOTP
//      sign-in satisfies the step-up gate), reads the section and its
//      consequences, and the page is scanned WITH the section in the tree.
//   2. A Manager sees no close section at all.
//   3. The Owner types a wrong slug: refused beside the field, still active.
//      That real Server Action POST is CAPTURED (its Next-Action id, its
//      headers and its body) and REPLAYED from the Manager's own signed-in
//      page with the slug corrected -- a forged close that reaches the real
//      action as the Manager and is refused there by name ("Only an Owner"),
//      with the workspace row and its closure backup count read unchanged out
//      of Postgres. (The close form is a client component whose action is a
//      function prop: it renders no `$ACTION` hidden fields, so copying its
//      HTML into another page forges nothing -- the first cut of this spec
//      did that and could only fail on its own precondition.)
//   4. The right slug and a reason: `owner_closed`, one closure backup job,
//      the reason on the audit row, the confirmation in the region the
//      revalidation cannot unmount.
//   5. The Manager reads the banner (closed by its Owner, the reason, the
//      pending decision) on a CRM page, which is scanned; the create control
//      is disabled with the closure sentence; and a create submitted from a
//      contact form the Manager opened while the workspace was still live
//      (a real, hydrated form posting the real action) is refused with the
//      closure sentence and the contact count unchanged.
//
// DENOMINATORS: the Manager's create control is asserted ENABLED and the
// form opened (and left open) before the closure, so its absence afterwards is the closure
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


test("an Owner closes the workspace; a Manager cannot, reads the banner, and cannot write", async ({
  page,
  browser,
}) => {
  const settingsUrl = `/${world.orgSlug}/settings/export`;
  const contactName = `E2E closure forged contact ${world.orgId.slice(0, 8)}`;
  const reason = `E2E: ${world.orgName} is winding down at the end of the season`;
  const typo = `${world.orgSlug}-typo`;

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

  // ---- 2. a Manager: no section -------------------------------------------
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  try {
    await signIn(manager, world, "manager");

    // The create control is live before the closure (the denominator), and a
    // contact form is opened in a SECOND tab and left open: after the closure
    // it is still a real, hydrated form bound to the real create action,
    // which is the forged write of step 5.
    await manager.goto(`/${world.orgSlug}/contacts`);
    await expect(manager.getByRole("link", { name: "New contact" })).toBeVisible();
    const staleCreate = await managerContext.newPage();
    await staleCreate.goto(`/${world.orgSlug}/contacts/new`);
    const staleForm = staleCreate.locator("form").filter({ has: staleCreate.locator('input[name="name"]') });
    await expect(staleForm).toBeVisible();

    await manager.goto(settingsUrl);
    await expect(manager.getByRole("heading", { level: 1, name: "Export this workspace" })).toBeVisible();
    await expect(manager.getByRole("heading", { name: "Close this workspace" })).toHaveCount(0);
    await expect(manager.getByTestId("close-workspace-form")).toHaveCount(0);

    // ---- 3. the Owner mistypes the slug, and that POST is captured --------
    // Matched on the page path AND the next-action header: only a real
    // client-invoked Server Action POST carries the action id the replay needs.
    const ownerPost = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === settingsUrl &&
        req.headers()["next-action"] !== undefined,
    );
    await page.getByLabel(/Type the workspace’s URL name to confirm/).fill(typo);
    await page.getByRole("textbox", { name: /Why are you closing it/ }).fill(reason);
    await page.getByRole("button", { name: "Close this workspace" }).click();
    const captured = await ownerPost;
    await expect(ownerForm.getByText(/Type the workspace’s URL name exactly/)).toBeVisible();
    expect(await organisationLifecycleState(world.orgId)).toBe("active");
    expect(await closureBackupCount(world.orgId)).toBe(0);

    const capturedHeaders = await captured.allHeaders();
    const capturedBody = captured.postData() ?? "";
    expect(capturedHeaders["next-action"], "the Owner's close POST carried no Next-Action id").toBeTruthy();
    expect(capturedBody.includes(typo), "the captured close POST did not carry the typed slug").toBe(true);

    // ---- the Manager's forged close: the Owner's real action id and body,
    // the slug corrected, sent from the Manager's own signed-in page --------
    const forgedBody = capturedBody.split(typo).join(world.orgSlug);
    expect(forgedBody.includes(typo), "the forged body still carries the typo").toBe(false);
    const replayHeaders: Record<string, string> = {};
    for (const name of ["next-action", "content-type", "accept", "next-router-state-tree"]) {
      const value = capturedHeaders[name];
      if (value !== undefined) replayHeaders[name] = value;
    }
    const forged = await manager.evaluate(
      async ({ url, headers, body }) => {
        const response = await fetch(url, { method: "POST", headers, body, credentials: "same-origin" });
        return { status: response.status, text: await response.text() };
      },
      { url: settingsUrl, headers: replayHeaders, body: forgedBody },
    );
    // The refusal is the action's OWN sentence: a wrong or unknown action id
    // would answer "Server action not found", never this.
    expect(
      forged.status,
      `the forged close POST was not answered by the action: ${forged.text.slice(0, 300)}`,
    ).toBe(200);
    expect(
      forged.text.includes(CLOSE_MESSAGES.notOwner),
      `the forged close POST reached no refusal from the real action: ${forged.text.slice(0, 300)}`,
    ).toBe(true);
    expect(await organisationLifecycleState(world.orgId), "a Manager's forged POST closed the workspace").toBe(
      "active",
    );
    expect(await closureBackupCount(world.orgId)).toBe(0);
    expect(await closedByOwnerAuditReasons(world.orgId)).toEqual([]);

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

    // The create route serves no form now ...
    await manager.goto(`/${world.orgSlug}/contacts/new`);
    await expect(manager.locator('input[name="name"]')).toHaveCount(0);

    // ... and a create through the form opened while it was live is refused
    // by the real action. The POST itself is captured so a submit that never
    // left the page, or left without the name, fails here by name.
    await staleForm.locator('input[name="name"]').fill(contactName);
    const createPost = staleCreate.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === `/${world.orgSlug}/contacts/new`,
    );
    await staleForm.getByRole("button", { name: "Create contact" }).click();
    const createBody = (await createPost).postData() ?? "";
    expect(createBody.includes(contactName), "the forged create POST did not carry the contact's name").toBe(true);
    await expect(staleForm.getByRole("alert")).toContainText("closed by its Owner");
    expect(await countContactsNamed(world.orgId, contactName), "a write landed in a closed workspace").toBe(0);
    expect(await organisationLifecycleState(world.orgId)).toBe("owner_closed");
  } finally {
    await managerContext.close();
  }
});
