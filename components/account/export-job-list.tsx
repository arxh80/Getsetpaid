import Link from "next/link";
import {
  EXPORT_STATUS_LABELS,
  archiveIsDownloadable,
  describeArchiveLife,
  type ExportStatus,
  isUuid,
} from "@/lib/export/contract";
import type { OwnExportJob } from "@/lib/export/jobs";
import { formatDateTime } from "@/lib/format/date";
import { StatusChip } from "@/components/ui/ruled-row";

// The list both export pages render. A server component: it draws what the
// database says and owns no state.
//
// WHAT IT IS CAREFUL ABOUT: the download link is drawn only for an archive
// that is still downloadable, and that is a CONVENIENCE rather than the
// control — the route refuses an expired or unfinished archive server-side
// with a 404 whether or not a link was ever rendered. The manifest's
// "withheld" list is shown in full, because an export that quietly left
// something out is the failure a statutory access response cannot have.

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(EXPORT_STATUS_LABELS, status)
    ? EXPORT_STATUS_LABELS[status as ExportStatus]
    : status;
}

export function ExportJobList({
  jobs,
  truncated,
  archiveDays,
  emptyText,
}: {
  jobs: readonly OwnExportJob[];
  truncated: boolean;
  archiveDays: number;
  emptyText: string;
}) {
  if (jobs.length === 0) {
    return (
      <p className="max-w-prose text-base text-ink-muted" data-testid="no-exports">
        {emptyText}
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col border-t border-rule">
        {jobs.map((job) => {
          const downloadable = archiveIsDownloadable(job.status, job.expiresAt);
          return (
            <li
              key={job.id}
              className="flex flex-col gap-3 border-b border-rule py-5"
              data-testid="export-job"
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
              </div>

              {job.status === "succeeded" ? (
                <p className="text-base text-ink-muted tabular-nums">
                  {job.rowCount ?? 0} records across {job.tableCount ?? 0} tables
                  {job.byteSize === null ? "" : `, ${humanBytes(job.byteSize)}`}.{" "}
                  {job.expiresAt === null ? null : (
                    <>
                      Kept for {describeArchiveLife(archiveDays)} — until{" "}
                      {formatDateTime(job.expiresAt)}.
                    </>
                  )}
                </p>
              ) : null}

              {job.status === "failed" && job.failureReason ? (
                <p className="max-w-prose text-base text-ink-muted">{job.failureReason}</p>
              ) : null}

              {downloadable && isUuid(job.id) ? (
                <Link
                  href={`/account/exports/${job.id}/download`}
                  prefetch={false}
                  className="self-start underline underline-offset-4 hover:text-ink"
                  data-testid="export-download"
                >
                  Download the archive
                </Link>
              ) : null}

              {job.status === "succeeded" && !downloadable ? (
                <p className="text-base text-ink-muted">
                  This archive has expired and its file has been removed from the download
                  page. Start a new export to get a fresh copy.
                </p>
              ) : null}

              {job.manifest && job.manifest.withheld.length > 0 ? (
                <details className="max-w-prose">
                  <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
                    What is not in this archive ({job.manifest.withheld.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {job.manifest.withheld.map((w) => (
                      <li key={`${w.what}-${w.reason}`} className="text-sm text-ink-muted">
                        <span className="font-semibold text-ink">{w.what}</span> — {w.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      {truncated ? (
        <p className="text-sm text-ink-muted">
          Only your most recent exports are shown.
        </p>
      ) : null}
    </>
  );
}
