"use server";

// In-app feedback: the submit action. CLAUDE.md § In-app feedback is the spec.
//
// ===========================================================================
// WHAT THIS ACTION DECIDES, AND WHAT THE DATABASE DECIDES
// ===========================================================================
// This action validates copy-level things (a category, a non-empty message,
// an image that sniffs as an image) and ASSEMBLES the row. It does not decide
// attribution and it does not meter. Both are decided by
// private.feedback_before_insert() (20260911000000) on EVERY writer -- the
// row's `user_id`/`user_email` come from the session, `organisation_role`
// from the caller's own membership, and an organisation the caller is not a
// member of is refused (42501); the 10/hour budget is spent in the same
// trigger (PT429) so a direct PostgREST INSERT meets the same rule this form
// does (Task 5's I1 and I2, both by construction). The client cannot even NAME
// `user_id`: it is outside the column-level INSERT grant.
//
// So the organisation this action passes is a CLAIM the database checks, and
// it is derived, not typed: the route the submitter was on is read from the
// middleware-stamped request path (never a form field), its first segment is
// resolved through getCurrentOrg() -- the same RLS-gated lookup every
// org-scoped page uses -- and only a workspace that lookup returns is named.
//
// ===========================================================================
// "CURRENT PAGE/ROUTE": THE PATHNAME, WITHOUT THE QUERY STRING
// ===========================================================================
// The dialog is opened over whatever page the user was reading, and a server
// action POSTs to that page's URL, so `currentPath()` IS where they were --
// including a modal opened over a record. The query string is dropped with
// the impersonation audit's own auditableRoute(): `?q=` carries a search
// term, which is a fragment of what the tenant's records say, and a platform
// table is no place for it. Path-segment record ids are KEPT, the same
// precedent's reasoning: which record the feedback is about is the point,
// and an id is not content. The organisation SLUG is in the path and is
// attribution, not content.
//
// ===========================================================================
// THE SCREENSHOT IS THE DOCUMENTS PIPELINE, IMAGES ONLY
// ===========================================================================
// sniffAndAllow() (magic bytes, never the declared type) must read the bytes
// as PNG/JPEG/WebP/GIF -- a PDF is on the documents allowlist and is refused
// here, because a screenshot is an image. Bytes go to the private, client-
// fenced `feedback-screenshots` bucket under an opaque `feedback/{id}` key
// through the service-role Storage client, are scanned synchronously
// (lib/crm/documents.ts's shape), and the verdict lands on the row. A
// quarantined screenshot is stored (evidence), never served (the view path
// refuses anything but `clean`), and files an incident alert by trigger.
//
// ===========================================================================
// THE EMAIL NEVER FAILS THE SUBMISSION
// ===========================================================================
// The row is stored first. The founder's receipt is sent after, through the
// one Brevo sender, and its failure is logged and left visible on the row
// (notified_at null) -- never surfaced to the submitter, who did nothing
// wrong and whose feedback IS recorded. lib/email/feedback-notification.ts.

import { headers } from "next/headers";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { currentPath } from "@/lib/auth/current-path";
import { auditableRoute } from "@/lib/admin/impersonation-contract";
import { firstPathSegment } from "@/lib/org/path";
import { createClient } from "@/lib/supabase/server";
import { createStorageClient } from "@/lib/supabase/storage";
import { echoedValues, field, type FormState } from "@/lib/forms";
import { FAILED_MESSAGE, REFUSED_MESSAGE } from "@/lib/crm/write";
import { sniffAndAllow } from "@/lib/security/file-allowlist";
import { getScanner, type ScanResult } from "@/lib/security/malware-scan";
import { formatRetryAfter } from "@/lib/format/duration";
import { notifyFounderOfFeedback } from "@/lib/email/feedback-notification";
import {
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  feedbackScreenshotKey,
  isFeedbackCategory,
  isFeedbackScreenshotMime,
} from "@/lib/feedback/contract";

const BUCKET = "feedback-screenshots";
const USER_AGENT_MAX = 512;
const ROUTE_MAX = 512;

const NOT_AN_IMAGE =
  "Screenshots must be an image — PNG, JPEG, WebP or GIF.";
const TOO_BIG = "That screenshot is larger than the 5 MiB limit.";
const RECORDED = "Thanks — your feedback has been recorded.";
const RECORDED_QUARANTINED =
  "Thanks — your feedback has been recorded. The screenshot didn’t pass the malware scan, so it has been quarantined and won’t be shown.";
const RECORDED_UNSCANNED =
  "Thanks — your feedback has been recorded. The screenshot couldn’t be scanned just now, so it is being held rather than shown.";

function verdictStatus(verdict: ScanResult): "clean" | "quarantined" | "error" {
  switch (verdict) {
    case "clean":
      return "clean";
    case "infected":
      return "quarantined";
    case "error":
      return "error";
  }
}

