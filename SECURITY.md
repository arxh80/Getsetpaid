# SECURITY.md

Internal engineering reference **and** pentest/audit prep document for GetSetPaid. Consolidates security decisions already made across `CLAUDE.md` and the PRD (`getsetpaid_crm_prd.docx` §10, §18) into one place, plus defines rate limits, incident response and vulnerability disclosure that didn't exist anywhere yet.

This is not the public-facing Trust Centre page (PRD §12) — it is written for engineers and external security testers, not customers. Nothing here is a substitute for the pre-launch independent penetration test (PRD §10.8) or legal/privacy counsel review (see `CLAUDE.md` § Legal).

## 1. Principles

- No feature is production-ready until threat modelling, access-control tests and OWASP-aligned tests pass — security is an acceptance criterion, not hardening applied after the fact.
- Least privilege everywhere: roles, database roles, service accounts, superuser access.
- Private by default: tenant data never crosses into the network/public surface without an explicit, tested, opt-in policy.

## 2. Tenancy and Row Level Security

- RLS is enabled on every tenant-owned table before the application can reach it. Separate policies per operation (SELECT/INSERT/UPDATE/DELETE) where useful.
- Access is derived from the authenticated session and organisation membership, checked **in the database** — never from a client-supplied organisation ID.
- Network/public tables (`network_profiles`, `network_links`) have their own read policies, entirely separate from tenant-private tables. Private tables are never joined into a public discovery path without an explicit, tested policy.
- Finance and audit tables carry additional, more restrictive policies than general CRM data.
- `SECURITY DEFINER` functions are used only where necessary, with `search_path` locked and `EXECUTE` restricted; every one is reviewed individually.
- Service-role/secret keys bypass RLS entirely and must never reach the browser.

## 3. Input handling

- All queries are parameterised or built with a trusted query builder — no string-concatenated SQL, anywhere.
- Search/filter/sort inputs map to an allowlist of column names and operators; free-form input never becomes a column/operator name.
- Rich text is sanitised against stored and reflected XSS. URLs are validated against an allowlist of protocols (`javascript:` and `data:` rejected). `dangerouslySetInnerHTML` is avoided; where unavoidable, it requires security review.
- A strong Content Security Policy is shipped with the Next.js app.

## 4. Authentication and session security

- Identity: Supabase Auth. Email/password and magic-link/OTP at MVP; **Google SSO ships at MVP**, Microsoft SSO is post-MVP.
- Session limits: **30-minute inactivity timeout, 12-hour absolute session lifetime.**
- MFA is **required** for Platform Superuser, Organisation Owner, Admin and Finance roles. Optional (not enforced) for all other roles at MVP.
- Step-up re-authentication (re-enter credentials/MFA) is required before: changing security settings (MFA, password, email), large data exports, deleting organisation data, and any high-risk admin/superuser function — including impersonation.
- Active-session listing with remote revocation is available to every user.
- Superuser impersonation is break-glass only: the superuser requests it, the target org's admin must accept, the session is time-boxed, and the whole flow is audited (actor, org, reason, start/end). No silent or unilateral impersonation.
- **Superuser dashboard** (single hardcoded superuser account at MVP): never exposes tenant record content directly — only aggregate metadata (seat count, storage, record counts). Org suspend/delete is soft-delete only, requires step-up re-auth, and notifies the org admin. Billing overrides require step-up re-auth, a mandatory audited reason, org-admin notification, and are time-boxed with auto-revert. Per-org feature overrides require a mandatory expiry date — no open-ended grants. Full spec in `CLAUDE.md` § Superuser dashboard.

## 5. Rate limiting and abuse prevention

Standard defaults — tune during implementation, but these are the numbers to build against:

| Endpoint category | Limit |
|---|---|
| Login | 5 attempts / 15 min, per IP **and** per account |
| Password recovery / verification | 3 / hour, per account |
| Search | 60 requests / min, per user |
| Exports | 5 / hour, per organisation |
| Network discovery | 30 requests / min, per user |

- Every unbounded list/API endpoint is paginated (cursor/keyset for activity feeds); server-side page-size ceilings, never a client-defined unlimited limit.
- Exports are async and bounded — no synchronous unbounded export endpoint.

## 6. File security

- Private Supabase Storage buckets only. Short-lived signed URLs issued after authorisation.
- **Malware-scan every upload at MVP** (e.g. ClamAV or a scanning API); quarantined files are not openable until cleared.
- Accept only a **strict allowlist of file types** (documents, images, PDFs) — not just MIME/extension checks. No executables, no macro-enabled Office formats.
- Filenames are sanitised; user-supplied paths are never used as storage keys.
- Every upload, view/download, share and delete action is logged.

## 7. Audit logging

