import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  closureDecisionAudit,
  membershipRole,
  organisationLifecycleState,
  plantOwnerClosedWorkspace,
  removeOrganisations,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { totpCode } from "../support/totp";

// PHASE 8 TASK 9c JOB 3a -- /super/closures (founder 2026-09-30, Q176/Q178).
//
// The superuser's half of an Owner closing their own workspace: the item
// appears, the operator reassigns one workspace to its remaining Manager (who
// becomes its Owner, and the workspace reopens) and deletes another
// permanently (lifecycle `deleted`, due for the existing hourly purge). Both
// through the real forms, behind the real step-up (a TOTP seconds old), with a
// reason that is read back out of audit_events. The workspaces are closed
// through the REAL close_my_workspace RPC as their Owner at aal2, so the row
// this page reads carries a real closure backup job.
//
// Non-superuser refusal is not repeated here: /super/closures is on
// tests/support/super-route-census.ts's list, so super-permissions.spec.ts and
// phase8-refusal-parity.spec.ts walk it as every wrong principal.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;
const planted: string[] = [];

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  await removeOrganisations(planted).catch(() => undefined);
  if (world) await tearDownWorld(world);
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

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("the empty state teaches the decision, and is accessible", async ({ page }) => {
  await signInAsSuperuser(page);
  await page.goto("/super");
  await page.getByRole("link", { name: "Closed workspaces" }).click();
  await expect(page).toHaveURL(/\/super\/closures$/);
  await expect(page.getByRole("heading", { level: 1, name: "Closed workspaces" })).toBeVisible();
  await expect(page.getByText("No workspace is waiting for a decision.")).toBeVisible();
  await expect(page.getByText(/hand it to one of its active members/)).toBeVisible();
  await scan(page);
});

test("reassign reopens one workspace under its Manager; delete marks the other for the purge", async ({
  page,
}) => {
  const member = { id: world.users.manager.id, name: "Morgan Closure-Manager" };
  const keep = await plantOwnerClosedWorkspace("keep", world.users.owner, member);
  const drop = await plantOwnerClosedWorkspace("drop", world.users.owner, member);
  planted.push(keep.id, drop.id);
  expect(await organisationLifecycleState(keep.id)).toBe("owner_closed");
  expect(await organisationLifecycleState(drop.id)).toBe("owner_closed");

  await signInAsSuperuser(page);
  await page.goto("/super/closures");

  const keepRow = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: keep.name }) });
  const dropRow = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: drop.name }) });
  await expect(keepRow).toBeVisible();
  await expect(dropRow).toBeVisible();
  // Aggregate metadata only: the backup's STATUS, the member count.
  await expect(keepRow.getByText(/Waiting to start|Being prepared|Ready to download|Could not be prepared/)).toBeVisible();
  await expect(keepRow.getByText("Active members")).toBeVisible();

  // The populated page, with both decision forms in the tree.
  await scan(page);

  // ---- reassign ------------------------------------------------------
  const reassignReason = `E2E reassign ${keep.id.slice(0, 8)}: the Manager takes over`;
  await keepRow.getByLabel(/New Owner/).selectOption({ label: `${member.name} — Manager` });
  await keepRow.getByRole("textbox", { name: /Reason/ }).first().fill(reassignReason);
  await keepRow.getByRole("button", { name: /Reassign and reopen/ }).click();
  await expect(page.getByText(`${keep.slug} is reopened under its new Owner.`, { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: keep.name })).toHaveCount(0);

  expect(await organisationLifecycleState(keep.id)).toBe("active");
  expect(await membershipRole(keep.id, member.id)).toBe("owner");
  expect(await closureDecisionAudit(keep.id)).toEqual([
    { action: "organisation.closure_reassigned", reason: reassignReason },
  ]);

  // ---- delete: the retyped slug is checked server-side first ------------
  const deleteReason = `E2E delete ${drop.id.slice(0, 8)}: the Owner asked for removal`;
  // The N3a acknowledgement box (below) is `required`; strip it so this
  // submission reaches the server's retyped-slug check at all.
  const ack = dropRow.getByRole("checkbox", { name: /Delete without a backup/ });
  await expect(ack).toBeVisible();
  await ack.evaluate((el) => el.removeAttribute("required"));
  await dropRow.getByLabel(/Type the URL name to confirm/).fill(`${drop.slug}-typo`);
  await dropRow.getByRole("textbox", { name: /Reason/ }).last().fill(deleteReason);
  await dropRow.getByRole("button", { name: /Delete permanently/ }).click();
  await expect(dropRow.getByText(/Type the workspace’s URL name exactly/)).toBeVisible();
  expect(await organisationLifecycleState(drop.id)).toBe("owner_closed");

  // ---- delete: a backup that has not succeeded needs an acknowledgement ---
  // (20261028002000, N3a). The fixture's closure backup is never built here
  // -- nothing nudges the runner for an RPC-made closure and the local cron
  // tick is a no-op -- so the checkbox is in the tree. The database is the
  // enforcement: with `required` stripped and the box unticked, the RPC
  // refuses and the workspace stays owner_closed.
  await dropRow.getByLabel(/Type the URL name to confirm/).fill(drop.slug);
  await ack.evaluate((el) => el.removeAttribute("required"));
  await expect(ack).not.toBeChecked();
  await dropRow.getByRole("button", { name: /Delete permanently/ }).click();
  await expect(dropRow.getByText(/backup has not succeeded\. Tick/)).toBeVisible();
  expect(await organisationLifecycleState(drop.id)).toBe("owner_closed");

  await ack.check();
  await dropRow.getByRole("button", { name: /Delete permanently/ }).click();
  await expect(page.getByText(`${drop.slug} is marked for permanent deletion.`, { exact: false })).toBeVisible();
  await expect(page.getByText("No workspace is waiting for a decision.")).toBeVisible();

  expect(await organisationLifecycleState(drop.id)).toBe("deleted");
  expect(await closureDecisionAudit(drop.id)).toEqual([
    { action: "organisation.closure_deleted", reason: deleteReason },
  ]);
});
