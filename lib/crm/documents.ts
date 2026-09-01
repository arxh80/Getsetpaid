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
import { authoriseOrg, failureState, stateFor } from "@/lib/crm/actions";
import { commitWrite, FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { sanitiseFilename, sniffAndAllow } from "@/lib/security/file-allowlist";
import { buildStorageKey } from "@/lib/crm/storage-keys";
import { getScanner, type ScanResult } from "@/lib/security/malware-scan";
import { LINK_ENTITY_TYPES, type LinkEntityType } from "@/lib/crm/links";

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
const UPLOADED_NOT_ATTACHED =
  "The file uploaded, but it couldn’t be attached to this record. You’ll find it in Documents.";

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

  // ATTACH, when the upload came from an entity's related panel. The panel's
  // form carries hidden `entityType`/`entityId`; the org-wide /documents form
  // carries neither, so this branch is skipped there. The document row exists
  // and is `clean` by the time we reach here, so this is a single link INSERT,
  // NOT a re-upload -- the "atomic-enough" shape the brief asks for: the file
  // is safely stored and scanned first, then attached.
  //
  // ONLY A CLEAN DOCUMENT IS ATTACHED. A quarantined one returned above with
  // "not attached" in its own copy; an `error` one is withheld and asks the
  // user to retry, so neither reaches here. The document_links INSERT policy
  // (20260902011000) validates the TARGET end via private.entity_is_visible, so
  // a forged entityId the caller cannot see is refused by the database whatever
  // this reads -- the app half is the good sentence, not the control (the same
  // split as lib/crm/link-actions.ts).
  const linkTarget = documentLinkTarget(formData);
  if (linkTarget) {
    const { error: linkError } = await supabase.from("document_links").insert({
      organisation_id: org.id,
      parent_id: documentId,
      entity_type: linkTarget.entityType,
      entity_id: linkTarget.entityId,
    });
    if (linkError) {
      // The file is uploaded and clean; only the attach failed. Say so rather
      // than claim the whole upload failed -- the document is real and findable
      // in /documents. 42501/23514/23503 are refusals (target not visible or
      // not a real tenant row); anything else is a transient fault.
      console.error("[crm] document attach-on-upload failed:", linkError.message);
      return { error: UPLOADED_NOT_ATTACHED, values: echoedValues(formData) };
    }
    // The target's detail page (its related panel) now shows the document.
    revalidatePath(`/${org.slug}/${entitySegment(linkTarget.entityType)}/${linkTarget.entityId}`);
    return { message: "Uploaded and attached." };
  }

  return { message: "Uploaded." };
}

/**
 * The entity a related-panel upload should attach the new document to, or null
 * for an org-wide upload. The `entityType` is validated against the link
 * allowlist here so a forged value is a null (skip the attach) rather than a
 * string reaching the INSERT — belt over the database's own CHECK/dispatch.
 */
function documentLinkTarget(
  formData: FormData,
): { entityType: LinkEntityType; entityId: string } | null {
  const entityType = field(formData, "entityType");
  const entityId = field(formData, "entityId");
  if (!entityType || !entityId) return null;
  if (!(LINK_ENTITY_TYPES as readonly string[]).includes(entityType)) return null;
  return { entityType: entityType as LinkEntityType, entityId };
}

/** The route segment for a link target type, for revalidation after an attach. */
function entitySegment(entityType: LinkEntityType): string {
  const SEGMENT: Record<LinkEntityType, string> = {
    company: "companies",
    contact: "contacts",
    agency: "agencies",
    artist: "artists",
    venue: "venues",
    event: "events",
  };
  return SEGMENT[entityType];
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
  revalidatePath(`/${org.slug}/documents/deleted`);
  return { message: "Deleted." };
}

// ===========================================================================
// FORM-SHAPED DELETE + RESTORE for the /documents list controls.
//
// deleteDocumentAction takes `orgSlug` as its first positional argument (Task
// 5's contract, so the upload/scan/download integration test can drive it),
// but useActionState in the list's DeleteRecordForm needs the `(prev, formData)`
// shape and passes orgSlug as a hidden field. deleteDocumentFormAction is the
// thin adapter; it changes no behaviour, only the calling convention.
//
// Documents have NO detail page (unlike every other soft-deleted entity, which
// restores from its own record page), so delete happens inline on /documents
// and restore inline on /documents/deleted -- these two form-shaped actions are
// what those row controls bind.
// ===========================================================================
export async function deleteDocumentFormAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return deleteDocumentAction(field(formData, "orgSlug"), formData);
}

/**
 * Form-shaped upload, for the DocumentUpload component's useActionState.
 * uploadDocumentAction takes `orgSlug` positionally (the integration test drives
 * it that way); the form passes it as a hidden field. Same adapter reason as
 * deleteDocumentFormAction.
 */
export async function uploadDocumentFormAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return uploadDocumentAction(field(formData, "orgSlug"), formData);
}

/**
 * Restore a soft-deleted document. Mirrors restoreEventAction: flip `deleted_at`
 * back to null through commitWrite ({ count: "exact" } -- a 204 is not a save),
 * with the mirror-of-delete predicate so restoring a LIVE document matches
 * nothing rather than reporting a success that changed nothing.
 *
 * NOT AUDITED as a byte-action: restore touches no bytes and mints no signed
 * URL -- it only un-hides metadata, and public.audit_document_action's closed
 * action set (upload/download/delete/quarantine, 20260902031000) deliberately
 * does not carry a restore verb. The soft-delete IS audited (document_deleted);
 * a document_restored audit is a one-line additive widening if a later phase
 * wants the symmetry (noted in FOLLOW-UPS).
 */
export async function restoreDocumentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const auth = await authoriseOrg(field(formData, "orgSlug"), formData, PERMISSION);
  if (!auth.ok) return auth.state;
  const org = auth.org;

  const documentId = field(formData, "documentId");
  if (!documentId) {
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  const supabase = await createClient();
  const result = await commitWrite(`document ${documentId} restore`, () =>
    supabase
      .from("documents")
      .update({ deleted_at: null }, { count: "exact" })
      .eq("organisation_id", org.id)
      .eq("id", documentId)
      .filter("deleted_at", "not.is", null),
  );

  if (result.outcome === "applied") {
    revalidatePath(`/${org.slug}/documents`);
    revalidatePath(`/${org.slug}/documents/deleted`);
  }
  return stateFor(result, "Restored. It is back in the documents list.", formData);
}
