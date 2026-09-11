# Email setup (Brevo)

Two independent email paths. Set both up; they use the same Brevo account but
plug in at different layers.

| Path | What it sends | Configured where |
|---|---|---|
| **Supabase Auth SMTP** | signup confirm, magic link, password reset, invites | Supabase (custom SMTP) — no app code |
| **App transactional** | in-app feedback receipt to founder, incident alerts (Phase 7) | `lib/email/send.ts` — Brevo HTTP API |

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
3. Call it from a server action / edge function only:
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
   take down the action that triggered it.

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
- `supabase/config.toml` has an `[auth.email.smtp]` block for the same values if
  you prefer config-as-code; keep the password out of git (use `env(...)`).

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
  consumers call `sendEmail()` and nothing else does:
  - `lib/email/feedback-notification.ts` — the founder's receipt for one
    feedback submission, sent after the row is stored, stamping
    `feedback.notified_at` only on `ok: true`. Recipient: `SUPPORT_CONTACT_EMAIL`.
  - `lib/email/incident-alerts.ts` — one digest of every `incident_alerts`
    row with `notified_at is null`, stamping only after `ok: true`. Invoked by
    `POST /api/incident-alerts/deliver` with
    `Authorization: Bearer $INCIDENT_ALERT_DELIVERY_SECRET`. **Nothing in the
    repo schedules that call** — point an external cron at it (every 5–15
    minutes is plenty; DECISIONS-QUEUE Q118). Until then alerts are rows on
    `/super/health` and not emails.
  Env: `BREVO_*` (above) plus `SUPPORT_CONTACT_EMAIL` and
  `INCIDENT_ALERT_DELIVERY_SECRET` (`.env.example`). Unset means "stored, not
  emailed" — logged loudly, never a crash, never a failed submission.
- **Deferred:** connection-request / general notifications — there is no
  notification subsystem at MVP (Q45), so nothing sends those yet.

## Sub-processor register

Brevo is listed in `docs/sub-processors.md`. It is EU-based (France), so the
UK → EEA transfer rides the UK adequacy regulations and needs no IDTA/SCCs; the
DPA still must be signed before real personal data flows (`SECURITY.md` § 15).
