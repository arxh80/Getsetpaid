// THE FINANCE VOCABULARIES, AND NOTHING ELSE.
//
// `financial_entries_category_check` and `financial_entries_status_check`
// (supabase/migrations/20260903000000_financial_entries.sql) are the
// enforcement -- a value outside either set is a 23514 at write time, for every
// writer including one that reaches PostgREST directly. These constants exist
// because a request cannot consult a CHECK constraint: the create/edit form's
// <select> and the filter inputs have to render and validate before any
// statement runs.
//
// BOUND TO THE DATABASE, NOT TRUSTED: Task 4's finance analogue of
// tests/integration/crm/operations-vocabularies-match-db.test.ts reads both
// CHECK definitions out of pg_constraint and asserts each set equals the tuple
// below. Adding a value in a migration without adding it here turns that test
// red naming this file, and vice versa. Same treatment as TASK_STATUSES,
// EVENT_STATUSES and the tier table.
//
// DELIBERATELY DATA + PRESENTATION, NO REACT -- mirrors lib/crm/task-status.ts.
// A tone is a NAME; the chip component (Task 2) maps the name to a DESIGN.md
// token, so this module stays importable from a Server Component, a Client
// Component and a vitest file alike. NOT `"use server"`.
//
// THE ORDER IS THE MIGRATION'S ORDER. The test sorts before comparing, because
// what has to match is the SET; the order is this file's to choose, and it is
// the order a form's <select> reads best in.

/**
 * The three finance categories. PRD § 6.7. Q58.
 *
 * `fee` is what the act is paid; `cost` is what the show costs to put on;
 * `income` is what the show takes. A cost and an income are told apart by the
 * category, NOT by the sign of amount_minor (which is non-negative).
 */
export const FINANCE_CATEGORIES = ["fee", "cost", "income"] as const;

export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];

/**
 * The two finance statuses, plan then reconciled. PRD § 6.7. Q59.
 *
 * `budgeted` is the plan; `actual` is what happened. MVP finance is exactly a
 * budget-vs-actuals sheet (CLAUDE.md § Scope discipline). `budgeted` is the
 * default -- a line is a plan until it is reconciled.
 */
export const FINANCE_STATUSES = ["budgeted", "actual"] as const;

export type FinanceStatus = (typeof FINANCE_STATUSES)[number];

// ===========================================================================
// THE PRESENTATION LAYER
// ===========================================================================
// Labels and chip TONES, in the same file as the constants they describe --
// exactly as task-status.ts holds TASK_STATUS_LABELS/TONE beside TASK_STATUSES.
// Still NO REACT.
//
// EVERY MAP IS A `Record` KEYED ON ITS UNION, so a value added to the CHECK and
// to the constant above makes the missing label and tone a COMPILE error here
// rather than an empty chip in a browser nobody opened.
//
// NO NEW COLOUR TOKEN. Every tone below is one DESIGN.md already measured
// (`--accent` for the active rail, plus --success/--warning/--danger/--rule),
// so `python scripts/contrast.py` gains no row. The chips render the label
// unconditionally, so colour is never the only signal -- DESIGN.md § Working
// palette.

/**
 * The chip tones a finance category or status can carry, as NAMES.
 *
 * The same tone vocabulary as lib/crm/task-status.ts's OperationsTone, so the
 * finance chips draw from the identical DESIGN.md token set and no new colour
 * is introduced. `active` is the accent BORDER with ink text (never accent
 * text, which DESIGN.md forbids); `muted` is the hairline-and-grey neutral.
 */
export type FinanceTone =
  | "active"
  | "muted"
  | "success"
  | "warning"
  | "danger";

/** The three categories as a human reads them. Sentence case (DESIGN.md voice). */
export const FINANCE_CATEGORY_LABELS: Record<FinanceCategory, string> = {
  fee: "Fee",
  cost: "Cost",
  income: "Income",
};

/**
 * The tone a category carries.
 *
 *   warning   fee     -- money going out to the act; the headline spend line.
 *   danger    cost    -- money going out to put the show on.
 *   success   income  -- money coming in.
 *
 * fee and cost are both outgoings and share no tone by accident: fee is the
 * artist spend a promoter watches first (warning), cost is the rest of the
 * outlay (danger, the one that decides whether the night loses money). The
 * LABEL is always the information -- DESIGN.md § Working palette forbids
 * colour-only status -- and the tone only reinforces it.
 */
export const FINANCE_CATEGORY_TONE: Record<FinanceCategory, FinanceTone> = {
  fee: "warning",
  cost: "danger",
  income: "success",
};

/** The two statuses as a human reads them. */
export const FINANCE_STATUS_LABELS: Record<FinanceStatus, string> = {
  budgeted: "Budgeted",
  actual: "Actual",
};

/**
 * The tone a status carries.
 *
 *   active    budgeted  -- still a plan; the accent rail marks the line that
 *                          has not been reconciled yet.
 *   success   actual    -- reconciled against what really happened.
 */
export const FINANCE_STATUS_TONE: Record<FinanceStatus, FinanceTone> = {
  budgeted: "active",
  actual: "success",
};

/** True iff `value` is a category the database will accept. */
export function isFinanceCategory(value: string | null): value is FinanceCategory {
  return value !== null && (FINANCE_CATEGORIES as readonly string[]).includes(value);
}

/** True iff `value` is a status the database will accept. */
export function isFinanceStatus(value: string | null): value is FinanceStatus {
  return value !== null && (FINANCE_STATUSES as readonly string[]).includes(value);
}
