"use server";

// Documents: the file-security pipeline. Upload (authorise → sniff → store →
// scan) is below; download (issueDownloadUrl, called by the download Route
// Handler) and soft-delete (deleteDocumentAction) complete it. Every one of
// the three byte-actions — upload, download, delete — writes an audit row.
//
// ===========================================================================
// THE PIPELINE, IN ORDER, AND WHY EACH STEP IS WHERE IT IS
// ===========================================================================
//   authoriseOrg('manage_documents')  -- the permission gate. Its refusal, like
//       every refusal here, echoes the submitted values back (React 19 resets
//       a <form action>, and a refusal that also empties the form takes the
//       user's work twice). The RLS INSERT policy re-checks the same key in the
//       database, so hiding the button is not the control -- the refused write
//       is (Global Constraint 12).
//   sniffAndAllow(bytes, name)  -- the ALLOWLIST. A magic-byte content sniff,
//       not an extension/Content-Type check, because both of those are the
//       client's word. The SNIFFED mime is what gets stored; a PNG renamed
//       `.pdf` is stored as image/png, an .exe renamed `.pdf` is rejected.
//   buildStorageKey(org.id, documentId)  -- an OPAQUE `{org}/{doc}` key with no
//       filename and no user input, so there is no path-traversal or
//       cross-tenant surface in the key. The DB CHECK documents_storage_key_shape
//       is the second layer.
//   storage upload (service-role)  -- the bytes go to the PRIVATE `documents`
//       bucket through lib/supabase/storage.ts. The browser has no Storage
//       grant (storage.objects is deny-all fenced), so this is the one
//       server-mediated path in and out.
//   insert row `pending`  -- METADATA through the user's own RLS-bound client,
//       so the insert policy applies. { count: "exact" } -- a 204 is not a save.
//   getScanner().scan(bytes)  -- the malware verdict. SYNCHRONOUS at MVP for the
//       stub; a real SaaS would move this to a webhook (a documented seam, not
//       built now). 'infected' => scan_status 'quarantined'.
//   update to the terminal status + scanned_at  -- the row's scanned_at is set
//       IFF terminal (the DB CHECK), and a quarantined row is never handed a
//       signed URL (Task 5).
//
// ===========================================================================
// AUDIT: APP-SIDE, VIA A GUARDED RPC — AND WHY NOT A TRIGGER
// ===========================================================================
// SECURITY.md § 6/§ 7 require every upload, download and soft-delete to be
// audited. The sole write path into audit_events is private.log_audit_event,
// granted to NO client role; 20260902031000 ships public.audit_document_action,
// the thin RPC that reaches it, guarded so a caller can only write a row for an
// org they can view and a document that is really theirs. Every audit here goes
// through auditDocument() → that RPC on the caller's own RLS-bound client.
//
// This is APP-SIDE audit, unlike the Phase 2 hard-delete/merge TRIGGER
// (20260828141000). There the anon key makes a raw PostgREST DELETE reachable
// without the app, so the database is the only chokepoint. A document's BYTES
// have no such path: storage.objects is deny-all fenced (20260902030000) and
// service_role on the server is the only reader/writer, so the application is
// the only path in and out and an app-side audit is sufficient. The download
// audit in particular is written by the Route Handler BEFORE the signed URL is
// issued — no audit, no URL. See SECURITY.md § 7.

import { revalidatePath } from "next/cache";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createStorageClient } from "@/lib/supabase/storage";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { authoriseOrg, failureState } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { sanitiseFilename, sniffAndAllow } from "@/lib/security/file-allowlist";
import { buildStorageKey } from "@/lib/crm/storage-keys";
import { getScanner, type ScanResult } from "@/lib/security/malware-scan";

const PERMISSION = "manage_documents";

/** 25 MiB, the same ceiling as documents.size_bytes' CHECK and the bucket. */
const MAX_SIZE_BYTES = 26214400;

const NO_FILE = "Choose a file to upload.";
const TOO_BIG =
  "That file is larger than the 25 MiB limit. Upload a smaller file.";
const QUARANTINED =
  "That file didn’t pass the malware scan, so it can’t be opened. It has been quarantined and not attached.";
const SCAN_FAILED =
  "We couldn’t scan that file just now, so it hasn’t been made available. Try again in a moment.";

/** The documents.scan_status value for a scanner verdict. */
function statusForVerdict(verdict: ScanResult): "clean" | "quarantined" | "error" {
  switch (verdict) {
    case "clean":
      return "clean";
    case "infected":
      return "quarantined";
    case "error":
      return "error";
  }
}

/**
 * Upload one document: authorise, sniff, store the bytes, record the metadata,
 * scan, and land the row at its terminal scan status.
 *
 * `orgSlug` is passed explicitly (the Task 6 form will bind it) so this action
 * is drivable directly by Task 5's upload/scan/download integration test.
 */
