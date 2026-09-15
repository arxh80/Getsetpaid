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
// THE BUDGET IS READ BEFORE ANY STORAGE I/O (fix round 1, finding I1)
// ===========================================================================
// The trigger meters the ROW, and the row is the cheap half of a submission.
// The expensive half -- a service-role write of up to 5 MiB into the private
// bucket and a synchronous malware scan -- ran BEFORE the INSERT, so a
// submitter whose budget was already spent (or a Free-tier account, for which
// feedback is the first path that can drive the Storage client at all) could
// loop the action and burn storage and scanner time without limit while the
// counter read a flat 10. So the action now asks
// public.feedback_budget_remaining() (20260911010000) -- a STABLE, SECURITY
// DEFINER read of the caller's own counter -- before it touches the bucket,
// and refuses with the SAME "Try again in …" sentence the trigger's PT429
// renders. It is a read: it spends nothing, so it cannot double-meter, and
// the trigger stays the enforcement (a skipped pre-check is still refused at
// the write). FAIL CLOSED: an error from the RPC is treated as "0 left".
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
// UNDER IMPERSONATION THE SUBMISSION IS ACCEPTED, WITHOUT A WORKSPACE (Q121)
// ===========================================================================
// FOUNDER RULING Q121 REVERSES TASK 6 FIX ROUND 1's M4. That round hid the
// control in app/(app)/layout.tsx and refused here with IMPERSONATION_REFUSAL,
// because getCurrentOrg() under a support-access session returns the workspace
// with `isImpersonated: true` and no membership behind it, so a row naming
// that workspace would be refused at the trigger (42501) -- correctly, since
// the attribution would be false.
//
// The founder chose the alternative that round queued: the operator's feedback
// from inside a customer's workspace is worth having, so it is ACCEPTED with
// NO organisation on it and LABELLED. This action therefore passes
// `organisation_id: null` when the workspace it resolved is an impersonated
// one -- it does not pass the id and let the trigger refuse, and it does not
// refuse itself. The route is captured exactly as it is for anyone else (the
// operator was on a real page and that page is the point of the feedback).
//
// THE LABEL IS NOT SET FROM HERE. `during_support_access` is outside the
// column-level INSERT grant and is stamped by private.feedback_before_insert()
// from private.is_impersonating() (`20260916002000`), so it is a fact the
// database establishes about the session, not a claim this action makes. That
// matters because this layout-and-action pair cannot be the enforcement: a
// direct PostgREST INSERT never runs either of them.
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
// Since fix round 1 the trigger also requires the object to EXIST for a
// session writer naming a key (20260911020000), so the upload-then-insert
// order here is load-bearing, not merely tidy.
//
// ===========================================================================
// THE EMAIL NEVER FAILS -- OR DELAYS -- THE SUBMISSION (fix round 1, I2)
// ===========================================================================
// The row is stored first. The founder's receipt is sent AFTER THE RESPONSE,
// through Next's after(): the one Brevo call now carries a 10-second timeout
// (lib/email/send.ts), and with that in place it is no longer awaited on the
// submit path at all -- a Brevo stall used to hold the dialog at "Sending…"
// and invite a retry that inserted a second, identical row. after() keeps
// the function alive on a serverless host until the callback settles, so the
// send still happens; its failure is still logged and still left visible on
// the row (notified_at null) -- never surfaced to the submitter, who did
// nothing wrong and whose feedback IS recorded. lib/email/feedback-notification.ts.

import { headers } from "next/headers";
import { after } from "next/server";
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
/** The feedback window, SECURITY.md § 5. Only ever used when the database
 *  failed to say how long is left -- and that case is logged, because the
 *  trigger and the RPC both always set it. */
const FEEDBACK_WINDOW_SECONDS = 3600;

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

function budgetRefusal(seconds: number, formData: FormData): FormState {
  return {
    error: `Too many feedback submissions just now. Try again in ${formatRetryAfter(seconds)}.`,
    values: echoedValues(formData),
  };
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

  // Q121: a support-access session holds no membership of the workspace it is
  // inside, so the row carries NO workspace rather than a false one. The
  // database labels it; see the header.
  const supportAccess = org?.isImpersonated === true;
  const organisationId = supportAccess ? null : (org?.id ?? null);

  // ---- THE BUDGET, READ BEFORE ANY STORAGE I/O (I1) --------------------------
  const supabase = await createClient();
  const budget = await supabase.rpc("feedback_budget_remaining").single();
  if (budget.error) {
    // Fail closed: a budget we cannot read is a budget we treat as spent.
    console.error("[feedback] budget pre-check failed; refusing without touching storage:", budget.error.message);
    return budgetRefusal(FEEDBACK_WINDOW_SECONDS, formData);
  }
  const remaining = Number((budget.data as { remaining?: unknown } | null)?.remaining);
  const retryAfter = Number((budget.data as { retry_after_seconds?: unknown } | null)?.retry_after_seconds);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return budgetRefusal(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : FEEDBACK_WINDOW_SECONDS,
      formData,
    );
  }

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
  const { error } = await supabase.from("feedback").insert({
    id: feedbackId,
    organisation_id: organisationId,
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
    // The row did not land, so the stored bytes are an orphan. A cleanup
    // that fails is logged, not ignored: the bytes stay behind with no row,
    // and the Phase 8 sweep (Q120) does not exist yet.
    if (screenshot) {
      const removed = await storage.storage.from(BUCKET).remove([screenshot.key]);
      if (removed.error) {
        console.error(
          `[feedback] orphaned screenshot ${screenshot.key} could not be removed after a refused insert:`,
          removed.error.message,
        );
      }
    }

    if (error.code === "PT429") {
      // THE BUDGET REFUSAL -- the trigger's `hint` is the real remainder of
      // the fixed hour, rendered as a human duration rather than raw seconds.
      // (Reachable only in the race between the pre-check above and the
      // trigger, or when the pre-check was wrong; either way the sentence is
      // the same one.)
      const seconds = Number(error.hint);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        // The trigger always sets hint; a missing one is a bug worth seeing,
        // not a silent over-statement of the wait by up to an hour.
        console.error("[feedback] PT429 arrived without a usable hint; rendering the whole window:", error.hint);
      }
      return budgetRefusal(
        Number.isFinite(seconds) && seconds > 0 ? seconds : FEEDBACK_WINDOW_SECONDS,
        formData,
      );
    }
    if (error.code === "42501") {
      return { error: REFUSED_MESSAGE, values: echoedValues(formData) };
    }
    console.error("[feedback] insert failed:", error.message);
    return { error: FAILED_MESSAGE, values: echoedValues(formData) };
  }

  // ---- the founder's receipt -- after the RESPONSE, never gating it ----------
  const notification = {
    feedbackId,
    category,
    message,
    route,
    submitterEmail: user.email,
    // The workspace NAMED in the email is the one the row carries -- null
    // under support access, so the receipt cannot read as a submission by a
    // member of that workspace. The name is still useful context and is
    // carried by `supportAccess` below instead.
    organisationName: supportAccess ? null : (org?.name ?? null),
    organisationSlug: supportAccess ? null : (org?.slug ?? null),
    organisationRole: supportAccess ? null : (org?.role ?? null),
    supportAccess,
    userAgent: userAgent === "" ? null : userAgent,
    screenshot: screenshot?.status ?? "none",
  } as const;
  after(() => notifyFounderOfFeedback(notification));

  if (screenshot?.status === "quarantined") return { message: RECORDED_QUARANTINED };
  if (screenshot?.status === "error") return { message: RECORDED_UNSCANNED };
  return { message: RECORDED };
}
