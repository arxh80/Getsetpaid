import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  FINANCE_EVENT_NAMES,
  FINANCE_LINES,
  setUpWorld,
  tearDownWorld,
  type E2eWorld,
} from "./support/fixtures";
import { signIn } from "./support/sign-in";

// THE PHASE 5 FINANCE GOLDEN PATH, WALKED.
//
// A SIBLING OF `events.spec.ts` AND `operations.spec.ts`, NOT A REWRITE OF
// EITHER. `CLAUDE.md` § Design's "what of it ships today" sentence names three
// specs that each walk one phase's stretch of the golden path; this is the
// fourth, and whoever extends the sentence again adds a fifth rather than
// folding this one in.
//
// ===========================================================================
// WHAT ONLY A BROWSER CAN PROVE HERE
// ===========================================================================
// Task 4's psql/HTTP suite already proves the three finance gates at the
// DATABASE and PostgREST layers: `view_finance` on the SELECT policy,
// `manage_finance` + `finance_module` on the writes, aal2 folded into both
// through `public.has_permission()`. What no SQL assertion can see is the layer
// above them:
//
//   * whether the PAGE mounts the finance panel at all. The render gate is one
//     `financeReadable &&` in app/(app)/[orgSlug]/events/[eventId]/page.tsx --
//     a page-level decision, invisible to a policy test, and the reason a
//     Booker gets no panel MARKUP rather than an empty one (tenant-breakout
//     .spec.ts asserts that half).
//   * whether the SUMMARY a person reads matches the lines they just entered.
//     `event_finance_summary`'s category -> bucket mapping is correct in psql
//     and could still be rendered into the wrong column by the panel.
//   * whether a Pro-tier write is actually PERMITTED end to end. Every
//     organisation in the product today has no subscription row, so
//     `private.finance_module_organisations()`'s "not yet billed => not yet
//     gated" escape carries every existing test. This suite's Pro org has a
//     real `pro`/`active` row, so the write below passes the TIER TERM itself.
//
// ===========================================================================
// WHY ONE SERIAL TEST FOR THE WALK
// ===========================================================================
// The sequence is the subject: a budgeted fee and an actual income entered on
// one event, and a summary that reflects BOTH in the right cells, is a claim
// about the chain rather than about three independent screens. The Starter-tier
// test after it is independent and stateless -- it reads and writes a different
// organisation entirely -- but `mode: "serial"` keeps them from interleaving on
// the single worker this suite runs with.
test.describe.configure({ mode: "serial" });

let world: E2eWorld;

test.beforeAll(async () => {
  world = await setUpWorld();
});

test.afterAll(async () => {
  if (world) await tearDownWorld(world);
});

/** The panel itself: `<section aria-labelledby="finance-heading">` whose heading
 *  is the single word "Finance". `exact` matters -- Playwright's `name` option
 *  is a SUBSTRING match by default, so a loose "Finance" would also match a
 *  region called "Finance summary" and the count-0 assertions in
 *  tenant-breakout.spec.ts would be weaker than they read. */
function financePanel(page: Page): Locator {
  return page.getByRole("region", { name: "Finance", exact: true });
}

/** One cell of the budget-vs-actuals table: `column` 0 is Budgeted, 1 is Actual.
 *  Addressed through the row's `<th scope="row">` rather than by index, so
 *  re-ordering the three rows moves the assertion with them. */
function summaryCell(page: Page, row: string, column: 0 | 1): Locator {
  return page
    .getByRole("region", { name: "Budget versus actuals", exact: true })
    .locator("tbody tr")
    .filter({ has: page.locator(`th:text-is("${row}")`) })
    .locator("td")
    .nth(column);
}

/** The line list's own count paragraph -- "N finance lines · latest first". The
 *  FIRST `role="status"` inside the panel in DOM order; the others (the
 *  recovery notice, a form's Alert) come after it and only when they apply. */
function lineCount(page: Page): Locator {
  return financePanel(page).locator('p[role="status"]').first();
}

/** A chip inside one line's ROW HEADER, addressed by the line's description.
 *  Deliberately not the whole `<li>`: each row's collapsed `<details>` holds an
 *  edit form whose `<select>`s contain an `<option>` for every category and
 *  status, and `textContent` includes them, so a row that rendered NO chips
 *  would still satisfy an unscoped text assertion. */
function rowChip(page: Page, description: string, label: string): Locator {
  return financePanel(page)
    .locator("li")
    .filter({ hasText: description })
    .locator("> div")
    .first()
    .getByText(label, { exact: true });
}

