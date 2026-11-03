import {
  ERASURE_STATUS_LABELS,
  summaryHeadline,
  type ErasureStatus,
} from "@/lib/erasure/contract";
import type { OwnErasureJob } from "@/lib/erasure/jobs";
import { formatDateTime } from "@/lib/format/date";
import { StatusChip } from "@/components/ui/ruled-row";

// What the person has asked for, and what happened. A server component: it
// draws what the database says and owns no state.
//
// A SUCCEEDED JOB IS ALMOST NEVER RENDERED HERE, and that is not a bug worth
// designing around: once the erasure completes, the account it belonged to
// does not exist, the session is invalid, and this page is unreachable. The
// succeeded branch is drawn for the operator's oversight read (the same
// policy admits them) and for the one-in-a-thousand render that happens
// between the commit and the next request.
//
// A FAILED job is the one this list really exists for: it is the only place
// somebody learns that nothing was deleted and why.

function statusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(ERASURE_STATUS_LABELS, status)
    ? ERASURE_STATUS_LABELS[status as ErasureStatus]
    : status;
}

export function ErasureJobList({
  jobs,
  emptyText,
}: {
  jobs: readonly OwnErasureJob[];
  emptyText: string;
}) {
  if (jobs.length === 0) {
    return (
      <p className="max-w-prose text-base text-ink-muted" data-testid="no-erasures">
        {emptyText}
      </p>
    );
  }

  return (
    <ul className="flex flex-col border-t border-rule">
      {jobs.map((job) => {
        const headline = summaryHeadline(job.summary);
        return (
          <li
            key={job.id}
            className="flex flex-col gap-3 border-b border-rule py-5"
            data-testid="erasure-job"
          >
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip
                tone={
                  job.status === "succeeded"
                    ? "active"
                    : job.status === "failed"
                      ? "revoked"
                      : "pending"
                }
              >
                {statusLabel(job.status)}
              </StatusChip>
              <span className="text-sm text-ink-muted tabular-nums">
                Asked for {formatDateTime(job.requestedAt)}
              </span>
              {job.completedAt ? (
                <span className="text-sm text-ink-muted tabular-nums">
                  Finished {formatDateTime(job.completedAt)}
                </span>
              ) : null}
            </div>
            {job.failureReason ? (
              <p className="max-w-prose text-base text-ink">{job.failureReason}</p>
            ) : null}
            {headline ? (
              <p className="max-w-prose text-base text-ink-muted">{headline}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
