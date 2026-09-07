"use client";

import { useActionState } from "react";
import { uploadDocumentFormAction } from "@/lib/crm/documents";
import { EMPTY_FORM_STATE } from "@/lib/forms";
import type { LinkEntityType } from "@/lib/crm/links";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

// The document upload control.
//
// ===========================================================================
// THE `accept` IS A HINT; THE SERVER ALLOWLIST IS THE CONTROL (rule 12)
// ===========================================================================
// The file input's `accept` narrows the OS picker to the types the product
// takes, which is a courtesy — a determined caller can still choose anything,
// or POST past the picker entirely. The enforcement is server-side:
// sniffAndAllow (lib/security/file-allowlist.ts) MAGIC-BYTE sniffs the bytes
// and rejects anything off the allowlist, and the malware scan quarantines the
// rest. So a renamed `.exe` is refused by the server whatever this attribute
// says. Hiding the wrong option is not the control; refusing the wrong upload
// is (Global Constraint 12), and both jobs are done.
//
// TWO NOTICES, BOTH BEFORE THE BUTTON:
//   * the 25 MiB cap — the same ceiling as documents.size_bytes' CHECK and the
//     bucket, stated so a too-big file is a sentence and not a silent refusal;
//   * "Files are scanned before they can be downloaded." — the scan notice, so
//     a freshly-uploaded file showing "Scanning…" and refusing to open is
//     expected behaviour, not a fault.
//
// UNCONTROLLED, so it works with JavaScript off (the whole-form default in this
// codebase). The file input carries a `key` that remounts it after each submit
// — a file input's value cannot be set programmatically, and without the
// remount a refused upload would leave the previous filename showing under a
// picker that no longer holds it (rule 11, the same reset the link picker's
// <select> needs).

/** The picker hint. Extensions only; the server sniff is the authority. */
const ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.docx,.xlsx,.pptx";

export function DocumentUpload({
  orgSlug,
  entity,
  compact,
}: {
  orgSlug: string;
  /**
   * When present, the upload also attaches the document to this CRM record (a
   * `document_links` row, written in the same action). Absent on the org-wide
   * /documents page, which creates just the document.
   */
  entity?: { type: LinkEntityType; id: string };
  /** A tighter layout for the related panel; the /documents page uses the full one. */
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    uploadDocumentFormAction,
    EMPTY_FORM_STATE,
  );
  const fileId = compact ? "related-document-file" : "document-file";
  const errorId = `${fileId}-error`;
  const noticeId = `${fileId}-notice`;
  const invalid = Boolean(state.error);

  return (
    <form
      action={formAction}
      className={
        "flex flex-col gap-3 border border-rule p-4" + (compact ? "" : " bg-surface")
      }
    >
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="orgSlug" value={orgSlug} />
      {entity ? (
        <>
          <input type="hidden" name="entityType" value={entity.type} />
          <input type="hidden" name="entityId" value={entity.id} />
        </>
      ) : null}

      <label htmlFor={fileId} className="text-sm font-semibold text-ink">
        {entity ? "Attach a file" : "Upload a file"}
      </label>

      <input
        // rule 11: remount to empty after each submit; a file input's value
        // cannot be restored on React's post-action reset.
        key={`file:${state.error ?? ""}:${state.message ?? ""}`}
        id={fileId}
        type="file"
        name="file"
        accept={ACCEPT}
        required
        aria-describedby={invalid ? `${errorId} ${noticeId}` : noticeId}
        aria-invalid={invalid ? true : undefined}
        className={
          "w-full min-w-0 border bg-surface px-3 py-2 text-base text-ink " +
          "file:mr-3 file:border file:border-rule file:bg-shell file:px-3 file:py-1 " +
          "file:text-sm file:font-semibold file:text-ink " +
          "transition-colors duration-[var(--dur-fast)] ease-brand " +
          (invalid ? "border-danger" : "border-rule hover:border-ink focus:border-accent")
        }
      />

      <p id={noticeId} className="max-w-prose text-sm text-ink-muted">
        Up to 25&nbsp;MiB. PDF, image (PNG, JPEG, WebP, GIF), plain text, CSV, or
        a Word, Excel or PowerPoint document.{" "}
        <span className="text-ink">
          Files are scanned before they can be downloaded.
        </span>
      </p>

      <div>
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Uploading…">
          {entity ? "Attach file" : "Upload"}
        </Button>
      </div>
    </form>
  );
}
