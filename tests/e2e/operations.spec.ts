import { expect, test } from "@playwright/test";
import {
  crmAuditAllowlist,
  crmAuditRows,
  EVENT_NAMES,
  NOTE_BODIES,
  setUpWorld,
  taskLinkIdsFor,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn, signOut } from "./support/sign-in";

// THE PHASE 4 OPERATIONS GOLDEN PATH, WALKED.
//
// `CLAUDE.md` § Design names the golden path "create contact -> create event ->
// add artist -> add venue -> ADD A TASK -> view activity". Phase 2 walks the
// first stretch (`golden-path.spec.ts`), Phase 3 the events stretch
// (`events.spec.ts`); this is the "add a task" step and the activity it
// produces, plus the note-visibility payoff a source review cannot see.
//
// ===========================================================================
// WHY ONE SERIAL TEST FOR THE GOLDEN PATH
// ===========================================================================
// The sequence is the subject: a task that links to an event from a fresh
// creation, completes, and shows `task_completed` on THAT event's timeline is a
// claim about the chain, not about three independent screens. The
// note-visibility payoff also spans two sign-ins (author, then a second same-org
// user), which a single shared page walks in order. `mode: "serial"` keeps them
// from interleaving; the refusal tests after it are independent and stateless.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

test("a task links to an event, completes, and lands on the event timeline", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  // ---- /tasks -> NEW TASK --------------------------------------------------
  await page.goto(`/${world.orgSlug}/tasks`);
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "New task" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/tasks/new$`));

  const TASK_TITLE = "Golden ops task — advance the settlement";
  await page.locator('input[name="title"]').fill(TASK_TITLE);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/tasks/[0-9a-f-]+$`));
  const taskUrl = page.url();
  await expect(page.locator("main")).toContainText(TASK_TITLE);

  // ---- LINK IT TO THE FIXTURE EVENT ----------------------------------------
  // The grouped picker's option value is `event:<id>`; the linked row names the
  // event (Manager Night A) and offers an Unlink control that includes the name.
  await page
    .locator('select[name="target"]')
    .selectOption(`event:${world.managerOwnedEventId}`);
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.locator("main")).toContainText("Linked records");
  await expect(
    page.getByRole("button", { name: new RegExp(`Unlink ${EVENT_NAMES.managerOwned}`) }),
  ).toBeVisible();

  // ---- THE EVENT'S RELATED PANEL SHOWS IT ----------------------------------
  await page.goto(`/${world.orgSlug}/events/${world.managerOwnedEventId}`);
  await expect(
    page.getByRole("heading", { name: EVENT_NAMES.managerOwned }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText("Tasks, notes & documents");
  // The task is a link in the related panel's Tasks sub-list — exactly one row
  // for it (denominator: not "somewhere on the page").
  const panelTaskLink = page.getByRole("link", { name: TASK_TITLE });
  await expect(panelTaskLink).toHaveCount(1);

  // ---- COMPLETE IT ---------------------------------------------------------
  // There is no inline "complete" button; a task reaches `done` through its own
  // edit form, which stamps `completed_at` and drives the timeline branch.
  await page.goto(`${taskUrl}/edit`);
  await page.locator('select[name="status"]').selectOption("done");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/tasks/[0-9a-f-]+$`));

  // ---- THE EVENT TIMELINE SHOWS task_completed -----------------------------
  // Re-read the event page. The timeline is a named region; the completion is
  // ONE row (only this task was completed — the fixture task on the same event
  // is still open), asserted by rendered text with a denominator, no
  // conditional locator.
  await page.goto(`/${world.orgSlug}/events/${world.managerOwnedEventId}`);
  const timeline = page.getByRole("region", { name: /activity/i });
  await expect(timeline).toHaveCount(1);
  const completedRows = timeline.getByText("Task completed", { exact: true });
  await expect(completedRows).toHaveCount(1);
  // The one completion names this task.
  await expect(timeline).toContainText(`${TASK_TITLE} was completed`);

  // ---- PHASE 8 TASK 7 (Q122): THE SERVER-ACTION HALF OF THE AUDIT ---------
  // Every write above went through a real form and a real server action. The
  // database trigger must have recorded each exactly as it records the same
  // write sent straight at PostgREST
  // (tests/integration/security/crm-audit-no-content-leak-p3-6.test.ts):
  // one row per write, attributed to the Manager in this workspace, value
  // keys EXACTLY the database's allowlist for that target, and none of what
  // was typed. Read straight out of Postgres; nothing on a page could hide a
  // false negative here.
  const taskId = taskUrl.split("/").pop()!;
  const manager = world.users.manager.id;
  const taskRows = await crmAuditRows(taskId);
  expect(taskRows.map((r) => r.action)).toEqual(["task.created", "task.updated"]);
  const taskKeys = await crmAuditAllowlist("task");
  for (const r of taskRows) {
    expect(r.actor_user_id).toBe(manager);
    expect(r.organisation_id).toBe(world.orgId);
    expect(r.target_type).toBe("task");
    // A .created row carries every allowlisted column; an .updated row
    // carries the allowlisted columns that CHANGED -- never anything else.
    const keys = Object.keys((r.after as { values: object }).values).sort();
    const expected =
      r.action === "task.created"
        ? taskKeys
        : taskKeys.filter((k) => ((r.after as { changed: string[] }).changed ?? []).includes(k));
    expect(keys).toEqual(expected);
    expect(JSON.stringify(r)).not.toContain("advance the settlement");
  }
  const completion = taskRows[1];
  expect((completion.before as { values: Record<string, unknown> }).values.status).toBe("open");
  expect((completion.after as { values: Record<string, unknown> }).values.status).toBe("done");

  const linkIds = await taskLinkIdsFor(taskId);
  expect(linkIds, "DENOMINATOR: the Link button wrote one task_links row").toHaveLength(1);
  const linkRows = await crmAuditRows(linkIds[0]);
  expect(linkRows.map((r) => r.action)).toEqual(["task_link.created"]);
  expect(linkRows[0].actor_user_id).toBe(manager);
  expect(Object.keys((linkRows[0].after as { values: object }).values).sort()).toEqual(
    await crmAuditAllowlist("task_link"),
  );
  expect((linkRows[0].after as { values: Record<string, unknown> }).values.entity_id).toBe(
    world.managerOwnedEventId,
  );
});

test("a private note hides from a second same-org user; a company note does not", async ({
  page,
}) => {
  await signIn(page, world, "manager");

  // The author creates a PRIVATE note and a COMPANY note.
  await page.goto(`/${world.orgSlug}/notes/new`);
  const PRIVATE_BODY = "Golden ops PRIVATE note — only I should read this";
  await page.locator('textarea[name="body"]').fill(PRIVATE_BODY);
  await page.locator('select[name="visibility"]').selectOption("private");
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/notes/[0-9a-f-]+$`));
  const privateUrl = page.url();
  await expect(page.locator("main")).toContainText(PRIVATE_BODY);

  // PHASE 8 TASK 7 (Q122): the private note's creation through the real form
  // is ONE note.created row, attributed, with the allowlist's keys -- and its
  // body, which the page above proves was stored, is nowhere in it (the Q54
  // boundary on the superuser-readable surface).
  const noteRows = await crmAuditRows(privateUrl.split("/").pop()!);
  expect(noteRows.map((r) => r.action)).toEqual(["note.created"]);
  expect(noteRows[0].actor_user_id).toBe(world.users.manager.id);
  expect(noteRows[0].organisation_id).toBe(world.orgId);
  expect(Object.keys((noteRows[0].after as { values: object }).values).sort()).toEqual(
    await crmAuditAllowlist("note"),
  );
  expect((noteRows[0].after as { values: Record<string, unknown> }).values.visibility).toBe("private");
  expect(JSON.stringify(noteRows[0])).not.toContain("only I should read this");

  await page.goto(`/${world.orgSlug}/notes/new`);
  const COMPANY_BODY = "Golden ops COMPANY note — the whole workspace reads this";
  await page.locator('textarea[name="body"]').fill(COMPANY_BODY);
  await page.locator('select[name="visibility"]').selectOption("company");
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page).toHaveURL(new RegExp(`/${world.orgSlug}/notes/[0-9a-f-]+$`));
  const companyUrl = page.url();
  await expect(page.locator("main")).toContainText(COMPANY_BODY);

  // ---- THE PAYOFF: A SECOND SAME-ORG USER ----------------------------------
  await signOut(page);
  await signIn(page, world, "standard_user");

  // The private note is not this user's, so `loadNote` returns nothing under
  // RLS and the app renders the not-found document. The body must be ABSENT.
  // Since the loading-skeletons pass this record-level refusal streams as
  // HTTP 200 with the identical not-found body (the status line is flushed by
  // the loading boundary before the page's notFound() lands); 404-or-200,
  // never 403 -- the oracle equality lives in tenant-breakout.spec.ts's
  // REFUSAL PARITY test, whose families include notes.
  const privateResponse = await page.goto(privateUrl);
  const privateStatus = privateResponse?.status() ?? -1;
  expect(
    [200, 404],
    `private note must refuse for a non-author as 404 or a streamed ` +
      `not-found (200), never 403; got ${privateStatus}`,
  ).toContain(privateStatus);
  await expect(page.locator("body")).toContainText("Page not found");
  await expect(page.locator("body")).not.toContainText(PRIVATE_BODY);

  // The company note IS visible to the same second user.
  await page.goto(companyUrl);
  await expect(page.locator("main")).toContainText(COMPANY_BODY);

  // And the fixture private note, authored by the manager, is likewise absent —
  // the payoff holds for a note this test did not create as well.
  await expect(page.locator("body")).not.toContainText(NOTE_BODIES.managerPrivate);
});

test("a read-only member is refused at /tasks/new — the route, not just the button", async ({
  page,
}) => {
  // HIDING THE UI IS NOT ENFORCEMENT (`CLAUDE.md` § Permissions). The list
  // renders a disabled button; this reaches the ROUTE directly and asserts the
  // form is not served — the write gate renders the read-only note instead.
  await signIn(page, world, "read_only");
  await page.goto(`/${world.orgSlug}/tasks/new`);
  await expect(page.locator("main")).toContainText("Read-only");
  await expect(page.getByRole("button", { name: "Create task" })).toHaveCount(0);
});

test("a standard user is told their task list is scoped, not that it is empty", async ({
  page,
}) => {
  // A record-scoped role in a populated workspace must be told WHOSE records it
  // is seeing, never "No tasks yet" (the Task 3 defect, on the operations
  // entity this time). The fixture task is the manager's, so the standard
  // user's own list is empty — and the page must say scoped, not empty.
  await signIn(page, world, "standard_user");
  await page.goto(`/${world.orgSlug}/tasks`);
  await expect(page.locator("main")).toContainText(
    /assigned to you|Others in this workspace may see more/i,
  );
  await expect(page.locator("main")).not.toContainText("No tasks yet");
});
