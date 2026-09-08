import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 7 TASK 1: THE SUPERUSER AUDIT LOG VIEWER, THROUGH THE BROWSER.
//
// The psql/HTTP suite and tests/integration/rls/rls.test.ts (sections D and,
// as of this task, H) already prove the POLICIES and the self-audit RPC at
// the database layer: a non-superuser (even an aal2 Org Owner) reads zero
// rows from audit_events and cannot call audit_superuser_audit_log_view();
// the platform superuser reads cross-tenant and the RPC writes exactly the
// described row. This file's job, matching every other spec in this
// directory, is narrower: does the PAGE built on those policies route
// around them, and does it stream the refusal DESIGN.md promises rather
// than leaking a distinguishing status or any tenant content.
//
// THE REFUSAL TEST USES `manager`, NOT AN ORG OWNER, AND THAT IS A
// DELIBERATE, DOCUMENTED CHOICE. lib/admin/superuser.ts's isSuperuser() has
// exactly one branch: is this account a row in public.platform_admins.
// Nothing about it reads the caller's organisation role at all -- there is
// no code path that COULD treat an Owner differently from a Manager, so
// proving the refusal with the cheaply-available `manager` persona (already
// wired for browser sign-in, MFA-optional) demonstrates the same property
// an Owner would, without a second TOTP enrolment that adds no coverage.
// tests/integration/rls/rls.test.ts's own section H is where the
// STRONGEST version of this ("even a fully aal2'd Owner") is actually
// exercised, at the RPC layer.

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** Sign in as `world.superuser` -- not one of the fixed `E2eRole` personas
 *  `signIn()` addresses by role (see E2eWorld's own header on `superuser`:
 *  platform-superuser status is `platform_admins` membership, not an
 *  organisation role). The manual form walk, mirroring
 *  tenant-breakout.spec.ts's signInAsOtherMember -- PLUS the TOTP challenge,
 *  because the platform superuser is MFA-required
 *  (CLAUDE.md § Session security) and has_platform_permission is aal2-gated. */