/** Today, as an `<input type="date">` speaks it. `occurred_on` is a `date`
 *  column filed against a day, so there is no timezone conversion here -- the
 *  same reason lib/crm/finance.ts's validator takes the ISO string as-is. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Fill the ADD form and submit it.
 *
 * The controls are addressed by their `id`s (`add-finance-*`), which the panel
 * builds from a fixed `idPrefix` -- the EDIT forms use `edit-finance-<entryId>`,
 * so these ids can only ever match the add form. Nothing here is conditional:
 * every field is filled every time.
 */
async function addFinanceLine(
  page: Page,
  line: { category: string; status: string; amount: string; description: string },
): Promise<void> {
  await page.locator("#add-finance-category").selectOption(line.category);
  await page.locator("#add-finance-status").selectOption(line.status);
  await page.locator("#add-finance-amount").fill(line.amount);
  await page.locator("#add-finance-occurred").fill(todayIso());
  await page.locator("#add-finance-description").fill(line.description);
  await page.getByRole("button", { name: "Add finance line" }).click();
}

const GOLDEN_FEE = {
  category: "fee",
  status: "budgeted",
  amount: "2500",
  formatted: "£2,500.00",
  description: "Golden finance line — budgeted headliner fee",
};

const GOLDEN_INCOME = {
  category: "income",
  status: "actual",
  amount: "7,250.00",
  formatted: "£7,250.00",
  description: "Golden finance line — actual box office",
};

test("a Finance user budgets a fee, books the income, and reads the net", async ({
  page,
}) => {
  // A REAL TOTP CHALLENGE HAPPENS INSIDE THIS CALL. `finance` is an
  // MFA-required role, and 20260827210000 puts aal2 inside has_permission(), so
  // a password-only session would hold neither finance key and would find no
  // panel at all -- see ./support/sign-in.ts.
  await signIn(page, world, "finance");

  await page.goto(`/${world.proOrgSlug}/events/${world.proEventId}`);
  await expect(
    page.getByRole("heading", { name: FINANCE_EVENT_NAMES.goldenPath, level: 1 }),
  ).toBeVisible();

  // ---- THE PANEL IS THERE, AND IT IS EMPTY --------------------------------
  // The empty state is the denominator for everything below: the two lines this
  // test writes are the only lines this event will ever have, so the summary at
  // the end is a statement about exactly them.
  const panel = financePanel(page);
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText("No finance lines yet");
  await expect(summaryCell(page, "Gross", 0)).toHaveText("£0.00");
  await expect(summaryCell(page, "Gross", 1)).toHaveText("£0.00");
  await expect(summaryCell(page, "Expense", 0)).toHaveText("£0.00");
  await expect(summaryCell(page, "Expense", 1)).toHaveText("£0.00");

  // ---- A BUDGETED FEE -----------------------------------------------------
  await addFinanceLine(page, GOLDEN_FEE);
  await expect(panel).toContainText(GOLDEN_FEE.description);
  await expect(panel).toContainText(GOLDEN_FEE.formatted);

  // ---- AN ACTUAL INCOME ---------------------------------------------------
  await addFinanceLine(page, GOLDEN_INCOME);
  await expect(panel).toContainText(GOLDEN_INCOME.description);
  await expect(panel).toContainText(GOLDEN_INCOME.formatted);

  // ---- RE-READ THE PAGE ---------------------------------------------------
  // A plain GET, not the post-action re-render: the summary is a separate
  // query against `event_finance_summary`, and reading it on a fresh request is
  // what makes it a claim about what was STORED rather than about what the
  // Server Action happened to revalidate.
  await page.reload();
  await expect(panel).toContainText(GOLDEN_FEE.description);
  await expect(panel).toContainText(GOLDEN_INCOME.description);
  // A DENOMINATOR FOR THE SUMMARY. Two lines, and the list's own count says so
  // -- so the four cells below cannot be right by counting nothing. Asserted as
  // the WHOLE paragraph, not as a substring: "2 finance lines" is a substring of
  // "12 finance lines", and an assertion that survives a tenfold miscount is
  // not a denominator.
  await expect(lineCount(page)).toHaveText("2 finance lines · latest first");

  // THE CHIPS CARRY A TEXT LABEL, never colour alone (DESIGN.md § Working
  // palette). Scoped to each row's HEADER div rather than to the whole `<li>`:
  // the row's collapsed `<details>` holds an edit form whose `<select>`s contain
  // an `<option>` for every category and status, and those are in `textContent`
  // whether the disclosure is open or not -- so an unscoped text assertion here
  // would pass against a row rendering no chips at all.
  await expect(rowChip(page, GOLDEN_FEE.description, "Fee")).toHaveCount(1);
  await expect(rowChip(page, GOLDEN_FEE.description, "Budgeted")).toHaveCount(1);
  await expect(rowChip(page, GOLDEN_INCOME.description, "Income")).toHaveCount(1);
  await expect(rowChip(page, GOLDEN_INCOME.description, "Actual")).toHaveCount(1);

  // ---- THE PAYOFF: GROSS / EXPENSE / NET ----------------------------------
  // The mapping under test is `event_finance_summary`'s: gross = Σ income,
  // expense = Σ (fee + cost). A fee filed as BUDGETED therefore lands in the
  // budgeted EXPENSE cell and nowhere else; an income filed as ACTUAL lands in
  // the actual GROSS cell and nowhere else. Every zero below is as load-bearing
  // as every figure -- swap the mapping and a zero becomes a number.
  await expect(summaryCell(page, "Gross", 0)).toHaveText("£0.00");
  await expect(summaryCell(page, "Gross", 1)).toHaveText(GOLDEN_INCOME.formatted);
  await expect(summaryCell(page, "Expense", 0)).toHaveText(GOLDEN_FEE.formatted);
  await expect(summaryCell(page, "Expense", 1)).toHaveText("£0.00");

  // NET IS COMPUTED, NOT STORED (`netMinor`, lib/crm/finance-summary.ts), and
  // its sign is rendered as a WORD beside the figure so it is never colour
  // alone. Budgeted: 0 - 2500 = a deficit. Actual: 7250 - 0 = a surplus.
  await expect(summaryCell(page, "Net", 0)).toContainText("-£2,500.00");
  await expect(summaryCell(page, "Net", 0)).toContainText("deficit");
  await expect(summaryCell(page, "Net", 1)).toContainText(GOLDEN_INCOME.formatted);
  await expect(summaryCell(page, "Net", 1)).toContainText("surplus");
});

