import type { ImpersonationStatus } from "@/lib/admin/impersonation-list";

// The status chip for one impersonation session, in the same shape every
// other status chip in this codebase uses (ProfileStatusChip,
// FinanceStatusChip, TaskStatusChip): the WORD plus a hairline box, never
// colour alone -- DESIGN.md, "status must never be colour-only".
//
// THE CALLER PASSES displayStatus(row), NOT row.status.
// lib/admin/impersonation-list.ts's displayStatus() collapses an 'active' row
// whose clock has run out to 'expired', because the database's `status`
// column is bookkeeping and `expires_at` is the enforcement (20260908020000).
// A chip reading "Active" on a session that grants nothing would be the UI
// claiming access that does not exist, which is the one direction a status
// label must never be wrong in.

const LABELS: Record<ImpersonationStatus, string> = {
  requested: "Awaiting the workspace",
  accepted: "Accepted — not started",
  declined: "Declined",
  active: "Active",
  ended: "Ended",
  expired: "Expired",
};

const TONE: Record<ImpersonationStatus, string> = {
  requested: "border-warning text-warning",
  accepted: "border-accent text-ink",
  declined: "border-rule text-ink-muted",
  // The one state in which a customer's data is actually reachable. Danger,
  // not success: "a session is open" is a thing to notice, not a thing to be
  // pleased about.
  active: "border-danger text-danger",
  ended: "border-rule text-ink-muted",
  expired: "border-rule text-ink-muted",
};

export function ImpersonationStatusChip({
  status,
}: {
  status: ImpersonationStatus;
}) {
  return (
    <span
      className={
        "inline-flex items-center border px-2 py-0.5 text-xs font-semibold " +
        "tracking-wide uppercase whitespace-nowrap " +
        TONE[status]
      }
    >
      {LABELS[status]}
    </span>
  );
}
