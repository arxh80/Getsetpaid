import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  PASSWORD,
  backdateDataSubjectRequest,
  clearDataSubjectRequestState,
  dataSubjectRequests,
  dsrAuditActions,
  dsrNoteBodies,
  raiseDsrDeadlineAlerts,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";
import { totpCode } from "../support/totp";

// PHASE 8 TASK 3: A DATA SUBJECT REQUEST, MADE, WORKED AND MISSED.
//
// supabase/tests/rls_phase8_data_subject_requests.sql proves the database --
// attribution, the generated deadline, the transition table, the notes
// boundary, the meter, the audit payloads and the alert writer. The permission
// matrix proves who may reach each RPC and table. Neither is re-proved here.
//
// Four things only a browser can show:
//
//   1. THE FORM IS WHERE THE LEGAL PAGE SAYS IT IS, reached from the signed-in
//      footer, and a request made through it appears on the person's own list
//      with the 30-day deadline the DATABASE computed (read out of Postgres,
//      not a literal in this file).
//   2. THE OPERATOR SEES IT AND WORKS IT, and the requester sees the new
//      status on their own page -- the two halves joined through the product
//      rather than through the table.
//   3. AN OVERDUE REQUEST IS IMPOSSIBLE TO MISS: the queue says so in words,
//      and the alert the cron job's own function writes is on /super/health.
//   4. OPERATOR NOTES EXIST AND THE REQUESTER NEVER SEES THEM -- asserted with
//      the note's text read straight out of the table first, so "not on the
//      page" cannot pass because no note was written.
//
// AXE SCANS BOTH NEW PAGES POPULATED, never empty: an empty-state scan of the
// queue would miss the row, the overdue chip, the transition controls, the
// note form and the reveal forms -- which is the whole of what this task
// added.

