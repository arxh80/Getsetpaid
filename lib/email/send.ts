import "server-only";

// Transactional email, via Brevo's HTTP API (https://api.brevo.com/v3/smtp/email).
//
// WHY THE HTTP API AND NOT SMTP+NODEMAILER: no extra dependency, works on the
// edge/serverless runtime this app deploys to, and the API key is the only
// secret to hold. SMTP would add a long-lived connection and a transport dep
// for no gain at this volume.
//
// WHY SERVER-ONLY: BREVO_API_KEY grants the ability to send mail as our domain.
// This module imports `server-only`, so the build fails if a Client Component
// ever reaches it -- the same guard lib/supabase/admin.ts uses for the
// service-role key. Never prefix any variable here with NEXT_PUBLIC_.
//
// SCOPE: transactional only (auth is handled by Supabase's own SMTP, configured
// separately -- see docs/email-setup.md). This helper is for app-initiated mail:
// the in-app feedback receipt to the founder and incident alerts (both Phase 7).
// Marketing email is a different stream with a PECR consent gate and does NOT
// go through here (CLAUDE.md -- Legal and regulatory compliance).

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface SendEmailInput {
  to: EmailAddress[];
  subject: string;
  html: string;
  /** Plain-text fallback. Optional but recommended for deliverability. */
  text?: string;
  /** Overrides the default sender for this one message. */
  from?: EmailAddress;
  replyTo?: EmailAddress;
}

export type SendEmailResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

function required(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : null;
}

/**
 * Send one transactional email through Brevo.
 *
 * Returns a typed result rather than throwing: a failed send must never take
 * down the action that triggered it (e.g. a feedback submission still succeeds
 * and is stored even if the notification email fails -- the caller decides what
 * to do with `ok: false`, and should log/audit it, never swallow it silently).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = required("BREVO_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "BREVO_API_KEY is not set" };
  }

  const from: EmailAddress | null =
    input.from ??
    (() => {
      const email = required("BREVO_SENDER_EMAIL");
      if (!email) return null;
      const name = required("BREVO_SENDER_NAME") ?? undefined;
      return { email, name };
    })();

  if (!from) {
    return { ok: false, error: "no sender: set BREVO_SENDER_EMAIL or pass `from`" };
  }

  if (input.to.length === 0) {
    return { ok: false, error: "no recipients" };
  }

  let response: Response;
  try {
    response = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: from,
        to: input.to,
        subject: input.subject,
        htmlContent: input.html,
        ...(input.text ? { textContent: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      }),
    });
  } catch (cause) {
    return { ok: false, error: `network error: ${String(cause)}` };
  }

  if (!response.ok) {
    // Brevo returns { code, message } on error. Read the body for the reason,
    // but never let a malformed error body throw and mask the real HTTP status.
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ? `: ${body.message}` : "";
    } catch {
      detail = "";
    }
    return { ok: false, error: `Brevo ${response.status}${detail}` };
  }

  const body = (await response.json()) as { messageId?: string };
  return { ok: true, messageId: body.messageId ?? "" };
}