test("a Starter-tier workspace keeps its finance readable and refuses the write", async ({
  page,
}) => {
  // Q67, WALKED. "Downgrading a subscription makes features read-only or
  // limited; it must never silently delete data" (CLAUDE.md § Permissions), so
  // the SELECT policy carries no `finance_module` term while both write
  // policies do. The same person, holding the same `finance` role, in a
  // Starter-tier workspace instead of a Pro one -- so the tier is the only
  // thing that differs between this test and the one above.
  await signIn(page, world, "finance");
  await page.goto(`/${world.starterOrgSlug}/events/${world.starterEventId}`);
  await expect(
    page.getByRole("heading", { name: FINANCE_EVENT_NAMES.starter, level: 1 }),
  ).toBeVisible();

  // ---- THE READ SURVIVES --------------------------------------------------
  const panel = financePanel(page);
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText(FINANCE_LINES.starter.description);
  await expect(panel).toContainText(FINANCE_LINES.starter.formatted);
  await expect(summaryCell(page, "Expense", 0)).toHaveText(
    FINANCE_LINES.starter.formatted,
  );

  // ---- AND IT SAYS WHY IT IS READ-ONLY ------------------------------------
  // The sentence is `getFinanceWriteAccess`'s tier explanation, and the control
  // is DISABLED rather than hidden -- a hidden button explains nothing.
  await expect(panel).toContainText("Read-only.");
  await expect(panel).toContainText("Finance is a Pro feature");
  const submit = page.getByRole("button", { name: "Add finance line" });
  await expect(submit).toBeDisabled();

  // ---- HIDING UI IS NOT ENFORCEMENT (Constraint 12) -----------------------
  // The disabled attribute is a courtesy to a person, not a control: anyone
  // holding this session can strip it, and lib/crm/finance.ts's header says in
  // as many words that "the form can be submitted by anyone who ignores the
  // disabled attribute". So strip it, fill the form and submit for real. What
  // must refuse the write is `authoriseFinance`'s tier term -- and, behind it,
  // `financial_entries_insert_manage_finance`'s `finance_module` conjunct,
  // which is what refuses the same request made without this application.
  await page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add finance line" }) })
    .evaluate((form) => {
      for (const control of form.querySelectorAll("[disabled]")) {
        control.removeAttribute("disabled");
      }
    });
  await addFinanceLine(page, {
    category: "cost",
    status: "budgeted",
    amount: "12.34",
    description: "Starter tier must refuse this line",
  });

  // The refusal is the SAME sentence the disabled control carries -- two paths
  // disagreeing is how a user concludes one of them is wrong.
  const refusal = panel.getByRole("alert");
  await expect(refusal).toContainText("Finance is a Pro feature");

  // AND NOTHING WAS WRITTEN. The count is the denominator: a refusal that
  // returned the right sentence while inserting the row would satisfy every
  // assertion above.
  await page.reload();
  await expect(lineCount(page)).toHaveText("1 finance line · latest first");
  await expect(panel).not.toContainText("Starter tier must refuse this line");
});
