import {
  deleteDocumentFormAction,
  restoreDocumentAction,
} from "@/lib/crm/documents";
import type { ScanStatus } from "@/lib/crm/task-status";
import { formatDate } from "@/lib/format/date";
import {
  DeleteRecordForm,
  RestoreRecordForm,
} from "@/components/crm/delete-restore";

// The document row's two interactive affordances: the DOWNLOAD link and the
// soft-delete / restore controls. Server-composable — the download link is pure
// (no interactivity), and the delete/restore controls wrap the existing client
// DeleteRecordForm / RestoreRecordForm, so this file needs no "use client".
//
// Documents have NO detail page, so unlike every other entity these controls
// live INLINE in the list rows (delete on /documents, restore on
// /documents/deleted).

// ===========================================================================
// THE DOWNLOAD LINK — DISABLED WITH A REASON WHEN NOT CLEAN, AND THE SERVER
// REFUSES ANYWAY (rule 12)
// ===========================================================================
// Hiding a download link is not the control; refusing the signed URL is. So the
// two jobs are both done: this renders a real link ONLY for a `clean` document,
// and for anything else it renders inert text that says why — while the
// download Route Handler (issueDownloadUrl, Task 5) independently returns 409
// for a non-clean document even if the link is forged. A pending, quarantined
// or errored file cannot be opened from here and cannot be opened by URL either.
//
// A PLAIN <a>, NOT next/link, and NO safeHref. The href is an app-internal
// route built from the document's own uuid (never user content), so it needs no
// protocol validation — safeHref is for user-supplied URLs and would in fact
// null a relative path. It is a full navigation (not a client transition) so the
// browser follows the handler's 302 to the short-lived signed URL and downloads.

const REASON: Record<Exclude<ScanStatus, "clean">, string> = {
  pending: "Scanning — not ready to open yet",
  quarantined: "Quarantined — cannot be opened",
  error: "Scan failed — not available",
};

export function DocumentDownloadLink({
  orgSlug,
  documentId,
  filename,
  scanStatus,
}: {
  orgSlug: string;
  documentId: string;
  filename: string;
  scanStatus: ScanStatus;
}) {
  if (scanStatus === "clean") {
    return (
      <a
        href={`/${orgSlug}/documents/${documentId}/download`}
        className="font-semibold break-words text-primary underline underline-offset-4 hover:text-ink"
      >
        {filename}
      </a>
    );
  }
  // Inert, and it says why. The filename is still shown (it identifies the
  // record); the reason is both visible and, for a screen reader, spoken.
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold break-words text-ink-muted">{filename}</span>
      <span className="text-xs text-ink-muted">{REASON[scanStatus]}</span>
    </span>
  );
}

export function DocumentDeleteControl({
  orgSlug,
  documentId,
  filename,
  blocked,
  describedBy,
}: {
  orgSlug: string;
  documentId: string;
  filename: string;
  blocked: boolean;
  describedBy: string;
}) {
  return (
    <DeleteRecordForm
      action={deleteDocumentFormAction}
      hiddenFields={{ orgSlug, documentId }}
      label="Delete"
      // One delete control PER ROW (documents have no detail page), so the
      // accessible name must carry the filename or the page announces N
      // identical "Delete" buttons — delete-restore.tsx's own label contract.
      srSubject={filename}
      question={`Delete “${filename}”? You can restore it from Deleted documents.`}
      blocked={blocked}
      describedBy={describedBy}
    />
  );
}

export function DocumentRestoreControl({
  orgSlug,
  documentId,
  filename,
  blocked,
  describedBy,
}: {
  orgSlug: string;
  documentId: string;
  /** Per-row control — the filename disambiguates the accessible name, same
   *  as DocumentDeleteControl. */
  filename: string;
  blocked: boolean;
  describedBy: string;
}) {
  return (
    <RestoreRecordForm
      action={restoreDocumentAction}
      hiddenFields={{ orgSlug, documentId }}
      label="Restore"
      srSubject={filename}
      blocked={blocked}
      describedBy={describedBy}
    />
  );
}

/**
 * In place of Restore, for a deleted document whose file the retention job has
 * destroyed (Q185, founder 2026-09-30). Plain text, not a disabled button: a
 * disabled control implies a state that could change, and this one cannot.
 * The date is the UK local day (`formatDate`, Europe/London) of the UTC
 * `bytes_purged_at`, in a <time> carrying the instant itself.
 *
 * NOT THE CONTROL. `restoreDocumentAction` refuses a purged row on its own read
 * and the database refuses it for every writer
 * (`documents_purged_implies_deleted`); this only says so before anyone tries.
 */
export function DocumentPurgedNotice({ purgedAt }: { purgedAt: string }) {
  return (
    <p className="max-w-56 text-sm text-ink-muted">
      File deleted under the retention policy on{" "}
      <time dateTime={purgedAt}>{formatDate(purgedAt)}</time>
    </p>
  );
}