export async function submitFeedbackAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: FAILED_MESSAGE, values: echoedValues(formData) };

  // ---- copy-level validation -----------------------------------------------
  const fieldErrors: Record<string, string> = {};
  const category = field(formData, "category");
  if (!category || !isFeedbackCategory(category)) {
    fieldErrors.category = "Choose a category.";
  }
  const message = field(formData, "message");
  if (!message) {
    fieldErrors.message = "Write a message.";
  } else if (message.length > FEEDBACK_MESSAGE_MAX) {
    fieldErrors.message = `Keep it under ${FEEDBACK_MESSAGE_MAX} characters.`;
  }
  if (
    Object.keys(fieldErrors).length > 0 ||
    !category ||
    !isFeedbackCategory(category) ||
    !message
  ) {
    return { fieldErrors, values: echoedValues(formData) };
  }

  // ---- where they were, and which workspace that resolves to --------------
  const route = auditableRoute(await currentPath()).slice(0, ROUTE_MAX);
  const slug = firstPathSegment(route);
  const org = slug ? await getCurrentOrg(slug) : null;
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, USER_AGENT_MAX);

  // ---- the optional screenshot ---------------------------------------------
  const feedbackId = crypto.randomUUID();
  const shot = formData.get("screenshot");
  let screenshot: {
    key: string;
    mime: string;
    size: number;
    status: "clean" | "quarantined" | "error";
  } | null = null;
  const storage = createStorageClient();

  if (shot instanceof File && shot.size > 0) {
    if (shot.size > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      return { fieldErrors: { screenshot: TOO_BIG }, values: echoedValues(formData) };
    }
    const bytes = new Uint8Array(await shot.arrayBuffer());
    const sniff = sniffAndAllow(bytes, shot.name);
    if (!sniff.ok || !isFeedbackScreenshotMime(sniff.mime)) {
      return { fieldErrors: { screenshot: NOT_AN_IMAGE }, values: echoedValues(formData) };
    }

    const key = feedbackScreenshotKey(feedbackId);
    const uploaded = await storage.storage
      .from(BUCKET)
      .upload(key, Buffer.from(bytes), { contentType: sniff.mime, upsert: false });
    if (uploaded.error) {
      console.error("[feedback] screenshot upload to storage failed:", uploaded.error.message);
      return { error: FAILED_MESSAGE, values: echoedValues(formData) };
    }

    let verdict: ScanResult;
    try {
      verdict = await getScanner().scan({ bytes });
    } catch (err) {
      console.error("[feedback] malware scan threw:", err instanceof Error ? err.message : String(err));
      verdict = "error";
    }
    screenshot = { key, mime: sniff.mime, size: bytes.length, status: verdictStatus(verdict) };
  }

  // ---- the row, through the submitter's OWN session --------------------------
  // No user_id, no user_email, no role, no status: the trigger stamps them and
  // the column grant would refuse them anyway.
  const supabase = await createClient();
  const { error } = await supabase.from("feedback").insert({
    id: feedbackId,
    organisation_id: org?.id ?? null,
    category,
    message,
    route,
    user_agent: userAgent === "" ? null : userAgent,
    screenshot_key: screenshot?.key ?? null,
    screenshot_mime: screenshot?.mime ?? null,
    screenshot_size_bytes: screenshot?.size ?? null,
    screenshot_scan_status: screenshot?.status ?? null,
    screenshot_scanned_at: screenshot ? new Date().toISOString() : null,
  });

  if (error) {
    // The row did not land, so the stored bytes are an orphan.
    if (screenshot) await storage.storage.from(BUCKET).remove([screenshot.key]);

    if (error.code === "PT429") {
      // THE BUDGET REFUSAL -- the trigger's `hint` is the real remainder of
      // the fixed hour, rendered as a human duration rather than raw seconds.
      const seconds = Number(error.hint);
      return {
        error: `Too many feedback submissions just now. Try again in ${formatRetryAfter(
          Number.isFinite(seconds) ? seconds : 3600,
        )}.`,
        values: echoedValues(formData),
      };
    }
    if (error.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[feedback] insert failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // ---- the founder's receipt -- after the row, never gating it ---------------
  await notifyFounderOfFeedback({
    feedbackId,
    category,
    message,
    route,
    submitterEmail: user.email,
    organisationName: org?.name ?? null,
    organisationSlug: org?.slug ?? null,
    organisationRole: org?.role ?? null,
    userAgent: userAgent === "" ? null : userAgent,
    screenshot: screenshot?.status ?? "none",
  });

  if (screenshot?.status === "quarantined") return { message: RECORDED_QUARANTINED };
  if (screenshot?.status === "error") return { message: RECORDED_UNSCANNED };
  return { message: RECORDED };
}
