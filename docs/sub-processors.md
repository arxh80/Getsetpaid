# Sub-processors

The public sub-processor list `CLAUDE.md` § Sub-processor / DPA register
requires under UK GDPR / EU GDPR Art 28. A third party appears here in the
same change that first sends it personal data; a signed Data Processing
Agreement is a pre-launch counsel item per vendor, and the "DPA" column says
honestly whether it is done. This is a working draft for counsel review. The
customer-facing list is the public Subprocessors page (`/legal/subprocessors`),
which renders `lib/legal/sub-processors.ts` — **edit both in the same change**:
`tests/unit/legal/sub-processors-drift.test.ts` fails if the two disagree on
the vendors, their order, their location or their DPA status.

| Sub-processor | Purpose | Personal data it processes | Location | Transfer basis (UK → there) | DPA |
|---|---|---|---|---|---|
| **Supabase, Inc.** | Database, authentication, file storage — the system of record | Everything the product stores: account identities, workspace records, documents, audit trail | UK/EU region only (`CLAUDE.md` § Non-functional targets) | No transfer: data is hosted in the UK/EU region. Supabase's own sub-processors (cloud provider) are covered by its DPA | **Not yet signed** — pre-launch |
| **Brevo (Sendinblue SAS)** | **Built:** transactional email — the in-app feedback receipt and the incident-alert digest to the support contact, and the account-lockout notice to the affected account holder (`lib/email/send.ts`, `lib/email/lockout-notification.ts`). **Not yet configured:** Supabase Auth SMTP relay for sign-up, magic-link and reset mail — a hosted-project setting (`docs/email-setup.md` § 3) that nothing in the repository configures today; this row's scope widens to auth mail only when that step is done | **Today:** the support contact's address; for a feedback receipt, the submitter's email, workspace name, role, the page path and **the message text they typed**; for a lockout notice, the locked account's email address. **Once the Auth relay is configured:** every user's address, on every sign-up / magic link / reset | France (EU) | The EEA is covered by the UK's adequacy regulations, so **no IDTA/SCCs are needed for the transfer itself**. Phase 7's DECISIONS-QUEUE Q91 described Brevo as "non-UK/EU"; it is EU-based, and Q119 records the correction | **Not yet signed** — must be before real personal data flows (`SECURITY.md` § 15) |

Not sub-processors (no personal data reaches them): the malware scanner at
MVP is a local stub (`SECURITY.md` § 6, Q42) — a scanning SaaS, when chosen,
is added here first.