test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) {
    await clearDataSubjectRequestState(Object.values(world.users).map((u) => u.id));
    await clearDataSubjectRequestState([world.superuser.id]);
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

/** The streamed not-found contract every /super page owes, title included. */
async function expectStreamedRefusal(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? -1;
  expect(
    [200, 404],
    `${url} must refuse as 404 or a streamed not-found -- never 403; got ${status}`,
  ).toContain(status);
  expect(page.url(), `${url} must not bounce an authenticated probe to login`).not.toMatch(/\/login/);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText("Superuser");
  await expect(page.locator("body")).not.toContainText("Data requests");
  await expect(page).not.toHaveTitle(/Superuser/);
  await expect(page).not.toHaveTitle(/Data requests/);
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

// ===========================================================================
// THE WHOLE WALK: ASKED, WORKED, ANSWERED, AND ONE THAT IS MISSED
// ===========================================================================
test("a Manager asks for a copy of their data, the operator works it, and an overdue one is impossible to miss", async ({
  browser,
}) => {
  const manager = world.users.manager;
  expect(
    await dataSubjectRequests(manager.id),
    "DENOMINATOR: the Manager starts with no requests",
  ).toEqual([]);

  const requesterContext = await browser.newContext();
  const requester = await requesterContext.newPage();
  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();

  try {
    // ---- 1. THE PERSON MAKES A REQUEST ------------------------------------
    await signIn(requester, world, "manager");
    await requester.goto(`/${world.orgSlug}`);
    await requester
      .getByRole("contentinfo")
      .getByRole("link", { name: "Your data requests" })
      .click();
    await expect(requester).toHaveURL(/\/account\/data-requests$/);
    await expect(
      requester.getByRole("heading", { level: 1, name: "Your data protection requests" }),
    ).toBeVisible();
    await expect(requester.getByTestId("no-requests")).toBeVisible();
    // The route for somebody who cannot sign in is on the page, not implied.
    await expect(
      requester.getByText("This form is for people with a GetSetPaid account"),
    ).toBeVisible();

    const detail = "Please send me everything you hold about my account.";
    await requester.getByRole("radio", { name: "A copy of my data (access)" }).check();
    await requester.getByRole("radio", { name: "My GetSetPaid account" }).check();
    await requester.getByLabel("Tell us what you want").fill(detail);
    await requester.getByRole("button", { name: "Send this request" }).click();
    await expect(requester.getByText("Your request has been sent.")).toBeVisible();

    // THE DATABASE COMPUTED THE DEADLINE, and the page shows that deadline.
    const afterSubmit = await dataSubjectRequests(manager.id);
    expect(afterSubmit).toHaveLength(1);
    expect(afterSubmit[0]).toMatchObject({
      right_type: "access",
      subject_scope: "account",
      status: "open",
      detail,
      days_to_due: 30,
    });
    const requestId = afterSubmit[0].id;

    const row = requester.getByTestId("own-request");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Received");
    await expect(requester.getByTestId("own-request-deadline")).toContainText("Due by");
    await expect(requester.getByTestId("own-request-deadline")).toContainText("days left");

    // Scanned WITH a request on it: the chip, the deadline line, the withdraw
    // control and the two radio groups are all in the tree.
    await expect(
      requester.getByRole("button", { name: "Withdraw this request" }),
    ).toBeVisible();
    await scan(requester);

    // ---- 2. A SECOND REQUEST, THE PROCESSOR KIND (Q132) --------------------
    await requester
      .getByRole("radio", { name: "Delete my data (erasure)" })
      .check();
    await requester
      .getByRole("radio", { name: "Records a business keeps about me in GetSetPaid" })
      .check();
    await requester
      .getByLabel("Tell us what you want")
      .fill("A promoter has me saved as a contact. Please ask them to delete me.");
    await requester.getByRole("button", { name: "Send this request" }).click();
    await expect(requester.getByText("Your request has been sent.")).toBeVisible();
    const both = await dataSubjectRequests(manager.id);
    expect(both.map((r) => r.subject_scope)).toEqual(["account", "workspace_records"]);
    const processorId = both[1].id;

    // ---- 3. AN OVERDUE ONE, SO THE QUEUE HAS SOMETHING TO SHOUT ABOUT ------
    // Backdated through the fixture, because the insert trigger forces
    // requested_at = now() for every writer -- which is exactly the property
    // that makes the deadline unforgeable.
    await backdateDataSubjectRequest(requestId, 31);
    const backdated = await dataSubjectRequests(manager.id);
    expect(
      backdated[0].days_to_due,
      "the backdated request must still carry a 30-day window; only its start moved",
    ).toBe(30);

    // ---- 4. THE OPERATOR READS THE QUEUE ----------------------------------
    await signInAsSuperuser(operator);
    await operator.goto("/super");
    await operator.getByRole("link", { name: "Data requests" }).click();
    await expect(operator).toHaveURL(/\/super\/data-requests$/);
    await expect(
      operator.getByRole("heading", { level: 1, name: "Data requests" }),
    ).toBeVisible();

    const queueRows = operator.getByTestId("dsr-row");
    await expect(queueRows).toHaveCount(2);
    // OLDEST DEADLINE FIRST: the backdated one leads.
    await expect(queueRows.nth(0)).toContainText(detail);
    await expect(queueRows.nth(0).getByTestId("dsr-overdue-chip")).toBeVisible();
    await expect(queueRows.nth(0).getByTestId("dsr-deadline")).toContainText("overdue");
    await expect(operator.getByTestId("dsr-overdue-banner")).toContainText(
      "past its statutory deadline",
    );
    // The requester's own address is the identity; no workspace record content.
    await expect(queueRows.nth(0)).toContainText(manager.email);

    // ---- 5. THE OPERATOR WORKS THEM ---------------------------------------
    // An internal note first, so the requester's page can be checked for it.
    const noteText = "Checked the audit trail. Export ready to send by hand.";
    await queueRows.nth(0).getByLabel("Add an internal note").fill(noteText);
    await queueRows.nth(0).getByRole("button", { name: "Add note" }).click();
    await expect(operator.getByText("Note added. The requester never sees it.")).toBeVisible();
    expect(
      await dsrNoteBodies(requestId),
      "DENOMINATOR: the note must really be in the table, or 'the requester cannot see it' is vacuous",
    ).toEqual([noteText]);

    await queueRows.nth(0).getByRole("button", { name: "Mark being worked on" }).click();
    await expect(operator.getByText("Marked Being worked on.")).toBeVisible();

    // The processor one is PASSED ON rather than answered (Q132).
    const processorRow = operator
      .getByTestId("dsr-row")
      .filter({ hasText: "A promoter has me saved as a contact" });
    await processorRow.getByRole("button", { name: "Pass to the business" }).click();
    await processorRow.getByLabel("Workspace slug").fill(world.orgSlug);
    await processorRow.getByRole("button", { name: "Pass it on" }).click();
    await expect(operator.getByText("Marked Passed to the business.")).toBeVisible();

    const afterRouting = await dataSubjectRequests(manager.id);
    expect(afterRouting.find((r) => r.id === processorId)).toMatchObject({
      status: "routed",
      routed_to_organisation_id: world.orgId,
    });

    // Scanned WITH rows, an overdue chip, a note, the transition controls and
    // an open reveal form all in the tree.
    await scan(operator);

    // ---- 6. THE ALERT NOBODY HAD TO GO LOOKING FOR -------------------------
    const written = await raiseDsrDeadlineAlerts();
    expect(written, "the overdue request must raise an alert").toBeGreaterThanOrEqual(1);
    await operator.goto("/super/health");
    await expect(operator.getByText("Data request OVERDUE")).toBeVisible();
    await expect(operator.getByText(requestId)).toBeVisible();
    // The alert carries identifiers only -- never what the person wrote.
    await expect(operator.locator("body")).not.toContainText(detail);

    // ---- 7. THE REQUESTER SEES THE NEW STATE, AND NEVER THE NOTE ----------
    await requester.reload();
    const rows = requester.getByTestId("own-request");
    await expect(rows).toHaveCount(2);
    await expect(requester.getByText("Being worked on")).toBeVisible();
    await expect(requester.getByText("Passed to the business")).toBeVisible();
    await expect(
      requester.getByText("We passed this to the business that holds the records"),
    ).toBeVisible();
    await expect(
      requester.locator("body"),
      "THE Q103 ASSERTION: the operator's note must not reach the requester's page",
    ).not.toContainText(noteText);

    // ---- 8. WITHDRAWING IS ONE PRESS, NO DIALOG ---------------------------
    const dialogs: string[] = [];
    requester.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await requester
      .getByTestId("own-request")
      .filter({ hasText: "A promoter has me saved as a contact" })
      .getByRole("button", { name: "Withdraw this request" })
      .click();
    await expect(requester.getByText("Your request has been withdrawn.")).toBeVisible();
    expect(dialogs, "withdrawing asked for a confirmation").toEqual([]);
    expect(
      (await dataSubjectRequests(manager.id)).find((r) => r.id === processorId)?.status,
    ).toBe("withdrawn");

    // ---- 9. THE AUDIT TRAIL, READ OUT OF POSTGRES -------------------------
    const actions = await dsrAuditActions(manager.id);
    expect(actions).toEqual([
      "data_subject_request.submitted",
      "data_subject_request.submitted",
      "data_subject_request.note_added",
      "data_subject_request.in_progress",
      "data_subject_request.routed",
      "data_subject_request.withdrawn",
    ]);
  } finally {
    await requesterContext.close();
    await operatorContext.close();
  }
});

// ===========================================================================
// THE REFUSALS
// ===========================================================================
test("a workspace Manager gets the same not-found document at /super/data-requests", async ({
  page,
}) => {
  await signIn(page, world, "manager");
  await expectStreamedRefusal(page, "/super/data-requests");
});

test("the superuser below aal2 is refused too", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter your two-factor code" }),
    "the superuser must be CHALLENGED, or this principal is not aal1 and the refusal proves nothing",
  ).toBeVisible();
  await expectStreamedRefusal(page, "/super/data-requests");
});
