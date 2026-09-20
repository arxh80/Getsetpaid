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
import {
  REJECTION_REASON_WARNING,
  ROUTING_SENDS_NOTHING,
  // A RELATIVE PATH, not "@/lib/...": no other spec under tests/e2e uses the
  // alias, and Playwright resolves these files itself. lib/dsr/contract.ts is
  // pure (no "server-only", no Supabase import), so importing it here costs
  // nothing and keeps the two sentences below verbatim rather than retyped.
} from "../../lib/dsr/contract";
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
//   5. THE TWO TRANSITIONS THAT CLOSE A REQUEST ARE CONFIRMED TO THE PERSON
//      WHO MADE THEM (fix round 1, review finding I6). Both were driven only
//      through Postgres before: the walk moved a request to `in_progress` and
//      `routed`, the two states where the row survives, so the defect -- the
//      row (and the message it held) unmounting from the open-only queue --
//      was invisible to it. "Marked Answered." and "Marked Refused." are now
//      asserted VISIBLE, in the view where the row has gone.
//   6. REFUSING GOES THROUGH THE REAL STEP-UP GATE, with the warning that the
//      requester reads the reason verbatim asserted visible beside the field,
//      and the reason then read on the requester's own page.
//   7. PASSING A REQUEST ON SAYS WHAT IT REALLY DOES (I7/Q160): the operator
//      reads that nothing is sent, confirms the workspace by NAME before
//      anything is written, and records how they told it; the requester is
//      told WHICH business, and that we have asked.
//
// AXE SCANS BOTH NEW PAGES POPULATED, never empty: an empty-state scan of the
// queue would miss the row, the overdue chip, the transition controls, the
// note form and the reveal forms -- which is the whole of what this task
// added. THE REVEAL FORMS ARE ASSERTED PRESENT BEFORE THE SCAN (fix round 1,
// M4): the comment used to claim "an open reveal form in the tree" and there
// was none -- the routing form had closed itself when the request left the
// state that drew it -- so the refusal textarea, its warning and the
// workspace field had never been scanned at all.

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
    // THE LIST IS THE SIGNAL, NOT THE MESSAGE. `useActionState` keeps the last
    // outcome on screen across re-renders, so "Your request has been sent."
    // stays visible after the first submission and a second `toBeVisible()`
    // would pass before the second submission had landed -- which is exactly
    // how this walk first went red (one row where it expected two). The row
    // count only changes when the database has the row.
    await expect(requester.getByTestId("own-request")).toHaveCount(1);
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
    await expect(requester.getByTestId("own-request")).toHaveCount(2);
    const both = await dataSubjectRequests(manager.id);
    expect(both.map((r) => r.subject_scope)).toEqual(["account", "workspace_records"]);
    const processorId = both[1].id;

    // ---- 2b. A THIRD, SO THERE IS ONE TO ANSWER ---------------------------
    // The walk used to stop at two, and both of them ended in a state where
    // the operator's row SURVIVES (`in_progress`, `routed`). The two
    // transitions that close a request -- the ones whose confirmation was
    // never rendered to anybody (I6) -- had no browser coverage at all.
    await requester.getByRole("radio", { name: "Correct something wrong (rectification)" }).check();
    await requester.getByRole("radio", { name: "My GetSetPaid account" }).check();
    await requester
      .getByLabel("Tell us what you want")
      .fill("My surname is spelled wrong on my profile. It should be Mullins.");
    await requester.getByRole("button", { name: "Send this request" }).click();
    await expect(requester.getByTestId("own-request")).toHaveCount(3);
    const all = await dataSubjectRequests(manager.id);
    const rectificationId = all[2].id;

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
    // `exact`, because the signed-in footer this layout also renders carries
    // "Your data requests" -- the requester's half of the same feature.
    await operator.getByRole("link", { name: "Data requests", exact: true }).click();
    await expect(operator).toHaveURL(/\/super\/data-requests$/);
    await expect(
      operator.getByRole("heading", { level: 1, name: "Data requests" }),
    ).toBeVisible();

    const queueRows = operator.getByTestId("dsr-row");
    await expect(queueRows).toHaveCount(3);
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

    // AN ACCOUNT-SCOPE ROW OFFERS NO "PASS TO THE BUSINESS" (M7): the database
    // always answers not_a_processor_request, so the control could only ever
    // produce an error. Asserted on the row that HAS the other controls, so it
    // is the scope filter being measured and not an unrendered row.
    await expect(queueRows.nth(0).getByRole("button", { name: "Mark answered" })).toBeVisible();
    await expect(
      queueRows.nth(0).getByRole("button", { name: "Pass to the business" }),
    ).toHaveCount(0);

    // ---- 5b. THE PROCESSOR ONE IS PASSED ON (Q132), AND SAYS WHAT THAT MEANS
    const processorRow = operator
      .getByTestId("dsr-row")
      .filter({ hasText: "A promoter has me saved as a contact" });
    await processorRow.getByRole("button", { name: "Pass to the business" }).click();

    // The operator reads that the product sends nothing (Q160a) -- verbatim
    // from lib/dsr/contract.ts, so the copy and this assertion cannot drift.
    await expect(processorRow.getByText(ROUTING_SENDS_NOTHING)).toBeVisible();

    await processorRow.getByLabel("Workspace slug").fill(world.orgSlug);
    await processorRow
      .getByLabel("How you told the workspace")
      .fill("Emailed the workspace Owner on the day this was received.");

    // FIRST PRESS: NOTHING IS WRITTEN. The workspace is resolved and its NAME
    // is shown for the operator to check -- a slug is typed, and a typo that
    // matches a different real workspace used to be uncorrectable.
    const routedRowCountBefore = (await dataSubjectRequests(manager.id)).filter(
      (r) => r.status === "routed",
    ).length;
    await processorRow.getByRole("button", { name: "Pass it on" }).click();
    const confirmation = processorRow.getByTestId("dsr-routing-confirm");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(world.orgName);
    expect(
      (await dataSubjectRequests(manager.id)).filter((r) => r.status === "routed").length,
      "the first press wrote a routing before the operator had confirmed the workspace",
    ).toBe(routedRowCountBefore);

    // SECOND PRESS: now it is recorded, and the confirmation names the
    // workspace and says nothing was sent.
    await processorRow.getByRole("button", { name: `Pass it on to ${world.orgName}` }).click();
    await expect(operator.getByText(`Recorded as passed to ${world.orgName}`)).toBeVisible();
    await expect(operator.getByText("Nothing was sent")).toBeVisible();

    const afterRouting = await dataSubjectRequests(manager.id);
    expect(afterRouting.find((r) => r.id === processorId)).toMatchObject({
      status: "routed",
      routed_to_organisation_id: world.orgId,
      routed_to_organisation_name: world.orgName,
    });

    // ---- 5c. AND ONE IS ANSWERED -- THE CONFIRMATION I6 SAYS NOBODY SAW ----
    // The default view lists OPEN requests only, so this is the exact shape of
    // the defect: the row goes, and before the fix the message went with it.
    const rectificationRow = operator
      .getByTestId("dsr-row")
      .filter({ hasText: "My surname is spelled wrong" });
    await rectificationRow.getByRole("button", { name: "Mark answered" }).click();
    await expect(
      operator.getByText("Marked Answered."),
      "answering a request must be confirmed to the operator, not answered by the row vanishing",
    ).toBeVisible();
    await expect(
      operator.getByTestId("dsr-row").filter({ hasText: "My surname is spelled wrong" }),
      "an answered request must leave the open-only queue",
    ).toHaveCount(0);
    expect(
      (await dataSubjectRequests(manager.id)).find((r) => r.id === rectificationId)?.status,
    ).toBe("fulfilled");

    // ---- 6. THE ALERT NOBODY HAD TO GO LOOKING FOR -------------------------
    const written = await raiseDsrDeadlineAlerts();
    expect(written, "the overdue request must raise an alert").toBeGreaterThanOrEqual(1);
    await operator.goto("/super/health");
    // The label appears twice on this page -- once as an <option> in the
    // alert-type filter and once on the row itself. The row is the one that
    // means an alert was written, so match its line rather than the filter's.
    await expect(operator.getByText(/Data request OVERDUE\s+·/)).toBeVisible();
    await expect(operator.getByText(requestId)).toBeVisible();
    // The alert carries identifiers only -- never what the person wrote.
    await expect(operator.locator("body")).not.toContainText(detail);

    // ---- 6b. THE SCAN, WITH THE REVEAL FORMS ACTUALLY IN THE TREE ---------
    // Review finding M4. Both reveal forms are OPENED and asserted visible
    // first: the refusal textarea with its warning, and the routing form on
    // the request that was just passed on (a routed request stays routable so
    // a wrong workspace is correctable, Q160c). Before this the scan ran with
    // neither in the DOM while its comment claimed one of them.
    await operator.goto("/super/data-requests");
    const overdueRow = operator.getByTestId("dsr-row").filter({ hasText: detail });
    await overdueRow.getByRole("button", { name: "Refuse this request" }).click();
    const reasonField = overdueRow.getByLabel("Why this request is refused");
    await expect(reasonField).toBeVisible();
    // The Q103 warning: the requester reads this text exactly as typed.
    await expect(overdueRow.getByText(REJECTION_REASON_WARNING)).toBeVisible();

    const routedRow = operator
      .getByTestId("dsr-row")
      .filter({ hasText: "A promoter has me saved as a contact" });
    await routedRow.getByRole("button", { name: "Correct the workspace" }).click();
    await expect(routedRow.getByLabel("Workspace slug")).toBeVisible();
    await expect(routedRow.getByLabel("How you told the workspace")).toBeVisible();

    // Scanned WITH rows, an overdue chip, a note, the transition controls and
    // TWO open reveal forms in the tree.
    await scan(operator);

    // ---- 6c. REFUSING, THROUGH THE REAL STEP-UP GATE ----------------------
    // The operator's credential is minutes old (the TOTP challenge above), so
    // the gate is satisfied rather than bypassed -- tests/unit/dsr/
    // admin-actions.test.ts drives the stale side, which a browser cannot
    // reach without waiting five minutes.
    const rejectionReason =
      "Refused under UK GDPR Art 12(5)(b): this is the fourth identical request this week.";
    await reasonField.fill(rejectionReason);
    // `.last()`: the reveal button and the form's submit share an accessible
    // name, and the submit is the later of the two in the DOM.
    await overdueRow.getByRole("button", { name: "Refuse this request" }).last().click();
    await expect(
      operator.getByText("Marked Refused."),
      "refusing a statutory request, after a step-up prompt, must be confirmed in words",
    ).toBeVisible();
    await expect(
      operator.getByTestId("dsr-row").filter({ hasText: detail }),
      "a refused request must leave the open-only queue",
    ).toHaveCount(0);
    expect(
      (await dataSubjectRequests(manager.id)).find((r) => r.id === requestId),
    ).toMatchObject({ status: "rejected", rejection_reason: rejectionReason });

    // ---- 7. THE REQUESTER SEES THE NEW STATE, AND NEVER THE NOTE ----------
    await requester.reload();
    const rows = requester.getByTestId("own-request");
    await expect(rows).toHaveCount(3);
    await expect(requester.getByText("Passed to the business", { exact: true })).toBeVisible();
    await expect(requester.getByText("Refused", { exact: true })).toBeVisible();
    await expect(requester.getByText("Answered", { exact: true })).toBeVisible();

    // THE REASON, VERBATIM AND INERT (it is operator-typed text).
    await expect(requester.getByTestId("own-request-rejection")).toHaveText(rejectionReason);

    // "WE HAVE ASKED", AND WHO (Q160b). The page used to say "We passed this
    // to the business ... It is the one that must answer you" and name
    // nobody -- a statement of delivery, for a product that sends nothing.
    const routedNotice = requester.getByTestId("own-request-routed");
    await expect(routedNotice).toContainText("We have asked");
    await expect(routedNotice).toContainText(world.orgName);
    await expect(
      requester.locator("body"),
      "the requester must not be told their request was DELIVERED to anybody",
    ).not.toContainText("We passed this to the business");

    await expect(
      requester.locator("body"),
      "THE Q103 ASSERTION: the operator's note must not reach the requester's page",
    ).not.toContainText(noteText);
    await expect(
      requester.locator("body"),
      "nor may the handover note the routing wrote -- it is an operator note like any other",
    ).not.toContainText("Emailed the workspace Owner");

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
    // SORTED, NOT IN ORDER, FOR ONE ROW ONLY: routing writes its mandatory
    // handover note in the SAME transaction as the routing (Q160a), so those
    // two rows share a transaction timestamp and the query's tiebreak is a
    // random uuid. The first three are ordered (three separate submissions),
    // and the rest is a multiset.
    expect(actions.slice(0, 3)).toEqual([
      "data_subject_request.submitted",
      "data_subject_request.submitted",
      "data_subject_request.submitted",
    ]);
    expect([...actions].sort()).toEqual(
      [
        "data_subject_request.submitted",
        "data_subject_request.submitted",
        "data_subject_request.submitted",
        "data_subject_request.note_added",
        "data_subject_request.note_added",
        "data_subject_request.in_progress",
        "data_subject_request.routed",
        "data_subject_request.fulfilled",
        "data_subject_request.rejected",
        "data_subject_request.withdrawn",
      ].sort(),
    );
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

// The aal1 superuser does NOT get the streamed not-found document, and that is
// correct rather than a gap: the MFA gate in app/(app)/layout.tsx swaps
// <main> for the challenge screen before any page under it renders at all, so
// the refusal it meets is the challenge, not the 404. platform-health.spec.ts
// asserts this same shape for the same reason. What matters is that no queue
// content is reachable.
test("an aal1 superuser session reaches no request queue", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(world.superuser.email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const challenge = page.getByRole("heading", { name: "Enter your two-factor code" });
  await expect(
    challenge,
    "the superuser must be CHALLENGED, or this principal is not aal1 and the refusal proves nothing",
  ).toBeVisible();
  await page.goto("/super/data-requests");
  await expect(challenge, "an aal1 superuser session must not reach the queue").toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Data requests" })).toHaveCount(0);
  await expect(page.getByTestId("dsr-row")).toHaveCount(0);
});