async function signInAsSuperuser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const heading = page.getByRole("heading", {
    name: "Enter your two-factor code",
  });
  await expect(heading).toBeVisible();
  await page
    .locator('input[name="code"]')
    .fill(totpCode(world.superuserTotpSecret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(heading).toHaveCount(0);
}

const REFUSED = (page: Page) => page.locator("body");

/**
 * Same shape as tenant-breakout.spec.ts's expectRefused: HTTP 200 (the
 * streamed not-found contract) or a literal 404, never 403, never a bounce
 * to /login, and the identical not-found document either way.
 *
 * FIX ROUND 1, IMPORTANT/⚠️ 4. DESIGN.md § Error pages' whole property is
 * "identical document" -- not merely "the words 'Page not found' appear
 * somewhere in it". The review's own ⚠️ named the gap precisely: this
 * refusal is reached through app/(app)/super/layout.tsx, which renders its
 * "Superuser" eyebrow and page.tsx's own <title> UNCONDITIONALLY, above
 * where the notFound() call happens -- if either survives into the
 * refusal's DOM, a non-superuser (or an attacker with a stolen password)
 * learns "this route exists and is superuser-gated" from a document that is
 * supposed to be indistinguishable from any other 404, which is exactly the
 * enumeration-oracle shape CLAUDE.md's tenant-isolation rule forbids.
 *
 * "Back to your workspace" is NOT used as the discriminator, even though it
 * is this layout's own link text -- app/(app)/not-found.tsx (the document
 * itself) uses the IDENTICAL string, so its presence proves nothing either
 * way. "Superuser" (the layout's eyebrow, `text-xs uppercase`) and the
 * page's <title> ("Audit log · Superuser · GetSetPaid") are unique to this
 * layout/page and appear nowhere else in the product (grepped).
 *
 * MEASURED, NOT ASSUMED: both assertions below PASS against the shipped
 * code, because Next.js's not-found resolution unmounts every layout
 * between the segment that threw notFound() and the nearest ANCESTOR that
 * owns a not-found.tsx of its own -- app/(app)/super/ has none, so the
 * error propagates past app/(app)/super/layout.tsx to app/(app)/not-found.tsx,
 * taking this layout's header with it. Asserted here so a future
 * app/(app)/super/not-found.tsx (which would catch the error AT that layer
 * instead, and reinstate the chrome) is a red test, not a silent leak.
 */
async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${url} must refuse as 404 or a streamed not-found (200) -- never 403; got ${status}`,
  ).toContain(status);
  expect(page.url(), `${url} must not bounce an authenticated probe to login`).not.toMatch(
    /\/login/,
  );
  await expect(REFUSED(page)).toContainText("Page not found");

  // THE PARITY ASSERTION. Neither the layout's own eyebrow label nor the
  // audit-log page's own <title> may survive into the refusal a
  // non-superuser receives.
  await expect(
    REFUSED(page),
    `${url}'s refusal must not carry the /super layout's "Superuser" chrome -- that would distinguish this refusal from an ordinary 404`,
  ).not.toContainText("Superuser");
  await expect(
    page,
    `${url}'s refusal must not carry the audit-log page's own <title> -- same oracle, via the tab title instead of the body`,
  ).not.toHaveTitle(/Superuser/);
}

test("a non-superuser gets the streamed not-found contract at /super and /super/audit-log, and sees no audit content", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  await expectStreamedRefusal(page, "/super");
  await expectStreamedRefusal(page, "/super/audit-log");

  // No leakage on the way to the refusal: neither planted probe's action
  // string, nor either organisation's id, ever reaches this session.
  await expect(REFUSED(page)).not.toContainText("e2e.audit_probe_alpha");
  await expect(REFUSED(page)).not.toContainText("e2e.audit_probe_beta");
});

test("the platform superuser reaches the audit log and reads rows from BOTH tenants", async ({
  page,
}) => {
  await signInAsSuperuser(page);

  await page.goto(
    `/super/audit-log?action=${encodeURIComponent("e2e.audit_probe_alpha")}`,
  );
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  await expect(page.locator("main")).toContainText("e2e.audit_probe_alpha");
  await expect(page.locator("main")).toContainText(world.orgId);

  await page.goto(
    `/super/audit-log?action=${encodeURIComponent("e2e.audit_probe_beta")}`,
  );
  await expect(page.locator("main")).toContainText("e2e.audit_probe_beta");
  await expect(page.locator("main")).toContainText(world.otherOrgId);
});

test("filtering by organisation narrows to that tenant's events only", async ({
  page,
}) => {
  await signInAsSuperuser(page);

  await page.goto(`/super/audit-log?org=${world.orgId}`);
  await expect(page.locator("main")).toContainText("e2e.audit_probe_alpha");
  await expect(page.locator("main")).not.toContainText("e2e.audit_probe_beta");
});

test("filtering by actor ID narrows correctly", async ({ page }) => {
  await signInAsSuperuser(page);

  // The alpha probe's actor is world.users.manager; the beta probe's is
  // world.otherOwner -- two different accounts, so filtering by ONE actor
  // must exclude the other's row even though both are visible unfiltered.
  await page.goto(`/super/audit-log?actor=${world.users.manager.id}`);
  await expect(page.locator("main")).toContainText("e2e.audit_probe_alpha");
  await expect(page.locator("main")).not.toContainText("e2e.audit_probe_beta");
});

test("viewing the audit log is itself audited, and that record is later visible", async ({
  page,
}) => {
  await signInAsSuperuser(page);

  // A first, ordinary view -- this is the access that gets self-audited.
  await page.goto("/super/audit-log");
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();

  // A second load, filtered to the self-audit action AND this account as
  // actor, must now show at least one row -- proof the RPC in
  // lib/admin/audit-log.ts's recordAuditLogView actually landed a write
  // rather than merely rendering the page.
  await page.goto(
    `/super/audit-log?action=${encodeURIComponent("audit_log.viewed")}&actor=${world.superuser.id}`,
  );
  await expect(page.locator("main")).toContainText("audit_log.viewed");
  await expect(page.locator("main")).not.toContainText("No events match");
});

test("Next pagination is a real keyset link, not disabled, when more than one page's worth of events exists", async ({
  page,
}) => {
  await signInAsSuperuser(page);

  // Unfiltered, page size 1: the two planted probes alone guarantee at
  // least a second row exists, so "Next" must be a real, enabled link
  // rather than the end-of-log state.
  await page.goto("/super/audit-log?size=1");
  const next = page.getByRole("link", { name: "Next" });
  await expect(next).toBeVisible();
  await expect(next).not.toHaveAttribute("aria-disabled", "true");

  const firstRow = page.locator("main table tbody tr").first();
  const firstRowText = await firstRow.innerText();
  await next.click();

  // NOT A SINGLE immediate read after the click. The heading is OUTSIDE the
  // results Suspense boundary (app/(app)/super/audit-log/page.tsx renders it
  // before <Suspense>), so it becomes visible on the FIRST paint of the new
  // navigation -- before the streamed row content has necessarily replaced
  // the old table. Asserting `not.toHaveText` on the row locator polls with
  // Playwright's own retry instead of racing a single snapshot against the
  // stream, which is what produced a false failure here (the OLD row's text,
  // read a beat too early).
  await expect(page.locator("main table tbody tr").first()).not.toHaveText(
    firstRowText,
  );
});
