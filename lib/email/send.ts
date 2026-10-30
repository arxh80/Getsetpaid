import "server-only";

// Transactional email, via Brevo's HTTP API (https://api.brevo.com/v3/smtp/email).
//
// WHY THE HTTP API AND NOT SMTP+NODEMAILER: no extra dependency, works on any
// runtime the app is deployed to (an IONOS VPS, founder 2026-09-30), and the API key is the only
// secret to hold. SMTP would add a long-lived connection and a transport dep
// for no gain at this volume.
//
// WHY SERVER-ONLY: BREVO_API_KEY grants the ability to send mail as our domain.
// This module imports `server-only`, so the build fails if a Client Component
// ever reaches it -- the same guard lib/supabase/admin.ts uses for the
// service-role key. Never prefix any variable here with NEXT_PUBLIC_.
//
// SCOPE: transactional only. Auth mail (sign-up, magic link, reset) is
// Supabase Auth's own SMTP, a separate hosted-project setting that is NOT
// configured in this repository yet -- docs/email-setup.md § 3. This helper is
// for app-initiated mail: the in-app feedback receipt to the founder and
// incident alerts (both Phase 7). Marketing email is a different stream with
// a PECR consent gate and does NOT go through here (CLAUDE.md -- Legal and
// regulatory compliance).
//
// TIMEOUT (Phase 7 Task 6 fix round 1, finding I2): the typed-result contract
// covered a rejected fetch and a non-2xx response but not a connection that
// is accepted and never answered -- undici's default is 300 s, far longer
// than any user waits (and longer than some runtimes let a request live), so
// a Brevo stall was a hung submission and, on retry, a duplicate row. Every call now carries an
// AbortSignal; the abort surfaces through the same `network error` branch.

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
/** How long one Brevo call may take before it is abandoned as a network
 *  failure. Brevo answers in well under a second when it answers at all. */
export const BREVO_TIMEOUT_MS = 10_000;

export interface EmailAddress {
  email: string;
  name?: string;
}

/** A file sent with the message. Brevo takes base64 content and a file name;
 *  the name is the caller's, so it must never be user-supplied text. */
export interface EmailAttachment {
  name: string;
  contentBase64: string;
}

export interface SendEmailInput {
  to: EmailAddress[];
  /**
   * Blind recipients. A message to SEVERAL people who should not see each
   * other's addresses (Task 9b review m5: a connection notice to a
   * workspace's Owners and Admins) passes them here with `to: []`; Brevo
   * requires a `to`, so the message is then addressed to the sender itself.
   */
  bcc?: EmailAddress[];
  subject: string;
  html: string;
  /** Plain-text fallback. Optional but recommended for deliverability. */
  text?: string;
  /** Overrides the default sender for this one message. */
  from?: EmailAddress;
  replyTo?: EmailAddress;
  /** Files attached to the message (an invoice PDF). Omitted when empty. */
  attachments?: readonly EmailAttachment[];
  /** Overrides BREVO_TIMEOUT_MS. Exists so the unit test can prove the
   *  abort path in milliseconds rather than ten seconds; production callers
   *  leave it unset. */
  timeoutMs?: number;
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

  const bcc = input.bcc ?? [];
  if (input.to.length === 0 && bcc.length === 0) {
    return { ok: false, error: "no recipients" };
  }
  // Undisclosed recipients: nobody in To but the sender, everybody in Bcc.
  const to = input.to.length > 0 ? input.to : [from];

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
        to,
        ...(bcc.length > 0 ? { bcc } : {}),
        subject: input.subject,
        htmlContent: input.html,
        ...(input.text ? { textContent: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachment: input.attachments.map((a) => ({ name: a.name, content: a.contentBase64 })) }
          : {}),
      }),
      // A stalled connection is a network failure, not a wait. See the header.
      signal: AbortSignal.timeout(input.timeoutMs ?? BREVO_TIMEOUT_MS),
    });
  } catch (cause) {
    // A timeout rejects with a DOMException named TimeoutError; it is named
    // in the result so the log line says "timed out" rather than just "error".
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `network error: Brevo did not answer within ${input.timeoutMs ?? BREVO_TIMEOUT_MS} ms`
        : `network error: ${String(cause)}`,
    };
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