export async function uploadDocumentAction(
  orgSlug: string | null,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(orgSlug, formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: NO_FILE, values: echoedValues(formData) };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { error: TOO_BIG, values: echoedValues(formData) };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // THE ALLOWLIST. Reject before a single byte reaches storage.
  const sniff = sniffAndAllow(bytes, file.name);
  if (!sniff.ok) {
    return { error: sniff.reason, values: echoedValues(formData) };
  }

  const filename = sanitiseFilename(file.name);
  const documentId = crypto.randomUUID();
  const storageKey = buildStorageKey(org.id, documentId);

  // THE BYTES -- service-role, because the bucket is client-fenced.
  const storage = createStorageClient();
  const uploaded = await storage.storage
    .from("documents")
    .upload(storageKey, Buffer.from(bytes), {
      contentType: sniff.mime,
      upsert: false,
    });
  if (uploaded.error) {
    console.error("[crm] document upload to storage failed:", uploaded.error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // THE METADATA -- through the caller's own RLS-bound client, so the INSERT
  // policy (manage_documents + entitlement + record scope) applies. Stored
  // pending; the scan verdict follows. owner_user_id is set explicitly though
  // the column defaults to auth.uid(), for the reason createEventAction states:
  // a write and a policy that agree only via a column default are one edit from
  // disagreeing.
  const supabase = await createClient();
  const inserted = await supabase
    .from("documents")
    .insert(
      {
        id: documentId,
        organisation_id: org.id,
        owner_user_id: user.id,
        filename,
        storage_key: storageKey,
        mime_type: sniff.mime,
        size_bytes: bytes.length,
        scan_status: "pending",
      },
      { count: "exact" },
    )
    .select("id")
    .single();

  if (inserted.error || !inserted.data) {
    // The row did not land, so the stored bytes are now an orphan -- remove
    // them rather than leave an unreferenced object in the bucket.
    await storage.storage.from("documents").remove([storageKey]);
    if (inserted.error?.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error(
      "[crm] document metadata insert failed:",
      inserted.error?.message ?? "no row returned",
    );
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // THE SCAN. Synchronous at MVP for the stub. A thrown scanner (an
  // unconfigured clamav/SaaS adapter) is fail-closed: treat it as 'error', so
  // the file is never made available on a scanner fault.
  let verdict: ScanResult;
  try {
    verdict = await getScanner().scan({ bytes });
  } catch (err) {
    console.error(
      "[crm] malware scan threw:",
      err instanceof Error ? err.message : String(err),
    );
    verdict = "error";
  }
  const scanStatus = statusForVerdict(verdict);

  // THE TERMINAL STATUS. scanned_at is set with it, satisfying
  // documents_scanned_at_iff_terminal. { count: "exact" } -- a 204 is not a save.
  const result = await commitWrite(`document ${documentId} scan-status`, () =>
    supabase
      .from("documents")
      .update(
        { scan_status: scanStatus, scanned_at: new Date().toISOString() },
        { count: "exact" },
      )
      .eq("organisation_id", org.id)
      .eq("id", documentId)
      .is("deleted_at", null),
  );
  if (result.outcome !== "applied") {
    // The bytes and the pending row both exist; the verdict just did not land.
    // A fault, logged by commitWrite. Do not claim success.
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // AUDIT. Exactly one row per upload: a malware hit is a 'document_quarantined'
  // event (it feeds incident alerting, SECURITY.md § 12), everything else is
  // 'document_uploaded'. Fail-closed: an audit fault must not report success on
  // an unaudited write, so it returns the fault sentence like any other.
  const auditAction =
    scanStatus === "quarantined" ? "document_quarantined" : "document_uploaded";
  if (!(await auditDocument(supabase, auditAction, org.id, documentId))) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidatePath(`/${org.slug}/documents`);

  if (scanStatus === "quarantined") {
    return { error: QUARANTINED, values: echoedValues(formData) };
  }
  if (scanStatus === "error") {
    return { error: SCAN_FAILED, values: echoedValues(formData) };
  }
  return { message: "Uploaded." };
}

// ===========================================================================
// AUDIT WRITER for the three byte-actions.
//
// One place, so upload, download and delete write the audit row the same way:
// public.audit_document_action on the caller's OWN RLS-bound client, so the
// actor is the signed-in user (log_audit_event forces auth.uid()) and the
// RPC's own guards apply (the caller must view the org and own the document).
// Returns false on a fault so every caller can fail closed -- an unaudited
// byte-action must never be reported as a success (SECURITY.md § 7).
// ===========================================================================
type DocumentAuditAction =
  | "document_uploaded"
  | "document_downloaded"
  | "document_deleted"
  | "document_quarantined";

async function auditDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  action: DocumentAuditAction,
  organisationId: string,
  documentId: string,
): Promise<boolean> {
  const { error } = await supabase.rpc("audit_document_action", {
    p_action: action,
    p_org: organisationId,
    p_document_id: documentId,
  });
  if (error) {
    console.error(`[crm] document audit (${action}) failed:`, error.message);
    return false;
  }
  return true;
}

// ===========================================================================
// DOWNLOAD: issue a short-lived signed URL, but only after authorisation and
// audit. Called by the download Route Handler.
//
// THE ORDER IS THE CONTROL (Global Constraint 12): load THROUGH RLS so a
// cross-tenant or absent id returns nothing and yields a 404 with no leak of
// existence; refuse anything but a `clean` verdict (the quarantine gate);
// AUDIT; only then sign. The signed URL is issued last, never before the audit
// -- no audit, no URL. Refusals are typed by the HTTP status the Route Handler
// returns, so a quarantined file is a 409 (it exists, it is being withheld) and
// an unreachable one is a 404 (as far as this caller is concerned it is not
// there at all).
// ===========================================================================

/** Signed-URL TTL, seconds. 60s (Q51): long enough to follow the redirect,
 *  short enough that a leaked URL is stale almost immediately. */
const SIGNED_URL_TTL_SECONDS = 60;

const STILL_UNAVAILABLE =
  "That file isn’t available to open. It may still be scanning, or it didn’t pass the malware scan.";

type DownloadOutcome =
  | { readonly ok: true; readonly url: string; readonly expiresAt: string }
  | { readonly ok: false; readonly status: 404 }
  | { readonly ok: false; readonly status: 409; readonly reason: string }
  | { readonly ok: false; readonly status: 500 };

/**
 * Resolve a document to a short-lived signed download URL, or a typed refusal.
 *
 * `documentId` is looked up through the caller's OWN client, so RLS decides
 * visibility: another tenant's id, a soft-deleted row, or one this record-scoped
 * user may not see all return nothing -> 404, indistinguishable from "never
 * existed", which is the point (no existence oracle).
 */
export async function issueDownloadUrl(
  orgSlug: string | null,
  documentId: string,
): Promise<DownloadOutcome> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 404 };
  if (!orgSlug) return { ok: false, status: 404 };

  // Membership: getCurrentOrg returns null for a slug the caller is not an
  // active member of -- same 404 as a missing document, no existence leak.
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { ok: false, status: 404 };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("storage_key, scan_status")
    .eq("organisation_id", org.id)
    .eq("id", documentId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    // 22P02 is an unparseable uuid in the URL: no such document, and there
    // never could be -- a 404, not a 500. Anything else is a real fault.
    if (error.code === "22P02") return { ok: false, status: 404 };
    console.error("[crm] document download lookup failed:", error.message);
    return { ok: false, status: 500 };
  }
  if (!data) return { ok: false, status: 404 };

  // THE QUARANTINE GATE. A pending/quarantined/error document never yields a
  // URL -- the byte is withheld until the scan says `clean`.
  if (data.scan_status !== "clean") {
    return { ok: false, status: 409, reason: STILL_UNAVAILABLE };
  }

  // AUDIT BEFORE THE URL. Every download is logged, and a logging fault
  // withholds the file rather than serving it unlogged.
  if (!(await auditDocument(supabase, "document_downloaded", org.id, documentId))) {
    return { ok: false, status: 500 };
  }

  // SIGN. Service-role, because the bucket is client-fenced. The URL is minted
  // only now, after authorisation (RLS) and audit.
  const storage = createStorageClient();
  const signed = await storage.storage
    .from("documents")
    .createSignedUrl(data.storage_key, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error(
      "[crm] createSignedUrl failed:",
      signed.error?.message ?? "no signed URL returned",
    );
    return { ok: false, status: 500 };
  }

  const expiresAt = new Date(
    Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  ).toISOString();
  return { ok: true, url: signed.data.signedUrl, expiresAt };
}

// ===========================================================================
// SOFT-DELETE. The row's deleted_at is set; the BYTES are deliberately NOT
// removed from the bucket -- soft-delete discipline (CLAUDE.md § Non-negotiable
// rules). A retention/GC job that purges the bytes of rows past retention is a
// documented Phase 8 follow-up (FOLLOW-UPS.md), not built here. { count:
// "exact" } because a 204 is not a save (lib/crm/write.ts), and audit after the
// row really moves.
// ===========================================================================
export async function deleteDocumentAction(
  orgSlug: string | null,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(orgSlug, formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const documentId = field(formData, "documentId");
  if (!documentId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const result = await commitWrite(`document ${documentId} soft-delete`, () =>
    supabase
      .from("documents")
      .update({ deleted_at: new Date().toISOString() }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", documentId)
      .is("deleted_at", null),
  );
  if (result.outcome !== "applied") {
    return failureState(result, formData);
  }

  if (!(await auditDocument(supabase, "document_deleted", org.id, documentId))) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  revalidatePath(`/${org.slug}/documents`);
  return { message: "Deleted." };
}
