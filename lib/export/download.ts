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
// uuid, not your job, no such job, still running, failed, expired. They are
// indistinguishable on purpose, so the endpoint is not an existence oracle
// for other people's exports.

import { createClient } from "@/lib/supabase/server";
import { createStorageClient } from "@/lib/supabase/storage";
import { getCurrentUser } from "@/lib/auth";
import { EXPORT_BUCKET, archiveIsDownloadable, isUuid } from "./contract";

/** Q51's TTL, the documents pipeline's. */
const SIGNED_URL_TTL_SECONDS = 60;

export type ExportDownloadOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 404 }
  | { readonly ok: false; readonly status: 500 };

export async function issueExportDownloadUrl(jobId: string): Promise<ExportDownloadOutcome> {
  if (!isUuid(jobId)) return { ok: false, status: 404 };

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

  const bucket = createStorageClient().storage.from(EXPORT_BUCKET);

  // THE BYTES, BEFORE THE AUDIT (the screenshot route's fix-round finding
  // M1): an audit row for an access that could not happen is a false record.
  let present: { data: boolean | null; error: { message: string } | null };
  try {
    present = await bucket.exists(data.storage_key);
  } catch (cause) {
    console.error("[export] storage exists() threw:", cause);
    return { ok: false, status: 500 };
  }
  if (present.data === false) {
    console.error(`[export] job ${jobId}: no archive object; no audit row written`);
    return { ok: false, status: 404 };
  }
  if (present.error || present.data !== true) {
    console.error("[export] storage exists() failed:", present.error?.message);
    return { ok: false, status: 500 };
  }

  const { error: auditError } = await supabase.rpc("audit_export_download", { p_job_id: jobId });
  if (auditError) {
    console.error("[export] download audit failed:", auditError.message);
    return { ok: false, status: 500 };
  }

  const { data: signed, error: signError } = await bucket.createSignedUrl(
    data.storage_key,
    SIGNED_URL_TTL_SECONDS,
  );
  if (signError || !signed?.signedUrl) {
    console.error("[export] signing failed:", signError?.message);
    return { ok: false, status: 500 };
  }
  return { ok: true, url: signed.signedUrl };
}
