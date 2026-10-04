// Telegram smoke test -- the ONE live Telegram send this repository permits,
// and it is run BY HAND by the founder, never by a test or an agent
// (task-9b brief: "No real sends from tests").
//
//   node scripts/telegram-test-send.mjs
//
// Reads TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID from the environment, then
// .env.development.local, then .env.local (the same names lib/telegram/send.ts
// reads). Sends one fixed message with no personal data in it and prints
// ok/failed. It never prints the token or the chat id.
import { readFileSync } from "node:fs";

function loadEnvFile(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // file absent -- fall through to the next source
  }
  return env;
}

const files = [loadEnvFile(".env.development.local"), loadEnvFile(".env.local")];
const get = (k) => process.env[k] || files.map((f) => f[k]).find(Boolean);

const token = get("TELEGRAM_BOT_TOKEN")?.trim();
const chatId = get("TELEGRAM_ALERT_CHAT_ID")?.trim();
if (!token || !chatId) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID must both be set.");
  process.exit(1);
}

const text = [
  "GetSetPaid: test message from scripts/telegram-test-send.mjs",
  "- Rate limit tripped: 0",
  "This is a hand-run smoke test; no alert was raised.",
].join("\n");

try {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.ok === true) {
    console.log("ok: message sent");
  } else {
    const description = String(body?.description ?? "no description").split(token).join("<redacted>");
    console.error(`failed: Telegram ${response.status}: ${description}`);
    process.exit(1);
  }
} catch (err) {
  const message = String(err?.name ?? err).split(token).join("<redacted>");
  console.error(`failed: ${message}`);
  process.exit(1);
}
