import "server-only";

// Viewing a feedback screenshot: the audited signed-URL issue.
//
// ===========================================================================
// THE ORDER IS THE CONTROL, AND THE AUDIT IS ON THE PATH THAT MINTS THE URL
// ===========================================================================
// CLAUDE.md § In-app feedback: "every superuser view of a feedback screenshot
// is itself an audited action (actor, feedback ID, timestamp) -- same audit
// discipline as impersonation, not a silent read." This is the one deliberate
// exception to "no direct tenant-data access outside impersonation", so the
// audit cannot be a side effect that might not run. It is a PRECONDITION:
//
//   1. identity      -- isSuperuser(), else 404 (the streamed-refusal family's
//                       literal-404 sibling: this is a route handler)
//   2. the row       -- loaded through the caller's OWN RLS client, so
//                       feedback_select_platform decides (aal2 superuser only,
//                       inside retention); nothing -> 404, no existence leak
//   3. the verdict   -- anything but `clean` -> 409 (the quarantine gate)
//   3b. the bytes    -- the object must EXIST in the bucket, checked through
//                       the service-role Storage client BEFORE the audit, so
//                       a row whose bytes are missing is a 404 with no audit
//                       row rather than an audit row followed by a 500 (fix
//                       round 1, finding M1). The trigger now refuses a
//                       session writer declaring a key with no object behind
//                       it (20260911020000); this covers what the trigger
//                       cannot -- bytes that were there and are gone.
//   4. THE AUDIT     -- public.audit_feedback_screenshot_view(), a guarded
//                       SECURITY DEFINER RPC that writes feedback.screenshot_viewed
//                       with the actor forced to auth.uid(); if it refuses or
//                       fails -> 500, and NO URL IS MINTED
//   5. the URL       -- only now, 60 seconds, service-role Storage client
//
// Task 5's I4 shipped an audit trigger that was a silent no-op because it
// exempted the wrong caller. This audit is not a trigger and has no exemption:
// it is an RPC the superuser's own session calls, whose refusal is the route's
// refusal. tests/e2e/feedback.spec.ts drives the real link and reads the row
// back out of Postgres; the psql suite drives the RPC from a non-superuser
// and an aal1 superuser and asserts 42501.
//
// OUT OF SCOPE, STATED: a superuser who holds a signed URL can reload it until
// it expires (60 seconds, Q51's TTL) without a second audit row. The audit
// records the ISSUE of access, not each byte-fetch -- the same boundary the
// document download audit has.

import { isSuperuser } from "@/lib/admin/superuser";
import { createClient } from "@/lib/supabase/server";
import { createStorageClient, objectPresence } from "@/lib/supabase/storage";
import { UUID_RE } from "@/lib/feedback/contract";

const BUCKET = "feedback-screenshots";
/** Q51's TTL, the documents pipeline's. */
const SIGNED_URL_TTL_SECONDS = 60;

const WITHHELD =
  "That screenshot isn’t available to open: it didn’t pass the malware scan, or the scan didn’t complete.";

export type ScreenshotOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 404 }
  | { readonly ok: false; readonly status: 409; readonly reason: string }
  | { readonly ok: false; readonly status: 500 };

export async function issueFeedbackScreenshotUrl(
  feedbackId: string,
): Promise<ScreenshotOutcome> {
  if (!UUID_RE.test(feedbackId)) return { ok: false, status: 404 };
  if (!(await isSuperuser())) return { ok: false, status: 404 };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("feedback")
    .select("screenshot_key, screenshot_scan_status")
    .eq("id", feedbackId)
    .maybeSingle();
  if (error) {
    console.error("[feedback] screenshot lookup failed:", error.message);
    return { ok: false, status: 500 };
  }
  if (!data || !data.screenshot_key) return { ok: false, status: 404 };
  if (data.screenshot_scan_status !== "clean") {
    return { ok: false, status: 409, reason: WITHHELD };
  }

  // THE BYTES, BEFORE THE AUDIT. An audit row must record a view that can
  // happen; a key with nothing behind it is "not found", not "viewed".
  const bucket = createStorageClient().storage.from(BUCKET);
  // objectPresence(), not exists(): a HEAD cannot tell a missing object from a
  // Storage fault (G20), and a fault must not read as "no screenshot".
  const presence = await objectPresence(bucket, data.screenshot_key as string);
  if (presence === "missing") {
    console.error(`[feedback] row ${feedbackId} names screenshot ${data.screenshot_key} but no object exists; no audit row written`);
    return { ok: false, status: 404 };
  }
  if (presence === "error") {
    console.error("[feedback] screenshot existence check failed; withholding the URL");
    return { ok: false, status: 500 };
  }

  // THE AUDIT, BEFORE THE URL. A refused or failed audit withholds the file.
  const audit = await supabase.rpc("audit_feedback_screenshot_view", {
    p_feedback_id: feedbackId,
  });
  if (audit.error) {
    console.error("[feedback] screenshot view audit refused/failed; withholding the URL:", audit.error.message);
    return { ok: false, status: 500 };
  }

  const signed = await bucket.createSignedUrl(data.screenshot_key as string, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("[feedback] createSignedUrl failed:", signed.error?.message ?? "no URL");
    return { ok: false, status: 500 };
  }
  return { ok: true, url: signed.data.signedUrl };
}
