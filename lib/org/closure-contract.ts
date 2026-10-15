// The Owner's "Close this workspace" flow (Phase 8 Task 9c job 3b; founder
// 2026-09-30, Q176/Q178, reversing Q104): its PURE half -- the messages, the
// form's shape check and the mapping from public.close_my_workspace()'s HINT
// to a sentence. No `server-only` and no Supabase import, so the unit suite
// drives it directly and the "use server" module beside it
// (./closure-actions.ts) exports nothing but its one async action.
//
// NOTHING HERE IS THE ENFORCEMENT. The RPC (20261021000000) checks, in the
// database and in this order: a session, aal2, an ACTIVE `owner` membership
// row of that workspace (so an impersonating superuser cannot close it), that
// it is still active, that the confirmation is the slug EXACTLY (no trimming,
// no case-folding), and that the reason is trimmed, non-blank and at most 500
// characters. This file mirrors those checks only so a person gets a sentence
// instead of a round trip.

export const CLOSE_REASON_MAX = 500;

export const CLOSE_MESSAGES = {
  notOwner: "Only an Owner of this workspace can close it.",
  stepUp:
    "Confirm it’s you before closing this workspace. Use the re-authentication prompt in this section, then try again.",
  aal2:
    "Closing a workspace needs two-step verification on this session. Enter your authentication code, then try again.",
  notActive:
    "This workspace is already read-only, so it can’t be closed from here. Reload the page to see its current state.",
  confirmMismatch:
    "Type the workspace’s URL name exactly — same letters, same case, no spaces — to confirm.",
  reasonRequired:
    "Give a reason. GetSetPaid reads it before deciding what happens to the workspace, and everyone in it sees it on the read-only banner.",
  reasonTooLong: `Keep the reason to ${CLOSE_REASON_MAX} characters or fewer.`,
  failed: "The workspace could not be closed just now. Nothing has changed — please try again.",
} as const;

export const CLOSED_MESSAGE =
  "The workspace is closed. Everyone in it now sees it as read-only, a full backup is being taken, and GetSetPaid has been told.";

type CloseFieldErrors = { confirmSlug?: string; reason?: string };

/** The form's fields, shape-checked against the RPC's own rules. */
export type CloseFormCheck =
  | { readonly ok: true; readonly confirmation: string; readonly reason: string }
  | { readonly ok: false; readonly fieldErrors: CloseFieldErrors };

/**
 * The confirmation is compared RAW -- not through lib/forms' `field()`, which
 * trims -- because the RPC compares it raw: " my-slug" is refused there, so
 * accepting it here would only move the refusal one round trip later and give
 * it a worse sentence. The reason is trimmed, as the RPC trims it.
 */
export function checkCloseForm(formData: FormData, slug: string): CloseFormCheck {
  const rawConfirm = formData.get("confirmSlug");
  const confirmation = typeof rawConfirm === "string" ? rawConfirm : "";
  const rawReason = formData.get("reason");
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";

  const fieldErrors: CloseFieldErrors = {};
  if (confirmation !== slug) fieldErrors.confirmSlug = CLOSE_MESSAGES.confirmMismatch;
  if (reason === "") fieldErrors.reason = CLOSE_MESSAGES.reasonRequired;
  else if (reason.length > CLOSE_REASON_MAX) fieldErrors.reason = CLOSE_MESSAGES.reasonTooLong;

  if (fieldErrors.confirmSlug || fieldErrors.reason) return { ok: false, fieldErrors };
  return { ok: true, confirmation, reason };
}

/** The RPC's refusal as form state: a section-level error or a field error. */
export type CloseRefusal =
  | { readonly error: string }
  | { readonly fieldErrors: CloseFieldErrors };

/** Keyed on the RPC's own HINT (our text, never a user's). */
export function closeRefusalFor(error: { code?: string; hint?: string | null }): CloseRefusal {
  switch (error.hint) {
    case "close_needs_a_session":
      return { error: CLOSE_MESSAGES.failed };
    case "close_needs_step_up":
      return { error: CLOSE_MESSAGES.aal2 };
    case "close_needs_an_owner":
      return { error: CLOSE_MESSAGES.notOwner };
    case "workspace_not_active":
    // 20261028000000 (N1): the workspace changed between the locked read and
    // the UPDATE -- it is no longer active, which is the same sentence.
    case "lifecycle_changed_concurrently":
      return { error: CLOSE_MESSAGES.notActive };
    case "close_confirmation_mismatch":
      return { fieldErrors: { confirmSlug: CLOSE_MESSAGES.confirmMismatch } };
    case "close_reason_required":
      return { fieldErrors: { reason: CLOSE_MESSAGES.reasonRequired } };
    case "close_reason_too_long":
      return { fieldErrors: { reason: CLOSE_MESSAGES.reasonTooLong } };
  }
  if (error.code === "42501") return { error: CLOSE_MESSAGES.notOwner };
  return { error: CLOSE_MESSAGES.failed };
}

/** The section's anchor id, and where it lives: the export settings page. */
export const CLOSE_SECTION_ID = "close-workspace";

export function closeWorkspacePath(orgSlug: string): string {
  return `/${orgSlug}/settings/export#${CLOSE_SECTION_ID}`;
}

// ---------------------------------------------------------------------------
// Q228 Task 4: the closure backup on the Owner's page.
// ---------------------------------------------------------------------------

export const CLOSURE_BACKUP_FAILED_LINE =
  "Your backup could not be built. Contact us and we will help you get a copy of your data.";

/** Shown under a multi-part backup's list: the last part carries the index. */
export function PARTS_TOGETHER_LINE(n: number): string {
  return `These ${n} parts together are the whole backup. Part ${n} holds the index (its manifest.json lists every part).`;
}

/**
 * Where "Contact us" goes when the backup failed. With the one configured
 * support address (SECURITY.md § 13) it is a mailto whose subject carries the
 * workspace slug and the job id and NOTHING else -- no name, no record
 * content. Without one it is the contact page, which says so in words.
 * `address` has already passed lib/legal/contact's conservative pattern.
 */
export function closureBackupHelpHref(address: string | null, slug: string, jobId: string): string {
  if (address === null) return "/legal/contact";
  const subject = `Closure backup failed: ${slug} (job ${jobId})`;
  return `mailto:${address}?subject=${encodeURIComponent(subject)}`;
}
