import {
  PROFILE_STATUS_LABELS,
  PROFILE_STATUS_TONE,
  type ProfileStatus,
} from "@/lib/network/fields";

// The draft / published chip for a network profile (Q81). Not named as its
// own deliverable in the brief, but the profiles list and the editor both
// need to say which state a profile is in, and DESIGN.md's status rule
// applies to it exactly as it does to VisibilityChip: never colour alone.
// draft/published is a two-way state, unlike the three-way visibility ladder,
// so the word plus a hairline box (the shape every OTHER status chip in this
// codebase uses -- FinanceStatusChip, StatusChip, TaskStatusChip) is
// sufficient; it does not carry the extra glyph the plan asks specifically of
// the visibility control.

const TONE_CLASS: Record<
  (typeof PROFILE_STATUS_TONE)[ProfileStatus],
  string
> = {
  active: "border-accent text-ink",
  muted: "border-rule text-ink-muted",
  success: "border-success text-success",
  warning: "border-warning text-warning",
  danger: "border-danger text-danger",
};

export function ProfileStatusChip({ status }: { status: ProfileStatus }) {
  return (
    <span
      className={
        "inline-flex items-center border px-2 py-0.5 text-xs font-semibold " +
        "tracking-wide uppercase whitespace-nowrap " +
        TONE_CLASS[PROFILE_STATUS_TONE[status]]
      }
    >
      {PROFILE_STATUS_LABELS[status]}
    </span>
  );
}
