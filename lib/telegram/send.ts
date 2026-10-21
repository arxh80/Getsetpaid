import "server-only";

// THE ONE TELEGRAM TRANSPORT (founder 2026-09-30, Q111: incident alerts go by
// email, a dashboard notification and a Telegram bot; Telegram replaces SMS).
//
// Deliberately tiny and deliberately dumb: it POSTs one already-built text to
// one chat and reports ok/failed. It knows nothing about alerts -- the content
// rule ("alert type, counts and a /super/health link ONLY") is enforced where
// the text is BUILT, by an allowlist (lib/telegram/incident-alert-payload.ts),
// so this module cannot be the place a field leaks in.
//
// SERVER ONLY, AND THE TOKEN NEVER LEAVES THIS FILE. TELEGRAM_BOT_TOKEN is part
// of the request URL (that is Telegram's API shape), so any error string that
// could echo the URL is scrubbed of it before it is returned or logged. Neither
// variable is NEXT_PUBLIC_.
//
// ABSENT CONFIG IS A NO-OP, NOT A FAILURE. With either TELEGRAM_BOT_TOKEN or
// TELEGRAM_ALERT_CHAT_ID unset, telegramConfig() answers null and the caller
// sends nothing and stamps nothing -- which is every environment this
// repository's tests reach, and why no test can send a real message.
//
// BOUNDED. One request, AbortSignal.timeout(TELEGRAM_TIMEOUT_MS), so this adds
// at most ten seconds to the delivery route's worst case (lib/email/
// incident-alerts.ts carries the arithmetic against the 600 s cadence).

export const TELEGRAM_TIMEOUT_MS = 10_000;
const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramConfig {
  readonly token: string;
  readonly chatId: string;
}

export type TelegramSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Both variables, trimmed, or null when either is missing or blank. */
export function telegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

function scrub(message: string, token: string): string {
  return message.split(token).join("<redacted>");
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  timeoutMs: number = TELEGRAM_TIMEOUT_MS,
): Promise<TelegramSendResult> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const detail = timedOut
      ? `Telegram did not answer within ${timeoutMs} ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, error: scrub(`network error: ${detail}`, config.token) };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON answer is a failure below; the body is not needed for it.
  }
  const okFlag =
    typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  if (!response.ok || !okFlag) {
    const description =
      typeof body === "object" && body !== null &&
      typeof (body as { description?: unknown }).description === "string"
        ? (body as { description: string }).description
        : "no description";
    return {
      ok: false,
      error: scrub(`Telegram ${response.status}: ${description}`, config.token),
    };
  }
  return { ok: true };
}
