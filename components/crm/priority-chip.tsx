import {
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_TONE,
  type OperationsTone,
  type TaskPriority,
} from "@/lib/crm/task-status";

// The task priority chip.
//
// The same rules as components/crm/task-status-chip.tsx: the label is the
// information and the colour is reinforcement (DESIGN.md § Working palette,
// "status must never be colour-only"), a hairline box rather than a pill, and
// every tone is an existing token so `python scripts/contrast.py` gains no row.
// `low` and `normal` are both muted on purpose — the ordinary case wants no
// colour — while `high` (warning) and `urgent` (danger) are the two that
// should catch the eye down a task list.

const TONE_CLASS: Record<OperationsTone, string> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

export function PriorityChip({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={
        "inline-flex items-center border px-2 py-0.5 " +
        "text-xs font-semibold tracking-wide uppercase whitespace-nowrap " +
        TONE_CLASS[TASK_PRIORITY_TONE[priority]]
      }
    >
      {TASK_PRIORITY_LABELS[priority]}
    </span>
  );
}
