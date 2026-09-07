import {
  SCAN_STATUS_LABELS,
  SCAN_STATUS_TONE,
  type OperationsTone,
  type ScanStatus,
} from "@/lib/crm/task-status";

// The document scan-status chip.
//
// ===========================================================================
// THE LABEL IS THE INFORMATION; THE COLOUR IS REINFORCEMENT
// ===========================================================================
// The same discipline as components/crm/task-status-chip.tsx and
// status-chip.tsx: DESIGN.md § Working palette forbids a status that is
// colour-only, so the label is rendered unconditionally and there is no
// dot-only variant. Printed in greyscale or read by somebody who cannot
// separate the tones, the chip still says "Quarantined" or "Scanning…".
//
// A HAIRLINE BOX, NOT A FILLED PILL (--radius: 0, no shadow, no gradient), and
// EVERY TONE IS AN EXISTING TOKEN (SCAN_STATUS_TONE maps to --warning /
// --success / --danger, all already measured), so this component adds no colour
// and `python scripts/contrast.py` is unchanged. `pending` and `error` share
// the warning tone deliberately and are told apart by the label — neither is a
// terminal-good state, so both earn the eye.
//
// A `<span>`, NOT A `<button>` AND NOT A LINK. Nothing about a scan status is
// interactive; whether a document can be OPENED is the download control's job
// (components/crm/document-row.tsx), which refuses anything but `clean`.

/** Tone -> tokens. A `Record` keyed on the union, so a new tone is a compile error. */
const TONE_CLASS: Record<OperationsTone, string> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

export function ScanStatusChip({ status }: { status: ScanStatus }) {
  return (
    <span
      className={
        "inline-flex items-center border px-2 py-0.5 " +
        "text-xs font-semibold tracking-wide uppercase whitespace-nowrap " +
        TONE_CLASS[SCAN_STATUS_TONE[status]]
      }
    >
      {SCAN_STATUS_LABELS[status]}
    </span>
  );
}
