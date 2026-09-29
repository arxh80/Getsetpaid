import "server-only";

// The founder's receipt for one feedback submission -- the first of the two
// consumers of the ONE Brevo sender (lib/email/send.ts, folded in from the
// `email-setup` branch per DECISIONS-QUEUE Q91).
//
// ===========================================================================
// A FAILED EMAIL NEVER FAILS THE SUBMISSION, AND IS NEVER SWALLOWED EITHER
// ===========================================================================
// The row is stored BEFORE this runs and the submitter is told their feedback
// is recorded because it is; the email is the operator's notification, not
// the user's receipt, so its failure is the operator's problem and is
// surfaced to the operator: logged loudly here, and left visible on the row
// itself -- `feedback.notified_at` stays NULL, which /super/feedback renders
// as "email not sent" beside the row. That column is stamped ONLY after
// `sendEmail()` answers ok:true (the send.ts docstring's own rule), so a
// failed send leaves the row re-sendable rather than lost.
//
// Nothing here throws. The action awaits this call and ignores its result
// on purpose; the two side effects (the log line, the stamp) are the whole
// of its output.
//
// RECIPIENT: SUPPORT_CONTACT_EMAIL -- CLAUDE.md § In-app feedback: "the same
// single support/security contact as SECURITY.md § 13 at this stage -- no
// separate feedback address yet". Unset means "stored, not emailed", logged as
// such, never a crash.

import { sendEmail } from "@/lib/email/send";
import { buildFeedbackEmail, type FeedbackEmailInput } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/service";
import { siteUrl } from "@/lib/supabase/env";

export type FeedbackNotificationInput = Omit<FeedbackEmailInput, "siteUrl">;

export function supportContactEmail(): string | null {
  const value = process.env.SUPPORT_CONTACT_EMAIL;
  return value && value.trim() !== "" ? value.trim() : null;
}

export async function notifyFounderOfFeedback(
  input: FeedbackNotificationInput,
): Promise<void> {
  try {
    const to = supportContactEmail();
    if (!to) {
      console.error(
        `[email] SUPPORT_CONTACT_EMAIL is not set; feedback ${input.feedbackId} is stored and NOT emailed (notified_at stays null).`,
      );
      return;
    }

    const body = buildFeedbackEmail({ ...input, siteUrl: siteUrl() });
    const result = await sendEmail({
      to: [{ email: to }],
      subject: body.subject,
      html: body.html,
      text: body.text,
      ...(input.submitterEmail ? { replyTo: { email: input.submitterEmail } } : {}),
    });

    if (!result.ok) {
      console.error(
        `[email] feedback receipt for ${input.feedbackId} failed (row stored, notified_at left null, re-sendable):`,
        result.error,
      );
      return;
    }

    // STAMP ONLY NOW. service_role holds update(notified_at) and nothing else
    // on this table (20260911000000); the `.is("notified_at", null)` guard
    // makes a double delivery a no-op stamp rather than a rewritten time.
    const { error } = await createServiceClient()
      .from("feedback")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", input.feedbackId)
      .is("notified_at", null);
    if (error) {
      // The email went; the stamp did not. Logged rather than retried: a
      // second send would be a duplicate, and the row reading "not sent" is
      // the honest failure the operator can see.
      console.error(
        `[email] feedback ${input.feedbackId} was emailed (messageId ${result.messageId}) but notified_at could not be stamped:`,
        error.message,
      );
    }
  } catch (cause) {
    console.error(
      `[email] feedback receipt for ${input.feedbackId} threw; row stored, not emailed:`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
