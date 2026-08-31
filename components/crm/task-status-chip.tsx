import {
  MEETING_STATUS_LABELS,
  MEETING_STATUS_TONE,
  TASK_STATUS_LABELS,
  TASK_STATUS_TONE,
  type MeetingStatus,
  type OperationsTone,
  type TaskStatus,
} from "@/lib/crm/task-status";

// The task and meeting status chips.
//
// ===========================================================================
// THE LABEL IS THE INFORMATION; THE COLOUR IS REINFORCEMENT
// ===========================================================================
// The same discipline as components/crm/status-chip.tsx: DESIGN.md § Working
// palette forbids a status that is colour-only, so the label is rendered
// unconditionally and there is no dot-only variant. Printed in greyscale or
// read by somebody who cannot separate the tones, the chip still says
// "Blocked".
//
// A HAIRLINE BOX, NOT A FILLED PILL (--radius: 0, no shadow, no gradient), and
// EVERY TONE IS AN EXISTING TOKEN so this component adds no colour and
// `python scripts/contrast.py` is unchanged. The `active` tone is the one that
// is not `border-current`: it pairs an ACCENT border with INK text, because
// DESIGN.md permits `--accent` on a border and forbids it on text. That mirrors
// the "primary" chip in components/crm/link-panel.tsx exactly.

/** Tone -> tokens. A `Record` keyed on the union, so a new tone is a compile error. */
const TONE_CLASS: Record<OperationsTone, string> = {
  // Accent rail, ink label. Never accent text (DESIGN.md § Two blues).
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

const CHIP =
  "inline-flex items-center border px-2 py-0.5 " +
  "text-xs font-semibold tracking-wide uppercase whitespace-nowrap ";

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return (
    <span className={CHIP + TONE_CLASS[TASK_STATUS_TONE[status]]}>
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

export function MeetingStatusChip({ status }: { status: MeetingStatus }) {
  return (
    <span className={CHIP + TONE_CLASS[MEETING_STATUS_TONE[status]]}>
      {MEETING_STATUS_LABELS[status]}
    </span>
  );
}
