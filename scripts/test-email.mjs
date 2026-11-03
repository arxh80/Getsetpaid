// Brevo smoke test. Proves your API key, verified sender, and domain
// authentication (SPF/DKIM) all work end to end.
//
//   node scripts/test-email.mjs you@example.com
//
// Reads BREVO_API_KEY / BREVO_SENDER_EMAIL / BREVO_SENDER_NAME from .env.local
// (same vars lib/email/send.ts uses). Sends one email; prints the result.
import { readFileSync } from "node:fs";

function loadEnvLocal() {
  const env = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env.local -- fall back to process.env only
  }
  return env;
}

const fileEnv = loadEnvLocal();
const get = (k) => process.env[k] ?? fileEnv[k];

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/test-email.mjs <recipient-email>");
  process.exit(1);
}

const apiKey = get("BREVO_API_KEY");
const senderEmail = get("BREVO_SENDER_EMAIL");
const senderName = get("BREVO_SENDER_NAME") ?? "GetSetPaid";

if (!apiKey) {
  console.error("BREVO_API_KEY not found in .env.local or the environment.");
  process.exit(1);
}
if (!senderEmail) {
  console.error("BREVO_SENDER_EMAIL not found. It must be a Brevo-verified sender.");
  process.exit(1);
}

const res = await fetch("https://api.brevo.com/v3/smtp/email", {
  method: "POST",
  headers: {
    "api-key": apiKey,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify({
    sender: { email: senderEmail, name: senderName },
    to: [{ email: to }],
    subject: "GetSetPaid email test",
    htmlContent: "<p>If you can read this, Brevo is wired up correctly.</p>",
    textContent: "If you can read this, Brevo is wired up correctly.",
  }),
});

if (res.ok) {
  const body = await res.json().catch(() => ({}));
  console.log(`OK: sent to ${to} (messageId: ${body.messageId ?? "n/a"}).`);
  console.log("Check the inbox (and spam). If it landed in spam, DKIM/SPF/DMARC");
  console.log("may not be verified yet in Brevo -> Domains.");
} else {
  const body = await res.json().catch(() => ({}));
  console.error(`FAILED: Brevo ${res.status} -- ${body.message ?? "(no message)"}`);
  console.error("Common causes: wrong API key; sender not verified in Brevo;");
  console.error("or the domain's DNS records are not verified yet.");
  process.exit(1);
}
