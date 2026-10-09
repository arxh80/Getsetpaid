# Email setup (Brevo)

Two independent email paths. Set both up; they use the same Brevo account but
plug in at different layers.

| Path | What it sends | Configured where |
|---|---|---|
| **Supabase Auth SMTP** | signup confirm, magic link, password reset, invites | Supabase (custom SMTP) — no app code. **Not configured yet**: neither the hosted project nor `supabase/config.toml` points Auth at Brevo today (§ 3 is a to-do) |
| **App transactional** | in-app feedback receipt to founder, incident alerts (Phase 7) | `lib/email/send.ts` — Brevo HTTP API. **Built** |

Provider: **Brevo** — free tier 300 emails/day, EU-based. Chosen for UK/EU data
residency (CLAUDE.md § International transfers) plus a free tier that covers MVP
volume many times over.

---

## 1. Brevo account + domain authentication (do this first)

Deliverability depends on it — without SPF/DKIM/DMARC, mail lands in spam.

1. Create the Brevo account and add the sending domain (e.g. `getsetpaid.co.uk`).
2. In **Brevo → Senders, Domains & Dedicated IPs → Domains**, add the domain and
   copy the DNS records it gives you:
   - **SPF** (TXT) — authorises Brevo to send for the domain.
   - **DKIM** (TXT, `brevo._domainkey` or `mail._domainkey`) — signs the mail.
   - **DMARC** (TXT at `_dmarc`) — start at `p=none` to monitor, tighten to
     `p=quarantine` then `p=reject` once SPF/DKIM pass cleanly.
3. Add those records at the DNS host and wait for Brevo to show them verified.
4. Add a verified **sender address** (e.g. `no-reply@getsetpaid.co.uk`).

## 2. App transactional email (`lib/email/send.ts`)

1. **Brevo → SMTP & API → API Keys** → generate a key.
2. Set the server-only env vars (see `.env.example`) in `.env.local` (dev) and in
   the deployment's env (prod):
   ```
   BREVO_API_KEY=...            # the API key — SERVER ONLY, never NEXT_PUBLIC_
   BREVO_SENDER_EMAIL=no-reply@getsetpaid.co.uk
   BREVO_SENDER_NAME=GetSetPaid
   ```
3. Call it from server-side code only (a server action or route handler):
   ```ts
   import { sendEmail } from "@/lib/email/send";

   const result = await sendEmail({
     to: [{ email: founderEmail }],
     subject: "New feedback",
     html: "<p>…</p>",
     text: "…",
   });
   if (!result.ok) {
     // log/audit result.error — never swallow it; the triggering action
     // (e.g. the feedback write) still succeeds independently.
   }
   ```
   The helper returns a typed result and never throws, so a mail failure cannot
   take down the action that triggered it. Every call carries a 10-second
   timeout (`BREVO_TIMEOUT_MS`): a Brevo endpoint that accepts the connection
   and never answers comes back as `ok: false` with a "did not answer" reason,
   not a hung caller. The feedback receipt runs after the submission's
   response (`after()` from `next/server`), so the submitter never waits on it.

## 3. Supabase Auth custom SMTP (production)

Supabase's built-in email sender is rate-limited and not for production. Point
Auth at Brevo's SMTP relay so auth emails come from your domain.

- **Brevo → SMTP & API → SMTP** — note the relay host and generate an SMTP key
  (this is a different credential from the API key in step 2).
- **Hosted project → Authentication → Emails → SMTP Settings**, enter:
  ```
  Host:        smtp-relay.brevo.com
  Port:        587            # STARTTLS (or 465 for SSL)
  Username:    <your Brevo SMTP login>
  Password:    <the Brevo SMTP key>
  Sender email: no-reply@getsetpaid.co.uk
  Sender name:  GetSetPaid
  ```
- Local dev uses Inbucket (Supabase's local mail catcher) — no Brevo needed
  locally; this custom SMTP is a hosted-project setting.
- `supabase/config.toml` carries only the CLI's commented-out `[auth.email.smtp]`
  example (a SendGrid placeholder); nothing there points at Brevo. If you
  prefer config-as-code, uncomment it with the values above and keep the
  password out of git (use `env(...)`).

## 4. Compliance (before real personal data flows)

- **Sign Brevo's DPA** and add Brevo to the public sub-processor list (Art 28 —
  CLAUDE.md § Sub-processor / DPA register).
- Brevo is EU-based, so no international-transfer paperwork is needed (unlike a
  US provider, which would need an IDTA/SCC).
- **Transactional only through this path.** Auth emails, feedback receipts and
  alerts ride contract / legitimate interest and need no consent. Any marketing
  email is a separate stream behind a PECR opt-in — do not send it via
  `sendEmail` without that consent gate.

## What's needed when

- **Now (auth is already live):** step 1 (domain auth) + step 3 (Supabase SMTP) +
  step 4 (DPA). No app code.
- **Phase 7 Task 6 — DONE in code, needs config:** step 2 is wired. Two
  consumers called `sendEmail()` when this task shipped (the lockout notice
  and the Phase 8 notices below have joined them since):
  - `lib/email/feedback-notification.ts` — the founder's receipt for one
    feedback submission, sent after the row is stored, stamping
    `feedback.notified_at` only on `ok: true`. Recipient: `SUPPORT_CONTACT_EMAIL`.
  - `lib/email/incident-alerts.ts` — one digest of every `incident_alerts`
    row with `notified_at is null`, stamping only after `ok: true`. Invoked by
    `POST /api/incident-alerts/deliver` with
    `Authorization: Bearer $INCIDENT_ALERT_DELIVERY_SECRET`. `pg_cron` schedules
    it every 10 minutes (`private.deliver_incident_alerts()`, Q118). It needs
    the two Vault entries in `SECURITY.md` § 15, and without them it is a
    no-op: alerts stay rows on `/super/health` and not emails.
  Env: `BREVO_*` (above) plus `SUPPORT_CONTACT_EMAIL` and
  `INCIDENT_ALERT_DELIVERY_SECRET` (`.env.example`). Unset means "stored, not
  emailed" — logged loudly, never a crash, never a failed submission.
- **Built (Phase 8 Task 9b/9c):** DSR, export-ready, erasure-failure,
  connection-request, task-reminder and workspace-closure notices, all through
  `lib/email/send.ts` on the same tick. Telegram carries the counts-only
  operator alert (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`).

## Sub-processor register

Brevo is listed in `docs/sub-processors.md`. It is EU-based (France), so the
UK → EEA transfer rides the UK adequacy regulations and needs no IDTA/SCCs; the
DPA still must be signed before real personal data flows (`SECURITY.md` § 15).
