"use server";

// Documents: the upload half of the file-security pipeline. Download (the
// signed-URL issue and its authorisation) is Task 5.
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
// AUDIT: A DELIBERATE SEAM, NOT AN OMISSION
// ===========================================================================
// SECURITY.md § 6 requires every upload to be audited. The sole write path into
// audit_events is private.log_audit_event, whose EXECUTE is granted to NO
// client role (it is called only by other SECURITY DEFINER functions). There
// is therefore no client-callable audit RPC in the schema today, and creating
// one is a MIGRATION -- specifically 20260902031000, which is Task 5's file
// (the storage-action audit helper). Task 4's binding rule is "only
// 20260902030000 is new", so Task 4 cannot ship that helper, and calling
// log_audit_event from here would raise 42501. The audit call therefore has a
// marked seam below; Task 5 wires it when it ships the helper. Stated plainly
// so the absence reads as sequencing, not as a forgotten control.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createStorageClient } from "@/lib/supabase/storage";
import { echoedValues, type FormState } from "@/lib/forms";
import { authoriseOrg } from "@/lib/crm/actions";
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

  // AUDIT SEAM -- Task 5 (see this file's header). The upload event
  // (actor=user.id, org=org.id, target=documentId, action 'document.uploaded',
  // plus the scan verdict) is recorded here once the client-callable audit
  // helper ships in 20260902031000. Not audited in Task 4.

  revalidatePath(`/${org.slug}/documents`);

  if (scanStatus === "quarantined") {
    return { error: QUARANTINED, values: echoedValues(formData) };
  }
  if (scanStatus === "error") {
    return { error: SCAN_FAILED, values: echoedValues(formData) };
  }
  return { message: "Uploaded." };
}
