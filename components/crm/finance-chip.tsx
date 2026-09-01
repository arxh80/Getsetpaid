import {
  FINANCE_CATEGORY_LABELS,
  FINANCE_CATEGORY_TONE,
  FINANCE_STATUS_LABELS,
  FINANCE_STATUS_TONE,
  type FinanceCategory,
  type FinanceStatus,
  type FinanceTone,
} from "@/lib/crm/finance-category";

// The finance category and status chips.
//
// The same discipline as components/crm/task-status-chip.tsx and
// priority-chip.tsx: the LABEL is the information and the colour is
// reinforcement (DESIGN.md § Working palette forbids colour-only status), a
// hairline box rather than a filled pill (--radius: 0, no shadow, no gradient),
// and EVERY TONE IS AN EXISTING TOKEN so this component adds no colour and
// `python scripts/contrast.py` stays at 16 rows. `active` pairs an ACCENT
// border with INK text -- never accent text, which DESIGN.md § Two blues
// forbids. FinanceTone is the same union as OperationsTone, so this TONE_CLASS
// is byte-identical to those two files on purpose.

const TONE_CLASS: Record<FinanceTone, string> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

const CHIP =
  "inline-flex items-center border px-2 py-0.5 " +
  "text-xs font-semibold tracking-wide uppercase whitespace-nowrap ";

export function FinanceCategoryChip({ category }: { category: FinanceCategory }) {
  return (
    <span className={CHIP + TONE_CLASS[FINANCE_CATEGORY_TONE[category]]}>
      {FINANCE_CATEGORY_LABELS[category]}
    </span>
  );
}

export function FinanceStatusChip({ status }: { status: FinanceStatus }) {
  return (
    <span className={CHIP + TONE_CLASS[FINANCE_STATUS_TONE[status]]}>
      {FINANCE_STATUS_LABELS[status]}
    </span>
  );
}
