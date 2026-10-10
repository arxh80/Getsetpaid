# Sub-processors

The public sub-processor list `CLAUDE.md` § Sub-processor / DPA register
requires under UK GDPR / EU GDPR Art 28. A third party appears here in the
same change that first sends it personal data; a signed Data Processing
Agreement is a pre-launch counsel item per vendor, and the "DPA" column says
honestly whether it is done. This is a working draft for counsel review. The
customer-facing list is the public Subprocessors page (`/legal/subprocessors`),
which renders `lib/legal/sub-processors.ts` — **edit both in the same change**:
`tests/unit/legal/sub-processors-drift.test.ts` fails if the two disagree on
the vendors, their order, their location or their DPA status, or if a
vendor's Purpose or Personal-data cell below differs from the verbatim copy
the module keeps beside its customer wording (so a change here forces that
wording to be re-read; the test cannot judge the rewrite itself).

**The application host (DECISIONS-QUEUE Q142, founder 2026-09-30):** an
IONOS VPS. IONOS SE is a German company. The server has not been bought, so
its region is **PENDING** — the founder expects the UK, and that expectation
is not written into the register as a fact. Every request passes through the
application servers, so the host will see session cookies, IP addresses and
page content. When the server is bought: set its Location cell here and in
`lib/legal/sub-processors.ts` in the same change, settle the transfer basis
with counsel, and publish new versions of the Privacy Notice, DPA, Security
page and Subprocessors page. No other application host is assumed anywhere
in this repository.

**The database region (Q145, founder 2026-09-30):** the production Supabase
project is in **Ireland (eu-west-1)**. The "(deployment setting)" marker the
Supabase row carried while the region was unconfirmed is gone.

| Sub-processor | Purpose | Personal data it processes | Location | Transfer basis (UK → there) | DPA |
|---|---|---|---|---|---|
| **Supabase, Inc.** | Database, authentication, file storage — the system of record | Everything the product stores: account identities, workspace records, documents, audit trail | Incorporated in the United States; data hosted in Ireland (eu-west-1) (founder 2026-09-30, Q145; `CLAUDE.md` § Non-functional targets) | **Not established.** The data region is Ireland (eu-west-1) (founder 2026-09-30); it is set when the hosted project is created, and `SECURITY.md` § 15 "Project region" is the pre-launch check that it is. Supabase, Inc. is US-incorporated with no signed DPA, so whether any restricted transfer takes place (for example support or sub-processor access from outside the UK) and which safeguard covers it (adequacy, the IDTA or SCCs) is for counsel to confirm. Supabase's own sub-processors (cloud provider) would be covered by its DPA once signed | **Not yet signed** — pre-launch |
| **Brevo (Sendinblue SAS)** | **Built:** transactional email — the in-app feedback receipt and the incident-alert digest to the support contact, and the account-lockout notice to the affected account holder (`lib/email/send.ts`, `lib/email/lockout-notification.ts`); since Phase 8 Task 9b/9c, the requester's data-subject-request received/closed and export-ready notices, the connection-request received/accepted/declined notices to the Owners and Admins (or the sender), task reminders to the assignee, and the workspace-closure and closure-decision notices (`lib/email/requester-notifications.ts`, `network-notifications.ts`, `task-reminder-notifications.ts`, `workspace-closure-notifications.ts`). **Not yet configured:** Supabase Auth SMTP relay for sign-up, magic-link and reset mail — a hosted-project setting (`docs/email-setup.md` § 3) that nothing in the repository configures today; this row's scope widens to auth mail only when that step is done | **Today:** the support contact's address; for a feedback receipt, the submitter's email, workspace name, role, the page path and **the message text they typed**; for a lockout notice, the locked account's email address; for those notices, the recipient's email address plus a request reference, right and status, a counterparty's published display name, a task's title and due date, or a workspace's name and slug (never a note, rating, financial or the superuser's reason). **Once the Auth relay is configured:** every user's address, on every sign-up / magic link / reset | France (EU) | The EEA is covered by the UK's adequacy regulations, so **no IDTA/SCCs are needed for the transfer itself**. Phase 7's DECISIONS-QUEUE Q91 described Brevo as "non-UK/EU"; it is EU-based, and Q119 records the correction | **Not yet signed** — must be before real personal data flows (`SECURITY.md` § 15) |
| **IONOS SE** | Application host — the virtual private server the Next.js application will run on. **Not yet bought:** nothing is deployed to it today | Every request and response: session cookies, IP addresses, page content, form submissions and uploads in transit | Incorporated in Germany (EU); server region PENDING — the server has not been set up yet (founder 2026-09-30: "most likely UK"; `DECISIONS-QUEUE` Q142) | **Not established.** It depends on the server's region, which is pending. Counsel to confirm the basis once the region is chosen, alongside IONOS SE's own sub-processors | **Not yet signed** — pre-launch |

Not sub-processors (no personal data reaches them): the malware scanner at
MVP is a local stub (`SECURITY.md` § 6, Q42) — a scanning SaaS, when chosen,
is added here first.

Integrations (Phase 9) add **no row**: the schema ships with no live provider,
so no connection can be made and nothing is sent to a mail or calendar vendor.
The first connector (Google Calendar, Q232) adds its vendor here, with its DPA
and transfer basis, before its `live` flag turns on.
