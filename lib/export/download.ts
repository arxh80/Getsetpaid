import "server-only";

// THE ONE WAY AN ARCHIVE'S BYTES ARE EVER READ.
//
// The document download route's shape, and the order IS the control: the
// caller is identified, the row is loaded through their OWN RLS client (so
// `export_jobs_select_own` is the authorisation and this file does not
// re-implement one), the archive is refused unless it exists and has not
// expired, the object is confirmed to be there, the ACCESS IS AUDITED, and
// only then is a 60-second signed URL minted. No audit row, no URL.
//
// THE IDOR GATE IS ASKED TWICE AND THAT IS DELIBERATE. `export_jobs_select_own`
// refuses another person's job here, and public.audit_export_download() asks
// `requested_by = auth.uid()` again inside a definer function — so the audit
// path cannot be the weaker of the two if a future policy is relaxed.
//
// 404 COVERS EVERY REFUSAL that is not a live archive: not signed in, not a
// uuid, not your job, no such job, still running, failed, expired, or no such
// part. They are indistinguishable on purpose, so the endpoint is not an
// existence oracle for other people's exports.
//
// PARTS (Q228). A closure backup can be several archives. Part 1 is always
// the job's own `storage_key`; part n >= 2 is read from `export_job_parts`
// through the SAME RLS client (`export_job_parts_select_own` reuses the job's
// own-row policy), never the service client -- a service read would answer
// an Admin of the same workspace with a real key and make this file the
// authorisation, which it must not be. The audit RPC is told the part and
// refuses one that does not exist; after the RLS read that refusal is
// unreachable, and if it is ever raised it is a 500 like any audit fault.

import { createClient } from "@/lib/supabase/server";
import { createStorageClient, objectPresence } from "@/lib/supabase/storage";
import { getCurrentUser } from "@/lib/auth";
import { EXPORT_BUCKET, archiveIsDownloadable, isUuid } from "./contract";

/** Q51's TTL, the documents pipeline's. */
const SIGNED_URL_TTL_SECONDS = 60;

export type ExportDownloadOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 404 }
  | { readonly ok: false; readonly status: 500 }
  /** Storage could not say whether the archive is there (G20). */
  | { readonly ok: false; readonly status: 503 };

export async function issueExportDownloadUrl(
  jobId: string,
  part: number = 1,
): Promise<ExportDownloadOutcome> {
  if (!isUuid(jobId)) return { ok: false, status: 404 };
  if (!Number.isSafeInteger(part) || part < 1) return { ok: false, status: 404 };

  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 404 };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("export_jobs")
    .select("id, status, storage_key, expires_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    // An unparseable uuid is already refused above; anything else here is a
    // fault, not a refusal.
    console.error("[export] download lookup failed:", error.message);
    return { ok: false, status: 500 };
  }
  if (!data || typeof data.storage_key !== "string") return { ok: false, status: 404 };
  if (!archiveIsDownloadable(data.status as string, data.expires_at as string | null)) {
    return { ok: false, status: 404 };
  }

  // WHICH OBJECT. Part 1 is the job's own key; a later part's key is read
  // through the caller's own RLS client, so a part of somebody else's job is
  // the same "no row" as a part that does not exist.
  let storageKey: string = data.storage_key;
  if (part >= 2) {
    const { data: partRow, error: partError } = await supabase
      .from("export_job_parts")
      .select("storage_key")
      .eq("job_id", jobId)
      .eq("part_no", part)
      .maybeSingle();
    if (partError) {
      console.error("[export] part lookup failed:", partError.message);
      return { ok: false, status: 500 };
    }
    if (!partRow || typeof partRow.storage_key !== "string") return { ok: false, status: 404 };
    storageKey = partRow.storage_key;
  }

  const bucket = createStorageClient().storage.from(EXPORT_BUCKET);

  // THE BYTES, BEFORE THE AUDIT (the screenshot route's fix-round finding
  // M1): an audit row for an access that could not happen is a false record.
  // A Storage fault is 503, not the not-found answer (G20): a blip must not
  // tell the owner of a real archive that it does not exist.
  const presence = await objectPresence(bucket, storageKey);
  if (presence === "missing") {
    console.error(`[export] job ${jobId} part ${part}: no archive object; no audit row written`);
    return { ok: false, status: 404 };
  }
  if (presence === "error") return { ok: false, status: 503 };

  const { error: auditError } = await supabase.rpc("audit_export_download", {
    p_job_id: jobId,
    p_part: part,
  });
  if (auditError) {
    console.error("[export] download audit failed:", auditError.message);
    return { ok: false, status: 500 };
  }

  const { data: signed, error: signError } = await bucket.createSignedUrl(
    storageKey,
    SIGNED_URL_TTL_SECONDS,
  );
  if (signError || !signed?.signedUrl) {
    console.error("[export] signing failed:", signError?.message);
    return { ok: false, status: 500 };
  }
  return { ok: true, url: signed.signedUrl };
}
