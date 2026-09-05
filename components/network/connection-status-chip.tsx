import {
  CONNECTION_STATUS_LABELS,
  CONNECTION_STATUS_TONE,
  type ConnectionStatus,
} from "@/lib/network/fields";

// The pending / accepted / declined / withdrawn chip for a connection request
// (Q79). Same shape as ProfileStatusChip and VisibilityChip -- a hairline box
// carrying its own text label, never colour alone (DESIGN.md's status rule).

const TONE_CLASS: Record<
  (typeof CONNECTION_STATUS_TONE)[ConnectionStatus],
  string
> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

export function ConnectionStatusChip({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className={
        "inline-flex items-center border px-2 py-0.5 text-xs font-semibold " +
        "tracking-wide uppercase whitespace-nowrap " +
        TONE_CLASS[CONNECTION_STATUS_TONE[status]]
      }
    >
      {CONNECTION_STATUS_LABELS[status]}
    </span>
  );
}