- Every high-value action records: actor, org, timestamp, action, target, correlation ID, before/after values.
- Append-only from the application. Superuser access audits itself. Passwords, tokens and keys are never logged.
- Retention: hot/queryable for 30 days, archived (cold storage) for up to 1 year total, then purged. Deletion/alteration of audit records outside that lifecycle is restricted to a narrowly controlled platform security process.

## 8. Data retention and residency

- Soft-delete operational records rather than hard deletion, subject to retention policy.
- Working defaults (pending legal sign-off — see `CLAUDE.md` § Legal): **7 years** for financial records, **2 years** for inactive-account data, **30 days hot / 1 year archived** for audit logs.
- GDPR data subject requests (export/erasure): **30-day** target, matching the ICO statutory maximum.
- **Data residency: UK/EU Supabase region only** — no US-region hosting for customer data.
- Currency: **GBP only at MVP**; schema (`financial_entries` etc.) stores a currency column and minor units so multi-currency UI can be added later without a migration.

## 9. Non-functional security-adjacent targets

- Availability SLO: **99.9%**, excluding planned maintenance.
- Backup targets: **RPO 24h / RTO 4h** for the database, with tested restore procedures.

## 10. Known risk areas (for pentest/audit context)

Pulled from PRD §18. A tester or reviewer should focus here first — this is where a mistake has the highest blast radius.

| Risk | Why it matters | Where the mitigation lives |
|---|---|---|
| Network privacy leakage | Shared identities between `network_profiles` and tenant tables can accidentally expose private data — the single highest-risk boundary in the system. | §2 (RLS, separate tables), `CLAUDE.md` § "The private/network split" |
| Role/subscription complexity | The permission matrix (platform policy ∩ entitlement ∩ role ∩ record scope ∩ exception) is easy to get subtly wrong. | Centralised entitlement/policy evaluation; test every role×tenant×network combination — see Testing gates below |
| File security | Contracts, riders and IDs are high-impact if exposed. | §6 |
| User-generated ratings | Public ratings could create legal/reputational exposure. | Ratings are permanently private in v1 (`CLAUDE.md` decisions log) |
| Financial scope creep | Finance drifting toward full accounting software expands the attack surface unnecessarily. | Finance stays at event/booking level (budget & actuals only) at MVP |
| Integration dependencies | Ticketing/email providers add third-party trust boundaries. | Deferred past MVP; adapters + link-first design when built |
| Legal/compliance drift | UK privacy guidance changes over time. | Scheduled legal review, versioned legal pages |

Tenant-breakout and network-leakage tests matter more than anything else in this list — they should exist before a feature ships, not be added after.

## 11. Testing gates

Per `CLAUDE.md` § Testing gates and PRD §16, before a release:

- RLS integration tests across roles, tenants and network visibility.
- API tests for validation, parameterisation, pagination and rate limiting.
- Security tests: XSS, SQL injection, IDOR/BOLA, CSRF, session fixation/hijacking, insecure file access, privilege escalation, tenant breakout.
- Accessibility: automated tooling plus keyboard/screen-reader spot checks.
- Dependency, secret and license scanning in CI.
- Manual review of every privileged function and every use of a service-role key.
- Pre-production backup restore test.
- Independent penetration test before general availability.

## 12. Incident response

Current stage (single founder, pre-launch): no formal on-call rotation yet.

- **Security contact:** the founder is the sole point of contact at this stage. *(TODO before launch: set up a dedicated security contact channel — see §13 — rather than a personal inbox.)*
- **Severity tiers:**
  - **Sev1** — active breach, confirmed data exposure, or a live exploit: response target **1 hour**.
  - **Sev2** — exploitable vulnerability, no evidence of exploitation: response target **24 hours**.
  - **Sev3** — low-risk finding, hardening opportunity: addressed **next sprint**.
- **Regulatory obligation:** notifiable UK GDPR breaches must be reported to the ICO without undue delay and, where feasible, within **72 hours** — this clock starts independent of the internal severity tiers above.
- A full written runbook (roles, communication plan, customer notification templates, post-incident review process) is still to be drafted — flag as open work before handling real customer data.
- **Basic trigger-based alerting ships at MVP** via the superuser dashboard: email/SMS on specific events (e.g. repeated failed logins across an org, a malware-scan hit). This is not a full alerting/observability platform — just enough to catch the incidents in the severity table above before a customer reports them.

## 13. Vulnerability disclosure

At MVP, external researchers report through the **general support channel** — there is no dedicated `security@` address or `security.txt` yet. This is a deliberately minimal starting point; revisit once there's a real user base to protect (a dedicated inbox and `security.txt` are cheap to add later and should not block launch).

## 14. Open security decisions

Carried over from `CLAUDE.md` § Open decisions — these need founder/legal input, not an engineering default:

- Exact retention periods per record type (legal/privacy counsel sign-off required).
- Whether/when to stand up a dedicated vulnerability disclosure channel and incident response runbook in full.
- First ticketing API partner (affects integration-specific threat modelling when that phase starts).
