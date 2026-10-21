# Task 9b — Founder rulings 2026-09-30: all notification emails, plus Telegram incident alerts

These are the founder's direct answers from 2026-09-30, covering Q157(3), Q174, Q45 and Q111. They are rulings, not defaults.

Read these first:
- `progress.md` § "Standing lessons"
- `lib/email/send.ts` and `lib/email/templates.ts`
- `lib/email/incident-alerts.ts`: the pg_cron → Vault → pg_net → route delivery pattern, and its overlap budget
- `lib/email/lockout-notification.ts`
- `SECURITY.md` § 12
- The CLAUDE.md sections on `reminder_at` and "A connection request arrives silently". Both become FALSE after this task and must be rewritten.

## Requirements

1. **Build every notification email through the ONE Brevo sender.**

   | Email | Recipient |
   |---|---|
   | DSR received | the requester |
   | DSR closed | the requester |
   | Erasure failure | the superuser |
   | Export ready | the requester. Link to the in-app download; never put the file or a signed URL in the email. |
   | Connection request received, accepted, declined | the relevant org's Owner/Admins, or the sender. Decide from the PRD and record the choice. |
   | Task reminder at `reminder_at` | the assignee |

   Every email must meet three rules.
   - **Content:** it carries no tenant-private content beyond what the recipient can already read in-app. A counterparty's email never names private notes, ratings or financials.
   - **Idempotency:** it follows the incident digest's "stamp only after ok:true" contract. Use a `notified_at`-style column the browser cannot write, with a service_role-only update on that one column.
   - **Delivery:** it comes from a bounded, scheduled run on the existing pg_cron tick, or from the write path where synchronous delivery is right. State which you chose and why. The whole route's worst case must stay inside the 600 s cadence.

2. **Add Telegram as a second incident-alert channel** beside the email digest, on the same tick and the same route.
   - **Env vars:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID`.
     - Add the NAMES ONLY to `.env.example`.
     - Values live in `.env.development.local` locally, and in the IONOS env or Supabase Vault in production.
     - Never commit the token and never log it.
   - **Payload:** alert type, counts and a `/super/health` link ONLY. No personal data, no tenant content, no emails, no ids.
     - Add a unit test that asserts the payload contains only the allowlisted fields.
   - **Absent config:** the channel is a no-op when either env var is missing.
   - **Independence:** a Telegram failure must not block or un-stamp the email channel, and an email failure must not block Telegram. Design the stamping so each channel can be re-sent on its own.
   - **`SECURITY.md` § 12:** state that Telegram (Dubai-based, outside the UK/EU) receives no personal data by construction. Flag for counsel whether it still needs a sub-processor row.

3. **Show incident alerts as dashboard notifications on `/super`.** The founder asked for email, dashboard and Telegram. Check first whether this already exists.

4. **Fix the docs.** Rewrite the lines in CLAUDE.md, SECURITY.md and FOLLOW-UPS that say reminders and connection requests are silent.

## Discipline

- **Mutation-test every guard.** Remove it, then record which assertions go red and in which layer.
- **Migrations:** new ones only; never edit a shipped migration.
- **Registries:** update the pinned totals, the matrix and the audit catalogue.
- **Gates:** run all five. Run the psql suite twice on the same database.
- **Commits:** one logical change per commit. Commit and push each one.
- **Report** to `task-9b-report.md`.
- **No real sends from tests.** Never send real email or Telegram messages from a test; stub the transport. The only live Telegram send allowed is through an explicit script the founder runs.
